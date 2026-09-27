/**
 * One pricing table, in one place, with a date on it.
 *
 * An unknown model does not silently cost $0 — `priceUsd` returns `null` and
 * the caller records a `pricing-unknown:<model>` degradation on the run.
 */

import type { UsageTotals } from '../types.ts';

/** USD per million tokens. Verified against platform.claude.com on this date. */
export const PRICING_AS_OF = '2026-09-27';

interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Context window, used by the batch packer. */
  contextTokens: number;
}

export const PRICING: Record<string, ModelPrice> = {
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50, contextTokens: 1_000_000 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, contextTokens: 1_000_000 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, contextTokens: 1_000_000 },
  // Sonnet 5 introductory pricing ($2/$10) ended 2026-08-31; standard rate applies.
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, contextTokens: 1_000_000 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, contextTokens: 200_000 },
};

/** Cache reads bill at ~0.1x input; 5-minute cache writes at ~1.25x input. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function contextWindow(model: string): number {
  return PRICING[model]?.contextTokens ?? 200_000;
}

export function isPriced(model: string): boolean {
  return model in PRICING;
}

/**
 * Returns the USD cost of one call, or null when the model is not in the table.
 * Null is a signal to record a degradation, not a licence to bill zero.
 */
export function priceUsd(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  },
): number | null {
  const price = PRICING[model];
  if (!price) return null;
  const m = 1_000_000;
  return (
    (usage.inputTokens / m) * price.inputPerMTok +
    (usage.outputTokens / m) * price.outputPerMTok +
    ((usage.cacheReadInputTokens ?? 0) / m) * price.inputPerMTok * CACHE_READ_MULTIPLIER +
    ((usage.cacheCreationInputTokens ?? 0) / m) * price.inputPerMTok * CACHE_WRITE_MULTIPLIER
  );
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
  };
}

export function addUsage(total: UsageTotals, next: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: total.inputTokens + (next.inputTokens ?? 0),
    outputTokens: total.outputTokens + (next.outputTokens ?? 0),
    cacheReadInputTokens: total.cacheReadInputTokens + (next.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      total.cacheCreationInputTokens + (next.cacheCreationInputTokens ?? 0),
    costUsd: total.costUsd + (next.costUsd ?? 0),
  };
}
