/**
 * The run.
 *
 * Each stage is a function from typed input to typed output; this file wires
 * them together and keeps the bookkeeping that the exit code and the summary
 * comment read from. There is exactly one place a run can be declared a
 * success, and it is at the bottom of this file.
 */

import { randomUUID } from 'node:crypto';
import type { ChangeSet, Finding, RunResult, RunStatus, StageError } from './types.ts';
import type { Config } from './config.ts';
import { unpricedModels } from './config.ts';
import { createPlatform, type Platform } from './platform/index.ts';
import { loadRules } from './rules/load.ts';
import { emptySnapshot, loadRepoSnapshot, type RepoSnapshot } from './context/repo.ts';
import { buildGraph, type ImportGraph } from './context/graph.ts';
import { DEFAULT_SELECT_OPTIONS, selectContext } from './context/select.ts';
import { buildSystemBlocks } from './review/prompt.ts';
import { planBatches } from './review/batch.ts';
import {
  BudgetExceededError,
  DeadlineExceededError,
  ReviewRunner,
  fileCacheKey,
  type Reviewer,
} from './review/run.ts';
import { contextWindow } from './review/pricing.ts';
import { verifyFindings } from './review/verify.ts';
import { ClaudeJudge, judgeFindings, type Judge } from './review/judge.ts';
import { JevJudge, isJevModel } from './review/jev.ts';
import { publishFindings, renderSummary, upsertSummary } from './publish/comments.ts';
import { Store } from './store/db.ts';
import { describeSkip } from './diff/filter.ts';
import { log, timed } from './logger.ts';
import { mapPool } from './pool.ts';

export interface RunOptions {
  repoRoot: string;
  localBase?: string;
  /** Injected in tests; defaults to the real platform + Anthropic client. */
  platform?: Platform;
  runner?: Reviewer;
  store?: Store;
  /** Injected in tests; otherwise selected from `cfg.judgeModel`. */
  judge?: Judge;
}

