import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregate,
  LINE_TOLERANCE,
  overlap,
  scoreCase,
  tokenMatcher,
  tokens,
  type CaseScore,
  type TextMatcher,
} from '../evals/score.ts';
import { applyMutation, buildMutationCases, MUTATIONS, unifiedDiffForSingleLine, type Mutation } from '../evals/mutate.ts';
import { EvalCaseSchema, loadCases, toChangeSet, type EvalCase } from '../evals/case.ts';
import { addedLines, parseHunks } from '../src/diff/parse.ts';
import type { Finding } from '../src/types.ts';

const EVALS_DIR = join(import.meta.dir, '..', 'evals');

function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return EvalCaseSchema.parse({
    id: 'c1',
    split: 'train',
    title: 't',
    files: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-a\n+b', headContent: 'b' }],
    expected: [
      { path: 'src/a.ts', line: 10, description: 'refund amount compared in the wrong currency unit', injected: true },
      { path: 'src/a.ts', line: 40, description: 'ledger write is not awaited' },
    ],
    forbidden: [
      { match: 'naming', why: 'style noise' },
      { match: '/consider\\s+adding\\s+logs/', why: 'generic advice' },
      { match: 'tests', why: 'only in other file', path: 'src/other.ts' },
    ],
    ...overrides,
  });
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: Math.random().toString(36),
    path: 'src/a.ts',
    line: 10,
    severity: 'high',
    category: 'bug',
    title: 'Currency unit mismatch',
    body: 'The refund amount uses the wrong unit.',
    evidence: 'x',
    ruleIds: [],
    confidence: 0.9,
    ...overrides,
  };
}

describe('tokens / overlap', () => {
  test('lowercases, strips punctuation, drops stopwords and short words', () => {
    expect([...tokens('The Refund, is NOT awaited!! a db')]).toEqual(['refund', 'awaited']);
  });

  test('overlap is the overlap coefficient and 0 when either side is empty', () => {
    expect(overlap('refund amount wrong', 'refund amount')).toBe(1);
    expect(overlap('refund amount', 'ledger write')).toBe(0);
    expect(overlap('', 'refund')).toBe(0);
    expect(overlap('the a an', 'refund')).toBe(0);
  });

  test('tokenMatcher applies the threshold', async () => {
    expect(await tokenMatcher.similar('refund unit mismatch', 'unit mismatch on refund')).toBe(true);
    expect(await tokenMatcher.similar('refund unit mismatch', 'completely unrelated words')).toBe(false);
  });
});

describe('scoreCase', () => {
  const opts = { costUsd: 0.1, durationMs: 1000 };

  test('matches by path, line tolerance and text similarity', async () => {
    const score = await scoreCase(evalCase(), [finding({ line: 10 + LINE_TOLERANCE })], opts);
    expect(score.matched).toHaveLength(1);
    expect(score.matchedInjected).toBe(1);
    expect(score.missed.map((e) => e.line)).toEqual([40]);
    expect(score.unmatched).toEqual([]);
    expect(score).toMatchObject({ expectedTotal: 2, expectedInjected: 1, postedTotal: 1, costUsd: 0.1, durationMs: 1000 });
  });

  test('a finding just outside the line tolerance does not match', async () => {
    const score = await scoreCase(evalCase(), [finding({ line: 10 + LINE_TOLERANCE + 1 })], opts);
    expect(score.matched).toHaveLength(0);
    expect(score.unmatched).toHaveLength(1);
  });

  test('a finding in the wrong file does not match', async () => {
    const score = await scoreCase(evalCase(), [finding({ path: 'src/b.ts' })], opts);
    expect(score.matched).toHaveLength(0);
  });

  test('one finding cannot satisfy two expectations', async () => {
    const c = evalCase({
      expected: [
        { path: 'src/a.ts', line: 10, description: 'currency unit mismatch' },
        { path: 'src/a.ts', line: 11, description: 'currency unit mismatch again' },
      ],
    });
    const score = await scoreCase(c, [finding()], opts);
    expect(score.matched).toHaveLength(1);
    expect(score.missed).toHaveLength(1);
  });

  test('uses a custom matcher when given', async () => {
    const always: TextMatcher = { name: 'always', similar: async () => true };
    const score = await scoreCase(evalCase(), [finding({ title: 'zzz', body: 'qqq', line: 40 })], { ...opts, matcher: always });
    expect(score.matched.map((e) => e.line)).toEqual([40]);
  });

  test('flags noise by substring and by /regex/, respecting a path restriction', async () => {
    const score = await scoreCase(
      evalCase(),
      [
        finding({ title: 'Improve NAMING here', line: 99 }),
        finding({ title: 'x', body: 'Consider   adding logs', line: 98 }),
        finding({ title: 'missing tests', line: 97 }), // forbidden only in src/other.ts
      ],
      opts,
    );
    expect(score.noise.map((n) => n.why)).toEqual(['style noise', 'generic advice']);
  });
});

