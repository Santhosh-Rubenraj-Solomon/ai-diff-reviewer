import { describe, expect, test } from 'bun:test';
import {
  addUsage,
  contextWindow,
  emptyUsage,
  isPriced,
  PRICING,
  priceUsd,
} from '../src/review/pricing.ts';
import {
  clampFinding,
  ModelFindingSchema,
  ReviewSchema,
  VerdictSchema,
  type ModelFinding,
} from '../src/review/schema.ts';
import { fingerprint, normalizeEvidence, sha256, withFingerprint } from '../src/publish/fingerprint.ts';
import { mapPool, withDeadline } from '../src/pool.ts';

describe('pricing', () => {
  test('an unknown model has no price rather than a zero price', () => {
    expect(isPriced('gpt-imaginary')).toBe(false);
    expect(priceUsd('gpt-imaginary', { inputTokens: 1_000_000, outputTokens: 0 })).toBeNull();
  });

  test('prices input and output per million tokens', () => {
    const cost = priceUsd('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(3 + 15, 10);
  });

  test('cache reads bill at 0.1x input and cache writes at 1.25x input', () => {
    const cost = priceUsd('claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1 * 0.1 + 1 * 1.25, 10);
  });

  test('zero usage costs zero for a known model', () => {
    expect(priceUsd('claude-opus-5', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  test('every priced model has a positive context window and non-negative prices', () => {
    for (const [model, price] of Object.entries(PRICING)) {
      expect(price.contextTokens).toBeGreaterThan(0);
      expect(price.inputPerMTok).toBeGreaterThanOrEqual(0);
      expect(price.outputPerMTok).toBeGreaterThanOrEqual(0);
      expect(contextWindow(model)).toBe(price.contextTokens);
    }
  });

  test('context window falls back to 200k for an unknown model', () => {
    expect(contextWindow('nope')).toBe(200_000);
  });

  test('addUsage sums every field and treats missing fields as zero', () => {
    const total = addUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUsd: 0.5 },
      { inputTokens: 10, costUsd: 0.25 },
    );
    expect(total).toEqual({
      inputTokens: 11,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      costUsd: 0.75,
    });
  });

  test('emptyUsage returns a fresh object each time', () => {
    const a = emptyUsage();
    a.inputTokens = 99;
    expect(emptyUsage().inputTokens).toBe(0);
  });
});

function modelFinding(overrides: Partial<ModelFinding> = {}): ModelFinding {
  return {
    path: 'src/a.ts',
    line: 3,
    severity: 'high',
    category: 'bug',
    title: 'Fix it',
    body: 'Because.',
    evidence: '  x = 1;',
    ruleIds: [],
    confidence: 0.8,
    ...overrides,
  };
}

describe('schemas', () => {
  test('ModelFindingSchema rejects an unknown severity and a fractional line', () => {
    expect(ModelFindingSchema.safeParse(modelFinding({ severity: 'urgent' as never })).success).toBe(false);
    expect(ModelFindingSchema.safeParse(modelFinding({ line: 2.5 })).success).toBe(false);
  });

  test('ReviewSchema accepts an empty findings array and optional notes', () => {
    expect(ReviewSchema.safeParse({ findings: [] }).success).toBe(true);
    expect(ReviewSchema.safeParse({ findings: [], notes: null }).success).toBe(true);
    expect(ReviewSchema.safeParse({}).success).toBe(false);
  });

  test('VerdictSchema only accepts keep or drop', () => {
    expect(VerdictSchema.safeParse({ verdict: 'keep', reason: 'ok' }).success).toBe(true);
    expect(VerdictSchema.safeParse({ verdict: 'maybe', reason: 'ok' }).success).toBe(false);
  });
});

describe('clampFinding', () => {
  test('strips a leading ./ and truncates the line to an integer of at least 1', () => {
    const out = clampFinding(modelFinding({ path: './src/a.ts', line: -4 }));
    expect(out.path).toBe('src/a.ts');
    expect(out.line).toBe(1);
  });

  test('collapses whitespace in the title and caps it at 120 characters with an ellipsis', () => {
    expect(clampFinding(modelFinding({ title: '  Fix   the\n bug ' })).title).toBe('Fix the bug');
    const long = clampFinding(modelFinding({ title: 'x'.repeat(300) })).title;
    expect(long).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });

  test('a title of exactly 120 characters is not truncated', () => {
    expect(clampFinding(modelFinding({ title: 'y'.repeat(120) })).title).toBe('y'.repeat(120));
  });

  test('clamps confidence into [0, 1]', () => {
    expect(clampFinding(modelFinding({ confidence: 7 })).confidence).toBe(1);
    expect(clampFinding(modelFinding({ confidence: -1 })).confidence).toBe(0);
  });

  test('dedupes and trims rule ids, dropping blanks', () => {
    expect(clampFinding(modelFinding({ ruleIds: [' a', 'a', '', '  ', 'b '] })).ruleIds).toEqual(['a', 'b']);
  });

  test('endLine is never before line, and is omitted when null', () => {
    expect(clampFinding(modelFinding({ line: 10, endLine: 4 })).endLine).toBe(10);
    expect(clampFinding(modelFinding({ line: 10, endLine: 12 })).endLine).toBe(12);
    expect('endLine' in clampFinding(modelFinding({ endLine: null }))).toBe(false);
  });

  test('keeps evidence verbatim, including indentation', () => {
    expect(clampFinding(modelFinding({ evidence: '\t  x = 1;  ' })).evidence).toBe('\t  x = 1;  ');
  });

  test('omits an empty or null suggestion', () => {
    expect('suggestion' in clampFinding(modelFinding({ suggestion: '' }))).toBe(false);
    expect('suggestion' in clampFinding(modelFinding({ suggestion: null }))).toBe(false);
    expect(clampFinding(modelFinding({ suggestion: 'do this' })).suggestion).toBe('do this');
  });
});

describe('fingerprint (extra)', () => {
  test('sha256 is the standard hex digest', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('changes with category', () => {
    const base = { path: 'a.ts', evidence: 'x', category: 'bug' as const, ruleIds: [] };
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, category: 'security' }));
  });

  test('is 32 hex characters', () => {
    expect(fingerprint({ path: 'a', evidence: 'b', category: 'bug', ruleIds: [] })).toMatch(/^[0-9a-f]{32}$/);
  });

  test('normalisation collapses tabs and CRLF-trailing whitespace', () => {
    expect(normalizeEvidence('\tif (a)\t{\r\n  b();\r')).toBe('if (a) {\nb();');
  });

  test('withFingerprint sets the id from the identity fields, not the title', () => {
    const finding = {
      path: 'a.ts',
      line: 1,
      severity: 'low' as const,
      category: 'bug' as const,
      title: 'one wording',
      body: '',
      evidence: 'x()',
      ruleIds: [],
      confidence: 1,
    };
    const a = withFingerprint(finding);
    const b = withFingerprint({ ...finding, title: 'a completely different wording', line: 40 });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(fingerprint(finding));
  });
});

describe('mapPool', () => {
  test('preserves input order in the results', async () => {
    const out = await mapPool([30, 10, 20], 3, async (ms, index) => {
      await Bun.sleep(ms);
      return index;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  test('never runs more than `limit` workers at once', async () => {
    let active = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(2);
      active -= 1;
    });
    expect(peak).toBe(3);
  });

  test('handles an empty input and a non-positive limit', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
    expect(await mapPool([1, 2], 0, async (x) => x * 2)).toEqual([2, 4]);
  });

  test('rejects when a worker throws', async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('withDeadline', () => {
  test('resolves with the value when the promise wins', async () => {
    expect(await withDeadline(Promise.resolve('ok'), 1_000, () => 'late')).toBe('ok');
  });

  test('resolves with onTimeout when the deadline wins', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 200));
    expect(await withDeadline(slow, 5, () => 'timed-out')).toBe('timed-out');
  });

  test('propagates a rejection that arrives before the deadline', async () => {
    await expect(withDeadline(Promise.reject(new Error('nope')), 1_000, () => 'x')).rejects.toThrow('nope');
  });
});
