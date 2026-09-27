/**
 * GitLab adapter.
 *
 * Two things this gets deliberately right:
 *   - every content read is pinned to a SHA, never to `source_branch`, so a
 *     push mid-review cannot mix commits into one review;
 *   - fork merge requests read from `source_project_id`, not from the target
 *     project, which would silently review the wrong code.
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
  paginateGitlab,
  PlatformError,
  type HttpOptions,
} from './http.ts';

interface GitlabMr {
  iid: number;
  title: string;
  description: string | null;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  web_url: string;
  diff_refs: { base_sha: string; start_sha: string; head_sha: string } | null;
}

interface GitlabDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

interface GitlabNote {
  id: number;
  body: string;
  system: boolean;
}

interface GitlabTreeEntry {
  path: string;
  type: 'blob' | 'tree';
}

export class GitlabPlatform implements Platform {
  readonly name = 'gitlab' as const;

  private readonly http: HttpOptions;
  private mr: GitlabMr | null = null;

  constructor(private readonly deps: PlatformDeps) {
    this.http = {
      headers: {
        'PRIVATE-TOKEN': deps.token,
        'content-type': 'application/json',
      },
    };
  }

  private project(id: string | number): string {
    return encodeURIComponent(String(id));
  }

  private mrBase(): string {
    return `${this.deps.apiUrl}/projects/${this.project(this.deps.projectId)}/merge_requests/${this.deps.requestId}`;
  }

  private async loadMr(): Promise<GitlabMr> {
    // Fetched once and passed down — the N+1 of re-fetching per file is real.
    if (this.mr) return this.mr;
    this.mr = await httpJson<GitlabMr>(this.mrBase(), { method: 'GET' }, this.http);
    return this.mr;
  }

  async fetchChangeSet(): Promise<ChangeSet> {
    const mr = await this.loadMr();
    if (!mr.diff_refs) {
      throw new Error(
        `merge request !${this.deps.requestId} has no diff_refs (is it still being prepared?)`,
      );
    }
    const { base_sha: baseSha, start_sha: startSha, head_sha: headSha } = mr.diff_refs;

    const diffs = await paginateGitlab<GitlabDiff>(`${this.mrBase()}/diffs`, this.http);

    const skipped: { path: string; reason: ChangeSet['skipped'][number]['reason'] }[] = [];
    const files = await mapPool(diffs, 6, async (entry): Promise<ChangedFile | null> => {
      const path = entry.new_path;
      const status = entry.new_file
        ? 'added'
        : entry.deleted_file
          ? 'deleted'
          : entry.renamed_file
            ? 'renamed'
            : 'modified';

      const hunks = parseHunks(entry.diff);
      const { additions, deletions } = countChanges(hunks);

      const headContent =
        status === 'deleted' ? null : await this.fetchFileAtSha(path, headSha).catch(() => null);

      const reason = classify({
        path,
        status,
        content: headContent,
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
      if (status === 'renamed') file.oldPath = entry.old_path;
      return file;
    });

    return {
      platform: 'gitlab',
      projectId: String(this.deps.projectId),
      requestId: String(this.deps.requestId),
      webUrl: mr.web_url,
      title: mr.title,
      description: mr.description ?? '',
      baseSha,
      startSha,
      headSha,
      targetBranch: mr.target_branch,
      files: files.filter((file): file is ChangedFile => file !== null),
      skipped,
    };
  }

  async fetchFileAtSha(path: string, sha: string): Promise<string | null> {
    const mr = await this.loadMr();
    const url =
      `${this.deps.apiUrl}/projects/${this.project(mr.source_project_id)}` +
      `/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(sha)}`;
    try {
      return await httpText(url, { method: 'GET' }, this.http);
    } catch (err) {
      if (err instanceof PlatformError && err.status === 404) return null;
      throw err;
    }
  }

  async fetchFileFromTargetBranch(path: string): Promise<string | null> {
    const mr = await this.loadMr();
    const url =
      `${this.deps.apiUrl}/projects/${this.project(mr.target_project_id)}` +
      `/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(mr.target_branch)}`;
    try {
      return await httpText(url, { method: 'GET' }, this.http);
    } catch (err) {
      if (err instanceof PlatformError && err.status === 404) return null;
      throw err;
    }
  }

  async listTargetBranchTree(prefix: string): Promise<string[]> {
    const mr = await this.loadMr();
    const url =
      `${this.deps.apiUrl}/projects/${this.project(mr.target_project_id)}/repository/tree` +
      `?recursive=true&ref=${encodeURIComponent(mr.target_branch)}&path=${encodeURIComponent(prefix)}`;
    try {
      const entries = await paginateGitlab<GitlabTreeEntry>(url, this.http);
      return entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
    } catch (err) {
      if (err instanceof PlatformError && err.status === 404) return [];
      throw err;
    }
  }

  async fetchRepoArchive(sha: string, destDir: string): Promise<string | null> {
    const mr = await this.loadMr();
    const url =
      `${this.deps.apiUrl}/projects/${this.project(mr.source_project_id)}` +
      `/repository/archive.tar.gz?sha=${encodeURIComponent(sha)}`;

    await mkdir(destDir, { recursive: true });
    const tarball = join(destDir, 'repo.tar.gz');
    try {
      const response = await httpRequest(url, { method: 'GET' }, { ...this.http, timeoutMs: 120_000 });
      await Bun.write(tarball, await response.arrayBuffer());
      // GitLab archives nest everything under <project>-<sha>-<sha>/; strip it.
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
    const payload = {
      body,
      position: {
        position_type: 'text',
        base_sha: changeSet.baseSha,
        start_sha: changeSet.startSha,
        head_sha: changeSet.headSha,
        new_path: finding.path,
        old_path: finding.path,
        new_line: finding.line,
      },
    };
    const created = await httpJson<{ id: string; notes: { id: number }[] }>(
      `${this.mrBase()}/discussions`,
      { method: 'POST', body: JSON.stringify(payload) },
      this.http,
    );
    return {
      commentId: String(created.notes?.[0]?.id ?? created.id),
      threadId: created.id,
      fallback: false,
    };
  }

  async postGeneralNote(body: string): Promise<PostedRef> {
    const created = await httpJson<{ id: number }>(
      `${this.mrBase()}/notes`,
      { method: 'POST', body: JSON.stringify({ body }) },
      this.http,
    );
    return { commentId: String(created.id), fallback: true };
  }

  async updateNote(ref: PostedRef, body: string): Promise<void> {
    await httpRequest(
      `${this.mrBase()}/notes/${ref.commentId}`,
      { method: 'PUT', body: JSON.stringify({ body }) },
      this.http,
    );
  }

  async resolveThread(ref: PostedRef, body: string): Promise<void> {
    if (!ref.threadId) return;
    await httpRequest(
      `${this.mrBase()}/discussions/${ref.threadId}/notes`,
      { method: 'POST', body: JSON.stringify({ body }) },
      this.http,
    );
    await httpRequest(
      `${this.mrBase()}/discussions/${ref.threadId}?resolved=true`,
      { method: 'PUT' },
      this.http,
    );
  }

  async listOwnNotes(): Promise<{ id: string; body: string }[]> {
    const notes = await paginateGitlab<GitlabNote>(`${this.mrBase()}/notes`, this.http);
    return notes
      .filter((note) => !note.system)
      .map((note) => ({ id: String(note.id), body: note.body ?? '' }));
  }
}
