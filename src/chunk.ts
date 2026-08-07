/**
 * Turning a raw unified diff into review units.
 *
 * Two jobs: throw away what is not worth a model call (binary, lockfiles,
 * generated output, anything absurdly large), and split what remains into
 * chunks of one file each. Excluded paths are returned alongside the
 * survivors so the CLI can report them rather than silently dropping them.
 */

import { config, GENERATED_PATTERNS, LOCKFILE_PATTERNS } from './config.ts';
import type { Chunk, DiffFile, ExcludedFile, LineRange } from './types.ts';

const FILE_HEADER = /^diff --git /;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Split a raw diff into one text block per file, headers included. */
export function splitByFile(rawDiff: string): string[] {
  if (!rawDiff.trim()) return [];

  const lines = rawDiff.split('\n');
  const blocks: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (FILE_HEADER.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
    // Anything before the first `diff --git` (e.g. commit headers) is dropped.
  }
  if (current) blocks.push(current.join('\n'));

  return blocks;
}

/**
 * Recover the file path from a diff block.
 *
 * The `+++ b/...` line is preferred because it is the post-image path; for a
 * deletion that line is `/dev/null`, so the pre-image path is used instead.
 * Falls back to the `diff --git` line for blocks with no `---`/`+++` pair
 * (mode changes, pure renames).
 */
export function parsePath(block: string): string {
  for (const line of block.split('\n')) {
    if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) {
      return stripPrefix(line.slice(4));
    }
  }
  for (const line of block.split('\n')) {
    if (line.startsWith('--- ') && !line.startsWith('--- /dev/null')) {
      return stripPrefix(line.slice(4));
    }
  }
  const header = block.split('\n', 1)[0] ?? '';
  const match = header.match(/^diff --git ("?)a\/(.+?)\1 ("?)b\/(.+?)\3$/);
  if (match?.[4]) return match[4];
  return header.replace(/^diff --git /, '').trim() || '<unknown>';
}

function stripPrefix(path: string): string {
  const trimmed = path.trim().replace(/\t.*$/, '');
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return unquoted.replace(/^[ab]\//, '');
}

/** Pull the pre- and post-image line ranges out of every hunk header. */
export function parseRanges(block: string): { old: LineRange[]; new: LineRange[] } {
  const oldRanges: LineRange[] = [];
  const newRanges: LineRange[] = [];

  for (const line of block.split('\n')) {
    const match = line.match(HUNK_HEADER);
    if (!match) continue;

    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);

    if (oldCount > 0) oldRanges.push({ start: oldStart, end: oldStart + oldCount - 1 });
    if (newCount > 0) newRanges.push({ start: newStart, end: newStart + newCount - 1 });
  }

  return { old: oldRanges, new: newRanges };
}

// --- Exclusion predicates ---------------------------------------------------

export function isBinary(block: string): boolean {
  return block.split('\n').some(
    (line) => line.startsWith('GIT binary patch') || /^Binary files .* differ$/.test(line),
  );
}

export function isLockfile(path: string): boolean {
  return LOCKFILE_PATTERNS.some((pattern) => pattern.test(path));
}

export function isGenerated(path: string): boolean {
  return GENERATED_PATTERNS.some((pattern) => pattern.test(path));
}

export function isOversized(block: string, ceiling = config.maxFileDiffBytes): boolean {
  return Buffer.byteLength(block, 'utf8') > ceiling;
}

function isNewFile(block: string): boolean {
  return block.split('\n').some(
    (line) => line.startsWith('new file mode') || line === '--- /dev/null',
  );
}

export interface FilterResult {
  files: DiffFile[];
  excluded: ExcludedFile[];
}

/**
 * Drop everything not worth reviewing, keeping a record of what was dropped.
 */
export function filterDiff(rawDiff: string, ceiling = config.maxFileDiffBytes): FilterResult {
  const files: DiffFile[] = [];
  const excluded: ExcludedFile[] = [];

  for (const block of splitByFile(rawDiff)) {
    const path = parsePath(block);

    if (isBinary(block)) {
      excluded.push({ path, reason: 'binary' });
      continue;
    }
    if (isLockfile(path)) {
      excluded.push({ path, reason: 'lockfile' });
      continue;
    }
    if (isGenerated(path)) {
      excluded.push({ path, reason: 'generated' });
      continue;
    }
    if (isOversized(block, ceiling)) {
      excluded.push({ path, reason: 'oversized', bytes: Buffer.byteLength(block, 'utf8') });
      continue;
    }

    const ranges = parseRanges(block);
    if (ranges.new.length === 0 && ranges.old.length === 0) {
      // Mode change or pure rename with no content — nothing to review.
      continue;
    }

    files.push({
      path,
      patch: block,
      oldRanges: ranges.old,
      newRanges: ranges.new,
      isNew: isNewFile(block),
    });
  }

  return { files, excluded };
}

// --- Chunking ---------------------------------------------------------------

/**
 * One chunk per file, except that a file over `maxChunkBytes` is split along
 * hunk boundaries so a chunk is never larger than the ceiling. Each split
 * chunk repeats the file header so it reads as a valid standalone diff.
 */
export function chunkFiles(files: DiffFile[], maxBytes = config.maxChunkBytes): Chunk[] {
  const chunks: Chunk[] = [];

  for (const file of files) {
    if (Buffer.byteLength(file.patch, 'utf8') <= maxBytes) {
      chunks.push({ ...file, part: 1, partsTotal: 1 });
      continue;
    }
    chunks.push(...splitFileByHunks(file, maxBytes));
  }

  return chunks;
}

function splitFileByHunks(file: DiffFile, maxBytes: number): Chunk[] {
  const lines = file.patch.split('\n');
  const firstHunk = lines.findIndex((line) => HUNK_HEADER.test(line));
  if (firstHunk === -1) return [{ ...file, part: 1, partsTotal: 1 }];

  const header = lines.slice(0, firstHunk).join('\n');
  const hunks: string[] = [];
  let current: string[] = [];

  for (const line of lines.slice(firstHunk)) {
    if (HUNK_HEADER.test(line) && current.length > 0) {
      hunks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) hunks.push(current.join('\n'));

  const headerBytes = Buffer.byteLength(header, 'utf8');
  const groups: string[][] = [];
  let group: string[] = [];
  let groupBytes = headerBytes;

  for (const hunk of hunks) {
    const hunkBytes = Buffer.byteLength(hunk, 'utf8') + 1;
    // A single hunk over the ceiling still ships alone; splitting mid-hunk
    // would produce a diff the model cannot reason about.
    if (group.length > 0 && groupBytes + hunkBytes > maxBytes) {
      groups.push(group);
      group = [];
      groupBytes = headerBytes;
    }
    group.push(hunk);
    groupBytes += hunkBytes;
  }
  if (group.length > 0) groups.push(group);

  return groups.map((hunkGroup, index) => {
    const patch = `${header}\n${hunkGroup.join('\n')}`;
    const ranges = parseRanges(patch);
    return {
      path: file.path,
      patch,
      oldRanges: ranges.old,
      newRanges: ranges.new,
      isNew: file.isNew,
      part: index + 1,
      partsTotal: groups.length,
    };
  });
}
