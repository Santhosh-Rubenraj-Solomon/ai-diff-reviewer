/**
 * The seam both providers implement. Nothing above this line knows whether it
 * is talking to GitLab, GitHub, or a local checkout.
 */

import type { ChangeSet, Finding, PostedRef } from '../types.ts';

export interface Platform {
  readonly name: 'gitlab' | 'github' | 'local';

  /** One fetch, pinned to base/start/head SHAs. Never reads by branch name. */
  fetchChangeSet(): Promise<ChangeSet>;

  /** File content at an explicit SHA, from the *source* project on forks. */
  fetchFileAtSha(path: string, sha: string): Promise<string | null>;

  /**
   * Read a path from the *target* branch — where project rules live, so that a
   * merge request cannot rewrite the rules that judge it.
   */
  fetchFileFromTargetBranch(path: string): Promise<string | null>;

  /** Lists candidate rule files on the target branch. Empty when unsupported. */
  listTargetBranchTree(prefix: string): Promise<string[]>;

  /** Extracts the repo at `sha` into `destDir`; null when unavailable. */
  fetchRepoArchive(sha: string, destDir: string): Promise<string | null>;

  /** Inline thread on a changed line. Throws if the provider rejects it. */
  postInline(finding: Finding, body: string, changeSet: ChangeSet): Promise<PostedRef>;

  /** Fallback when a position is rejected, and the home of the run summary. */
  postGeneralNote(body: string): Promise<PostedRef>;

  /** Edits an existing note in place — the summary is never duplicated. */
  updateNote(ref: PostedRef, body: string): Promise<void>;

  /** Marks a thread resolved, with a short note saying why. */
  resolveThread(ref: PostedRef, body: string): Promise<void>;

  /** Existing bot notes, so a re-run can find its own summary comment. */
  listOwnNotes(): Promise<{ id: string; body: string }[]>;
}

export interface PlatformDeps {
  apiUrl: string;
  token: string;
  projectId: string;
  requestId: string;
  maxFileBytes: number;
}
