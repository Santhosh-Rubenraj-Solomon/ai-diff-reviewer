/**
 * Jev (TypeSafe "System One") as the second gate.
 *
 * Jev cannot generate text, so it cannot do the review pass. What it can do is
 * answer bounded questions with calibrated probabilities in one round trip,
 * which is exactly the shape of gate two: is this finding real, is it about the
 * changed lines, is it specific, is it worth a developer's attention.
 *
 * Three things this buys over a prose verdict:
 *   - four independent signals instead of one opaque keep/drop, so a drop names
 *     the condition that failed;
 *   - probabilities that are calibrated by construction rather than
 *     self-reported by the model being judged;
 *   - a state object rather than a rendered prompt — the model selects from a
 *     fixed schema, so text inside the diff has no instruction channel to
 *     hijack.
 *
 * What it costs: no natural-language rationale. `dropReason` is synthesised
 * from the failing condition and its probability instead.
 *
 * Request and response shapes follow TypeSafe's documented `noul` / `choice` /
 * `score` primitives. The endpoint is configurable because the model is
 * reachable three ways (TypeSafe direct, OpenRouter, Cloudflare) and it is in
 * early access.
 */

import type { UsageTotals } from '../types.ts';
import { httpJson, PlatformError, type HttpOptions } from '../platform/http.ts';
import { addUsage, emptyUsage, priceUsd } from './pricing.ts';
import { log } from '../logger.ts';
import type { Judge, JudgeRequest, JudgeVerdict } from './judge.ts';

export interface JevThresholds {
  /** Minimum probability that the defect is real in the code as shown. */
  real: number;
  /** Minimum probability that it concerns the changed lines. */
  changed: number;
  /** Minimum probability that it names a concrete failure. */
  specific: number;
  /** Minimum position on the 0..2 action rubric. */
  action: number;
}

export const DEFAULT_JEV_THRESHOLDS: JevThresholds = {
  real: 0.6,
  changed: 0.6,
  specific: 0.5,
  // The rubric is ['dismiss', 'worth a comment', 'must fix']; 0.75 requires a
  // finding to sit meaningfully past "dismiss" rather than merely lean that way.
  action: 0.75,
};

export interface JevOptions {
  model: string;
  apiKey: string;
  /** Full URL of the decisions endpoint. */
  endpoint: string;
  thresholds?: JevThresholds;
  /** Rule bodies are truncated to this many characters each (32k context). */
  ruleCharBudget?: number;
}

interface NoulAnswer {
  type: 'noul';
  noul: number;
}

interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence?: number;
  legend?: Record<string, unknown>;
  probabilities?: Record<string, number>;
}

type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