export async function runReview(cfg: Config, opts: RunOptions): Promise<RunResult> {
  const started = performance.now();
  const runId = randomUUID();
  const errors: StageError[] = [];
  const degradations = new Set<string>();
  let status: RunStatus = 'completed';

  const degrade = (reason: string): void => {
    degradations.add(reason);
  };
  const fail = (stage: string, message: string, next: RunStatus = 'partial'): void => {
    errors.push({ stage, message });
    status = worst(status, next);
  };

  for (const model of unpricedModels(cfg)) {
    degrade(`pricing-unknown:${model}`);
  }

  const store = opts.store ?? new Store(cfg.stateDbPath);
  const platform = opts.platform ?? createPlatform(cfg, opts);

  // ---- intake -------------------------------------------------------------
  let changeSet: ChangeSet;
  try {
    changeSet = await timed('intake', () => platform.fetchChangeSet());
  } catch (err) {
    return finish({
      runId,
      cfg,
      changeSet: null,
      status: 'failed',
      errors: [{ stage: 'intake', message: message(err) }],
      degradations: [...degradations],
      posted: [],
      dropped: [],
      reviewedPaths: [],
      skipped: [],
      costUsd: 0,
      started,
      rulesHash: '',
      judgeModel: null,
      store,
    });
  }

  log.stage({
    stage: 'intake',
    files: changeSet.files.length,
    skipped: changeSet.skipped.length,
    headSha: changeSet.headSha.slice(0, 10),
  });

  const skipped = changeSet.skipped.map((entry) => ({
    path: entry.path,
    reason: describeSkip(entry.reason),
  }));

  // ---- rules --------------------------------------------------------------
  const ruleResult = await timed('rules', () =>
    loadRules(platform, {
      rulesDir: cfg.rulesDir,
      fileMaxBytes: cfg.ruleFileMaxBytes,
      totalMaxBytes: cfg.ruleTotalMaxBytes,
    }),
  ).catch((err) => {
    fail('rules', message(err));
    return { rules: [], errors: [], dropped: [], rulesHash: '' };
  });

  for (const ruleError of ruleResult.errors) {
    fail('rules', `${ruleError.sourcePath}: ${ruleError.message}`);
  }
  for (const droppedRule of ruleResult.dropped) {
    degrade(`rule-dropped:${droppedRule.id} (${droppedRule.reason})`);
  }
  log.stage({
    stage: 'rules',
    loaded: ruleResult.rules.length,
    rejected: ruleResult.errors.length,
    dropped: ruleResult.dropped.length,
  });

  if (changeSet.files.length === 0) {
    const result = finish({
      runId,
      cfg,
      changeSet,
      status,
      errors,
      degradations: [...degradations],
      posted: [],
      dropped: [],
      reviewedPaths: [],
      skipped,
      costUsd: 0,
      started,
      rulesHash: ruleResult.rulesHash,
      judgeModel: null,
      store,
    });
    await postSummary(result, changeSet, { platform, store, cfg }).catch((err) =>
      log.warn('summary post failed', { error: message(err) }),
    );
    return result;
  }

  // ---- context ------------------------------------------------------------
  let snapshot: RepoSnapshot = emptySnapshot('context disabled');
  let graph: ImportGraph | null = null;

  if (cfg.context !== 'off') {
    snapshot = await timed('context:repo', () =>
      loadRepoSnapshot(platform, changeSet.headSha, cfg.cacheDir),
    ).catch((err) => {
      fail('context:repo', message(err));
      return emptySnapshot('repository snapshot failed');
    });
    if (snapshot.degraded) degrade(`context:${snapshot.degraded}`);

    if (cfg.context === 'full' && snapshot.root) {
      graph = await timed('context:graph', () => buildGraph(snapshot)).catch((err) => {
        fail('context:graph', message(err));
        return null;
      });
      if (graph) {
        degrade(`context-analyzer:${graph.analyzerNames.join(',') || 'none'}`);
        log.stage({
          stage: 'context:graph',
          files: graph.analyzedFiles,
          unresolvedImports: graph.unresolvedImports,
        });
      }
    }
  }

  const selection = await timed('context:select', () =>
    selectContext(changeSet, ruleResult.rules, snapshot, graph, {
      ...DEFAULT_SELECT_OPTIONS,
      mode: cfg.context,
    }),
  );
  for (const outlined of selection.outlined) {
    degrade(`context-outlined:${outlined.path} (${outlined.reason})`);
  }
  log.stage({
    stage: 'context:select',
    files: selection.contexts.length,
    rippleFiles: selection.rippleFiles,
    rippleSnippets: selection.rippleSnippets,
  });

  // ---- cache --------------------------------------------------------------
  const runner = opts.runner ?? new ReviewRunner(cfg);
  const cachedFindings: Finding[] = [];
  const toReview: typeof selection.contexts = [];

  for (const context of selection.contexts) {
    const key = fileCacheKey({
      contentHash: context.file.contentHash,
      rulesHash: ruleResult.rulesHash,
      promptVersion: cfg.promptVersion,
      model: cfg.reviewModel,
      effort: cfg.reviewEffort,
      contextMode: cfg.context,
    });
    const hit = store.cacheGet(key);
    if (hit) cachedFindings.push(...hit);
    else toReview.push(context);
  }
  log.stage({
    stage: 'cache',
    reused: selection.contexts.length - toReview.length,
    toReview: toReview.length,
  });

  // ---- review -------------------------------------------------------------
  const systemBlocks = buildSystemBlocks(ruleResult.rules);
  const rawFindings: Finding[] = [...cachedFindings];
  const reviewedPaths = selection.contexts
    .filter((context) => !toReview.includes(context))
    .map((context) => context.file.path);

  if (toReview.length > 0) {
    let systemTokens = 0;
    try {
      systemTokens = await runner.countSystem(systemBlocks);
    } catch (err) {
      fail('review:count', message(err), 'interrupted');
      systemTokens = 0;
    }

    const contextWindowTokens = Math.floor(
      contextWindow(cfg.reviewModel) * cfg.inputBudgetRatio,
    );

    try {
      const plan = await timed('review:plan', () =>
        planBatches(toReview, {
          counter: runner,
          systemTokens,
          budgetTokens: contextWindowTokens,
          maxFilesPerBatch: cfg.maxFilesPerBatch,
          concurrency: cfg.concurrency,
        }),
      );

      for (const shedFile of plan.shed) {
        skipped.push({ path: shedFile.path, reason: shedFile.detail });
        fail('review:plan', `${shedFile.path} could not be batched: ${shedFile.detail}`);
      }
      for (const entry of plan.degraded) {
        degrade(`context-reduced:${entry.path} -> ${entry.to}`);
      }
      log.stage({
        stage: 'review:plan',
        batches: plan.batches.length,
        shed: plan.shed.length,
        systemTokens,
      });

      // Held on an object so the assignment inside the worker is visible to
      // the checker after the pool drains.
      const control: { halted: string | null } = { halted: null };
      const outcomes = await mapPool(plan.batches, cfg.concurrency, async (batch) => {
        if (control.halted !== null) return null;
        try {
          return await runner.reviewBatch(batch, systemBlocks, changeSet);
        } catch (err) {
          if (err instanceof BudgetExceededError || err instanceof DeadlineExceededError) {
            control.halted = message(err);
            return null;
          }
          throw err;
        }
      });

      if (control.halted !== null) {
        fail('review', control.halted, 'partial');
        degrade('run-halted-early');
      }

      let succeeded = 0;
      for (let index = 0; index < outcomes.length; index += 1) {
        const outcome = outcomes[index];
        const batch = plan.batches[index]!;
        if (!outcome) {
          for (const context of batch.files) {
            skipped.push({ path: context.file.path, reason: 'not reviewed: run halted early' });
          }
          continue;
        }
        if (!outcome.ok) {
          fail('review', `batch ${outcome.index} failed: ${outcome.error}`);
          if (outcome.refused) degrade('model-refusal');
          for (const context of batch.files) {
            skipped.push({ path: context.file.path, reason: `not reviewed: ${outcome.error}` });
          }
          continue;
        }

        succeeded += 1;
        rawFindings.push(...outcome.findings);

        // Cache per file, content-addressed — never by path alone.
        for (const context of batch.files) {
          reviewedPaths.push(context.file.path);
          const key = fileCacheKey({
            contentHash: context.file.contentHash,
            rulesHash: ruleResult.rulesHash,
            promptVersion: cfg.promptVersion,
            model: cfg.reviewModel,
            effort: cfg.reviewEffort,
            contextMode: cfg.context,
          });
          store.cachePut(
            key,
            outcome.findings.filter((finding) => finding.path === context.file.path),
          );
        }
      }

      if (succeeded === 0 && plan.batches.length > 0) {
        status = worst(status, 'interrupted');
      }
    } catch (err) {
      if (err instanceof BudgetExceededError || err instanceof DeadlineExceededError) {
        fail('review', message(err), 'partial');
      } else {
        fail('review', message(err), 'interrupted');
      }
    }
  }

  for (const entry of runner.degradations) degrade(entry);

  // ---- gate 1: deterministic verification ---------------------------------
  const verified = verifyFindings(changeSet, rawFindings, {
    confidenceThreshold: cfg.confidenceThreshold,
  });
  log.stage({
    stage: 'verify',
    kept: verified.kept.length,
    dropped: verified.dropped.length,
  });

  // ---- gate 2: the judge ---------------------------------------------------
  let kept = verified.kept;
  const dropped = [...verified.dropped];

  const judge = cfg.judge === 'on' ? (opts.judge ?? selectJudge(cfg, runner)) : null;

  if (judge && kept.length > 0) {
    try {
      const judged = await timed('judge', () =>
        judgeFindings(kept, changeSet, ruleResult.rules, judge, cfg.concurrency),
      );
      kept = judged.kept;
      dropped.push(...judged.dropped);
      if (judged.failedOpen) {
        status = worst(status, 'partial');
        degrade('judge-failed-open');
      }
      log.stage({
        stage: 'judge',
        backend: judge.name,
        kept: judged.kept.length,
        dropped: judged.dropped.length,
        errors: judged.errors,
        costUsd: judge.usage.costUsd,
      });
    } catch (err) {
      fail('judge', message(err));
      degrade('judge-skipped');
    }
  }

  // ---- publish ------------------------------------------------------------
  const scope = {
    platform: changeSet.platform,
    projectId: changeSet.projectId,
    requestId: changeSet.requestId,
  };
  const publishOptions = { platform, store, scope, changeSet, dryRun: cfg.dryRun };

  let posted: Finding[] = kept;
  try {
    const report = await timed('publish', () => publishFindings(kept, publishOptions));
    posted = [...report.posted, ...report.skippedAsUnchanged];
    if (report.fallbacks > 0) degrade(`inline-position-fallbacks:${report.fallbacks}`);
    for (const failure of report.failures) {
      fail('publish', `${failure.fingerprint}: ${failure.message}`);
    }
    log.stage({
      stage: 'publish',
      posted: report.posted.length,
      unchanged: report.skippedAsUnchanged.length,
      resolved: report.resolved.length,
      failures: report.failures.length,
    });
  } catch (err) {
    fail('publish', message(err));
  }

  const result = finish({
    runId,
    cfg,
    changeSet,
    status,
    errors,
    degradations: [...degradations],
    posted,
    dropped,
    reviewedPaths: [...new Set(reviewedPaths)],
    skipped,
    // The judge may run on a separate backend with its own bill; a Claude
    // judge reports zero here because the runner already counted it.
    costUsd: runner.usage.costUsd + (judge?.usage.costUsd ?? 0),
    started,
    rulesHash: ruleResult.rulesHash,
    judgeModel: judge?.name ?? null,
    store,
  });

  await postSummary(result, changeSet, { platform, store, cfg }).catch((err) =>
    log.warn('summary post failed', { error: message(err) }),
  );

  return result;
}

