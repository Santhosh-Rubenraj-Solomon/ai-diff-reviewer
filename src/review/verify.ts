/**
 * Gate 1 — deterministic verification. No model call happens in this file.
 *
 * This is the only place that decides whether a finding is real enough to
 * post. Every guarantee the prompt makes about evidence is enforced here,
 * because a guarantee that lives only in prose is not a guarantee.
 *
 * Every drop is recorded with its reason: that list is the debugging tool and
 * the eval input.
 */

import type { ChangeSet, ChangedFile, Finding } from '../types.ts';
import { reviewableLines } from '../diff/parse.ts';
import { normalizeEvidence } from '../publish/fingerprint.ts';

export interface VerifyOptions {
  confidenceThreshold: number;
  /** fingerprint -> content hash of the file when it was last posted. */
  alreadyPosted?: Map<string, string>;
}

export interface VerifyResult {
  kept: Finding[];
  dropped: Finding[];
}

/** Phrases that mean "this code is fine" — a review comment, not a finding. */
const PRAISE = [
  'correctly handles',
  'correctly implements',
  'good use of',
  'nice use of',
  'well done',
  'looks good',
  'lgtm',
  'no issues found',
  'no problems found',
  'this is correct',
  'great job',
];

export function verifyFindings(
  changeSet: ChangeSet,
  findings: readonly Finding[],
  opts: VerifyOptions,
): VerifyResult {
  const byPath = new Map(changeSet.files.map((file) => [file.path, file]));
  const reviewable = new Map<string, Set<number>>();
  const normalizedCache = new Map<string, { lines: string[] }>();

  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  const seenFingerprints = new Set<string>();

  const drop = (finding: Finding, reason: string): void => {
    dropped.push({ ...finding, verdict: 'dropped', dropReason: reason });
  };

  for (const finding of findings) {
    // 1. The path is in this change set.
    const file = byPath.get(finding.path);
    if (!file) {
      drop(finding, `path \`${finding.path}\` is not in this change set`);
      continue;
    }

    // 2. The line is inside a hunk (added, or adjacent to a deletion).
    let lines = reviewable.get(file.path);
    if (!lines) {
      lines = reviewableLines(file.hunks);
      reviewable.set(file.path, lines);
    }

    // 3. The evidence exists verbatim at head.
    const located = locateEvidence(file, finding.evidence, normalizedCache);
    if (located === null) {
      drop(finding, 'evidence does not appear in the file at head');
      continue;
    }

    let candidate = finding;
    if (!lines.has(finding.line)) {
      // The snippet is real but the line is wrong — correct it if the evidence
      // sits on a changed line, otherwise the finding is out of scope.
      const corrected = nearestOf(located, finding.line, lines);
      if (corrected === null) {
        drop(finding, `line ${finding.line} is not inside a changed hunk`);
        continue;
      }
      candidate = { ...finding, line: corrected, lineCorrectedFrom: finding.line };
    } else if (!located.includes(finding.line)) {
      const corrected = nearestOf(located, finding.line, lines);
      if (corrected !== null && corrected !== finding.line) {
        candidate = { ...finding, line: corrected, lineCorrectedFrom: finding.line };
      }
    }

    // 4. It reads as a defect, not as praise.
    const prose = `${candidate.title}\n${candidate.body}`.toLowerCase();
    const praise = PRAISE.find((phrase) => prose.includes(phrase));
    if (praise) {
      drop(candidate, `reads as praise rather than a defect ("${praise}")`);
      continue;
    }

    // 5. Confidence clears the bar.
    if (candidate.confidence < opts.confidenceThreshold) {
      drop(
        candidate,
        `confidence ${candidate.confidence.toFixed(2)} is below the ${opts.confidenceThreshold} threshold`,
      );
      continue;
    }

    // 6. Not a duplicate within this run, and not already posted unchanged.
    if (seenFingerprints.has(candidate.id)) {
      drop(candidate, 'duplicate of another finding in this run');
      continue;
    }
    const postedAt = opts.alreadyPosted?.get(candidate.id);
    if (postedAt !== undefined && postedAt === file.contentHash) {
      drop(candidate, 'already posted for this file content');
      continue;
    }

    seenFingerprints.add(candidate.id);
    kept.push({ ...candidate, verdict: 'kept' });
  }

  return { kept, dropped };
}

/**
 * Returns every head-side line where the (whitespace-normalised) evidence
 * begins, or null when it is nowhere in the file.
 */
export function locateEvidence(
  file: ChangedFile,
  evidence: string,
  cache?: Map<string, { lines: string[] }>,
): number[] | null {
  if (file.headContent === null) return null;

  const needle = normalizeEvidence(evidence);
  if (needle.length === 0) return null;

  const cached = cache?.get(file.path);
  const haystack =
    cached ??
    {
      lines: file.headContent.split('\n').map((line) => line.trim().replace(/\s+/g, ' ')),
    };
  cache?.set(file.path, haystack);

  const needleLines = needle.split('\n');
  const hits: number[] = [];

  for (let start = 0; start + needleLines.length <= haystack.lines.length; start += 1) {
    let matched = true;
    let offset = 0;
    for (const needleLine of needleLines) {
      // Skip blank head lines so that evidence spanning a blank line still matches.
      while (start + offset < haystack.lines.length && haystack.lines[start + offset] === '') {
        offset += 1;
      }
      if (haystack.lines[start + offset] !== needleLine) {
        matched = false;
        break;
      }
      offset += 1;
    }
    if (matched) hits.push(start + 1);
  }

  return hits.length > 0 ? hits : null;
}

/** Picks the located line closest to what the model claimed, if any is in scope. */
function nearestOf(located: number[], claimed: number, allowed: Set<number>): number | null {
  const inScope = located.filter((line) => allowed.has(line));
  if (inScope.length === 0) return null;
  return inScope.reduce((best, line) =>
    Math.abs(line - claimed) < Math.abs(best - claimed) ? line : best,
  );
}
