import { describe, expect, test } from 'bun:test';
import type { ChangeSet, Finding } from '../src/types.ts';
import { parseHunks } from '../src/diff/parse.ts';
import { sha256 } from '../src/publish/fingerprint.ts';
import { verifyFindings } from '../src/review/verify.ts';

const HEAD = [
  'export function refund(amountMinor: number, total: number) {',
  '  if (amountMinor > total) {',
  '    throw new Error("too much");',
  '  }',
  '  return true;',
  '}',
].join('\n');

function changeSet(): ChangeSet {
  return {
    platform: 'local',
    projectId: 'p',
    requestId: 'r',
    title: 't',
    description: '',
    baseSha: 'a'.repeat(40),
    startSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    targetBranch: 'main',
    files: [
      {
        path: 'src/refund.ts',
        status: 'modified',
        hunks: parseHunks(
          [
            '@@ -1,1 +1,6 @@',
            ' export function refund(amountMinor: number, total: number) {',
            '+  if (amountMinor > total) {',
            '+    throw new Error("too much");',
            '+  }',
            '+  return true;',
            '+}',
          ].join('\n'),
        ),
        headContent: HEAD,
        contentHash: sha256(HEAD),
        language: 'typescript',
        additions: 5,
        deletions: 0,
      },
    ],
    skipped: [],
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'fp',
    path: 'src/refund.ts',
    line: 2,
    severity: 'high',
    category: 'bug',
    title: 'Compare in the same unit',
    body: 'amountMinor is in minor units and total is not.',
    evidence: '  if (amountMinor > total) {',
    ruleIds: [],
    confidence: 0.9,
    ...overrides,
  };
}

const OPTIONS = { confidenceThreshold: 0.6 };

describe('verifyFindings', () => {
  test('keeps a finding whose evidence and line both check out', () => {
    const result = verifyFindings(changeSet(), [finding()], OPTIONS);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test('drops a path that is not in the change set', () => {
    const result = verifyFindings(changeSet(), [finding({ path: 'src/other.ts' })], OPTIONS);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]!.dropReason).toContain('not in this change set');
  });

  test('drops invented evidence', () => {
    const result = verifyFindings(
      changeSet(),
      [finding({ evidence: '  if (amount > limit) { // paraphrased' })],
      OPTIONS,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]!.dropReason).toContain('does not appear in the file');
  });

  test('matches evidence through re-indentation', () => {
    const result = verifyFindings(
      changeSet(),
      [finding({ evidence: 'if (amountMinor  >  total) {' })],
      OPTIONS,
    );
    expect(result.kept).toHaveLength(1);
  });

  test('corrects a wrong line when the snippet is real and in scope', () => {
    const result = verifyFindings(changeSet(), [finding({ line: 5 })], OPTIONS);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.line).toBe(2);
    expect(result.kept[0]!.lineCorrectedFrom).toBe(5);
  });

  test('drops a line outside any hunk', () => {
    const untouched = changeSet();
    untouched.files[0]!.hunks = parseHunks(
      ['@@ -5,1 +5,2 @@', '  return true;', '+  // trailing'].join('\n'),
    );
    const result = verifyFindings(untouched, [finding({ line: 2 })], OPTIONS);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]!.dropReason).toContain('not inside a changed hunk');
  });

  test('drops praise', () => {
    const result = verifyFindings(
      changeSet(),
      [finding({ title: 'This correctly handles the overflow case' })],
      OPTIONS,
    );
    expect(result.dropped[0]!.dropReason).toContain('praise');
  });

  test('drops findings below the confidence threshold', () => {
    const result = verifyFindings(changeSet(), [finding({ confidence: 0.4 })], OPTIONS);
    expect(result.dropped[0]!.dropReason).toContain('below the 0.6 threshold');
  });

  test('drops a duplicate of a finding already kept in this run', () => {
    const result = verifyFindings(changeSet(), [finding(), finding()], OPTIONS);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped[0]!.dropReason).toContain('duplicate');
  });

  test('records a reason for every drop', () => {
    const result = verifyFindings(
      changeSet(),
      [finding({ path: 'nope.ts' }), finding({ confidence: 0 })],
      OPTIONS,
    );
    expect(result.dropped).toHaveLength(2);
    for (const dropped of result.dropped) {
      expect(dropped.verdict).toBe('dropped');
      expect(dropped.dropReason).toBeTruthy();
    }
  });
});
