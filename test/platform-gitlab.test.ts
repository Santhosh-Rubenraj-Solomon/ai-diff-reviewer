import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitlabPlatform } from '../src/platform/gitlab.ts';
import { createPlatform } from '../src/platform/index.ts';
import { GithubPlatform } from '../src/platform/github.ts';
import { LocalPlatform } from '../src/platform/local.ts';
import { configureLogger } from '../src/logger.ts';
import type { Config } from '../src/config.ts';
import type { ChangeSet, Finding } from '../src/types.ts';
import { jsonResponse, mockFetch, type FetchCall } from './helpers.ts';

configureLogger({ quiet: true });

const API = 'https://gitlab.example.com/api/v4';
const MR_URL = `${API}/projects/group%2Fshop/merge_requests/12`;
const SHAS = { base_sha: 'b'.repeat(40), start_sha: 's'.repeat(40), head_sha: 'h'.repeat(40) };

const MR = {
  iid: 12,
  title: 'Refunds',
  description: null,
  target_branch: 'main',
  source_project_id: 200, // a fork
  target_project_id: 100,
  web_url: 'https://gitlab.example.com/group/shop/-/merge_requests/12',
  diff_refs: SHAS,
};

const DIFFS = [
  { old_path: 'src/a.ts', new_path: 'src/a.ts', new_file: false, renamed_file: false, deleted_file: false, diff: '@@ -1 +1,2 @@\n a\n+b\n' },
  { old_path: 'src/new.ts', new_path: 'src/new.ts', new_file: true, renamed_file: false, deleted_file: false, diff: '@@ -0,0 +1 @@\n+n\n' },
  { old_path: 'src/old.ts', new_path: 'src/moved.ts', new_file: false, renamed_file: true, deleted_file: false, diff: '@@ -1 +1 @@\n-x\n+y\n' },
  { old_path: 'src/dead.ts', new_path: 'src/dead.ts', new_file: false, renamed_file: false, deleted_file: true, diff: '@@ -1 +0,0 @@\n-x\n' },
  { old_path: 'dist/app.js', new_path: 'dist/app.js', new_file: false, renamed_file: false, deleted_file: false, diff: '@@ -1 +1 @@\n-x\n+y\n' },
];

const CONTENT: Record<string, string> = { 'src/a.ts': 'a\nb', 'src/new.ts': 'n', 'src/moved.ts': 'y', 'dist/app.js': 'y' };

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function platform(): GitlabPlatform {
  return new GitlabPlatform({ apiUrl: API, token: 'glpat', projectId: 'group/shop', requestId: '12', maxFileBytes: 100_000 });
}

function route(handler: (url: string, init: RequestInit) => Response | null, mr: unknown = MR): FetchCall[] {
  const mock = mockFetch((url, init) => {
    const custom = handler(url, init);
    if (custom) return custom;
    if (url === MR_URL) return jsonResponse(mr);
    return new Response('404', { status: 404 });
  });
  restore = mock.restore;
  return mock.calls;
}

function finding(overrides: Partial<Finding> = {}): Finding {
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
    ...overrides,
  };
}

const CS = { baseSha: SHAS.base_sha, startSha: SHAS.start_sha, headSha: SHAS.head_sha } as ChangeSet;

