/**
 * The repository at one SHA, cached by that SHA.
 *
 * SHA-keyed caches are safe to reuse; a branch-keyed cache with a TTL means a
 * rule pushed an hour ago may not be visible. There is no TTL here because
 * there is nothing time-dependent to expire.
 *
 * Repo access is also *not* coupled to any optional feature: if the archive
 * fails, the snapshot comes back degraded and the review still runs on diffs
 * plus full head files.
 */

import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Platform } from '../platform/types.ts';
import { log } from '../logger.ts';

const COMPLETE_MARKER = '.aidr-snapshot-complete';
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'vendor', 'target']);
const MAX_FILES = 20_000;

export interface RepoSnapshot {
  /** Absolute path to the checkout, or null when unavailable. */
  root: string | null;
  /** Repo-relative paths. Empty when `root` is null. */
  files: string[];
  read(path: string): Promise<string | null>;
  /** Non-null when the snapshot is unusable or incomplete — recorded on the run. */
  degraded: string | null;
}

export function emptySnapshot(reason: string): RepoSnapshot {
  return {
    root: null,
    files: [],
    read: async () => null,
    degraded: reason,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  const visit = async (dir: string): Promise<void> => {
    if (truncated) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.') && entry.name !== '.review') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await visit(full);
      } else if (entry.isFile()) {
        files.push(relative(root, full));
      }
    }
  };

  await visit(root);
  return { files, truncated };
}

export async function loadRepoSnapshot(
  platform: Platform,
  headSha: string,
  cacheDir: string,
): Promise<RepoSnapshot> {
  const dest = join(cacheDir, headSha);
  let root: string | null = null;

  if (await exists(join(dest, COMPLETE_MARKER))) {
    root = dest;
    log.info('repo snapshot cache hit', { sha: headSha.slice(0, 7) });
  } else {
    await mkdir(dest, { recursive: true });
    root = await platform.fetchRepoArchive(headSha, dest);
    if (root) await writeFile(join(dest, COMPLETE_MARKER), headSha, 'utf8').catch(() => {});
  }

  if (!root) {
    return emptySnapshot('repository archive unavailable; context limited to diff + head files');
  }

  const { files, truncated } = await walk(root);
  const snapshotRoot = root;

  return {
    root: snapshotRoot,
    files,
    degraded: truncated ? `repository walk truncated at ${MAX_FILES} files` : null,
    async read(path: string): Promise<string | null> {
      const full = join(snapshotRoot, path);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile() || info.size > 1_000_000) return null;
      return await readFile(full, 'utf8').catch(() => null);
    },
  };
}
