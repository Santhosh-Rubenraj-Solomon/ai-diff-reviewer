/**
 * Publishing, idempotently.
 *
 * Re-running on the same head SHA posts nothing new. Re-running after a push
 * posts what is new, resolves what was fixed, and edits the one summary
 * comment in place. Comment identity lives in SQLite keyed by fingerprint, so
 * a five-push merge request does not end with five copies of each comment.
 */

import type { ChangeSet, Finding, PostedRef, RunResult } from '../types.ts';
import type { Platform } from '../platform/types.ts';
import { Store, type Scope } from '../store/db.ts';
import { describeSkip } from '../diff/filter.ts';
import { log } from '../logger.ts';

export const FINDING_MARKER = (fingerprint: string): string => `<!-- aidr:finding:${fingerprint} -->`;
export const SUMMARY_MARKER = '<!-- aidr:summary -->';

/** Provider limits differ; this is comfortably under both. */
const MAX_BODY_CHARS = 60_000;

const SEVERITY_LABEL: Record<Finding['severity'], string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Removes the two things a comment body can do that a comment body should not:
 * trigger a GitLab quick action, and notify a person. Fenced code is left
 * alone — neither provider parses quick actions inside a code block, and
 * mangling `// comment` lines would make every review unreadable.
 */
export function neutralise(body: string): string {
  const lines = body.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      let safe = line.replace(/^\/([a-z])/, '&#47;$1');
      safe = safe.replace(/(^|[\s(])@([A-Za-z0-9][\w-]*)/g, '$1@\u200b$2');
      return safe;
    })
    .join('\n');
}

/** Splits on markdown boundaries, never inside a fenced code block. */
export function chunkMarkdown(body: string, max = MAX_BODY_CHARS): string[] {
  if (body.length <= max) return [body];

  const chunks: string[] = [];
  const lines = body.split('\n');
  let current: string[] = [];
  let length = 0;
  let inFence = false;

  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push(current.join('\n'));
    current = [];
    length = 0;
  };

  for (const line of lines) {
    const isFence = /^\s*```/.test(line);

    // A closing fence always stays with the block it closes, even if that
    // pushes the chunk over `max`. An oversized chunk is recoverable; a code
    // block split across two comments is not.
    if (isFence && inFence) {
      current.push(line);
      length += line.length + 1;
      inFence = false;
      continue;
    }

    if (!inFence && length + line.length + 1 > max && current.length > 0) flush();
    if (isFence) inFence = true;
    current.push(line);
    length += line.length + 1;
  }
  flush();

  return chunks.map((chunk, index) =>
    chunks.length > 1 ? `${chunk}\n\n<sub>part ${index + 1} of ${chunks.length}</sub>` : chunk,
  );
}

export function renderFindingBody(finding: Finding): string {
  const parts = [
    `**${SEVERITY_LABEL[finding.severity]} · ${finding.category}** — ${finding.title}`,
    '',
    finding.body,
  ];

  if (finding.suggestion) {
    parts.push('', '<details><summary>Suggested change</summary>', '', '```', finding.suggestion, '```', '', '</details>');
  }

  const meta: string[] = [`confidence ${finding.confidence.toFixed(2)}`];
  if (finding.ruleIds.length > 0) meta.push(`rules: ${finding.ruleIds.join(', ')}`);
  if (finding.lineCorrectedFrom !== undefined) {
    meta.push(`line corrected from ${finding.lineCorrectedFrom}`);
  }
  parts.push('', `<sub>${meta.join(' · ')} — posted by aidr</sub>`, FINDING_MARKER(finding.id));

  return neutralise(parts.join('\n'));
}

export function renderSummary(result: RunResult, changeSet: ChangeSet): string {
  const counts = new Map<Finding['severity'], number>();
  for (const finding of result.findingsPosted) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }

  const statusLine =
    result.status === 'completed'
      ? 'Review completed.'
      : result.status === 'partial'
        ? '**Review partial** — some work did not finish. Details below.'
        : result.status === 'interrupted'
          ? '**Review interrupted** — results are incomplete.'
          : '**Review failed.**';

  const severityLine =
    result.findingsPosted.length === 0
      ? 'No findings.'
      : (['critical', 'high', 'medium', 'low'] as const)
          .filter((severity) => counts.get(severity))
          .map((severity) => `${counts.get(severity)} ${severity}`)
          .join(' · ');

  const skipped = result.filesSkipped.length
    ? result.filesSkipped
        .map((entry) => `- \`${entry.path}\` — ${entry.reason}`)
        .join('\n')
    : '- none';

  const degradations = result.degradations.length
    ? result.degradations.map((entry) => `- ${entry}`).join('\n')
    : '- none';

  const errors = result.errors.length
    ? result.errors.map((entry) => `- \`${entry.stage}\`: ${entry.message}`).join('\n')
    : '- none';

  const body = [
    SUMMARY_MARKER,
    `### aidr — ${statusLine}`,
    '',
    `**Findings:** ${severityLine}`,
    `**Files reviewed:** ${result.filesReviewed.length} of ${result.filesReviewed.length + result.filesSkipped.length} changed`,
    `**Head:** \`${changeSet.headSha.slice(0, 10)}\``,
    '',
    '<details><summary>Files not reviewed</summary>',
    '',
    skipped,
    '',
    '</details>',
    '',
    '<details><summary>Run detail</summary>',
    '',
    `- model: \`${result.model}\` · prompt \`${result.promptVersion}\` · rules \`${result.rulesHash.slice(0, 8)}\``,
    `- cost: $${result.costUsd.toFixed(4)} · duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    `- findings dropped before posting: ${result.findingsDropped.length}`,
    `- run id: \`${result.runId}\``,
    '',
    '**Degradations**',
    degradations,
    '',
    '**Errors**',
    errors,
    '',
    '</details>',
  ].join('\n');

  return neutralise(body);
}

