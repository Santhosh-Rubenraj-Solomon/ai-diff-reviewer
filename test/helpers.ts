import type { ChangeSet, Finding, PostedRef } from '../src/types.ts';
import type { Platform } from '../src/platform/types.ts';
import type { Batch } from '../src/types.ts';
import type { Reviewer } from '../src/review/run.ts';
import type { SystemBlock } from '../src/review/prompt.ts';
import { emptyUsage } from '../src/review/pricing.ts';

export interface FakePlatformOptions {
  changeSet: ChangeSet;
  /** Repo-relative path -> content, as seen on the target branch. */
  targetFiles?: Record<string, string>;
  /** Make the next postInline throw, to exercise the general-note fallback. */
  rejectInline?: boolean;
}

export interface FakePlatform extends Platform {
  inline: { finding: Finding; body: string }[];
  notes: { id: string; body: string }[];
  updates: { id: string; body: string }[];
  resolutions: string[];
}

export function makeFakePlatform(opts: FakePlatformOptions): FakePlatform {
  const targetFiles = opts.targetFiles ?? {};
  let nextId = 1;

  const platform: FakePlatform = {
    name: 'local',
    inline: [],
    notes: [],
    updates: [],
    resolutions: [],

    async fetchChangeSet() {
      return opts.changeSet;
    },
    async fetchFileAtSha(path) {
      return opts.changeSet.files.find((file) => file.path === path)?.headContent ?? null;
    },
    async fetchFileFromTargetBranch(path) {
      return targetFiles[path] ?? null;
    },
    async listTargetBranchTree(prefix) {
      return Object.keys(targetFiles).filter((path) => path.startsWith(prefix));
    },
    async fetchRepoArchive() {
      return null;
    },
    async postInline(finding, body) {
      if (opts.rejectInline) throw new Error('position is outside the diff');
      platform.inline.push({ finding, body });
      const ref: PostedRef = { commentId: String(nextId++), threadId: `t${nextId}`, fallback: false };
      return ref;
    },
    async postGeneralNote(body) {
      const id = String(nextId++);
      platform.notes.push({ id, body });
      return { commentId: id, fallback: true };
    },
    async updateNote(ref, body) {
      platform.updates.push({ id: ref.commentId, body });
      const note = platform.notes.find((entry) => entry.id === ref.commentId);
      if (note) note.body = body;
    },
    async resolveThread(ref) {
      platform.resolutions.push(ref.commentId);
    },
    async listOwnNotes() {
      return platform.notes.map((note) => ({ id: note.id, body: note.body }));
    },
  };

  return platform;
}

export interface FakeReviewerOptions {
  /** Findings returned for every batch. */
  findings?: Finding[];
  fail?: boolean;
  judge?: (finding: string) => { verdict: 'keep' | 'drop'; reason: string } | null;
}

export function makeFakeReviewer(opts: FakeReviewerOptions = {}): Reviewer & { calls: number } {
  return {
    usage: emptyUsage(),
    degradations: new Set<string>(),
    calls: 0,
    async count(text: string) {
      // Deterministic and monotonic in length; good enough for packing tests.
      return Math.ceil(text.length / 4);
    },
    async countSystem(blocks: SystemBlock[]) {
      return Math.ceil(blocks.map((block) => block.text).join('').length / 4);
    },
    async reviewBatch(batch: Batch) {
      this.calls += 1;
      if (opts.fail) {
        return {
          index: batch.index,
          findings: [],
          ok: false,
          error: 'synthetic failure',
          servedBy: 'fake',
        };
      }
      const paths = new Set(batch.files.map((file) => file.file.path));
      return {
        index: batch.index,
        findings: (opts.findings ?? []).filter((finding) => paths.has(finding.path)),
        ok: true,
        servedBy: 'fake',
      };
    },
    async judgeFinding(_system: string, user: string) {
      return opts.judge ? opts.judge(user) : { verdict: 'keep', reason: 'fake judge' };
    },
  };
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * Replaces `globalThis.fetch` with a router. Returns the recorded calls and a
 * `restore` to put the real fetch back. No test ever reaches the network.
 */
export function mockFetch(
  route: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  const fake = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init.body === 'string' ? init.body : null,
    });
    return await route(url, init);
  };
  globalThis.fetch = fake as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}
