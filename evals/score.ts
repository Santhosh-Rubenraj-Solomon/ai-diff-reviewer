/**
 * Scoring.
 *
 * A finding matches an expectation when it is in the same file, within a few
 * lines, and says something recognisably similar. The text half is a token
 * overlap by default so the harness runs offline; `--match=llm` swaps in a
 * model-backed comparison for the cases where wording diverges.
 */

import type { Finding } from '../src/types.ts';
import type { EvalCase, Expected } from './case.ts';

export const LINE_TOLERANCE = 3;
export const OVERLAP_THRESHOLD = 0.2;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'not', 'no',
  'this', 'that', 'these', 'those', 'it', 'its', 'of', 'to', 'in', 'on', 'for', 'with',
  'as', 'at', 'by', 'from', 'into', 'so', 'can', 'will', 'would', 'should', 'now', 'then',
  'when', 'which', 'what', 'code', 'line', 'lines', 'you', 'your',
]);

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

/** Overlap coefficient — robust when one side is much shorter than the other. */
export function overlap(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

export interface TextMatcher {
  readonly name: string;
  similar(expected: string, finding: string): Promise<boolean>;
}

export const tokenMatcher: TextMatcher = {
  name: 'token-overlap',
  async similar(expected, finding) {
    return overlap(expected, finding) >= OVERLAP_THRESHOLD;
  },
};

export interface CaseScore {
  caseId: string;
  split: 'train' | 'holdout';
  expectedTotal: number;
  expectedInjected: number;
  matched: Expected[];
  matchedInjected: number;
  missed: Expected[];
  /** Findings that matched no expectation — a lower bound on false positives. */
  unmatched: Finding[];
  noise: { finding: Finding; why: string }[];
  postedTotal: number;
  costUsd: number;
  durationMs: number;
}

function isNoise(finding: Finding, evalCase: EvalCase): string | null {
  const haystack = `${finding.title}\n${finding.body}`.toLowerCase();
  for (const rule of evalCase.forbidden) {
    if (rule.path && rule.path !== finding.path) continue;
    const pattern = rule.match.startsWith('/') && rule.match.endsWith('/')
      ? new RegExp(rule.match.slice(1, -1), 'i')
      : null;
    const hit = pattern ? pattern.test(haystack) : haystack.includes(rule.match.toLowerCase());
    if (hit) return rule.why;
  }
  return null;
}

export async function scoreCase(
  evalCase: EvalCase,
  findings: readonly Finding[],
  opts: { matcher?: TextMatcher; costUsd: number; durationMs: number },
): Promise<CaseScore> {
  const matcher = opts.matcher ?? tokenMatcher;

  const matched: Expected[] = [];
  const missed: Expected[] = [];
  const claimed = new Set<Finding>();

  for (const expectation of evalCase.expected) {
    let hit: Finding | null = null;
    for (const finding of findings) {
      if (claimed.has(finding)) continue;
      if (finding.path !== expectation.path) continue;
      if (Math.abs(finding.line - expectation.line) > LINE_TOLERANCE) continue;
      const similar = await matcher.similar(
        expectation.description,
        `${finding.title} ${finding.body}`,
      );
      if (!similar) continue;
      hit = finding;
      break;
    }
    if (hit) {
      claimed.add(hit);
      matched.push(expectation);
    } else {
      missed.push(expectation);
    }
  }

  const noise: CaseScore['noise'] = [];
  for (const finding of findings) {
    const why = isNoise(finding, evalCase);
    if (why) noise.push({ finding, why });
  }

  return {
    caseId: evalCase.id,
    split: evalCase.split,
    expectedTotal: evalCase.expected.length,
    expectedInjected: evalCase.expected.filter((entry) => entry.injected).length,
    matched,
    matchedInjected: matched.filter((entry) => entry.injected).length,
    missed,
    unmatched: findings.filter((finding) => !claimed.has(finding)),
    noise,
    postedTotal: findings.length,
    costUsd: opts.costUsd,
    durationMs: opts.durationMs,
  };
}

export interface Metrics {
  cases: number;
  recallInjected: number | null;
  recallAll: number | null;
  /** Lower bound: unlabelled-but-plausible findings count against it. */
  precisionStrict: number | null;
  noisePerCase: number;
  costPerCaseP50: number;
  costPerCaseP90: number;
  latencyP50Ms: number;
  latencyP90Ms: number;
  findingsPerCase: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

export function aggregate(scores: readonly CaseScore[]): Metrics {
  const expectedInjected = scores.reduce((sum, score) => sum + score.expectedInjected, 0);
  const matchedInjected = scores.reduce((sum, score) => sum + score.matchedInjected, 0);
  const expectedAll = scores.reduce((sum, score) => sum + score.expectedTotal, 0);
  const matchedAll = scores.reduce((sum, score) => sum + score.matched.length, 0);
  const posted = scores.reduce((sum, score) => sum + score.postedTotal, 0);
  const noise = scores.reduce((sum, score) => sum + score.noise.length, 0);

  return {
    cases: scores.length,
    recallInjected: expectedInjected > 0 ? matchedInjected / expectedInjected : null,
    recallAll: expectedAll > 0 ? matchedAll / expectedAll : null,
    precisionStrict: posted > 0 ? matchedAll / posted : null,
    noisePerCase: scores.length > 0 ? noise / scores.length : 0,
    costPerCaseP50: percentile(scores.map((score) => score.costUsd), 50),
    costPerCaseP90: percentile(scores.map((score) => score.costUsd), 90),
    latencyP50Ms: percentile(scores.map((score) => score.durationMs), 50),
    latencyP90Ms: percentile(scores.map((score) => score.durationMs), 90),
    findingsPerCase: scores.length > 0 ? posted / scores.length : 0,
  };
}

export const TARGETS = {
  recallInjected: 0.6,
  precisionStrict: 0.7,
  noisePerCase: 1,
  costPerCase: 0.5,
  latencyP90Ms: 4 * 60 * 1000,
} as const;