export interface PublishOptions {
  platform: Platform;
  store: Store;
  scope: Scope;
  changeSet: ChangeSet;
  dryRun: boolean;
}

export interface PublishReport {
  posted: Finding[];
  skippedAsUnchanged: Finding[];
  resolved: string[];
  failures: { fingerprint: string; message: string }[];
  fallbacks: number;
}

/** Posts new findings, resolves fixed ones, and reports every failure. */
export async function publishFindings(
  findings: readonly Finding[],
  opts: PublishOptions,
): Promise<PublishReport> {
  const report: PublishReport = {
    posted: [],
    skippedAsUnchanged: [],
    resolved: [],
    failures: [],
    fallbacks: 0,
  };

  const existing = new Map(
    opts.store.listComments(opts.scope).map((comment) => [comment.fingerprint, comment]),
  );

  for (const finding of findings) {
    const already = existing.get(finding.id);
    if (already && !already.resolved) {
      report.skippedAsUnchanged.push(finding);
      continue;
    }

    if (opts.dryRun) {
      report.posted.push(finding);
      continue;
    }

    const body = renderFindingBody(finding);
    const chunks = chunkMarkdown(body);

    let ref: PostedRef;
    try {
      ref = await opts.platform.postInline(finding, chunks[0]!, opts.changeSet);
    } catch (err) {
      // Position rejected (line outside the diff, file collapsed): say where
      // the finding belongs rather than dropping it on the floor.
      log.warn('inline position rejected; falling back to a general note', {
        path: finding.path,
        line: finding.line,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        ref = await opts.platform.postGeneralNote(
          `> Could not attach this to \`${finding.path}:${finding.line}\` inline.\n\n${chunks[0]!}`,
        );
        report.fallbacks += 1;
      } catch (fallbackErr) {
        report.failures.push({
          fingerprint: finding.id,
          message: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
        continue;
      }
    }

    for (const extra of chunks.slice(1)) {
      await opts.platform.postGeneralNote(extra).catch((err) => {
        report.failures.push({ fingerprint: finding.id, message: `continuation: ${String(err)}` });
      });
    }

    opts.store.putComment(opts.scope, {
      fingerprint: finding.id,
      commentId: ref.commentId,
      threadId: ref.threadId ?? null,
      fallback: ref.fallback,
      headSha: opts.changeSet.headSha,
      resolved: false,
    });
    report.posted.push(finding);
  }

  // Anything we posted before, for a file we reviewed again, that no longer
  // appears: the code was fixed. Resolve it rather than leaving it dangling.
  const live = new Set(findings.map((finding) => finding.id));
  const reviewedPaths = new Set(opts.changeSet.files.map((file) => file.path));
  for (const comment of existing.values()) {
    if (comment.resolved || live.has(comment.fingerprint)) continue;
    if (reviewedPaths.size === 0) continue;
    if (opts.dryRun) {
      report.resolved.push(comment.fingerprint);
      continue;
    }
    try {
      await opts.platform.resolveThread(
        { commentId: comment.commentId, threadId: comment.threadId ?? undefined, fallback: comment.fallback },
        `Fixed in \`${opts.changeSet.headSha.slice(0, 10)}\`.`,
      );
      opts.store.markResolved(opts.scope, comment.fingerprint);
      report.resolved.push(comment.fingerprint);
    } catch (err) {
      report.failures.push({
        fingerprint: comment.fingerprint,
        message: `resolve failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return report;
}

/** Exactly one summary comment, edited in place. */
export async function upsertSummary(
  body: string,
  opts: PublishOptions,
): Promise<{ commentId: string | null; error?: string }> {
  if (opts.dryRun) return { commentId: null };

  let commentId = opts.store.getSummaryId(opts.scope);

  if (!commentId) {
    // A fresh clone of the state DB should still find the comment we own.
    const notes = await opts.platform.listOwnNotes().catch(() => []);
    commentId = notes.find((note) => note.body.includes(SUMMARY_MARKER))?.id ?? null;
  }

  try {
    if (commentId) {
      await opts.platform.updateNote({ commentId, fallback: true }, body);
    } else {
      const ref = await opts.platform.postGeneralNote(body);
      commentId = ref.commentId;
    }
    opts.store.setSummaryId(opts.scope, commentId);
    return { commentId };
  } catch (err) {
    return { commentId, error: err instanceof Error ? err.message : String(err) };
  }
}

export function describeSkipReasons(
  skipped: readonly { path: string; reason: string }[],
): { path: string; reason: string }[] {
  return skipped.map((entry) => ({
    path: entry.path,
    reason: describeSkip(entry.reason as Parameters<typeof describeSkip>[0]) ?? entry.reason,
  }));
}