async function postSummary(
  result: RunResult,
  changeSet: ChangeSet,
  deps: { platform: Platform; store: Store; cfg: Config },
): Promise<void> {
  const body = renderSummary(result, changeSet);
  if (deps.cfg.dryRun) {
    log.info('summary (dry run)', {});
    process.stdout.write(`\n${body}\n`);
    return;
  }
  const outcome = await upsertSummary(body, {
    platform: deps.platform,
    store: deps.store,
    scope: {
      platform: changeSet.platform,
      projectId: changeSet.projectId,
      requestId: changeSet.requestId,
    },
    changeSet,
    dryRun: false,
  });
  if (outcome.error) log.warn('summary upsert failed', { error: outcome.error });
}

interface FinishInput {
  runId: string;
  cfg: Config;
  changeSet: ChangeSet | null;
  status: RunStatus;
  errors: StageError[];
  degradations: string[];
  posted: Finding[];
  dropped: Finding[];
  reviewedPaths: string[];
  skipped: { path: string; reason: string }[];
  costUsd: number;
  started: number;
  rulesHash: string;
  judgeModel: string | null;
  store: Store;
}

function finish(input: FinishInput): RunResult {
  const result: RunResult = {
    runId: input.runId,
    status: input.status,
    platform: input.cfg.platform,
    projectId: input.changeSet?.projectId ?? input.cfg.projectId,
    requestId: input.changeSet?.requestId ?? input.cfg.requestId,
    headSha: input.changeSet?.headSha ?? '',
    model: input.cfg.reviewModel,
    judgeModel: input.judgeModel,
    promptVersion: input.cfg.promptVersion,
    rulesHash: input.rulesHash,
    filesReviewed: input.reviewedPaths,
    filesSkipped: input.skipped,
    findingsPosted: input.posted,
    findingsDropped: input.dropped,
    degradations: input.degradations,
    costUsd: input.costUsd,
    durationMs: Math.round(performance.now() - input.started),
    errors: input.errors,
  };
  input.store.saveRun(result);
  return result;
}

/**
 * Gate two's backend, chosen from the model id.
 *
 * A decision model answers the four gate conditions directly and returns
 * calibrated probabilities; a generative model answers in prose. Both satisfy
 * `Judge`, and which one ran is recorded on the run.
 */
export function selectJudge(cfg: Config, runner: Reviewer): Judge {
  if (isJevModel(cfg.judgeModel)) {
    return new JevJudge({
      model: cfg.judgeModel,
      apiKey: cfg.jev.apiKey ?? '',
      endpoint: cfg.jev.endpoint,
    });
  }
  return new ClaudeJudge(runner, cfg.judgeModel);
}

const ORDER: Record<RunStatus, number> = {
  completed: 0,
  partial: 1,
  interrupted: 2,
  failed: 3,
};

export function worst(a: RunStatus, b: RunStatus): RunStatus {
  return ORDER[a] >= ORDER[b] ? a : b;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
