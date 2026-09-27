import { describe, expect, test } from 'bun:test';
import type { FileContext } from '../src/types.ts';
import { CoverageError, assertCoverage, planBatches } from '../src/review/batch.ts';
import { parseHunks } from '../src/diff/parse.ts';
import { sha256 } from '../src/publish/fingerprint.ts';

function context(path: string, body: string): FileContext {
  const content = body;
  return {
    file: {
      path,
      status: 'modified',
      hunks: parseHunks(['@@ -1,1 +1,2 @@', ' a', '+b'].join('\n')),
      headContent: content,
      contentHash: sha256(content),
      language: 'typescript',
      additions: 1,
      deletions: 0,
    },
    numberedDiff: `--- ${path} ---\n+ 2 | b`,
    numberedHeadContent: content,
    symbolOutline: null,
    ripple: [],
    rules: [],
  };
}

/** Tokens proportional to length — enough to exercise packing deterministically. */
const counter = { count: async (text: string) => Math.ceil(text.length / 4) };

describe('planBatches', () => {
  test('every file lands in exactly one batch', async () => {
    const contexts = ['a', 'b', 'c', 'd'].map((name) => context(`src/${name}.ts`, 'x'.repeat(100)));
    const plan = await planBatches(contexts, {
      counter,
      systemTokens: 10,
      budgetTokens: 100_000,
      maxFilesPerBatch: 2,
    });

    const batched = plan.batches.flatMap((batch) => batch.files.map((file) => file.file.path));
    expect(batched.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    expect(new Set(batched).size).toBe(batched.length);
    expect(plan.batches.every((batch) => batch.files.length <= 2)).toBe(true);
  });

  test('respects the per-request token budget', async () => {
    const contexts = Array.from({ length: 6 }, (_, index) =>
      context(`src/${index}.ts`, 'x'.repeat(400)),
    );
    const plan = await planBatches(contexts, {
      counter,
      systemTokens: 50,
      budgetTokens: 400,
      maxFilesPerBatch: 10,
    });
    expect(plan.batches.length).toBeGreaterThan(1);
    expect(plan.shed).toHaveLength(0);
  });

  test('degrades a file that will not fit before shedding it', async () => {
    const big = context('src/big.ts', 'x'.repeat(20_000));
    const plan = await planBatches([big], {
      counter,
      systemTokens: 10,
      budgetTokens: 2_000,
      maxFilesPerBatch: 5,
    });
    // The head body is dropped for an outline rather than the file being skipped.
    expect(plan.shed).toHaveLength(0);
    expect(plan.degraded[0]).toMatchObject({ path: 'src/big.ts' });
    expect(plan.batches[0]!.files[0]!.numberedHeadContent).toBeNull();
  });

  test('sheds a file whose diff alone blows the budget, with a reason', async () => {
    const huge = context('src/huge.ts', 'x'.repeat(50));
    huge.numberedDiff = 'y'.repeat(40_000);
    const plan = await planBatches([huge], {
      counter,
      systemTokens: 10,
      budgetTokens: 1_100,
      maxFilesPerBatch: 5,
    });
    expect(plan.batches).toHaveLength(0);
    expect(plan.shed[0]!.path).toBe('src/huge.ts');
    expect(plan.shed[0]!.detail).toContain('per-request budget');
  });
});

describe('assertCoverage', () => {
  const contexts = [context('src/a.ts', 'a'), context('src/b.ts', 'b')];

  test('passes when every file appears once', () => {
    expect(() =>
      assertCoverage(contexts, [{ index: 0, files: contexts, estimatedInputTokens: 1 }], []),
    ).not.toThrow();
  });

  test('fails when a file was never batched', () => {
    expect(() =>
      assertCoverage(contexts, [{ index: 0, files: [contexts[0]!], estimatedInputTokens: 1 }], []),
    ).toThrow(CoverageError);
  });

  test('fails when a file was batched twice', () => {
    expect(() =>
      assertCoverage(
        contexts,
        [
          { index: 0, files: contexts, estimatedInputTokens: 1 },
          { index: 1, files: [contexts[1]!], estimatedInputTokens: 1 },
        ],
        [],
      ),
    ).toThrow(/more than once/);
  });

  test('a shed file is allowed to be absent', () => {
    expect(() =>
      assertCoverage(contexts, [{ index: 0, files: [contexts[0]!], estimatedInputTokens: 1 }], [
        { path: 'src/b.ts' },
      ]),
    ).not.toThrow();
  });
});
