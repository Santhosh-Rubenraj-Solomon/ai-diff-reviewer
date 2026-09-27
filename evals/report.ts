/**
 * Report rendering. `bun run evals:report <file.json>` re-renders a saved run,
 * so a committed report can be read without re-spending on the model.
 */

import { readFile } from 'node:fs/promises';
import type { CaseScore, Metrics } from './score.ts';
import { TARGETS, aggregate } from './score.ts';

export interface EvalReport {
  createdAt: string;
  variant: {
    reviewer: string;
    model: string;
    judge: string;
    effort: string;
    context: string;
    promptVersion: string;
    matcher: string;
    mode: string;
  };
  scores: CaseScore[];
}

function pct(value: number | null): string {
  return value === null ? '   n/a' : `${(value * 100).toFixed(1).padStart(5, ' ')}%`;
}

function verdict(ok: boolean): string {
  return ok ? 'pass' : 'MISS';
}

export function renderMetrics(label: string, metrics: Metrics): string {
  const lines = [
    `${label} (${metrics.cases} cases)`,
    `  recall, injected bugs   ${pct(metrics.recallInjected)}   target >= ${(TARGETS.recallInjected * 100).toFixed(0)}%   ${
      metrics.recallInjected === null ? '' : verdict(metrics.recallInjected >= TARGETS.recallInjected)
    }`,
    `  recall, all expected    ${pct(metrics.recallAll)}`,
    `  precision (lower bound) ${pct(metrics.precisionStrict)}   target >= ${(TARGETS.precisionStrict * 100).toFixed(0)}%   ${
      metrics.precisionStrict === null ? '' : verdict(metrics.precisionStrict >= TARGETS.precisionStrict)
    }`,
    `  noise per case          ${metrics.noisePerCase.toFixed(2).padStart(6, ' ')}    target <= ${TARGETS.noisePerCase}       ${verdict(metrics.noisePerCase <= TARGETS.noisePerCase)}`,
    `  findings per case       ${metrics.findingsPerCase.toFixed(2).padStart(6, ' ')}`,
    `  cost per case p50/p90   $${metrics.costPerCaseP50.toFixed(4)} / $${metrics.costPerCaseP90.toFixed(4)}   target p90 <= $${TARGETS.costPerCase.toFixed(2)}   ${verdict(metrics.costPerCaseP90 <= TARGETS.costPerCase)}`,
    `  latency p50/p90         ${(metrics.latencyP50Ms / 1000).toFixed(1)}s / ${(metrics.latencyP90Ms / 1000).toFixed(1)}s   target p90 <= ${TARGETS.latencyP90Ms / 1000}s   ${verdict(metrics.latencyP90Ms <= TARGETS.latencyP90Ms)}`,
  ];
  return lines.join('\n');
}

export function renderReport(report: EvalReport): string {
  const train = report.scores.filter((score) => score.split === 'train');
  const holdout = report.scores.filter((score) => score.split === 'holdout');

  const out: string[] = [
    '',
    '='.repeat(72),
    `aidr eval report — ${report.createdAt}`,
    `variant: reviewer=${report.variant.reviewer} model=${report.variant.model} judge=${report.variant.judge}`,
    `         effort=${report.variant.effort} context=${report.variant.context} prompt=${report.variant.promptVersion}`,
    `         matcher=${report.variant.matcher} mode=${report.variant.mode}`,
    '='.repeat(72),
    '',
    ...(report.variant.reviewer === 'stub'
      ? [
          'NOTE: the stub reviewer returns each case\'s hardcoded findings. These',
          'numbers exercise the harness and the scoring path; they do not measure',
          'the reviewer. Run --reviewer=model for a real measurement.',
          '',
        ]
      : []),
    renderMetrics('TRAIN  (tune here)', aggregate(train)),
    '',
    renderMetrics('HOLDOUT (report here)', aggregate(holdout)),
    '',
    'Per case:',
  ];

  for (const score of [...report.scores].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
    const status =
      score.expectedTotal === 0
        ? score.postedTotal === 0
          ? 'clean'
          : `${score.postedTotal} finding(s)`
        : `${score.matched.length}/${score.expectedTotal} found`;
    out.push(
      `  ${score.split.padEnd(8)} ${score.caseId.padEnd(40)} ${status.padEnd(16)}` +
        `${score.noise.length ? ` noise=${score.noise.length}` : ''}`,
    );
    for (const missed of score.missed) {
      out.push(`      missed  ${missed.path}:${missed.line} — ${missed.description}`);
    }
    for (const entry of score.noise) {
      out.push(`      noise   ${entry.finding.path}:${entry.finding.line} — ${entry.why}`);
    }
  }

  out.push('');
  return out.join('\n');
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: bun run evals/report.ts <report.json>\n');
    process.exit(1);
  }
  const report = JSON.parse(await readFile(file, 'utf8')) as EvalReport;
  process.stdout.write(renderReport(report));
}