describe('GitlabPlatform.fetchChangeSet', () => {
  test('pins to diff_refs and reads content from the source (fork) project at head_sha', async () => {
    const calls = route((url) => {
      if (url.startsWith(`${MR_URL}/diffs`)) return jsonResponse(DIFFS);
      const match = /\/projects\/(\d+)\/repository\/files\/(.+)\/raw\?ref=(.+)$/.exec(url);
      if (match) {
        expect(match[1]).toBe('200');
        expect(match[3]).toBe(SHAS.head_sha);
        const path = decodeURIComponent(match[2]!);
        return path in CONTENT ? new Response(CONTENT[path]) : null;
      }
      return null;
    });

    const cs = await platform().fetchChangeSet();
    expect(cs).toMatchObject({
      platform: 'gitlab',
      projectId: 'group/shop',
      requestId: '12',
      description: '',
      baseSha: SHAS.base_sha,
      startSha: SHAS.start_sha,
      headSha: SHAS.head_sha,
      targetBranch: 'main',
    });
    expect(cs.files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/new.ts', 'added'],
      ['src/moved.ts', 'renamed'],
    ]);
    expect(cs.files[2]!.oldPath).toBe('src/old.ts');
    expect(cs.skipped).toEqual(
      expect.arrayContaining([
        { path: 'src/dead.ts', reason: 'deleted' },
        { path: 'dist/app.js', reason: 'vendored' },
      ]),
    );
    expect(calls.filter((c) => c.url === MR_URL)).toHaveLength(1);
    expect(calls[0]!.headers['PRIVATE-TOKEN']).toBe('glpat');
    expect(calls.some((c) => c.url.includes('/projects/100/repository/files/'))).toBe(false);
  });

  test('an MR whose diff_refs are not ready is an error, not an empty review', async () => {
    route(() => null, { ...MR, diff_refs: null });
    await expect(platform().fetchChangeSet()).rejects.toThrow('has no diff_refs');
  });

  test('a content read that errors becomes a recorded no-content skip', async () => {
    route((url) => {
      if (url.startsWith(`${MR_URL}/diffs`)) return jsonResponse([DIFFS[0]]);
      if (url.includes('/repository/files/')) return new Response('forbidden', { status: 403 });
      return null;
    });
    const cs = await platform().fetchChangeSet();
    expect(cs.files).toEqual([]);
    expect(cs.skipped).toEqual([{ path: 'src/a.ts', reason: 'no-content' }]);
  });
});

