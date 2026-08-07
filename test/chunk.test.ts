import { describe, expect, test } from 'bun:test';
import {
  chunkFiles,
  filterDiff,
  isBinary,
  isGenerated,
  isLockfile,
  parsePath,
  parseRanges,
  splitByFile,
} from '../src/chunk.ts';

const TWO_FILES = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ export function a() {
   const x = 1;
-  return x;
+  return x + 1;
+  // unreachable
 }
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-const b = 1;
+const b = 2;
`;

describe('splitByFile', () => {
  test('splits on diff --git boundaries', () => {
    const blocks = splitByFile(TWO_FILES);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toStartWith('diff --git a/src/a.ts');
    expect(blocks[1]).toStartWith('diff --git a/src/b.ts');
  });

  test('returns nothing for an empty diff', () => {
    expect(splitByFile('')).toEqual([]);
    expect(splitByFile('   \n')).toEqual([]);
  });

  test('drops commit headers emitted by git show', () => {
    const withHeader = `commit abc123\nAuthor: Someone\n\n    subject\n\n${TWO_FILES}`;
    expect(splitByFile(withHeader)).toHaveLength(2);
  });
});

describe('parsePath', () => {
  test('prefers the post-image path', () => {
    expect(parsePath(splitByFile(TWO_FILES)[0]!)).toBe('src/a.ts');
  });

  test('falls back to the pre-image path for deletions', () => {
    const deletion = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const gone = 1;
`;
    expect(parsePath(deletion)).toBe('src/gone.ts');
  });

  test('unquotes paths containing spaces', () => {
    const quoted = `diff --git "a/src/my file.ts" "b/src/my file.ts"
--- "a/src/my file.ts"
+++ "b/src/my file.ts"
@@ -1 +1 @@
-a
+b
`;
    expect(parsePath(quoted)).toBe('src/my file.ts');
  });
});

describe('parseRanges', () => {
  test('reads both sides of a hunk header', () => {
    const ranges = parseRanges(splitByFile(TWO_FILES)[0]!);
    expect(ranges.old).toEqual([{ start: 10, end: 12 }]);
    expect(ranges.new).toEqual([{ start: 10, end: 13 }]);
  });

  test('treats an omitted count as one line', () => {
    const ranges = parseRanges('@@ -5 +7 @@\n-a\n+b\n');
    expect(ranges.old).toEqual([{ start: 5, end: 5 }]);
    expect(ranges.new).toEqual([{ start: 7, end: 7 }]);
  });

  test('drops zero-length sides', () => {
    const ranges = parseRanges('@@ -0,0 +1,3 @@\n+a\n+b\n+c\n');
    expect(ranges.old).toEqual([]);
    expect(ranges.new).toEqual([{ start: 1, end: 3 }]);
  });
});

describe('exclusion predicates', () => {
  test('detects binary diffs in both forms', () => {
    expect(isBinary('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ')).toBe(true);
    expect(isBinary('diff --git a/x.png b/x.png\nGIT binary patch\nliteral 10')).toBe(true);
    expect(isBinary(TWO_FILES)).toBe(false);
  });

  test('detects lockfiles anywhere in the tree', () => {
    expect(isLockfile('package-lock.json')).toBe(true);
    expect(isLockfile('apps/web/pnpm-lock.yaml')).toBe(true);
    expect(isLockfile('bun.lockb')).toBe(true);
    expect(isLockfile('src/lockfile-parser.ts')).toBe(false);
  });

  test('detects generated and vendored paths', () => {
    expect(isGenerated('dist/index.js')).toBe(true);
    expect(isGenerated('src/api.pb.go')).toBe(true);
    expect(isGenerated('web/static/app.min.js')).toBe(true);
    expect(isGenerated('src/__snapshots__/a.snap')).toBe(true);
    expect(isGenerated('src/distance.ts')).toBe(false);
  });
});

describe('filterDiff', () => {
  test('keeps reviewable files and records the rest', () => {
    const withNoise = `${TWO_FILES}diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-{}
+{"a":1}
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;
    const { files, excluded } = filterDiff(withNoise);

    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    // Order follows the diff, so the report reads in the same order git wrote.
    expect(excluded).toEqual([
      { path: 'package-lock.json', reason: 'lockfile' },
      { path: 'logo.png', reason: 'binary' },
    ]);
  });

  test('excludes an oversized file rather than truncating it', () => {
    const huge = `diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
@@ -1,1 +1,2 @@
${'+x\n'.repeat(500)}`;
    const { files, excluded } = filterDiff(huge, 100);

    expect(files).toEqual([]);
    expect(excluded[0]?.reason).toBe('oversized');
    expect(excluded[0]?.bytes).toBeGreaterThan(100);
  });

  test('marks added files as new so history is skipped', () => {
    const added = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+const a = 1;
+export default a;
`;
    expect(filterDiff(added).files[0]?.isNew).toBe(true);
    expect(filterDiff(TWO_FILES).files[0]?.isNew).toBe(false);
  });
});

describe('chunkFiles', () => {
  test('emits one chunk per file when nothing is oversized', () => {
    const chunks = chunkFiles(filterDiff(TWO_FILES).files);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.partsTotal === 1)).toBe(true);
  });

  test('splits an oversized file on hunk boundaries', () => {
    const manyHunks = [
      'diff --git a/src/big.ts b/src/big.ts',
      '--- a/src/big.ts',
      '+++ b/src/big.ts',
      ...Array.from({ length: 6 }, (_, i) => `@@ -${i * 10 + 1},2 +${i * 10 + 1},2 @@\n-old${i}\n+new${i}`),
    ].join('\n');

    const files = filterDiff(manyHunks).files;
    const chunks = chunkFiles(files, 120);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.path === 'src/big.ts')).toBe(true);
    expect(chunks.map((chunk) => chunk.part)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i + 1),
    );

    // Every chunk must still parse as a diff, with its own header and hunks.
    for (const chunk of chunks) {
      expect(chunk.patch).toStartWith('diff --git a/src/big.ts');
      expect(chunk.patch).toContain('@@ -');
      expect(chunk.newRanges.length).toBeGreaterThan(0);
    }

    // No hunk may be lost or duplicated across the split.
    const hunkCount = chunks.reduce(
      (total, chunk) => total + (chunk.patch.match(/^@@ -/gm)?.length ?? 0),
      0,
    );
    expect(hunkCount).toBe(6);
  });
});
