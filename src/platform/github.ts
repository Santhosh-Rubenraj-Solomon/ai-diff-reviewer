/**
 * GitHub adapter.
 *
 * Same invariants as the GitLab one: content is read at `head.sha`, and on a
 * fork it is read from `head.repo.full_name` rather than the base repository.
 * GitHub exposes no `start_sha`, so `startSha` mirrors `baseSha`.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeSet, ChangedFile, Finding, PostedRef } from '../types.ts';
import { classify, languageOf } from '../diff/filter.ts';
import { countChanges, parseHunks } from '../diff/parse.ts';
import { sha256 } from '../publish/fingerprint.ts';
import { mapPool } from '../pool.ts';
import { log } from '../logger.ts';
import type { Platform, PlatformDeps } from './types.ts';
import {
  httpJson,
  httpRequest,
  httpText,
  paginateGithub,
  PlatformError,
  type HttpOptions,
} from './http.ts';

interface GithubPr {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  base: { sha: string; ref: string; repo: { full_name: string } };
  head: { sha: string; ref: string; repo: { full_name: string } | null };
}

interface GithubFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'changed' | 'copied' | 'unchanged';
  patch?: string;
  additions: number;
  deletions: number;
}

export class GithubPlatform implements Platform {
  readonly name = 'github' as const;

  private readonly http: HttpOptions;
  private pr: GithubPr | null = null;

  constructor(private readonly deps: PlatformDeps) {
    this.http = {
      headers: {
        authorization: `Bearer ${deps.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
    };
  }

  private repoBase(fullName = this.deps.projectId): string {
    return `${this.deps.apiUrl}/repos/${fullName}`;
  }

  private graphqlUrl(): string {
    return this.deps.apiUrl.endsWith('/api/v3')
      ? `${this.deps.apiUrl.slice(0, -'/api/v3'.length)}/api/graphql`
      : `${this.deps.apiUrl}/graphql`;
  }

  private async loadPr(): Promise<GithubPr> {
    if (this.pr) return this.pr;
    this.pr = await httpJson<GithubPr>(
      `${this.repoBase()}/pulls/${this.deps.requestId}`,
      { method: 'GET' },
      this.http,
    );
    return this.pr;
  }

  /** Where the head commit actually lives — the fork on a fork PR. */
  private async headRepo(): Promise<string> {
    const pr = await this.loadPr();
    return pr.head.repo?.full_name ?? this.deps.projectId;
  }

  async fetchChangeSet(): Promise<ChangeSet> {
    const pr = await this.loadPr();
    const headSha = pr.head.sha;

    const entries = await paginateGithub<GithubFile>(
      `${this.repoBase()}/pulls/${this.deps.requestId}/files`,
      this.http,
    );

    const skipped: ChangeSet['skipped'] = [];
    const files = await mapPool(entries, 6, async (entry): Promise<ChangedFile | null> => {
      const path = entry.filename;
      const status =
        entry.status === 'removed'
          ? 'deleted'
          : entry.status === 'added'
            ? 'added'
            : entry.status === 'renamed'
              ? 'renamed'
              : 'modified';

      // GitHub omits `patch` for binary blobs and very large diffs.
      const hunks = entry.patch ? parseHunks(entry.patch) : [];
      const { additions, deletions } = countChanges(hunks);

      const headContent =
        status === 'deleted' ? null : await this.fetchFileAtSha(path, headSha).catch(() => null);

      const reason = classify({
        path,
        status,
        content: headContent,
        platformSaysBinary: !entry.patch && status !== 'deleted',
        maxFileBytes: this.deps.maxFileBytes,
      });
      if (reason) {
        skipped.push({ path, reason });
        return null;
      }

      const file: ChangedFile = {
        path,
        status,
        hunks,
        headContent,
        contentHash: sha256(headContent ?? ''),
        language: languageOf(path),
        additions,
        deletions,
      };
      if (status === 'renamed' && entry.previous_filename) file.oldPath = entry.previous_filename;
      return file;
    });

    return {
      platform: 'github',
      projectId: this.deps.projectId,
      requestId: String(this.deps.requestId),
      webUrl: pr.html_url,
      title: pr.title,
      description: pr.body ?? '',
      baseSha: pr.base.sha,
      startSha: pr.base.sha,
      headSha,
      targetBranch: pr.base.ref,
      files: files.filter((file): file is ChangedFile => file !== null),
      skipped,
    };
  }

  async fetchFileAtSha(path: string, sha: string): Promise<string | null> {
    const repo = await this.headRepo();
    return await this.rawContents(repo, path, sha);
  }

  async fetchFileFromTargetBranch(path: string): Promise<string | null> {
    const pr = await this.loadPr();
    return await this.rawContents(pr.base.repo.full_name, path, pr.base.ref);
  }

  private async rawContents(repo: string, path: string, ref: string): Promise<string | null> {
    const url = `${this.repoBase(repo)}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}?ref=${encodeURIComponent(ref)}`;
    try {
      return await httpText(
        url,
        { method: 'GET', headers: { accept: 'application/vnd.github.raw' } },
        this.http,
      );
    } catch (err) {
      if (err instanceof PlatformError && err.status === 404) return null;
      throw err;
    }
  }

  async listTargetBranchTree(prefix: string): Promise<string[]> {
    const pr = await this.loadPr();
    const url = `${this.repoBase(pr.base.repo.full_name)}/git/trees/${encodeURIComponent(
      pr.base.ref,
    )}?recursive=1`;
    try {
      const tree = await httpJson<{ tree: { path: string; type: string }[]; truncated?: boolean }>(
        url,
        { method: 'GET' },
        this.http,
      );
      if (tree.truncated) {
        log.warn('target branch tree was truncated by the API', { prefix });
      }
      return tree.tree
        .filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix))
        .map((entry) => entry.path);
    } catch (err) {
      if (err instanceof PlatformError && err.status === 404) return [];
      throw err;
    }
  }

  async fetchRepoArchive(sha: string, destDir: string): Promise<string | null> {
    const repo = await this.headRepo();
    const url = `${this.repoBase(repo)}/tarball/${encodeURIComponent(sha)}`;
    await mkdir(destDir, { recursive: true });
    const tarball = join(destDir, 'repo.tar.gz');
    try {
      const response = await httpRequest(
        url,
        { method: 'GET' },
        { ...this.http, timeoutMs: 120_000 },
      );
      await Bun.write(tarball, await response.arrayBuffer());
      const proc = Bun.spawn(['tar', '-xzf', tarball, '-C', destDir, '--strip-components=1'], {
        stderr: 'pipe',
      });
      const code = await proc.exited;
      if (code !== 0) {
        log.warn('archive extraction failed', { code });
        return null;
      }
      await rm(tarball, { force: true });
      return destDir;
    } catch (err) {
      log.warn('archive fetch failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async postInline(finding: Finding, body: string, changeSet: ChangeSet): Promise<PostedRef> {
    const created = await httpJson<{ id: number; node_id: string }>(
      `${this.repoBase()}/pulls/${this.deps.requestId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          body,
          commit_id: changeSet.headSha,
          path: finding.path,
          line: finding.line,
          side: 'RIGHT',
        }),
      },
      this.http,
    );
    return { commentId: String(created.id), threadId: created.node_id, fallback: false };
  }

  async postGeneralNote(body: string): Promise<PostedRef> {
    const created = await httpJson<{ id: number }>(
      `${this.repoBase()}/issues/${this.deps.requestId}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) },
      this.http,
    );
    return { commentId: String(created.id), fallback: true };
  }

  async updateNote(ref: PostedRef, body: string): Promise<void> {
    await httpRequest(
      `${this.repoBase()}/issues/comments/${ref.commentId}`,
      { method: 'PATCH', body: JSON.stringify({ body }) },
      this.http,
    );
  }

  /**
   * Replies in the thread, then resolves it. Resolution is GraphQL-only on
   * GitHub, so we look the thread up by its first comment's database id.
   */
  async resolveThread(ref: PostedRef, body: string): Promise<void> {
    await httpRequest(
      `${this.repoBase()}/pulls/${this.deps.requestId}/comments/${ref.commentId}/replies`,
      { method: 'POST', body: JSON.stringify({ body }) },
      this.http,
    ).catch((err) => {
      log.warn('reply to review thread failed', { error: String(err) });
    });

    const threadId = await this.findThreadId(Number(ref.commentId));
    if (!threadId) {
      log.warn('could not locate review thread to resolve', { commentId: ref.commentId });
      return;
    }
    await this.graphql(
      'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}',
      { id: threadId },
    ).catch((err) => log.warn('resolveReviewThread failed', { error: String(err) }));
  }

  private async findThreadId(commentDatabaseId: number): Promise<string | null> {
    const [owner, repo] = this.deps.projectId.split('/');
    const data = await this.graphql<{
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: { id: string; isResolved: boolean; comments: { nodes: { databaseId: number }[] } }[];
          };
        };
      };
    }>(
      `query($owner:String!,$repo:String!,$number:Int!){
         repository(owner:$owner,name:$repo){
           pullRequest(number:$number){
             reviewThreads(first:100){
               nodes{ id isResolved comments(first:1){ nodes{ databaseId } } }
             }
           }
         }
       }`,
      { owner, repo, number: Number(this.deps.requestId) },
    ).catch(() => null);

    if (!data) return null;
    for (const thread of data.repository.pullRequest.reviewThreads.nodes) {
      if (thread.isResolved) continue;
      if (thread.comments.nodes.some((c) => c.databaseId === commentDatabaseId)) return thread.id;
    }
    return null;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await httpJson<{ data: T; errors?: { message: string }[] }>(
      this.graphqlUrl(),
      { method: 'POST', body: JSON.stringify({ query, variables }) },
      this.http,
    );
    if (response.errors?.length) {
      throw new Error(response.errors.map((e) => e.message).join('; '));
    }
    return response.data;
  }

  async listOwnNotes(): Promise<{ id: string; body: string }[]> {
    const comments = await paginateGithub<{ id: number; body: string | null }>(
      `${this.repoBase()}/issues/${this.deps.requestId}/comments`,
      this.http,
    );
    return comments.map((comment) => ({ id: String(comment.id), body: comment.body ?? '' }));
  }
}
