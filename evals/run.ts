#!/usr/bin/env bun
/**
 * The eval harness.
 *
 * Runs entirely against frozen fixtures — no platform API, no live merge
 * request, nothing posted. The default reviewer is a stub, so `bun run evals`
 * works with no API key and exercises the scoring path itself.
 *
 *   bun run evals                          stub reviewer, offline
 *   bun run evals --reviewer=model         real review pass (sync)
 *   bun run evals --reviewer=model --mode=batch    via the Batch API (50% cheaper)
 *   bun run evals --split=holdout          report on the held-out half only
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Finding } from '../src/types.ts';
import { loadConfig } from '../src/config.ts';
import { emptySnapshot } from '../src/context/repo.ts';
import { DEFAULT_SELECT_OPTIONS, selectContext } from '../src/context/select.ts';
import { planBatches } from '../src/review/batch.ts';
import { buildSystemBlocks, buildUserPrompt } from '../src/review/prompt.ts';
import { ReviewSchema, clampFinding } from '../src/review/schema.ts';
import { ReviewRunner } from '../src/review/run.ts';
import { verifyFindings } from '../src/review/verify.ts';
import { judgeFindings } from '../src/review/judge.ts';
import { withFingerprint } from '../src/publish/fingerprint.ts';
import { priceUsd } from '../src/review/pricing.ts';
import { mapPool } from '../src/pool.ts';
import { configureLogger } from '../src/logger.ts';
import { loadCases, toChangeSet, type EvalCase } from './case.ts';
import { buildMutationCases } from './mutate.ts';
import { aggregate, scoreCase, tokenMatcher, type CaseScore } from './score.ts';
import { renderReport, type EvalReport } from './report.ts';

const HERE = new URL('.', import.meta.url).pathname;

interface Options {
  reviewer: 'stub' | 'model';
  mode: 'sync' | 'batch';
  split: 'all' | 'train' | 'holdout';
  limit: number;
  judge: 'on' | 'off';
  out: string | null;
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const [key, value] = token.slice(2).split('=');
    flags.set(key!, value ?? 'true');
  }
  return {
    reviewer: (flags.get('reviewer') as Options['reviewer']) ?? 'stub',
    mode: (flags.get('mode') as Options['mode']) ?? 'sync',
    split: (flags.get('split') as Options['split']) ?? 'all',
    limit: Number(flags.get('limit') ?? Number.MAX_SAFE_INTEGER),
    judge: (flags.get('judge') as Options['judge']) ?? 'off',
    out: flags.get('out') ?? null,
  };
}

function stubFindings(evalCase: EvalCase): Finding[] {
  return evalCase.stubFindings.map((raw) =>
    withFingerprint(
      clampFinding({
        ...raw,
        endLine: null,
        suggestion: null,
      }),
    ),
  );
}

async function main(): Promise<number> {
  configureLogger({ format: 'human', quiet: true });
  const options = parseOptions(process.argv.slice(2));

  const curated = await loadCases(join(HERE, 'cases'));
  const injected = await buildMutationCases(join(HERE, 'clean'));
  const all = [...curated, ...injected].filter(
    (entry) => options.split === 'all' || entry.split === options.split,
  );
  const cases = all.slice(0, options.limit);

  if (cases.length === 0) {
    process.stderr.write('no eval cases found\n');
    return 1;
  }

  const cfg = loadConfig(
    { ...process.env, REVIEWER_PLATFORM: 'local' },
    { platform: 'local', dryRun: true, judge: options.judge, context: 'diff' },
  );

  const scores: CaseScore[] =
    options.reviewer === 'stub'
      ? await runStub(cases)
      : options.mode === 'batch'
        ? await runBatch(cases, cfg)
        : await runSync(cases, cfg);

  const report: EvalReport = {
    createdAt: new Date().toISOString(),
    variant: {
      reviewer: options.reviewer,
      model: options.reviewer === 'model' ? cfg.reviewModel : 'stub',
      judge: options.judge,
      effort: cfg.reviewEffort,
      context: cfg.context,
      promptVersion: cfg.promptVersion,
      matcher: tokenMatcher.name,
      mode: options.mode,
    },
    scores,
  };

  const outDir = join(HERE, 'reports');
  await mkdir(outDir, { recursive: true });
  const outPath =
    options.out ?? join(outDir, `${report.createdAt.replace(/[:.]/g, '-')}-${options.reviewer}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');

  process.stdout.write(renderReport(report));
  process.stdout.write(`report written to ${outPath}\n`);

  const holdout = aggregate(scores.filter((score) => score.split === 'holdout'));
  // Non-zero only when the harness itself could not produce a number.
  return holdout.cases === 0 ? 1 : 0;
}

async function runStub(cases: EvalCase[]): Promise<CaseScore[]> {
  const scores: CaseScore[] = [];
  for (const evalCase of cases) {
    const started = performance.now();
    const changeSet = toChangeSet(evalCase);
    const verified = verifyFindings(changeSet, stubFindings(evalCase), {
      confidenceThreshold: 0.6,
    });
    scores.push(
      await scoreCase(evalCase, verified.kept, {
        costUsd: 0,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  }
  return scores;
}

async function runSync(cases: EvalCase[], cfg: ReturnType<typeof loadConfig>): Promise<CaseScore[]> {
  const runner = new ReviewRunner(cfg);

  return await mapPool(cases, 2, async (evalCase) => {
    const started = performance.now();
    const costBefore = runner.usage.costUsd;
    const changeSet = toChangeSet(evalCase);

    const selection = await selectContext(changeSet, [], emptySnapshot('evals'), null, {
      ...DEFAULT_SELECT_OPTIONS,
      mode: 'diff',
    });
    const systemBlocks = buildSystemBlocks([]);
    const systemTokens = await runner.countSystem(systemBlocks);
    const plan = await planBatches(selection.contexts, {
      counter: runner,
      systemTokens,
      budgetTokens: 400_000,
      maxFilesPerBatch: cfg.maxFilesPerBatch,
      concurrency: 2,
    });

    const raw: Finding[] = [];
    for (const batch of plan.batches) {
      const outcome = await runner.reviewBatch(batch, systemBlocks, changeSet);
      raw.push(...outcome.findings);
    }

    const verified = verifyFindings(changeSet, raw, {
      confidenceThreshold: cfg.confidenceThreshold,
    });
    let kept = verified.kept;
    if (cfg.judge === 'on') {
      kept = (await judgeFindings(kept, changeSet, [], runner, 2)).kept;
    }

    return await scoreCase(evalCase, kept, {
      costUsd: runner.usage.costUsd - costBefore,
      durationMs: Math.round(performance.now() - started),
    });
  });
}

/** One request per case through the Batch API — half price, results unordered. */
async function runBatch(cases: EvalCase[], cfg: ReturnType<typeof loadConfig>): Promise<CaseScore[]> {
  const client = new Anthropic();
  const started = performance.now();
  const systemBlocks = buildSystemBlocks([]);
  const changeSets = new Map(cases.map((entry) => [entry.id, toChangeSet(entry)]));

  const requests = await Promise.all(
    cases.map(async (evalCase) => {
      const changeSet = changeSets.get(evalCase.id)!;
      const selection = await selectContext(changeSet, [], emptySnapshot('evals'), null, {
        ...DEFAULT_SELECT_OPTIONS,
        mode: 'diff',
      });
      return {
        custom_id: evalCase.id,
        params: {
          model: cfg.reviewModel,
          max_tokens: cfg.maxTokens,
          system: systemBlocks.map((block) => ({ type: 'text' as const, text: block.text })),
          messages: [
            { role: 'user' as const, content: buildUserPrompt(changeSet, selection.contexts) },
          ],
          output_config: {
            format: zodOutputFormat(ReviewSchema),
            effort: cfg.reviewEffort,
          },
        },
      };
    }),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- batch params are wider than the typed surface
  const batch = await client.messages.batches.create({ requests: requests as any });
  process.stderr.write(`batch ${batch.id} submitted (${requests.length} requests)\n`);

  for (;;) {
    const status = await client.messages.batches.retrieve(batch.id);
    if (status.processing_status === 'ended') break;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }

  const findingsByCase = new Map<string, Finding[]>();
  const costByCase = new Map<string, number>();

  // Results arrive in any order — key by custom_id, never by position.
  for await (const result of await client.messages.batches.results(batch.id)) {
    if (result.result.type !== 'succeeded') {
      findingsByCase.set(result.custom_id, []);
      continue;
    }
    const message = result.result.message;
    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');

    try {
      const parsed = ReviewSchema.parse(JSON.parse(text));
      findingsByCase.set(
        result.custom_id,
        parsed.findings.map((raw) => withFingerprint(clampFinding(raw))),
      );
    } catch {
      // A structured-output response that does not parse is a failed call.
      findingsByCase.set(result.custom_id, []);
    }
    costByCase.set(
      result.custom_id,
      priceUsd(cfg.reviewModel, {
        inputTokens: message.usage.input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
      }) ?? 0,
    );
  }

  const scores: CaseScore[] = [];
  for (const evalCase of cases) {
    const changeSet = changeSets.get(evalCase.id)!;
    const verified = verifyFindings(changeSet, findingsByCase.get(evalCase.id) ?? [], {
      confidenceThreshold: cfg.confidenceThreshold,
    });
    scores.push(
      await scoreCase(evalCase, verified.kept, {
        costUsd: costByCase.get(evalCase.id) ?? 0,
        durationMs: Math.round((performance.now() - started) / cases.length),
      }),
    );
  }
  return scores;
}

process.exit(await main());
