/**
 * The only module in the tree that talks to git.
 *
 * Every call is a thin `Bun.spawn` wrapper around the git CLI. No git library:
 * the CLI's output format is stable, it is already installed wherever this
 * tool runs, and it keeps the dependency count at zero.
 */

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/** Run git and return stdout. Throws `GitError` on a non-zero exit. */
export async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: cwd ?? process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    // Keep output machine-readable regardless of the user's git config.
    env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) throw new GitError(args, exitCode, stderr);
  return stdout;
}

/** Run git and return stdout, or `null` if the command failed. */
async function gitOrNull(args: string[]): Promise<string | null> {
  try {
    return await git(args);
  } catch {
    return null;
  }
}

/** True when the current working directory sits inside a git work tree. */
export async function isGitRepo(): Promise<boolean> {
  const out = await gitOrNull(['rev-parse', '--is-inside-work-tree']);
  return out?.trim() === 'true';
}

/** Absolute path to the repository root. */
export async function repoRoot(): Promise<string> {
  return (await git(['rev-parse', '--show-toplevel'])).trim();
}

/** True once the repository has at least one commit. */
export async function hasCommits(): Promise<boolean> {
  return (await gitOrNull(['rev-parse', '--verify', 'HEAD'])) !== null;
}

// --- Diff sources -----------------------------------------------------------

/** `git diff` — unstaged changes in the working tree. */
export async function diffWorkingTree(): Promise<string> {
  return git(['diff', '--no-color', '--no-ext-diff', '-M']);
}

/** `git diff --cached` — changes staged for the next commit. */
export async function diffStaged(): Promise<string> {
  return git(['diff', '--cached', '--no-color', '--no-ext-diff', '-M']);
}

/** `git diff <base>...HEAD` — everything this branch adds over its base. */
export async function diffBranch(base: string): Promise<string> {
  return git(['diff', '--no-color', '--no-ext-diff', '-M', `${base}...HEAD`]);
}

/** `git show <ref>` — a single commit as a diff. */
export async function showCommit(ref: string): Promise<string> {
  return git(['show', '--no-color', '--no-ext-diff', '-M', '--format=', ref]);
}

// --- History ----------------------------------------------------------------

/** Field separator that will not occur in a commit subject. */
export const LOG_SEP = '\x1f';

/**
 * `git log` for one path. Returns raw lines of
 * `hash<SEP>shortHash<SEP>isoDate<SEP>author<SEP>subject`.
 */
export async function logForFile(path: string, depth: number): Promise<string> {
  const out = await gitOrNull([
    'log',
    `-n${depth}`,
    '--no-color',
    '--follow',
    `--format=%H${LOG_SEP}%h${LOG_SEP}%aI${LOG_SEP}%an${LOG_SEP}%s`,
    '--',
    path,
  ]);
  return out ?? '';
}

/**
 * `git blame -L <start>,<end>` against HEAD, in porcelain form.
 *
 * Returns an empty string when the path or range does not exist at HEAD —
 * a new file, or a range past the end of the pre-image. Callers treat that
 * as "no history available" rather than as an error.
 */
export async function blameLines(
  path: string,
  start: number,
  end: number,
): Promise<string> {
  const out = await gitOrNull([
    'blame',
    '--line-porcelain',
    '-L',
    `${start},${end}`,
    'HEAD',
    '--',
    path,
  ]);
  return out ?? '';
}

// --- Repository state -------------------------------------------------------

/** Current branch name, or `null` when HEAD is detached. */
export async function currentBranch(): Promise<string | null> {
  const out = await gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = out?.trim();
  return !name || name === 'HEAD' ? null : name;
}

/**
 * The repository's default branch.
 *
 * Prefers what the remote advertises, then falls back to whichever of the
 * conventional names actually exists locally.
 */
export async function defaultBranch(): Promise<string | null> {
  const symbolic = await gitOrNull(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const fromRemote = symbolic?.trim().replace(/^refs\/remotes\/origin\//, '');
  if (fromRemote) return fromRemote;

  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    if (await gitOrNull(['rev-parse', '--verify', `refs/heads/${candidate}`])) {
      return candidate;
    }
  }
  return null;
}

/** True when anything is staged for commit. */
export async function hasStagedChanges(): Promise<boolean> {
  try {
    await git(['diff', '--cached', '--quiet']);
    return false;
  } catch (err) {
    // Exit 1 means "differences found"; anything else is a real failure.
    if (err instanceof GitError && err.exitCode === 1) return true;
    throw err;
  }
}

/** True when tracked files have unstaged modifications. */
export async function isWorkingTreeDirty(): Promise<boolean> {
  try {
    await git(['diff', '--quiet']);
    return false;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return true;
    throw err;
  }
}

/** Resolve a ref to a full hash, or `null` if it does not exist. */
export async function resolveRef(ref: string): Promise<string | null> {
  const out = await gitOrNull(['rev-parse', '--verify', `${ref}^{commit}`]);
  return out?.trim() ?? null;
}