interface JevResponse {
  id: string;
  model: string;
  provider?: string;
  answers: Record<string, JevAnswer | undefined>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

const ACTION_RUBRIC = [
  'A competent engineer would dismiss this and move on.',
  'Worth a review comment, though it is not a blocker.',
  'Must be fixed before this change is merged.',
];

/** The questions gate two actually asks, one per condition. */
export function buildJevQuestions(): Record<string, unknown> {
  return {
    real: {
      type: 'noul',
      instructions: 'Is the described problem real in this code, exactly as shown?',
      criteria: {
        true: 'The code shown does have the described defect, and the quoted evidence supports it.',
        false:
          'The code shown does not have this defect, or the claim misreads what the code does.',
      },
    },
    changed: {
      type: 'noul',
      instructions:
        'Does the problem concern the lines this change touched, rather than pre-existing code?',
      criteria: {
        true: 'The defect is introduced by, or made reachable by, the changed lines.',
        false: 'The defect already existed in code this change did not touch.',
      },
    },
    specific: {
      type: 'noul',
      instructions:
        'Does the finding name a concrete failure, rather than a general best practice?',
      criteria: {
        true: 'It says what breaks, when, and what to do about it.',
        false: 'It is generic advice, a style preference, or a restatement of what the code does.',
      },
    },
    action: {
      type: 'score',
      instructions: 'How should a reviewer treat this finding?',
      criteria: ACTION_RUBRIC,
    },
  };
}

/** Everything the decision depends on, as data rather than as a prompt. */
export function buildJevState(request: JudgeRequest, ruleCharBudget: number): Record<string, unknown> {
  const { finding } = request;
  return {
    finding: {
      file: finding.path,
      line: finding.line,
      severity: finding.severity,
      category: finding.category,
      claim: finding.title,
      detail: finding.body,
      evidence: finding.evidence,
    },
    code_at_head: request.hunkWithContext,
    project_rules_cited: request.ruleBodies.map((body) =>
      body.length > ruleCharBudget ? `${body.slice(0, ruleCharBudget)}\n…[truncated]` : body,
    ),
  };
}

function noul(answers: JevResponse['answers'], key: string): number | null {
  const answer = answers[key];
  if (!answer || answer.type !== 'noul') return null;
  return typeof answer.noul === 'number' ? answer.noul : null;
}

function score(answers: JevResponse['answers'], key: string): number | null {
  const answer = answers[key];
  if (!answer || answer.type !== 'score') return null;
  return typeof answer.score === 'number' ? answer.score : null;
}

export interface JevDecision {
  verdict: 'keep' | 'drop';
  reason: string;
  /** The weakest of the three probabilities — a conservative summary. */
  calibratedConfidence: number;
}

/**
 * Turns four probabilities into one decision, deterministically.
 *
 * A dropped finding names the condition that failed and its probability, which
 * recovers most of what a prose reason gave us.
 */
export function decide(
  answers: JevResponse['answers'],
  thresholds: JevThresholds,
): JevDecision | null {
  const real = noul(answers, 'real');
  const changed = noul(answers, 'changed');
  const specific = noul(answers, 'specific');
  const action = score(answers, 'action');

  // A missing answer is a malformed response, not a silent "drop".
  if (real === null || changed === null || specific === null || action === null) return null;

  const failures: string[] = [];
  if (real < thresholds.real) failures.push(`not real in this code (real=${real.toFixed(2)})`);
  if (changed < thresholds.changed) {
    failures.push(`pre-existing rather than introduced here (changed=${changed.toFixed(2)})`);
  }
  if (specific < thresholds.specific) {
    failures.push(`generic rather than specific (specific=${specific.toFixed(2)})`);
  }
  if (action < thresholds.action) {
    failures.push(`below the action bar (action=${action.toFixed(2)} of 2)`);
  }

  const calibratedConfidence = Math.min(real, changed, specific);

  if (failures.length > 0) {
    return { verdict: 'drop', reason: `jev: ${failures.join('; ')}`, calibratedConfidence };
  }

  return {
    verdict: 'keep',
    reason: `jev: real=${real.toFixed(2)} changed=${changed.toFixed(2)} specific=${specific.toFixed(
      2,
    )} action=${action.toFixed(2)}`,
    calibratedConfidence,
  };
}

/** Transport seam, so the judge is testable without a network. */
export interface JevTransport {
  post(body: Record<string, unknown>): Promise<JevResponse>;
}

export function httpTransport(opts: JevOptions): JevTransport {
  const http: HttpOptions = {
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    // Jev answers in 70-500ms; a long timeout here would only hide a problem.
    timeoutMs: 15_000,
  };

  return {
    async post(body) {
      return await httpJson<JevResponse>(
        opts.endpoint,
        { method: 'POST', body: JSON.stringify(body) },
        http,
      );
    },
  };
}

export class JevJudge implements Judge {
  readonly name: string;
  readonly usage: UsageTotals = emptyUsage();

  private readonly thresholds: JevThresholds;
  private readonly ruleCharBudget: number;

  constructor(
    private readonly opts: JevOptions,
    private readonly transport: JevTransport = httpTransport(opts),
  ) {
    this.name = opts.model;
    this.thresholds = opts.thresholds ?? DEFAULT_JEV_THRESHOLDS;
    this.ruleCharBudget = opts.ruleCharBudget ?? 2_000;
  }

  async judge(request: JudgeRequest): Promise<JudgeVerdict | null> {
    let response: JevResponse;
    try {
      response = await this.transport.post({
        model: this.opts.model,
        state: buildJevState(request, this.ruleCharBudget),
        questions: buildJevQuestions(),
      });
    } catch (err) {
      const detail =
        err instanceof PlatformError ? `${err.status} ${err.message}` : String(err);
      log.warn('jev judge call failed', { path: request.finding.path, error: detail });
      return null;
    }

    this.recordUsage(response);

    const decision = decide(response.answers ?? {}, this.thresholds);
    if (!decision) {
      // In-schema output is guaranteed; a *missing* answer is not, and is a
      // failed call rather than a verdict.
      log.warn('jev returned an incomplete answer set', {
        path: request.finding.path,
        keys: Object.keys(response.answers ?? {}),
      });
      return null;
    }

    return {
      verdict: decision.verdict,
      reason: decision.reason,
      calibratedConfidence: decision.calibratedConfidence,
    };
  }

  private recordUsage(response: JevResponse): void {
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    // Jev reports the billed cost directly; fall back to the table if absent.
    const reported = response.usage?.cost;
    const cost =
      typeof reported === 'number'
        ? reported
        : (priceUsd(this.opts.model, { inputTokens, outputTokens }) ?? 0);

    Object.assign(
      this.usage,
      addUsage(this.usage, { inputTokens, outputTokens, costUsd: cost }),
    );
  }
}

/** True for any model id this backend should handle. */
export function isJevModel(model: string): boolean {
  return /^jev(-|$)/i.test(model) || model.toLowerCase().startsWith('typesafe/');
}
