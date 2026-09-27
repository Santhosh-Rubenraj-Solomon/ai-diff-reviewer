/**
 * Gate 2 — the judge, which gets the code.
 *
 * A validator that only sees the finding can check that evidence *looks* like
 * evidence. This one is handed the surrounding hunk and the text of any rule
 * the finding cites, so a rule-backed finding cannot be thrown out as "generic
 * advice" by a stage that never saw the rule.
 *
 * Error policy, stated once and recorded on the run: fail closed (drop) below
 * `high`, fail open (keep, run marked partial) at `high` and `critical`.
 */

import type { ChangeSet, Finding, Rule } from '../types.ts';
import { lineSlice } from '../diff/render.ts';
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from './prompt.ts';
import { mapPool } from '../pool.ts';
import { log } from '../logger.ts';

export const JUDGE_CONTEXT_RADIUS = 20;

export interface Judge {
  judgeFinding(systemPrompt: string, userPrompt: string): Promise<{ verdict: 'keep' | 'drop'; reason: string } | null>;
}

export interface JudgeResult {
  kept: Finding[];
  dropped: Finding[];
  /** True when at least one high/critical finding survived on the fail-open path. */
  failedOpen: boolean;
  errors: number;
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
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));

  const verdicts = await mapPool(findings, concurrency, async (finding) => {
    const file = byPath.get(finding.path);
    const headContent = file?.headContent ?? null;
    if (headContent === null) {
      return { finding, outcome: 'error' as const, reason: 'no head content to judge against' };
    }

    const prompt = buildJudgePrompt({
      path: finding.path,
      line: finding.line,
      severity: finding.severity,
      title: finding.title,
      body: finding.body,
      evidence: finding.evidence,
      hunkWithContext: lineSlice(headContent, finding.line, JUDGE_CONTEXT_RADIUS),
      ruleBodies: finding.ruleIds
        .map((id) => ruleById.get(id))
        .filter((rule): rule is Rule => rule !== undefined)
        .map((rule) => `Rule \`${rule.id}\`:\n${rule.body}`),
    });

    const verdict = await judge.judgeFinding(JUDGE_SYSTEM_PROMPT, prompt);
    if (!verdict) return { finding, outcome: 'error' as const, reason: 'judge call failed' };
    return {
      finding,
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
      dropped.push({ ...entry.finding, verdict: 'dropped', dropReason: `judge: ${entry.reason}` });
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
