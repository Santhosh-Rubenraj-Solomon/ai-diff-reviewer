/**
 * Terminal renderer.
 *
 * Kept behind a plain function taking `ReviewResult` so a GitHub renderer can
 * be added later without touching the reviewer.
 */

import { describeTarget } from '../target.ts';
import type { ExcludedFile, Finding, ReviewResult, Severity } from '../types.ts';

const useColor =
  process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb' && Boolean(process.stdout.isTTY);

const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  yellow: paint('33'),
  blue: paint('34'),
  green: paint('32'),
  magenta: paint('35'),
  cyan: paint('36'),
};

const SEVERITY_ORDER: Record<Severity, number> = { bug: 0, risk: 1, nit: 2 };

const SEVERITY_LABEL: Record<Severity, string> = {
  bug: c.red('bug '),
  risk: c.yellow('risk'),
  nit: c.blue('nit '),
};

const EXCLUSION_LABEL: Record<ExcludedFile['reason'], string> = {
  binary: 'binary',
  lockfile: 'lockfile',
  generated: 'generated or vendored',
  oversized: 'over the size ceiling',
};

export interface RenderOptions {
  /** Show discarded findings and their refutations. */
  verbose: boolean;
}

/** Everything printed before the model is called. */
export function renderStatusLine(result: Pick<ReviewResult, 'target' | 'filesReviewed'>): string {
  const plural = result.filesReviewed === 1 ? 'file' : 'files';
  return `Reviewing ${c.bold(describeTarget(result.target))} — ${result.filesReviewed} ${plural}`;
}

export function render(result: ReviewResult, options: RenderOptions): string {
  const shown = result.findings.filter(
    (finding) => finding.verdict !== 'discarded' || options.verbose,
  );
  const survivors = result.findings.filter((finding) => finding.verdict !== 'discarded');
  const discarded = result.findings.length - survivors.length;

  const out: string[] = [''];

  if (shown.length === 0) {
    out.push(c.green('No findings.'));
    if (discarded > 0) {
      out.push(
        c.dim(
          `${discarded} candidate finding(s) did not survive verification. Re-run with --verbose to see them.`,
        ),
      );
    }
  } else {
    for (const [file, findings] of groupByFile(shown)) {
      out.push(c.bold(c.cyan(file)));
      for (const finding of findings) out.push(...renderFinding(finding));
      out.push('');
    }
  }

  out.push(...renderSummary(result, survivors, discarded, options));
  return out.join('\n');
}

function groupByFile(findings: Finding[]): Array<[string, Finding[]]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const bucket = groups.get(finding.file);
    if (bucket) bucket.push(finding);
    else groups.set(finding.file, [finding]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, group]) => [
      file,
      group.sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          (a.line ?? 0) - (b.line ?? 0),
      ),
    ]);
}

function renderFinding(finding: Finding): string[] {
  const location = finding.line === null ? 'file' : `:${finding.line}`;
  const flags: string[] = [];
  if (finding.verdict === 'unverified') flags.push(c.magenta('[unverified]'));
  if (finding.verdict === 'discarded') flags.push(c.dim('[discarded]'));

  const lines = [
    `  ${SEVERITY_LABEL[finding.severity]} ${c.dim(location)}  ${c.bold(finding.title)}${
      flags.length ? ` ${flags.join(' ')}` : ''
    }`,
  ];

  for (const line of wrap(finding.body, 88)) lines.push(`       ${line}`);

  if (finding.evidence) {
    for (const line of finding.evidence.split('\n').slice(0, 6)) {
      lines.push(c.dim(`       │ ${line}`));
    }
  }

  if (finding.historyBasis) {
    for (const [i, line] of wrap(finding.historyBasis, 84).entries()) {
      lines.push(c.dim(`       ${i === 0 ? 'history: ' : '         '}${line}`));
    }
  }

  if (finding.verdict !== 'survived' && finding.verdictReason) {
    for (const [i, line] of wrap(finding.verdictReason, 84).entries()) {
      lines.push(c.dim(`       ${i === 0 ? 'verdict: ' : '         '}${line}`));
    }
  }

  lines.push('');
  return lines;
}

function renderSummary(
  result: ReviewResult,
  survivors: Finding[],
  discarded: number,
  options: RenderOptions,
): string[] {
  const out: string[] = [];
  const counts = { bug: 0, risk: 0, nit: 0 } as Record<Severity, number>;
  for (const finding of survivors) counts[finding.severity]++;

  const parts = [
    counts.bug > 0 ? c.red(`${counts.bug} bug`) : null,
    counts.risk > 0 ? c.yellow(`${counts.risk} risk`) : null,
    counts.nit > 0 ? c.blue(`${counts.nit} nit`) : null,
  ].filter(Boolean);

  out.push(
    c.dim('─'.repeat(60)),
    `${parts.length > 0 ? parts.join(c.dim(' · ')) : c.green('clean')}` +
      c.dim(
        ` · ${result.chunksReviewed} chunk(s) reviewed · ${discarded} discarded by verification · ${result.verifyCallsUsed} verification call(s)`,
      ),
  );

  if (result.excluded.length > 0) {
    const summary = result.excluded
      .slice(0, options.verbose ? result.excluded.length : 5)
      .map((file) => `${file.path} (${EXCLUSION_LABEL[file.reason]})`);
    const hidden = result.excluded.length - summary.length;
    out.push(
      c.dim(
        `skipped ${result.excluded.length} file(s): ${summary.join(', ')}${
          hidden > 0 ? `, and ${hidden} more` : ''
        }`,
      ),
    );
  }

  for (const warning of result.warnings) {
    out.push(c.yellow(`! ${warning.stage}${warning.path ? ` ${warning.path}` : ''}: ${warning.message}`));
  }

  out.push('');
  return out;
}

/** Naive greedy wrap. Long unbreakable tokens are left to the terminal. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.length === 0) line = word;
      else if (line.length + word.length + 1 <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.filter((line, i, all) => line.length > 0 || i < all.length - 1);
}