describe('aggregate', () => {
  function score(overrides: Partial<CaseScore>): CaseScore {
    return {
      caseId: 'c',
      split: 'train',
      expectedTotal: 0,
      expectedInjected: 0,
      matched: [],
      matchedInjected: 0,
      missed: [],
      unmatched: [],
      noise: [],
      postedTotal: 0,
      costUsd: 0,
      durationMs: 0,
      ...overrides,
    };
  }

  test('no cases gives null ratios and zero rates rather than NaN', () => {
    const metrics = aggregate([]);
    expect(metrics).toMatchObject({
      cases: 0,
      recallInjected: null,
      recallAll: null,
      precisionStrict: null,
      noisePerCase: 0,
      costPerCaseP50: 0,
      findingsPerCase: 0,
    });
  });

  test('computes recall, precision, noise and percentiles across cases', () => {
    const exp = { path: 'a', line: 1, description: 'd' };
    const metrics = aggregate([
      score({ expectedTotal: 2, expectedInjected: 1, matched: [exp], matchedInjected: 1, postedTotal: 2, costUsd: 0.1, durationMs: 100 }),
      score({ expectedTotal: 2, expectedInjected: 1, matched: [], postedTotal: 0, costUsd: 0.3, durationMs: 300, noise: [{ finding: finding(), why: 'x' }] }),
      score({ costUsd: 0.2, durationMs: 200 }),
    ]);
    expect(metrics.cases).toBe(3);
    expect(metrics.recallInjected).toBe(0.5);
    expect(metrics.recallAll).toBe(0.25);
    expect(metrics.precisionStrict).toBe(0.5);
    expect(metrics.noisePerCase).toBeCloseTo(1 / 3);
    expect(metrics.costPerCaseP50).toBe(0.2);
    expect(metrics.costPerCaseP90).toBe(0.3);
    expect(metrics.latencyP50Ms).toBe(200);
    expect(metrics.findingsPerCase).toBeCloseTo(2 / 3);
  });
});

describe('mutations', () => {
  const source = ['a', 'b', 'c', 'TARGET', 'e', 'f', 'g', 'h'].join('\n');
  const mutation = (replace: string | null): Mutation => ({
    id: 'm',
    fixture: 'x',
    path: 'src/x.ts',
    kind: 'k',
    find: 'TARGET',
    replace,
    expected: 'e',
    severity: 'high',
  });

  test('a replacement edits exactly one line and the diff parses to an add at that line', () => {
    const applied = applyMutation(source, mutation('CHANGED'))!;
    expect(applied.line).toBe(4);
    expect(applied.mutated.split('\n')[3]).toBe('CHANGED');
    const hunks = parseHunks(applied.diff);
    expect([...addedLines(hunks)]).toEqual([4]);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 7, newStart: 1, newLines: 7 });
  });

  test('a deletion anchors to the surviving line before it', () => {
    const applied = applyMutation(source, mutation(null))!;
    expect(applied.mutated.split('\n')).not.toContain('TARGET');
    expect(applied.line).toBe(3);
    expect(applied.diff.split('\n')[0]).toBe('@@ -1,7 +1,6 @@');
  });

  test('deleting the first line anchors to line 1', () => {
    expect(applyMutation('TARGET\nb', mutation(null))!.line).toBe(1);
  });

  test('a find that does not match exactly returns null', () => {
    expect(applyMutation('  TARGET', mutation('x'))).toBeNull();
  });

  test('unifiedDiffForSingleLine clamps context at the file edges', () => {
    expect(unifiedDiffForSingleLine(['only'], 0, 'new')).toBe('@@ -1,1 +1,1 @@\n-only\n+new');
  });

  test('every shipped mutation still applies to its clean fixture, with alternating splits', async () => {
    const cases = await buildMutationCases(join(EVALS_DIR, 'clean'));
    expect(cases).toHaveLength(MUTATIONS.length);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.filter((c) => c.split === 'holdout').length).toBe(Math.floor(MUTATIONS.length / 2));
    for (const c of cases) {
      const cs = toChangeSet(c);
      const file = cs.files[0]!;
      const line = c.expected[0]!.line;
      // The expected line exists in the mutated head content.
      expect(line).toBeGreaterThanOrEqual(1);
      expect(line).toBeLessThanOrEqual(file.headContent!.split('\n').length);
    }
  });

  test('a drifted anchor is a loud error, not a skipped case', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidr-mut-'));
    try {
      for (const fixture of new Set(MUTATIONS.map((m) => m.fixture))) {
        await writeFile(join(dir, fixture), 'nothing matches here\n');
      }
      await expect(buildMutationCases(dir)).rejects.toThrow('no longer match their fixture');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('case loading', () => {
  test('every shipped golden case parses and converts to a change set', async () => {
    const cases = await loadCases(join(EVALS_DIR, 'cases'));
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const cs = toChangeSet(c);
      expect(cs.requestId).toBe(c.id);
      expect(cs.files.length).toBe(c.files.length);
    }
  });

  test('applies schema defaults', () => {
    const c = EvalCaseSchema.parse({ id: 'x', split: 'holdout', title: 't', files: [{ path: 'a.md', diff: '', headContent: null }] });
    expect(c).toMatchObject({ description: '', targetBranch: 'main', expected: [], forbidden: [], stubFindings: [] });
    expect(c.files[0]!.status).toBe('modified');
  });

  test('an invalid case file names itself in the error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidr-cases-'));
    try {
      await writeFile(join(dir, 'broken.json'), JSON.stringify({ id: 'x', split: 'nope', title: 't', files: [] }));
      await writeFile(join(dir, 'ignored.txt'), 'not json');
      await expect(loadCases(dir)).rejects.toThrow('broken.json is not a valid eval case');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a missing cases directory yields no cases', async () => {
    expect(await loadCases(join(tmpdir(), 'definitely-missing-aidr-dir'))).toEqual([]);
  });

  test('toChangeSet carries oldPath and hashes null content as empty', () => {
    const c = EvalCaseSchema.parse({
      id: 'x',
      split: 'train',
      title: 't',
      files: [{ path: 'b.ts', status: 'renamed', oldPath: 'a.ts', diff: '@@ -1 +1 @@\n-a\n+b', headContent: null }],
    });
    const file = toChangeSet(c).files[0]!;
    expect(file.oldPath).toBe('a.ts');
    expect(file.contentHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(file.additions).toBe(1);
  });
});
