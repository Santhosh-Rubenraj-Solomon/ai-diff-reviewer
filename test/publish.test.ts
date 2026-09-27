import { describe, expect, test } from 'bun:test';
import { chunkMarkdown, neutralise, renderFindingBody } from '../src/publish/comments.ts';
import { fingerprint, normalizeEvidence } from '../src/publish/fingerprint.ts';
import type { Finding } from '../src/types.ts';

describe('fingerprint', () => {
  const base = {
    path: 'src/a.ts',
    evidence: '  if (x > y) {',
    category: 'bug' as const,
    ruleIds: ['money'],
  };

  test('is stable across re-indentation', () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base, evidence: 'if (x   >   y) {' }));
  });

  test('changes when the code changes', () => {
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, evidence: '  if (x >= y) {' }));
  });

  test('changes when the file changes', () => {
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, path: 'src/b.ts' }));
  });

  test('does not depend on rule id ordering', () => {
    expect(fingerprint({ ...base, ruleIds: ['a', 'b'] })).toBe(
      fingerprint({ ...base, ruleIds: ['b', 'a'] }),
    );
  });

  test('normalisation drops blank lines but keeps structure', () => {
    expect(normalizeEvidence('a\n\n  b  ')).toBe('a\nb');
  });
});

describe('neutralise', () => {
  test('defuses a GitLab quick action at the start of a line', () => {
    expect(neutralise('/approve')).toBe('&#47;approve');
  });

  test('leaves code comments inside a fence alone', () => {
    const body = ['```ts', '// a comment', '/approve', '```'].join('\n');
    expect(neutralise(body)).toBe(body);
  });

  test('breaks an @mention without hiding it', () => {
    const out = neutralise('cc @someone');
    expect(out).not.toBe('cc @someone');
    expect(out).toContain('someone');
  });
});

describe('chunkMarkdown', () => {
  test('returns a single chunk when it fits', () => {
    expect(chunkMarkdown('short', 100)).toEqual(['short']);
  });

  test('never splits inside a fenced code block', () => {
    const body = ['intro', '```', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), '```', 'tail'].join(
      '\n',
    );
    const chunks = chunkMarkdown(body, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = (chunk.match(/^```/gm) ?? []).length;
      expect(fences % 2).toBe(0);
    }
  });
});

describe('renderFindingBody', () => {
  const finding: Finding = {
    id: 'abc123',
    path: 'src/a.ts',
    line: 4,
    severity: 'critical',
    category: 'security',
    title: 'Add an authorisation check',
    body: 'Any caller can disable any account.',
    evidence: 'router.post(',
    ruleIds: ['api-authz'],
    confidence: 0.91,
  };

  test('embeds the fingerprint so a re-run can recognise its own comment', () => {
    const body = renderFindingBody(finding);
    expect(body).toContain('<!-- aidr:finding:abc123 -->');
    expect(body).toContain('Critical · security');
    expect(body).toContain('api-authz');
  });

  test('notes a corrected line rather than hiding the correction', () => {
    const body = renderFindingBody({ ...finding, lineCorrectedFrom: 9 });
    expect(body).toContain('line corrected from 9');
  });
});