describe('GitlabPlatform reads', () => {
  test('fetchFileAtSha url-encodes the whole path and returns null on 404', async () => {
    const calls = route((url) => (url.includes('src%2Fa.ts') ? new Response('code') : null));
    const p = platform();
    expect(await p.fetchFileAtSha('src/a.ts', 'abc')).toBe('code');
    expect(calls.at(-1)!.url).toBe(`${API}/projects/200/repository/files/src%2Fa.ts/raw?ref=abc`);
    expect(await p.fetchFileAtSha('missing.ts', 'abc')).toBeNull();
  });

  test('fetchFileFromTargetBranch reads the target project at the target branch', async () => {
    const calls = route((url) => (url.includes('/repository/files/') ? new Response('rule') : null));
    expect(await platform().fetchFileFromTargetBranch('.review/x.md')).toBe('rule');
    expect(calls.at(-1)!.url).toBe(`${API}/projects/100/repository/files/.review%2Fx.md/raw?ref=main`);
  });

  test('a non-404 error from a target-branch read propagates', async () => {
    route((url) => (url.includes('/repository/files/') ? new Response('', { status: 401 }) : null));
    await expect(platform().fetchFileFromTargetBranch('x')).rejects.toMatchObject({ status: 401 });
  });

  test('listTargetBranchTree returns blobs only, from the target project', async () => {
    const calls = route((url) =>
      url.includes('/repository/tree')
        ? jsonResponse([
            { path: '.review/sub', type: 'tree' },
            { path: '.review/a.md', type: 'blob' },
          ])
        : null,
    );
    expect(await platform().listTargetBranchTree('.review')).toEqual(['.review/a.md']);
    expect(calls.at(-1)!.url).toContain('/projects/100/repository/tree?recursive=true&ref=main&path=.review');
  });

  test('listTargetBranchTree is empty on 404', async () => {
    route(() => null);
    expect(await platform().listTargetBranchTree('.review')).toEqual([]);
  });

  test('listOwnNotes drops system notes', async () => {
    route((url) =>
      url.startsWith(`${MR_URL}/notes`)
        ? jsonResponse([
            { id: 1, body: 'added 2 commits', system: true },
            { id: 2, body: 'summary', system: false },
          ])
        : null,
    );
    expect(await platform().listOwnNotes()).toEqual([{ id: '2', body: 'summary' }]);
  });

  test('fetchRepoArchive returns null when the archive cannot be fetched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidr-gl-'));
    route(() => null);
    expect(await platform().fetchRepoArchive(SHAS.head_sha, dir)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('GitlabPlatform writes', () => {
  test('postInline sends a text position pinned to all three SHAs', async () => {
    const calls = route((url, init) =>
      url === `${MR_URL}/discussions` && init.method === 'POST' ? jsonResponse({ id: 'disc1', notes: [{ id: 555 }] }) : null,
    );
    const ref = await platform().postInline(finding(), 'body', CS);
    expect(ref).toEqual({ commentId: '555', threadId: 'disc1', fallback: false });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({
      body: 'body',
      position: {
        position_type: 'text',
        base_sha: SHAS.base_sha,
        start_sha: SHAS.start_sha,
        head_sha: SHAS.head_sha,
        new_path: 'src/a.ts',
        old_path: 'src/a.ts',
        new_line: 2,
      },
    });
  });

  test('postInline throws when GitLab rejects the position', async () => {
    route((url) => (url.endsWith('/discussions') ? new Response('{"message":"400 (Bad request) \\"Note {:line_code=>[\\"can\'t be blank\\"]}\\""}', { status: 400 }) : null));
    await expect(platform().postInline(finding(), 'b', CS)).rejects.toMatchObject({ status: 400 });
  });

  // BUG (src/platform/gitlab.ts:248): postInline always sends
  // `old_path: finding.path` (the head-side path). For a renamed file GitLab
  // expects old_path to be the pre-rename path, so inline comments on renamed
  // files are rejected and fall back to general notes. The ChangeSet passed in
  // already carries `oldPath` for the file.
  test.todo('postInline uses the pre-rename path as old_path for a renamed file', async () => {
    const calls = route((url) => (url.endsWith('/discussions') ? jsonResponse({ id: 'd', notes: [{ id: 1 }] }) : null));
    const cs = {
      ...CS,
      files: [{ path: 'src/moved.ts', oldPath: 'src/old.ts', status: 'renamed' }],
    } as unknown as ChangeSet;
    await platform().postInline(finding({ path: 'src/moved.ts' }), 'b', cs);
    expect(JSON.parse(calls.at(-1)!.body!).position.old_path).toBe('src/old.ts');
  });

  test('postGeneralNote and updateNote use the notes endpoint', async () => {
    const calls = route((url, init) => {
      if (url === `${MR_URL}/notes` && init.method === 'POST') return jsonResponse({ id: 9 });
      if (url === `${MR_URL}/notes/9` && init.method === 'PUT') return jsonResponse({});
      return null;
    });
    const p = platform();
    const ref = await p.postGeneralNote('s');
    expect(ref).toEqual({ commentId: '9', fallback: true });
    await p.updateNote(ref, 's2');
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: JSON.stringify({ body: 's2' }) });
  });

  test('resolveThread replies then resolves the discussion', async () => {
    const calls = route((url) => (url.includes('/discussions/disc1') ? jsonResponse({}) : null));
    await platform().resolveThread({ commentId: '1', threadId: 'disc1', fallback: false }, 'fixed');
    const writes = calls.filter((c) => c.url.includes('/discussions/disc1'));
    expect(writes.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${MR_URL}/discussions/disc1/notes`],
      ['PUT', `${MR_URL}/discussions/disc1?resolved=true`],
    ]);
  });

  test('resolveThread without a thread id makes no request', async () => {
    const calls = route(() => null);
    await platform().resolveThread({ commentId: '1', fallback: true }, 'x');
    expect(calls).toHaveLength(0);
  });

  test('resolveThread propagates a failure instead of swallowing it', async () => {
    route((url) => (url.includes('/discussions/') ? new Response('', { status: 403 }) : null));
    await expect(platform().resolveThread({ commentId: '1', threadId: 'd', fallback: false }, 'x')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('createPlatform', () => {
  const base = { apiUrl: API, token: 't', projectId: 'p', requestId: '1', maxFileBytes: 10 } as unknown as Config;

  test('returns the adapter named by the config', () => {
    expect(createPlatform({ ...base, platform: 'gitlab' }, { repoRoot: '.' })).toBeInstanceOf(GitlabPlatform);
    expect(createPlatform({ ...base, platform: 'github' }, { repoRoot: '.' })).toBeInstanceOf(GithubPlatform);
    expect(createPlatform({ ...base, platform: 'local' }, { repoRoot: '.' })).toBeInstanceOf(LocalPlatform);
  });
});
