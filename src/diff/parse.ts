/**
 * Unified diff -> hunks with real line numbers on both sides.
 *
 * This one structure powers everything downstream: which lines a finding may
 * reference, which symbols the change touched, and where a comment anchors.
 * Hunk headers are never used to *infer* which lines changed — the line kinds
 * are read off the diff body itself.
 */

import type { DiffLine, FileStatus, Hunk } from '../types.ts';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface ParsedFileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * Parses the hunks of a single file's diff body. Tolerates leading `---`/`+++`
 * headers, `\ No newline at end of file`, and hunk headers with omitted counts.
 */
export function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  if (!diffText) return hunks;

  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of diffText.split('\n')) {
    const header = HUNK_HEADER.exec(rawLine);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        // A missing count means exactly one line, not zero.
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }

    if (!current) continue; // preamble (---, +++, index, diff --git)

    // "\ No newline at end of file" annotates the previous line; it is not one.
    if (rawLine.startsWith('\\')) continue;

    const marker = rawLine[0];
    const text = rawLine.slice(1);

    if (marker === '+') {
      current.lines.push({ kind: 'add', oldLine: null, newLine, text });
      newLine += 1;
    } else if (marker === '-') {
      current.lines.push({ kind: 'del', oldLine, newLine: null, text });
      oldLine += 1;
    } else if (marker === ' ') {
      current.lines.push({ kind: 'context', oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
    } else if (rawLine === '') {
      // Some producers emit a bare empty line for an empty context line.
      current.lines.push({ kind: 'context', oldLine, newLine, text: '' });
      oldLine += 1;
      newLine += 1;
    }
    // Anything else (e.g. a trailing "diff --git" of the next file) is ignored
    // here; splitMultiFileDiff is responsible for not handing it to us.
  }

  return hunks;
}

export function countChanges(hunks: Hunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions += 1;
      else if (line.kind === 'del') deletions += 1;
    }
  }
  return { additions, deletions };
}

/**
 * The head-side lines a finding is allowed to reference: every added line, plus
 * the context lines immediately adjacent to a deletion so that deletion-only
 * hunks remain reviewable. Context lines far from any change are out of scope.
 */
export function reviewableLines(hunks: Hunk[]): Set<number> {
  const lines = new Set<number>();
  for (const hunk of hunks) {
    for (let i = 0; i < hunk.lines.length; i += 1) {
      const line = hunk.lines[i]!;
      if (line.kind === 'add' && line.newLine !== null) {
        lines.add(line.newLine);
        continue;
      }
      if (line.kind !== 'del') continue;
      // Anchor the deletion to the nearest surviving head-side line.
      const before = previousWithNewLine(hunk.lines, i);
      const after = nextWithNewLine(hunk.lines, i);
      if (before !== null) lines.add(before);
      if (after !== null) lines.add(after);
    }
  }
  return lines;
}

function previousWithNewLine(lines: DiffLine[], from: number): number | null {
  for (let i = from - 1; i >= 0; i -= 1) {
    const candidate = lines[i]!.newLine;
    if (candidate !== null) return candidate;
  }
  return null;
}

function nextWithNewLine(lines: DiffLine[], from: number): number | null {
  for (let i = from + 1; i < lines.length; i += 1) {
    const candidate = lines[i]!.newLine;
    if (candidate !== null) return candidate;
  }
  return null;
}

/** Head-side line numbers of added lines only — used for symbol intersection. */
export function addedLines(hunks: Hunk[]): Set<number> {
  const lines = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add' && line.newLine !== null) lines.add(line.newLine);
    }
  }
  return lines;
}

/** Base-side line numbers of removed lines. */
export function removedLines(hunks: Hunk[]): Set<number> {
  const lines = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'del' && line.oldLine !== null) lines.add(line.oldLine);
    }
  }
  return lines;
}

const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/** Splits a multi-file `git diff` into per-file diffs. */
export function parseMultiFileDiff(text: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  const lines = text.split('\n');

  let block: string[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;

  const flush = (): void => {
    if (oldPath === null && newPath === null) return;
    const body = block.join('\n');
    const binary = /^(GIT binary patch|Binary files )/m.test(body);
    const hunks = binary ? [] : parseHunks(body);
    const { additions, deletions } = countChanges(hunks);
    files.push({
      oldPath,
      newPath,
      status: statusFor(body, oldPath, newPath),
      hunks,
      additions,
      deletions,
      binary,
    });
    block = [];
  };

  for (const line of lines) {
    const header = GIT_HEADER.exec(line);
    if (header) {
      flush();
      oldPath = header[1]!;
      newPath = header[2]!;
      continue;
    }
    if (line.startsWith('--- /dev/null')) oldPath = null;
    if (line.startsWith('+++ /dev/null')) newPath = null;
    block.push(line);
  }
  flush();

  return files;
}

function statusFor(body: string, oldPath: string | null, newPath: string | null): FileStatus {
  if (/^new file mode/m.test(body) || oldPath === null) return 'added';
  if (/^deleted file mode/m.test(body) || newPath === null) return 'deleted';
  if (/^rename from /m.test(body) || (oldPath !== newPath && oldPath && newPath)) return 'renamed';
  return 'modified';
}
