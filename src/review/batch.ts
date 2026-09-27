/**
 * Batch planning against *real* token counts.
 *
 * `chars × 0.25` is not a token count, and a budget built on it does not hold.
 * Every section here is measured with `messages.countTokens` for the model
 * that will actually run, and the plan is asserted afterwards: every file
 * appears in exactly one batch, or the run fails rather than quietly
 * reviewing a file twice or not at all.
 */

import type { Batch, FileContext, SkipReason } from '../types.ts';
import { renderFileSection } from './prompt.ts';
import { renderSymbolOutline } from '../diff/render.ts';
import { analyze } from '../context/parse.ts';
import { mapPool } from '../pool.ts';

export interface TokenCounter {
  count(text: string): Promise<number>;
}

export interface PlanOptions {
  counter: TokenCounter;
  /** Tokens already consumed by the system prompt and rules. */
  systemTokens: number;
  /** Ceiling for one request's input. */
  budgetTokens: number;
  maxFilesPerBatch: number;
  /** Bounded concurrency for the counting pass. */
  concurrency?: number;
}

export interface BatchPlan {
  batches: Batch[];
  /** Files that could not be made to fit, with the reason. Never silent. */
  shed: { path: string; reason: SkipReason; detail: string }[];
  /** Files whose context was reduced to make them fit. */
  degraded: { path: string; to: string }[];
}

/** Progressive degradation: ripple first, then the head body, then nothing left. */
export function degrade(context: FileContext, level: 1 | 2): FileContext {
  if (level === 1) return { ...context, ripple: [] };

  let outline = context.symbolOutline;
  if (!outline && context.file.headContent) {
    const analysis = analyze(context.file.language, context.file.headContent);
    outline = renderSymbolOutline(
      analysis.exports.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.startLine,
      })),
    );
  }
  return { ...context, ripple: [], numberedHeadContent: null, symbolOutline: outline };
}

export async function planBatches(
  contexts: readonly FileContext[],
  opts: PlanOptions,
): Promise<BatchPlan> {
  const perRequestBudget = Math.max(1_000, opts.budgetTokens - opts.systemTokens);
  const shed: BatchPlan['shed'] = [];
  const degraded: BatchPlan['degraded'] = [];

  // 1. Measure every section, degrading any that cannot fit on its own.
  const measured = await mapPool(contexts, opts.concurrency ?? 4, async (context) => {
    let candidate = context;
    let tokens = await opts.counter.count(renderFileSection(candidate));

    if (tokens > perRequestBudget) {
      candidate = degrade(context, 1);
      tokens = await opts.counter.count(renderFileSection(candidate));
      if (tokens <= perRequestBudget) degraded.push({ path: context.file.path, to: 'diff+file' });
    }
    if (tokens > perRequestBudget) {
      candidate = degrade(context, 2);
      tokens = await opts.counter.count(renderFileSection(candidate));
      if (tokens <= perRequestBudget) degraded.push({ path: context.file.path, to: 'diff+outline' });
    }
    if (tokens > perRequestBudget) {
      return { context, tokens, fits: false as const };
    }
    return { context: candidate, tokens, fits: true as const };
  });

  const fitting: { context: FileContext; tokens: number }[] = [];
  for (const entry of measured) {
    if (!entry.fits) {
      shed.push({
        path: entry.context.file.path,
        reason: 'too-large',
        detail: `diff alone is ${entry.tokens} tokens, over the ${perRequestBudget} token per-request budget`,
      });
      continue;
    }
    fitting.push({ context: entry.context, tokens: entry.tokens });
  }

  // 2. Greedy, largest-first packing under both caps.
  fitting.sort((a, b) => b.tokens - a.tokens);

  const batches: Batch[] = [];
  for (const entry of fitting) {
    const target = batches.find(
      (batch) =>
        batch.files.length < opts.maxFilesPerBatch &&
        batch.estimatedInputTokens + entry.tokens <= perRequestBudget,
    );
    if (target) {
      target.files.push(entry.context);
      target.estimatedInputTokens += entry.tokens;
    } else {
      batches.push({
        index: batches.length,
        files: [entry.context],
        estimatedInputTokens: opts.systemTokens + entry.tokens,
      });
    }
  }
  batches.forEach((batch, index) => {
    batch.index = index;
  });

  assertCoverage(contexts, batches, shed);
  return { batches, shed, degraded };
}

export class CoverageError extends Error {}

/** Every non-shed file in exactly one batch, or the run fails here. */
export function assertCoverage(
  contexts: readonly FileContext[],
  batches: readonly Batch[],
  shed: readonly { path: string }[],
): void {
  const shedPaths = new Set(shed.map((entry) => entry.path));
  const counts = new Map<string, number>();
  for (const batch of batches) {
    for (const context of batch.files) {
      counts.set(context.file.path, (counts.get(context.file.path) ?? 0) + 1);
    }
  }

  const missing: string[] = [];
  const duplicated: string[] = [];
  for (const context of contexts) {
    const path = context.file.path;
    const seen = counts.get(path) ?? 0;
    if (shedPaths.has(path)) {
      if (seen > 0) duplicated.push(`${path} (shed but still batched)`);
      continue;
    }
    if (seen === 0) missing.push(path);
    if (seen > 1) duplicated.push(`${path} (x${seen})`);
  }

  const extra = [...counts.keys()].filter(
    (path) => !contexts.some((context) => context.file.path === path),
  );

  if (missing.length || duplicated.length || extra.length) {
    throw new CoverageError(
      [
        'batch coverage assertion failed',
        missing.length ? `not batched: ${missing.join(', ')}` : '',
        duplicated.length ? `batched more than once: ${duplicated.join(', ')}` : '',
        extra.length ? `batched but not in the change set: ${extra.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    );
  }
}
