/**
 * Gate 2 — the judge, which gets the code.
 *
 * A validator that only sees the finding can check that evidence *looks* like
 * evidence. This one is handed the surrounding hunk and the text of any rule
 * the finding cites, so a rule-backed finding cannot be thrown out as "generic
 * advice" by a stage that never saw the rule.
 *
 * The gate is a structured request, not a rendered prompt, so the backend can
 * be a generative model (`ClaudeJudge`) or a decision model (`JevJudge`) — the
 * two answer the same question by very different means.
 *
 * Error policy, stated once and recorded on the run: fail closed (drop) below
 * `high`, fail open (keep, run marked partial) at `high` and `critical`.
 */

import type { ChangeSet, Finding, Rule, UsageTotals } from '../types.ts';
import { lineSlice } from '../diff/render.ts';
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from './prompt.ts';
import { emptyUsage } from './pricing.ts';
import { mapPool } from '../pool.ts';
import { log } from '../logger.ts';

export const JUDGE_CONTEXT_RADIUS = 20;

/** Everything the decision depends on, independent of how it is asked. */
export interface JudgeRequest {
  finding: Finding;
  /** The finding's line plus JUDGE_CONTEXT_RADIUS either side, numbered. */
  hunkWithContext: string;
  /** Bodies of the project rules this finding cites. */
  ruleBodies: string[];
}

export interface JudgeVerdict {
  verdict: 'keep' | 'drop';
  reason: string;
  /**
   * Present only when the backend reports a calibrated probability. The review
   * model's own `confidence` is self-reported and is not this.
   */
  calibratedConfidence?: number;
}

export interface Judge {
  /** Model id, recorded on the run so a verdict can be explained later. */
  readonly name: string;
  /** Cost this backend incurred. Zero when another component accounts for it. */
  readonly usage: UsageTotals;
  judge(request: JudgeRequest): Promise<JudgeVerdict | null>;
}

/** The low-level prompt call a generative backend exposes. */
export interface PromptJudgeBackend {
  judgeFinding(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ verdict: 'keep' | 'drop'; reason: string } | null>;
}

/**
 * Claude as the judge. Usage stays at zero here because the `ReviewRunner` that
 * makes the call already accounts for it — double counting would inflate the
 * cost line on every summary.
 */
export class ClaudeJudge implements Judge {
  readonly usage: UsageTotals = emptyUsage();

  constructor(
    private readonly backend: PromptJudgeBackend,
    readonly name: string,
  ) {}

  async judge(request: JudgeRequest): Promise<JudgeVerdict | null> {
    const prompt = buildJudgePrompt({
      path: request.finding.path,
      line: request.finding.line,
      severity: request.finding.severity,
      title: request.finding.title,
      body: request.finding.body,
      evidence: request.finding.evidence,
      hunkWithContext: request.hunkWithContext,
      ruleBodies: request.ruleBodies,
    });

    const verdict = await this.backend.judgeFinding(JUDGE_SYSTEM_PROMPT, prompt);
    return verdict ? { verdict: verdict.verdict, reason: `judge: ${verdict.reason}` } : null;
  }
}

export interface JudgeResult {
  kept: Finding[];
  dropped: Finding[];
  /** True when at least one high/critical finding survived on the fail-open path. */
  failedOpen: boolean;
  errors: number;
}

export function buildJudgeRequest(
  finding: Finding,
  headContent: string,
  rules: readonly Rule[],
): JudgeRequest {
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  return {
    finding,
    hunkWithContext: lineSlice(headContent, finding.line, JUDGE_CONTEXT_RADIUS),
    ruleBodies: finding.ruleIds
      .map((id) => ruleById.get(id))
      .filter((rule): rule is Rule => rule !== undefined)
      .map((rule) => `Rule \`${rule.id}\`:\n${rule.body}`),
  };
}

export async function judgeFindings(
  findings: readonly Finding[],
  changeSet: ChangeSet,
  rules: readonly Rule[],
  judge: Judge,
  concurrency: number,
): Promise<JudgeResult> {
  if (findings.length === 0) {
    return { kept: [], dropped: [], failedOpen: false, errors: 0 };
  }

  const byPath = new Map(changeSet.files.map((file) => [file.path, file]));

  const verdicts = await mapPool(findings, concurrency, async (finding) => {
    const headContent = byPath.get(finding.path)?.headContent ?? null;
    if (headContent === null) {
      return { finding, outcome: 'error' as const, reason: 'no head content to judge against' };
    }

    const verdict = await judge.judge(buildJudgeRequest(finding, headContent, rules));
    if (!verdict) return { finding, outcome: 'error' as const, reason: 'judge call failed' };

    return {
      finding:
        verdict.calibratedConfidence === undefined
          ? finding
          : { ...finding, calibratedConfidence: verdict.calibratedConfidence },
      outcome: verdict.verdict === 'keep' ? ('keep' as const) : ('drop' as const),
      reason: verdict.reason,
    };
  });

  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  let failedOpen = false;
  let errors = 0;

  for (const entry of verdicts) {
    if (entry.outcome === 'keep') {
      kept.push(entry.finding);
      continue;
    }
    if (entry.outcome === 'drop') {
      dropped.push({ ...entry.finding, verdict: 'dropped', dropReason: entry.reason });
      continue;
    }

    errors += 1;
    const severe = entry.finding.severity === 'critical' || entry.finding.severity === 'high';
    if (severe) {
      failedOpen = true;
      log.warn('judge failed open', { path: entry.finding.path, severity: entry.finding.severity });
      kept.push(entry.finding);
    } else {
      dropped.push({
        ...entry.finding,
        verdict: 'dropped',
        dropReason: `judge unavailable; failed closed below high severity (${entry.reason})`,
      });
    }
  }

  return { kept, dropped, failedOpen, errors };
}
