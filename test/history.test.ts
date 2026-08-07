import { describe, expect, test } from 'bun:test';
import { LOG_SEP } from '../src/git.ts';
import { formatHistoryForPrompt, mergeRanges, parseBlame, parseLog } from '../src/history.ts';
import type { HistoryContext } from '../src/types.ts';

describe('parseLog', () => {
  test('reads the separated fields', () => {
    const raw = [
      ['a'.repeat(40), 'aaaaaaa', '2026-01-02T03:04:05+00:00', 'Ada', 'fix: off-by-one in paging'].join(LOG_SEP),
      ['b'.repeat(40), 'bbbbbbb', '2025-12-01T00:00:00+00:00', 'Grace', 'feat: add paging'].join(LOG_SEP),
    ].join('\n');

    const commits = parseLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      date: '2026-01-02T03:04:05+00:00',
      author: 'Ada',
      subject: 'fix: off-by-one in paging',
    });
  });

  test('keeps separators that appear inside a subject', () => {
    const raw = ['c'.repeat(40), 'ccccccc', '2026-01-01T00:00:00Z', 'X', `a${LOG_SEP}b`].join(LOG_SEP);
    expect(parseLog(raw)[0]?.subject).toBe(`a${LOG_SEP}b`);
  });

  test('returns nothing for empty output', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('parseBlame', () => {
  const PORCELAIN = `${'a'.repeat(40)} 12 12 1
author Ada Lovelace
author-time 1767225600
summary fix: guard against null user
filename src/a.ts
\tconst user = getUser();
${'b'.repeat(40)} 13 13 1
author Grace Hopper
author-time 1735689600
summary feat: add user lookup
filename src/a.ts
\treturn user.name;
`;

  test('produces one entry per blamed line', () => {
    const entries = parseBlame(PORCELAIN);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.shortHash).toBe('a'.repeat(8));
    expect(entries[0]?.author).toBe('Ada Lovelace');
    expect(entries[0]?.subject).toBe('fix: guard against null user');
    expect(entries[0]?.line).toBe(12);
    expect(entries[1]?.line).toBe(13);
  });

  test('returns nothing when blame produced no output', () => {
    expect(parseBlame('')).toEqual([]);
  });
});

describe('mergeRanges', () => {
  test('merges overlapping and adjacent ranges', () => {
    expect(
      mergeRanges([
        { start: 10, end: 12 },
        { start: 13, end: 15 },
        { start: 1, end: 3 },
        { start: 2, end: 8 },
      ]),
    ).toEqual([
      { start: 1, end: 8 },
      { start: 10, end: 15 },
    ]);
  });

  test('leaves disjoint ranges alone', () => {
    expect(
      mergeRanges([
        { start: 1, end: 2 },
        { start: 20, end: 21 },
      ]),
    ).toEqual([
      { start: 1, end: 2 },
      { start: 20, end: 21 },
    ]);
  });

  test('does not mutate its input', () => {
    const input = [{ start: 5, end: 6 }];
    mergeRanges(input);
    expect(input).toEqual([{ start: 5, end: 6 }]);
  });

  test('handles the empty case', () => {
    expect(mergeRanges([])).toEqual([]);
  });
});

describe('formatHistoryForPrompt', () => {
  const base: HistoryContext = {
    path: 'src/a.ts',
    available: true,
    commits: [],
    blame: [{ shortHash: 'abcdef12', author: 'Ada', date: '', subject: 'fix: null guard', line: 12 }],
    totalCommits: 9,
    recentCommits: 4,
    priorFixes: ['fix: null guard'],
    reverts: ['Revert "feat: cache users"'],
    daysSinceLastTouch: 3,
    distinctBlameCommits: 2,
  };

  test('states plainly when there is no history', () => {
    const text = formatHistoryForPrompt({
      ...base,
      available: false,
      unavailableReason: 'new file — no prior history',
    });
    expect(text).toContain('No git history available');
    expect(text).toContain('new file');
    expect(text).toContain('do not infer history signals');
  });

  test('surfaces churn, prior fixes, reverts and blame', () => {
    const text = formatHistoryForPrompt(base);
    expect(text).toContain('9 commits');
    expect(text).toContain('4 within');
    expect(text).toContain('2 distinct commit(s)');
    expect(text).toContain('3 day(s) ago');
    expect(text).toContain('fix: null guard');
    expect(text).toContain('Revert "feat: cache users"');
    expect(text).toContain('12: abcdef12');
  });

  test('omits the recency clause when blame carried no dates', () => {
    const text = formatHistoryForPrompt({ ...base, daysSinceLastTouch: null });
    expect(text).not.toContain('day(s) ago');
  });
});
