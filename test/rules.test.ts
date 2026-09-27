import { describe, expect, test } from 'bun:test';
import { loadRules, parseRuleFile } from '../src/rules/load.ts';
import { matchCounts, ruleMatches, rulesForPath } from '../src/rules/match.ts';
import type { Rule } from '../src/types.ts';
import { makeFakePlatform } from './helpers.ts';
import type { ChangeSet } from '../src/types.ts';

const EMPTY_CHANGESET: ChangeSet = {
  platform: 'local',
  projectId: 'p',
  requestId: 'r',
  title: '',
  description: '',
  baseSha: 'a',
  startSha: 'a',
  headSha: 'b',
  targetBranch: 'main',
  files: [],
  skipped: [],
};

function rule(partial: Partial<Rule>): Rule {
  return {
    id: 'r',
    globs: [],
    global: false,
    severity: 'medium',
    priority: 0,
    body: 'body',
    sourcePath: '.review/r.md',
    bytes: 4,
    ...partial,
  };
}

async function load(files: Record<string, string>, overrides: Partial<Parameters<typeof loadRules>[1]> = {}) {
  const platform = makeFakePlatform({ changeSet: EMPTY_CHANGESET, targetFiles: files });
  return await loadRules(platform, {
    rulesDir: '.review',
    fileMaxBytes: 10 * 1024,
    totalMaxBytes: 50 * 1024,
    ...overrides,
  });
}

describe('parseRuleFile', () => {
  test('separates frontmatter from body and records that globs were declared', () => {
    const parsed = parseRuleFile('---\nid: x\nglobs: ["a/**"]\n---\nBody text');
    expect(parsed.declaredGlobs).toBe(true);
    expect(parsed.body).toBe('Body text');
  });

  test('notices a document with no frontmatter', () => {
    expect(parseRuleFile('Just a body').missingFrontmatter).toBe(true);
  });
});

describe('loadRules', () => {
  test('loads a well-formed scoped rule', async () => {
    const result = await load({
      '.review/money.md': '---\nid: payments-money\nglobs: ["src/payments/**/*.ts"]\nseverity: high\n---\nMoney is minor units.',
    });
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({ id: 'payments-money', global: false, severity: 'high' });
  });

  test('a rule with no globs key is global', async () => {
    const result = await load({ '.review/all.md': '---\nid: everywhere\n---\nApplies broadly.' });
    expect(result.rules[0]!.global).toBe(true);
  });

  test('a malformed globs line is rejected, never promoted to global', async () => {
    // This is the reference bug: `globs:` parsing to [] and meaning "everywhere".
    const result = await load({ '.review/bad.md': '---\nid: broken\nglobs:\n---\nBody.' });
    expect(result.rules).toHaveLength(0);
    expect(result.errors[0]!.message).toContain('globs');
    expect(result.errors[0]!.sourcePath).toBe('.review/bad.md');
  });

  test('an empty globs array is rejected too', async () => {
    const result = await load({ '.review/bad.md': '---\nid: broken\nglobs: []\n---\nBody.' });
    expect(result.rules).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  test('rejects a missing id and names the file', async () => {
    const result = await load({ '.review/x.md': '---\nseverity: high\n---\nBody.' });
    expect(result.errors[0]!.sourcePath).toBe('.review/x.md');
    expect(result.errors[0]!.message).toContain('id');
  });

  test('rejects duplicate ids', async () => {
    const result = await load({
      '.review/a.md': '---\nid: dup\n---\nA.',
      '.review/b.md': '---\nid: dup\n---\nB.',
    });
    expect(result.rules).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('duplicate rule id');
  });

  test('an oversized rule is dropped loudly, not skipped silently', async () => {
    const result = await load(
      { '.review/big.md': `---\nid: big\n---\n${'x'.repeat(200)}` },
      { fileMaxBytes: 50 },
    );
    expect(result.rules).toHaveLength(0);
    expect(result.dropped[0]!.reason).toContain('per-file limit');
  });

  test('the total budget drops by declared priority, not directory order', async () => {
    const body = 'y'.repeat(60);
    const result = await load(
      {
        '.review/a-low.md': `---\nid: low\npriority: 1\n---\n${body}`,
        '.review/z-high.md': `---\nid: high\npriority: 9\n---\n${body}`,
      },
      { totalMaxBytes: 70 },
    );
    expect(result.rules.map((entry) => entry.id)).toEqual(['high']);
    expect(result.dropped[0]!.id).toBe('low');
  });

  test('the rules hash is order-independent but content-sensitive', async () => {
    const first = await load({
      '.review/a.md': '---\nid: a\n---\nA.',
      '.review/b.md': '---\nid: b\n---\nB.',
    });
    const same = await load({
      '.review/b.md': '---\nid: b\n---\nB.',
      '.review/a.md': '---\nid: a\n---\nA.',
    });
    const changed = await load({
      '.review/a.md': '---\nid: a\n---\nA changed.',
      '.review/b.md': '---\nid: b\n---\nB.',
    });
    expect(first.rulesHash).toBe(same.rulesHash);
    expect(first.rulesHash).not.toBe(changed.rulesHash);
  });
});

describe('matching', () => {
  test('a controller glob matches a nested controller', () => {
    // The reference converts globs by hand and `*` never crosses `/`, so its
    // own built-in security rule silently matches nothing.
    const controllers = rule({ id: 'c', globs: ['**/*.controller.ts'] });
    expect(ruleMatches(controllers, 'src/users/users.controller.ts')).toBe(true);
    expect(ruleMatches(controllers, 'users.controller.ts')).toBe(true);
    expect(ruleMatches(controllers, 'src/users/users.service.ts')).toBe(false);
  });

  test('scoped rules come before global ones, highest priority first', () => {
    const rules = [
      rule({ id: 'global', global: true }),
      rule({ id: 'scoped-low', globs: ['src/**'], priority: 1 }),
      rule({ id: 'scoped-high', globs: ['src/**'], priority: 5 }),
    ];
    expect(rulesForPath(rules, 'src/a.ts').map((entry) => entry.id)).toEqual([
      'scoped-high',
      'scoped-low',
      'global',
    ]);
  });

  test('match counts expose a rule that matches nothing', () => {
    const counts = matchCounts([rule({ id: 'dead', globs: ['nope/**'] })], ['src/a.ts']);
    expect(counts.get('dead')).toBe(0);
  });
});
