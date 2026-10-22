import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GithubPlatform } from '../src/platform/github.ts';
import { configureLogger } from '../src/logger.ts';
import type { ChangeSet, Finding } from '../src/types.ts';
import { jsonResponse, mockFetch, type FetchCall } from './helpers.ts';

configureLogger({ quiet: true });

const API = 'https://api.github.com';
const HEAD = 'h'.repeat(40);
const BASE = 'b'.repeat(40);

const PR = {
  number: 7,
  title: 'Add refunds',
  body: null,
  html_url: 'https://github.com/acme/shop/pull/7',
  base: { sha: BASE, ref: 'main', repo: { full_name: 'acme/shop' } },
  head: { sha: HEAD, ref: 'feature', repo: { full_name: 'fork/shop' } },
};

const FILES = [
  { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b', additions: 1, deletions: 0 },
  { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', patch: '@@ -1 +1 @@\n-x\n+y', additions: 1, deletions: 1 },
  { filename: 'src/removed.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-x', additions: 0, deletions: 1 },
  { filename: 'logo.svg', status: 'added', additions: 0, deletions: 0 },
  { filename: 'yarn.lock', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1 },
  { filename: 'src/ghost.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1 },
];

const CONTENT: Record<string, string> = {
  'src/a.ts': 'a\nb',
  'src/new.ts': 'y',
  'logo.svg': '<svg/>',
  'yarn.lock': 'b',
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function platform(apiUrl = API): GithubPlatform {
  return new GithubPlatform({ apiUrl, token: 'tkn', projectId: 'acme/shop', requestId: '7', maxFileBytes: 100_000 });
}

function route(handler: (url: string, init: RequestInit) => Response | null): FetchCall[] {
  const mock = mockFetch((url, init) => {
    const custom = handler(url, init);
    if (custom) return custom;
    if (url === `${API}/repos/acme/shop/pulls/7`) return jsonResponse(PR);
    return new Response('not found', { status: 404 });
  });
  restore = mock.restore;
  return mock.calls;
}

function finding(): Finding {
  return {
    id: 'f',
    path: 'src/a.ts',
    line: 2,
    severity: 'high',
    category: 'bug',
    title: 't',
    body: 'b',
    evidence: 'b',
    ruleIds: [],
    confidence: 1,
  };
}

describe('GithubPlatform.fetchChangeSet', () => {
  test('builds a pinned change set, reading content from the fork at head.sha', async () => {
    const calls = route((url) => {
      if (url.startsWith(`${API}/repos/acme/shop/pulls/7/files`)) return jsonResponse(FILES);
      const match = /\/repos\/fork\/shop\/contents\/(.+)\?ref=(.+)$/.exec(url);
      if (match) {
        expect(match[2]).toBe(HEAD);
        const path = decodeURIComponent(match[1]!);
        return path in CONTENT ? new Response(CONTENT[path]) : null;
      }
      return null;
    });

    const cs = await platform().fetchChangeSet();

    expect(cs).toMatchObject({
      platform: 'github',
      projectId: 'acme/shop',
      requestId: '7',
      title: 'Add refunds',
      description: '',
      baseSha: BASE,
      startSha: BASE,
      headSha: HEAD,
      targetBranch: 'main',
      webUrl: PR.html_url,
    });
    expect(cs.files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/new.ts', 'renamed'],
    ]);
    expect(cs.files[1]!.oldPath).toBe('src/old.ts');
    expect(cs.files[0]!.additions).toBe(1);
    expect(cs.files[0]!.language).toBe('typescript');

    const skipped = Object.fromEntries(cs.skipped.map((s) => [s.path, s.reason]));
    expect(skipped).toEqual({
      'src/removed.ts': 'deleted',
      'logo.svg': 'binary', // GitHub omitted the patch
      'yarn.lock': 'lockfile',
      'src/ghost.ts': 'no-content', // 404 at head
    });

    // The PR is fetched exactly once, not per file.
    expect(calls.filter((c) => c.url === `${API}/repos/acme/shop/pulls/7`)).toHaveLength(1);
    // No content read is made by branch name.
    expect(calls.some((c) => c.url.includes('ref=feature'))).toBe(false);
    // Removed files are never fetched.
    expect(calls.some((c) => c.url.includes('removed.ts'))).toBe(false);
    // Auth header is sent.
    expect(calls[0]!.headers.authorization).toBe('Bearer tkn');
  });

  test('a same-repo PR (head.repo null) reads from the base project', async () => {
    const calls = route((url) => {
      if (url === `${API}/repos/acme/shop/pulls/7`) return jsonResponse({ ...PR, head: { ...PR.head, repo: null } });
      if (url.includes('/pulls/7/files')) return jsonResponse([FILES[0]]);
      if (url.includes('/repos/acme/shop/contents/')) return new Response('a\nb');
      return null;
    });
    const cs = await platform().fetchChangeSet();
    expect(cs.files).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('/repos/fork/'))).toBe(false);
  });

  test('a failing PR fetch rejects rather than returning an empty change set', async () => {
    route((url) => (url.endsWith('/pulls/7') ? new Response('nope', { status: 401 }) : null));
    await expect(platform().fetchChangeSet()).rejects.toMatchObject({ status: 401 });
  });
});

describe('GithubPlatform reads', () => {
  test('fetchFileAtSha requests the raw media type and encodes path segments', async () => {
    const calls = route((url) => (url.includes('/contents/') ? new Response('body') : null));
    expect(await platform().fetchFileAtSha('dir with space/a#b.ts', 'abc')).toBe('body');
    const call = calls.find((c) => c.url.includes('/contents/'))!;
    expect(call.url).toBe(`${API}/repos/fork/shop/contents/dir%20with%20space/a%23b.ts?ref=abc`);
    expect(call.headers.accept).toBe('application/vnd.github.raw');
  });

  test('fetchFileFromTargetBranch reads the base repo at the base branch', async () => {
    const calls = route((url) => (url.includes('/contents/') ? new Response('rule') : null));
    expect(await platform().fetchFileFromTargetBranch('.review/a.md')).toBe('rule');
    expect(calls.at(-1)!.url).toBe(`${API}/repos/acme/shop/contents/.review/a.md?ref=main`);
  });

  test('a non-404 read error propagates', async () => {
    route((url) => (url.includes('/contents/') ? new Response('forbidden', { status: 403 }) : null));
    await expect(platform().fetchFileAtSha('a.ts', 'x')).rejects.toMatchObject({ status: 403 });
  });

  test('listTargetBranchTree returns blobs under the prefix only', async () => {
    route((url) =>
      url.includes('/git/trees/main?recursive=1')
        ? jsonResponse({
            truncated: true,
            tree: [
              { path: '.review', type: 'tree' },
              { path: '.review/a.md', type: 'blob' },
              { path: '.review/sub/b.md', type: 'blob' },
              { path: 'src/x.ts', type: 'blob' },
            ],
          })
        : null,
    );
    expect(await platform().listTargetBranchTree('.review')).toEqual(['.review/a.md', '.review/sub/b.md']);
  });

  test('listTargetBranchTree is empty on 404', async () => {
    route(() => null);
    expect(await platform().listTargetBranchTree('.review')).toEqual([]);
  });

  test('fetchRepoArchive returns null (not a throw) when the tarball cannot be fetched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidr-gh-'));
    route(() => null);
    expect(await platform().fetchRepoArchive(HEAD, dir)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('GithubPlatform writes', () => {
  const cs = { headSha: HEAD } as ChangeSet;

  test('postInline anchors to the head commit on the RIGHT side', async () => {
    const calls = route((url, init) =>
      url.endsWith('/pulls/7/comments') && init.method === 'POST' ? jsonResponse({ id: 99, node_id: 'N_99' }) : null,
    );
    const ref = await platform().postInline(finding(), 'body', cs);
    expect(ref).toEqual({ commentId: '99', threadId: 'N_99', fallback: false });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ body: 'body', commit_id: HEAD, path: 'src/a.ts', line: 2, side: 'RIGHT' });
  });

  test('postInline throws when GitHub rejects the position', async () => {
    route((url) => (url.endsWith('/pulls/7/comments') ? new Response('{"message":"line must be part of the diff"}', { status: 422 }) : null));
    await expect(platform().postInline(finding(), 'b', cs)).rejects.toMatchObject({ status: 422 });
  });

  test('postGeneralNote posts to the issue thread and updateNote patches in place', async () => {
    const calls = route((url, init) => {
      if (url.endsWith('/issues/7/comments') && init.method === 'POST') return jsonResponse({ id: 5 });
      if (url.endsWith('/issues/comments/5') && init.method === 'PATCH') return jsonResponse({});
      return null;
    });
    const p = platform();
    const ref = await p.postGeneralNote('summary');
    expect(ref).toEqual({ commentId: '5', fallback: true });
    await p.updateNote(ref, 'summary v2');
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: JSON.stringify({ body: 'summary v2' }) });
  });

  test('listOwnNotes paginates and maps a null body to empty', async () => {
    route((url) => (url.includes('/issues/7/comments') ? jsonResponse([{ id: 1, body: 'x' }, { id: 2, body: null }]) : null));
    expect(await platform().listOwnNotes()).toEqual([
      { id: '1', body: 'x' },
      { id: '2', body: '' },
    ]);
  });

  test('resolveThread replies, finds the unresolved thread by comment id, and resolves it', async () => {
    const graphqlBodies: { query: string; variables: Record<string, unknown> }[] = [];
    const calls = route((url, init) => {
      if (url.endsWith('/pulls/7/comments/42/replies')) return jsonResponse({ id: 43 });
      if (url === `${API}/graphql`) {
        const body = JSON.parse(init.body as string);
        graphqlBodies.push(body);
        if (body.query.startsWith('mutation')) return jsonResponse({ data: { resolveReviewThread: { thread: { id: 'T2' } } } });
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    { id: 'T1', isResolved: true, comments: { nodes: [{ databaseId: 42 }] } },
                    { id: 'T2', isResolved: false, comments: { nodes: [{ databaseId: 42 }] } },
                  ],
                },
              },
            },
          },
        });
      }
      return null;
    });
    await platform().resolveThread({ commentId: '42', fallback: false }, 'fixed');
    expect(calls.some((c) => c.url.endsWith('/replies') && c.body === JSON.stringify({ body: 'fixed' }))).toBe(true);
    expect(graphqlBodies[0]!.variables).toEqual({ owner: 'acme', repo: 'shop', number: 7 });
    expect(graphqlBodies[1]!.variables).toEqual({ id: 'T2' });
  });

  test('GitHub Enterprise uses /api/graphql rather than /api/v3/graphql', async () => {
    const ghe = 'https://ghe.example.com/api/v3';
    const calls = mockFetch((url) => {
      if (url === `${ghe}/repos/acme/shop/pulls/7/comments/1/replies`) return jsonResponse({});
      if (url === 'https://ghe.example.com/api/graphql') {
        return jsonResponse({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      }
      return new Response('', { status: 404 });
    });
    restore = calls.restore;
    await platform(ghe).resolveThread({ commentId: '1', fallback: false }, 'x');
    expect(calls.calls.some((c) => c.url === 'https://ghe.example.com/api/graphql')).toBe(true);
  });

  test('a GraphQL error payload does not resolve anything', async () => {
    const calls = route((url) => {
      if (url.endsWith('/replies')) return jsonResponse({});
      if (url.endsWith('/graphql')) return jsonResponse({ data: null, errors: [{ message: 'denied' }] });
      return null;
    });
    await platform().resolveThread({ commentId: '1', fallback: false }, 'x');
    // Only the lookup query was attempted; no mutation followed.
    expect(calls.filter((c) => c.url.endsWith('/graphql'))).toHaveLength(1);
  });

  // GAP vs .review/no-silent-failures.md and the Platform contract: when the
  // reply, the thread lookup, or the resolve mutation fails, resolveThread only
  // logs at warn and resolves successfully (src/platform/github.ts:265-279).
  // The caller cannot tell a resolved thread from an unresolved one, so the
  // store may record it as resolved. Expected: reject (or report) on failure.
  test.todo('resolveThread rejects when the thread could not be resolved', async () => {
    route((url) => {
      if (url.endsWith('/replies')) return jsonResponse({});
      if (url.endsWith('/graphql')) return jsonResponse({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      return null;
    });
    await expect(platform().resolveThread({ commentId: '1', fallback: false }, 'x')).rejects.toThrow();
  });

  // GAP vs .review/platform-reads-are-pinned.md ("a list endpoint consumed
  // without following its pagination cursor"): findThreadId queries
  // `reviewThreads(first:100)` with no pageInfo/after cursor
  // (src/platform/github.ts:290). On a PR with more than 100 review threads, a
  // thread beyond the first page is never found and never resolved.
  test.todo('findThreadId follows the reviewThreads cursor past the first 100 threads', async () => {
    const queries: string[] = [];
    route((url, init) => {
      if (url.endsWith('/replies')) return jsonResponse({});
      if (url.endsWith('/graphql')) {
        const body = JSON.parse(init.body as string);
        queries.push(body.query);
        return jsonResponse({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      }
      return null;
    });
    await platform().resolveThread({ commentId: '1', fallback: false }, 'x');
    expect(queries[0]).toContain('pageInfo');
  });
});
