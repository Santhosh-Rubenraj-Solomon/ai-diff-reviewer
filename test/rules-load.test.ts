import { describe, expect, test } from 'bun:test';
import { loadRules, parseRuleFile } from '../src/rules/load.ts';
import type { ChangeSet } from '../src/types.ts';
import { makeFakePlatform } from './helpers.ts';

const EMPTY: ChangeSet = {
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

const OPTS = { rulesDir: '.review', fileMaxBytes: 10 * 1024, totalMaxBytes: 50 * 1024 };

async function load(files: Record<string, string>, opts = OPTS) {
  return await loadRules(makeFakePlatform({ changeSet: EMPTY, targetFiles: files }), opts);
}

describe('parseRuleFile (edge cases)', () => {
  test('accepts CRLF line endings', () => {
    const parsed = parseRuleFile('---\r\nid: x\r\n---\r\nBody');
    expect(parsed.missingFrontmatter).toBe(false);
    expect(parsed.body).toBe('Body');
    expect(parsed.declaredGlobs).toBe(false);
  });

  test('throws on invalid YAML so the loader can name the file', () => {
    expect(() => parseRuleFile('---\nid: [unclosed\n---\nBody')).toThrow();
  });

  test('frontmatter that is a scalar does not count as declaring globs', () => {
    expect(parseRuleFile('---\njust a string\n---\nBody').declaredGlobs).toBe(false);
  });
});

describe('loadRules (error paths)', () => {
  test('ignores non-markdown files and accepts a trailing slash on the rules dir', async () => {
    const result = await load(
      { '.review/a.md': '---\nid: a\n---\nA', '.review/notes.txt': 'not a rule' },
      { ...OPTS, rulesDir: '.review/' },
    );
    expect(result.rules.map((rule) => rule.id)).toEqual(['a']);
    expect(result.errors).toEqual([]);
  });

  test('an unreadable rule file is an error, not a silent skip', async () => {
    const platform = makeFakePlatform({ changeSet: EMPTY, targetFiles: { '.review/a.md': 'x' } });
    platform.fetchFileFromTargetBranch = async () => null;
    const result = await loadRules(platform, OPTS);
    expect(result.errors).toEqual([{ sourcePath: '.review/a.md', message: 'could not be read from the target branch' }]);
  });

  test('invalid YAML is reported with the file name', async () => {
    const result = await load({ '.review/bad.md': '---\nid: [oops\n---\nBody' });
    expect(result.rules).toEqual([]);
    expect(result.errors[0]!.sourcePath).toBe('.review/bad.md');
    expect(result.errors[0]!.message).toStartWith('frontmatter is not valid YAML');
  });

  test('a file without frontmatter is rejected', async () => {
    const result = await load({ '.review/plain.md': 'Just prose.' });
    expect(result.errors[0]!.message).toContain('missing `---` frontmatter');
  });

  test('an empty body is rejected', async () => {
    const result = await load({ '.review/empty.md': '---\nid: empty\n---\n   \n' });
    expect(result.errors[0]!.message).toBe('rule body is empty');
  });

  test('ids must be lowercase kebab-case', async () => {
    const result = await load({ '.review/x.md': '---\nid: Bad_Id\n---\nBody' });
    expect(result.errors[0]!.message).toContain('id: must be lowercase kebab-case');
  });

  test('an unknown severity or non-integer priority is rejected', async () => {
    const result = await load({
      '.review/s.md': '---\nid: s\nseverity: urgent\n---\nBody',
      '.review/p.md': '---\nid: p\npriority: 1.5\n---\nBody',
    });
    expect(result.rules).toEqual([]);
    expect(result.errors.map((error) => error.sourcePath).sort()).toEqual(['.review/p.md', '.review/s.md']);
  });

  test('defaults severity to medium and priority to 0, and records byte size', async () => {
    const result = await load({ '.review/d.md': '---\nid: d\n---\nhéllo' });
    expect(result.rules[0]).toMatchObject({ severity: 'medium', priority: 0, global: true, bytes: 6 });
  });

  test('a rule exactly at the per-file limit is kept', async () => {
    const result = await load({ '.review/edge.md': `---\nid: edge\n---\n${'x'.repeat(10)}` }, { ...OPTS, fileMaxBytes: 10 });
    expect(result.rules).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  test('the budget skips a large rule but still admits a smaller lower-priority one', async () => {
    const result = await load(
      {
        '.review/big.md': `---\nid: big\npriority: 5\n---\n${'b'.repeat(80)}`,
        '.review/first.md': `---\nid: first\npriority: 9\n---\n${'f'.repeat(50)}`,
        '.review/small.md': `---\nid: small\npriority: 1\n---\n${'s'.repeat(20)}`,
      },
      { ...OPTS, totalMaxBytes: 100 },
    );
    expect(result.rules.map((rule) => rule.id)).toEqual(['first', 'small']);
    expect(result.dropped.map((entry) => entry.id)).toEqual(['big']);
    expect(result.dropped[0]!.reason).toContain('total rule budget of 100 bytes exhausted');
  });

  test('no rules at all yields a stable hash and empty lists', async () => {
    const a = await load({});
    const b = await load({});
    expect(a.rules).toEqual([]);
    expect(a.rulesHash).toBe(b.rulesHash);
    expect(a.rulesHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
