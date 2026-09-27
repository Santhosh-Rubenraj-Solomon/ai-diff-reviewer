import { describe, expect, test } from 'bun:test';
import {
  addedLines,
  countChanges,
  parseHunks,
  parseMultiFileDiff,
  removedLines,
  reviewableLines,
} from '../src/diff/parse.ts';

describe('parseHunks', () => {
  test('numbers both sides of a mixed hunk', () => {
    const hunks = parseHunks(
      ['@@ -10,3 +10,4 @@', ' keep', '-gone', '+added one', '+added two', ' tail'].join('\n'),
    );

    expect(hunks).toHaveLength(1);
    const lines = hunks[0]!.lines;
    expect(lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['context', 12, 13],
    ]);
  });

  test('an omitted count means one line, not zero', () => {
    const hunks = parseHunks(['@@ -5 +5 @@', '-old', '+new'].join('\n'));
    expect(hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
  });

  test('ignores the no-newline marker rather than counting it as a line', () => {
    const hunks = parseHunks(['@@ -1,1 +1,1 @@', '-a', '\\ No newline at end of file', '+b'].join('\n'));
    expect(hunks[0]!.lines.map((line) => line.kind)).toEqual(['del', 'add']);
  });

  test('skips the ---/+++ preamble', () => {
    const hunks = parseHunks(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,2 @@', ' a', '+b'].join('\n'),
    );
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines).toHaveLength(2);
  });

  test('counts additions and deletions', () => {
    const hunks = parseHunks(['@@ -1,2 +1,2 @@', '-a', '-b', '+c', '+d'].join('\n'));
    expect(countChanges(hunks)).toEqual({ additions: 2, deletions: 2 });
  });
});

describe('reviewableLines', () => {
  test('includes added lines', () => {
    const hunks = parseHunks(['@@ -1,1 +1,3 @@', ' a', '+b', '+c'].join('\n'));
    expect([...reviewableLines(hunks)].sort((x, y) => x - y)).toEqual([2, 3]);
  });

  test('a deletion-only hunk still has a reviewable anchor', () => {
    // The reference tool returns nothing here, which then marks every export
    // as touched. A deletion must stay reviewable at the surviving line.
    const hunks = parseHunks(['@@ -10,3 +10,2 @@', ' before', '-gone', ' after'].join('\n'));
    const lines = reviewableLines(hunks);
    expect(lines.size).toBeGreaterThan(0);
    expect(lines.has(10)).toBe(true); // context before
    expect(lines.has(11)).toBe(true); // context after, on the head side
  });

  test('context lines far from a change are not reviewable', () => {
    const hunks = parseHunks(
      ['@@ -1,5 +1,5 @@', ' a', ' b', '-c', '+C', ' d', ' e'].join('\n'),
    );
    const lines = reviewableLines(hunks);
    expect(lines.has(3)).toBe(true); // the replacement
    expect(lines.has(1)).toBe(false); // two lines away from any change
  });

  test('added and removed line sets are side-correct', () => {
    const hunks = parseHunks(['@@ -7,2 +7,2 @@', '-old', '+new', ' tail'].join('\n'));
    expect([...addedLines(hunks)]).toEqual([7]);
    expect([...removedLines(hunks)]).toEqual([7]);
  });
});

describe('parseMultiFileDiff', () => {
  test('splits files and detects status', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,2 @@',
      ' one',
      '+two',
      'diff --git a/src/b.ts b/src/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1,1 @@',
      '+fresh',
    ].join('\n');

    const files = parseMultiFileDiff(text);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ newPath: 'src/a.ts', status: 'modified', additions: 1 });
    expect(files[1]).toMatchObject({ newPath: 'src/b.ts', status: 'added' });
  });

  test('flags binary files instead of parsing them', () => {
    const text = [
      'diff --git a/logo.png b/logo.png',
      'index 111..222 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    expect(parseMultiFileDiff(text)[0]).toMatchObject({ binary: true, hunks: [] });
  });
});
