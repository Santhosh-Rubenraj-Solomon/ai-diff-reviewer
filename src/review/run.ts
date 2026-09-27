/**
 * The model calls: batching, bounded concurrency, jittered retries, a run
 * deadline, a cost ceiling, and a content-addressed result cache.
 *
 * Failure semantics that matter:
 *   - `parsed_output === null` is a failed call, not "zero findings";
 *   - `stop_reason === 'refusal'` is handled explicitly and, if a fallback
 *     model is configured, recorded on the run rather than applied silently;
 *   - nothing here repairs JSON. There is no JSON to repair.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Batch, Finding, UsageTotals } from '../types.ts';
import type { Config } from '../config.ts';
import { log } from '../logger.ts';
import { addUsage, emptyUsage, priceUsd } from './pricing.ts';
import { ReviewSchema, VerdictSchema, clampFinding, type Verdict } from './schema.ts';
import { buildUserPrompt, type SystemBlock } from './prompt.ts';
import { withFingerprint } from '../publish/fingerprint.ts';
import { sha256 } from '../publish/fingerprint.ts';
import type { ChangeSet } from '../types.ts';
import type { TokenCounter } from './batch.ts';

export class BudgetExceededError extends Error {}
export class DeadlineExceededError extends Error {}

/** Structural view of the SDK's usage block — avoids pinning a type path. */
interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface BatchOutcome {
  index: number;
  findings: Finding[];
  ok: boolean;
  error?: string;
  refused?: boolean;
  servedBy: string;
}

/**
 * What the pipeline needs from a reviewer. `ReviewRunner` is the real one;
 * tests and the eval harness supply their own.
 */
export interface Reviewer extends TokenCounter {
  readonly usage: UsageTotals;
  readonly degradations: Set<string>;
  countSystem(blocks: SystemBlock[]): Promise<number>;
  reviewBatch(batch: Batch, blocks: SystemBlock[], changeSet: ChangeSet): Promise<BatchOutcome>;
  judgeFinding(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ verdict: 'keep' | 'drop'; reason: string } | null>;
}

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;

function isRetryable(err: unknown): boolean {
  return (
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionError ||
    err instanceof Anthropic.APIConnectionTimeoutError
  );
}

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function fileCacheKey(input: {
  contentHash: string;
  rulesHash: string;
  promptVersion: string;
  model: string;
  effort: string;
  contextMode: string;
}): string {
  return sha256(
    [
      input.contentHash,
      input.rulesHash,
      input.promptVersion,
      input.model,
      input.effort,
      input.contextMode,
    ].join('|'),
  );
}

export class ReviewRunner implements Reviewer {
  readonly usage: UsageTotals = emptyUsage();
  readonly degradations = new Set<string>();

  private readonly client: Anthropic;
  private readonly deadlineAt: number;

  constructor(
    private readonly cfg: Config,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
    this.deadlineAt = Date.now() + cfg.runDeadlineMs;
  }

  private checkLimits(): void {
    if (Date.now() > this.deadlineAt) {
      throw new DeadlineExceededError('run deadline reached; posting what survived');
    }
    if (this.usage.costUsd >= this.cfg.budgetUsd) {
      throw new BudgetExceededError(
        `cost ceiling of $${this.cfg.budgetUsd.toFixed(2)} reached; posting what survived`,
      );
    }
  }

  /** Real token counts, from the model that will actually run. */
  async count(text: string): Promise<number> {
    const response = await this.client.messages.countTokens({
      model: this.cfg.reviewModel,
      messages: [{ role: 'user', content: text }],
    });
    return response.input_tokens;
  }

  async countSystem(blocks: SystemBlock[]): Promise<number> {
    const response = await this.client.messages.countTokens({
      model: this.cfg.reviewModel,
      system: blocks.map((block) => ({ type: 'text' as const, text: block.text })),
      messages: [{ role: 'user', content: 'x' }],
    });
    return response.input_tokens;
  }

