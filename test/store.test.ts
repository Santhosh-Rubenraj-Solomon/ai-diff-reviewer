import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scopeKey, Store, type PostedComment } from '../src/store/db.ts';
import type { Finding, RunResult } from '../src/types.ts';

const SCOPE = { platform: 'gitlab', projectId: 'group/a', requestId: '12' };
const OTHER = { platform: 'gitlab', projectId: 'group/b', requestId: '12' };

function comment(overrides: Partial<PostedComment> = {}): PostedComment {
  return {
    fingerprint: 'fp1',
    commentId: '100',
    threadId: 't1',
    fallback: false,
    headSha: 'h1',
    resolved: false,
    ...overrides,
  };
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'run-1',
    status: 'completed',
    platform: 'gitlab',
    projectId: 'group/a',
    requestId: '12',
    headSha: 'h1',
    model: 'claude-sonnet-5',
    judgeModel: null,
    promptVersion: 'v1',
    rulesHash: 'rh',
    filesReviewed: ['a.ts'],
    filesSkipped: [],
    findingsPosted: [],
    findingsDropped: [],
    degradations: [],
    costUsd: 0.12,
    durationMs: 1234,
    errors: [],
    ...overrides,
  };
}

describe('scopeKey', () => {
  test('includes platform, project and request so identical MR numbers do not collide', () => {
    expect(scopeKey(SCOPE)).toBe('gitlab:group/a:12');
    expect(scopeKey(SCOPE)).not.toBe(scopeKey(OTHER));
  });
});

describe('Store', () => {
  test('file cache round-trips findings and misses cleanly', () => {
    const store = new Store(':memory:');
    const findings = [{ id: 'x', path: 'a.ts' } as Finding];
    expect(store.cacheGet('k')).toBeNull();
    store.cachePut('k', findings);
    expect(store.cacheGet('k')).toEqual(findings);
    store.cachePut('k', []);
    expect(store.cacheGet('k')).toEqual([]);
    store.close();
  });

  test('comments are scoped, replaceable, and booleans survive the round trip', () => {
    const store = new Store(':memory:');
    store.putComment(SCOPE, comment());
    store.putComment(SCOPE, comment({ fingerprint: 'fp2', threadId: null, fallback: true }));
    store.putComment(OTHER, comment({ commentId: 'other' }));

    expect(store.getComment(SCOPE, 'fp1')).toEqual(comment());
    expect(store.getComment(SCOPE, 'fp2')).toMatchObject({ threadId: null, fallback: true });
    expect(store.getComment(SCOPE, 'missing')).toBeNull();
    expect(store.listComments(SCOPE)).toHaveLength(2);
    expect(store.getComment(OTHER, 'fp1')!.commentId).toBe('other');

    store.putComment(SCOPE, comment({ commentId: '101', headSha: 'h2' }));
    expect(store.getComment(SCOPE, 'fp1')).toMatchObject({ commentId: '101', headSha: 'h2' });
    expect(store.listComments(SCOPE)).toHaveLength(2);
    store.close();
  });

  test('markResolved only affects the named scope and fingerprint', () => {
    const store = new Store(':memory:');
    store.putComment(SCOPE, comment());
    store.putComment(OTHER, comment());
    store.markResolved(SCOPE, 'fp1');
    expect(store.getComment(SCOPE, 'fp1')!.resolved).toBe(true);
    expect(store.getComment(OTHER, 'fp1')!.resolved).toBe(false);
    store.markResolved(SCOPE, 'nope'); // no-op, no throw
    store.close();
  });

  test('one summary id per scope, overwritten in place', () => {
    const store = new Store(':memory:');
    expect(store.getSummaryId(SCOPE)).toBeNull();
    store.setSummaryId(SCOPE, 's1');
    store.setSummaryId(SCOPE, 's2');
    expect(store.getSummaryId(SCOPE)).toBe('s2');
    expect(store.getSummaryId(OTHER)).toBeNull();
    store.close();
  });

  test('runs round-trip their full payload and list newest first with a limit', async () => {
    const store = new Store(':memory:');
    expect(store.getRun('missing')).toBeNull();
    const first = run({ runId: 'r1', degradations: ['context engine off'] });
    store.saveRun(first);
    await Bun.sleep(5);
    store.saveRun(run({ runId: 'r2', status: 'partial', headSha: 'h2' }));
    await Bun.sleep(5);
    store.saveRun(run({ runId: 'r3' }));

    expect(store.getRun('r1')).toEqual(first);
    const listed = store.listRuns(2);
    expect(listed.map((row) => row.runId)).toEqual(['r3', 'r2']);
    expect(listed[1]).toMatchObject({ status: 'partial', headSha: 'h2' });
    expect(Date.parse(listed[0]!.createdAt)).not.toBeNaN();
    store.close();
  });

  test('creates the parent directory for an on-disk database and persists across reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidr-store-'));
    try {
      const path = join(dir, 'nested', 'deeper', 'state.sqlite');
      const store = new Store(path);
      store.setSummaryId(SCOPE, 'persisted');
      store.close();
      expect(existsSync(path)).toBe(true);

      const reopened = new Store(path); // migrations are idempotent
      expect(reopened.getSummaryId(SCOPE)).toBe('persisted');
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
