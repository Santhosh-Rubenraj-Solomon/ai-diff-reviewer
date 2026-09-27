/**
 * Local adapter — a real ChangeSet from a local checkout, no network, no posting.
 *
 * This is the mode you debug in. Content comes from the working tree, so the
 * diff and the content are consistent with each other by construction: the
 * change under review is "everything between the merge base and what is on
 * disk right now", including uncommitted work.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChangeSet, ChangedFile, PostedRef } from '../types.ts';
import { classify, languageOf } from '../diff/filter.ts';
import { countChanges, parseMultiFileDiff } from '../diff/parse.ts';
import { sha256 } from '../publish/fingerprint.ts';
import type { Platform } from './types.ts';

/** Not part of anyone's source tree; keeps `rules check` counts meaningful. */
const IGNORED_TREE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'vendor',
  'target',
  '.aidr',
]);

export interface LocalOptions {
  repoRoot: string;
  /** Branch or ref to diff against. Auto-detected when omitted. */
  base?: string;
  maxFileBytes: number;
}

async function git(repoRoot: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['git', '-C', repoRoot, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function gitOrThrow(repoRoot: string, args: string[]): Promise<string> {
  const result = await git(repoRoot, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.err.trim() || result.out.trim()}`);
  }
  return result.out;
}

export class LocalPlatform implements Platform {
  readonly name = 'local' as const;

  constructor(private readonly opts: LocalOptions) {}

  private async detectBase(): Promise<string> {
    if (this.opts.base) return this.opts.base;
    for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
      const result = await git(this.opts.repoRoot, ['rev-parse', '--verify', '--quiet', candidate]);
      if (result.code === 0 && result.out.trim()) return candidate;
    }
    // A repo with a single commit and no main branch: diff against the empty tree.
    return await gitOrThrow(this.opts.repoRoot, ['hash-object', '-t', 'tree', '/dev/null']).then((s) =>
      s.trim(),
    );
  }

  async fetchChangeSet(): Promise<ChangeSet> {
    const root = this.opts.repoRoot;
    const base = await this.detectBase();
    const headSha = (await gitOrThrow(root, ['rev-parse', 'HEAD'])).trim();
    const mergeBase = await git(root, ['merge-base', base, 'HEAD']);
    const baseSha = mergeBase.code === 0 && mergeBase.out.trim() ? mergeBase.out.trim() : base;

    const branch = (await gitOrThrow(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const subject = (await gitOrThrow(root, ['log', '-1', '--pretty=%s'])).trim();
    const body = (await gitOrThrow(root, ['log', '-1', '--pretty=%b'])).trim();

    // Working tree against the merge base: what a reviewer would actually see.
    const diffText = await gitOrThrow(root, ['diff', '--no-color', '--find-renames', baseSha, '--']);
    const parsed = parseMultiFileDiff(diffText);

    const skipped: ChangeSet['skipped'] = [];
    const files: ChangedFile[] = [];

    for (const entry of parsed) {
      const path = entry.newPath ?? entry.oldPath;
      if (!path) continue;

      const { additions, deletions } = countChanges(entry.hunks);
      const headContent =
        entry.status === 'deleted' || entry.binary
          ? null
          : await readFile(join(root, path), 'utf8').catch(() => null);

      const reason = classify({
        path,
        status: entry.status,
        content: headContent,
        platformSaysBinary: entry.binary,
        maxFileBytes: this.opts.maxFileBytes,
      });
      if (reason) {
        skipped.push({ path, reason });
        continue;
      }

      const file: ChangedFile = {
        path,
        status: entry.status,
        hunks: entry.hunks,
        headContent,
        contentHash: sha256(headContent ?? ''),
        language: languageOf(path),
        additions,
        deletions,
      };
      if (entry.status === 'renamed' && entry.oldPath) file.oldPath = entry.oldPath;
      files.push(file);
    }

    return {
      platform: 'local',
      projectId: root,
      requestId: branch,
      title: subject,
      description: body,
      baseSha,
      startSha: baseSha,
      headSha,
      targetBranch: base,
      files,
      skipped,
    };
  }

  async fetchFileAtSha(path: string, _sha: string): Promise<string | null> {
    return await readFile(join(this.opts.repoRoot, path), 'utf8').catch(() => null);
  }

  /** Locally, rules come from the working tree — that is what you are editing. */
  async fetchFileFromTargetBranch(path: string): Promise<string | null> {
    return await readFile(join(this.opts.repoRoot, path), 'utf8').catch(() => null);
  }

  async listTargetBranchTree(prefix: string): Promise<string[]> {
    const root = join(this.opts.repoRoot, prefix);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_TREE_DIRS.has(entry.name)) continue;
          await walk(full);
        } else {
          out.push(relative(this.opts.repoRoot, full));
        }
      }
    };
    await walk(root);
    return out;
  }

  async fetchRepoArchive(_sha: string, _destDir: string): Promise<string | null> {
    // The checkout is already on disk; the context engine reads it directly.
    return this.opts.repoRoot;
  }

  async postInline(): Promise<PostedRef> {
    throw new Error('the local platform cannot post comments; run with --dry-run');
  }

  async postGeneralNote(): Promise<PostedRef> {
    throw new Error('the local platform cannot post comments; run with --dry-run');
  }

  async updateNote(): Promise<void> {
    throw new Error('the local platform cannot post comments; run with --dry-run');
  }

  async resolveThread(): Promise<void> {
    throw new Error('the local platform cannot post comments; run with --dry-run');
  }

  async listOwnNotes(): Promise<{ id: string; body: string }[]> {
    return [];
  }
}
