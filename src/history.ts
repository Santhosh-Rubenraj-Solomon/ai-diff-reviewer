/**
 * The repository's own memory of the lines being changed.
 *
 * This is the differentiator. Every reviewer feeds the model the diff, and the
 * expensive ones add repo-wide semantic context, but none feed the history of
 * the exact lines under review. `git log` gives churn; `git blame -L` on the
 * touched ranges gives who last changed those lines, when, and whether that
 * change was itself a fix or a revert. All of it is local, free and instant.
 */

import { config } from './config.ts';
import * as git from './git.ts';
import { LOG_SEP } from './git.ts';
import type { BlameEntry, Chunk, CommitInfo, HistoryContext, LineRange } from './types.ts';

const FIX_PATTERN = /\b(fix(es|ed|up)?|bug|hotfix|patch|regress(ion|ed)?|broke|broken)\b/i;
const REVERT_PATTERN = /^revert\b|\brevert(s|ed|ing)?\b/i;

/** Parse the `git log` output produced by `logForFile`. */
export function parseLog(raw: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [hash, shortHash, date, author, ...rest] = line.split(LOG_SEP);
    if (!hash || !shortHash) continue;
    commits.push({
      hash,
      shortHash,
      date: date ?? '',
      author: author ?? '',
      subject: rest.join(LOG_SEP),
    });
  }
  return commits;
}

/** Parse `git blame --line-porcelain` into one entry per blamed line. */
export function parseBlame(raw: string): BlameEntry[] {
  const entries: BlameEntry[] = [];
  let pending: Partial<BlameEntry> & { authorTime?: number } = {};

  for (const line of raw.split('\n')) {
    const header = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (header) {
      if (pending.shortHash) entries.push(finalize(pending));
      pending = {
        shortHash: header[1]!.slice(0, 8),
        line: Number(header[2]),
      };
      continue;
    }
    if (line.startsWith('author ')) pending.author = line.slice('author '.length);
    else if (line.startsWith('author-time ')) {
      pending.authorTime = Number(line.slice('author-time '.length));
    } else if (line.startsWith('summary ')) pending.subject = line.slice('summary '.length);
  }
  if (pending.shortHash) entries.push(finalize(pending));

  return entries;
}

function finalize(pending: Partial<BlameEntry> & { authorTime?: number }): BlameEntry {
  return {
    shortHash: pending.shortHash ?? '',
    author: pending.author ?? '',
    date: pending.authorTime ? new Date(pending.authorTime * 1000).toISOString() : '',
    subject: pending.subject ?? '',
    line: pending.line ?? 0,
  };
}

/** Merge overlapping or adjacent ranges so blame runs once per contiguous span. */
export function mergeRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [{ ...sorted[0]! }];

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Build the history context for one chunk.
 *
 * Never throws: a new file, an untracked path or a blame that falls off the
 * end of the pre-image all degrade to an explicit "no history available"
 * marker, which the prompt states plainly rather than leaving the model to
 * guess from an empty section.
 */
export async function enrichChunk(chunk: Chunk): Promise<HistoryContext> {
  const empty = (reason: string): HistoryContext => ({
    path: chunk.path,
    available: false,
    unavailableReason: reason,
    commits: [],
    blame: [],
    totalCommits: 0,
    recentCommits: 0,
    priorFixes: [],
    reverts: [],
    daysSinceLastTouch: null,
    distinctBlameCommits: 0,
  });

  if (chunk.isNew) return empty('new file — no prior history');

  const commits = parseLog(await git.logForFile(chunk.path, config.logDepth));

  const ranges = mergeRanges(chunk.oldRanges);
  const blameResults = await Promise.all(
    ranges.map((range) => git.blameLines(chunk.path, range.start, range.end)),
  );
  const blame = blameResults.flatMap(parseBlame);

  if (commits.length === 0 && blame.length === 0) {
    return empty('git has no record of this path');
  }

  const now = Date.now();
  const windowMs = config.churnWindowDays * 24 * 60 * 60 * 1000;
  const recentCommits = commits.filter((commit) => {
    const time = Date.parse(commit.date);
    return Number.isFinite(time) && now - time <= windowMs;
  }).length;

  // Subjects from the blamed lines carry more weight than file-wide history,
  // so they lead the list the model sees.
  const blameSubjects = blame.map((entry) => entry.subject);
  const subjects = dedupe([...blameSubjects, ...commits.map((c) => c.subject)]);

  const blameTimes = blame
    .map((entry) => Date.parse(entry.date))
    .filter((time) => Number.isFinite(time));
  const daysSinceLastTouch =
    blameTimes.length > 0
      ? Math.floor((now - Math.max(...blameTimes)) / (24 * 60 * 60 * 1000))
      : null;

  return {
    path: chunk.path,
    available: true,
    commits,
    blame,
    totalCommits: commits.length,
    recentCommits,
    priorFixes: subjects.filter((subject) => FIX_PATTERN.test(subject)).slice(0, 10),
    reverts: subjects.filter((subject) => REVERT_PATTERN.test(subject)).slice(0, 10),
    daysSinceLastTouch,
    distinctBlameCommits: new Set(blame.map((entry) => entry.shortHash)).size,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

/**
 * Render history as the prompt section the model reads.
 *
 * Kept deliberately terse: the model gets signals and a handful of subjects,
 * not a commit log to wade through.
 */
export function formatHistoryForPrompt(history: HistoryContext): string {
  if (!history.available) {
    return `No git history available for ${history.path} (${history.unavailableReason}).\nJudge this change on its own terms; do not infer history signals.`;
  }

  const lines: string[] = [`Git history for ${history.path}:`];
  lines.push(
    `- ${history.totalCommits} commits in the last ${config.logDepth} touching this file; ${history.recentCommits} within ${config.churnWindowDays} days.`,
  );
  lines.push(
    `- The lines this diff modifies were last changed by ${history.distinctBlameCommits} distinct commit(s)` +
      (history.daysSinceLastTouch === null
        ? '.'
        : `, most recently ${history.daysSinceLastTouch} day(s) ago.`),
  );

  if (history.priorFixes.length > 0) {
    lines.push('- Prior fix/bug commits touching this code:');
    for (const subject of history.priorFixes) lines.push(`    "${subject}"`);
  }
  if (history.reverts.length > 0) {
    lines.push('- Reverts touching this code:');
    for (const subject of history.reverts) lines.push(`    "${subject}"`);
  }

  const blameSample = history.blame.slice(0, 12);
  if (blameSample.length > 0) {
    lines.push('- Blame on the modified lines (line: commit "subject"):');
    for (const entry of blameSample) {
      lines.push(`    ${entry.line}: ${entry.shortHash} "${entry.subject}"`);
    }
  }

  return lines.join('\n');
}