  private recordUsage(model: string, usage: RawUsage | undefined | null): void {
    if (!usage) return;
    const detail = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    };
    const cost = priceUsd(model, detail);
    if (cost === null) this.degradations.add(`pricing-unknown:${model}`);
    Object.assign(this.usage, addUsage(this.usage, { ...detail, costUsd: cost ?? 0 }));
  }

  private async withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      this.checkLimits();
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt === RETRY_ATTEMPTS) throw err;
        const delay = jitter(RETRY_BASE_MS * 2 ** (attempt - 1));
        log.warn('retrying model call', {
          label,
          attempt,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** One review call over one batch. Never throws for model-level failures. */
  async reviewBatch(
    batch: Batch,
    systemBlocks: SystemBlock[],
    changeSet: ChangeSet,
  ): Promise<BatchOutcome> {
    const userPrompt = buildUserPrompt(changeSet, batch.files);
    const models = [this.cfg.reviewModel, ...(this.cfg.fallbackModel ? [this.cfg.fallbackModel] : [])];

    let lastError: string | undefined;
    let refused = false;

    for (const model of models) {
      try {
        const response = await this.withRetries(`review:batch-${batch.index}`, () =>
          this.client.messages.parse({
            model,
            max_tokens: this.cfg.maxTokens,
            system: systemBlocks.map((block) => ({
              type: 'text' as const,
              text: block.text,
              ...(block.cache_control ? { cache_control: block.cache_control } : {}),
            })),
            messages: [{ role: 'user', content: userPrompt }],
            output_config: {
              format: zodOutputFormat(ReviewSchema),
              effort: this.cfg.reviewEffort,
            },
          }),
        );

        this.recordUsage(model, response.usage);

        if (response.stop_reason === 'refusal') {
          refused = true;
          lastError = `model declined the request (${response.stop_details?.category ?? 'unspecified'})`;
          log.warn('review call refused', { model, batch: batch.index, detail: lastError });
          continue; // try the fallback model, if one is configured
        }

        const parsed = response.parsed_output;
        if (!parsed) {
          // A schema miss is a failed call. It is not an empty review.
          lastError = 'response did not satisfy the output schema';
          log.warn('review call produced no parsed output', { model, batch: batch.index });
          continue;
        }

        if (model !== this.cfg.reviewModel) {
          this.degradations.add(`model-fallback:${this.cfg.reviewModel}->${model}`);
        }

        const findings = parsed.findings.map((raw) => withFingerprint({ ...clampFinding(raw) }));
        return { index: batch.index, findings, ok: true, servedBy: model, refused };
      } catch (err) {
        if (err instanceof BudgetExceededError || err instanceof DeadlineExceededError) throw err;
        lastError = err instanceof Error ? err.message : String(err);
        log.warn('review call failed', { model, batch: batch.index, error: lastError });
      }
    }

    return {
      index: batch.index,
      findings: [],
      ok: false,
      error: lastError ?? 'unknown failure',
      refused,
      servedBy: this.cfg.reviewModel,
    };
  }

  /** One finding, one call, on the cheaper model, with the code attached. */
  async judgeFinding(systemPrompt: string, userPrompt: string): Promise<Verdict | null> {
    try {
      const response = await this.withRetries('judge', () =>
        this.client.messages.parse({
          model: this.cfg.judgeModel,
          max_tokens: 2_000,
          system: [
            { type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } },
          ],
          messages: [{ role: 'user', content: userPrompt }],
          output_config: {
            format: zodOutputFormat(VerdictSchema),
            effort: this.cfg.judgeEffort,
          },
        }),
      );
      this.recordUsage(this.cfg.judgeModel, response.usage);
      if (response.stop_reason === 'refusal') return null;
      return response.parsed_output ?? null;
    } catch (err) {
      if (err instanceof BudgetExceededError || err instanceof DeadlineExceededError) throw err;
      log.warn('judge call failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}
