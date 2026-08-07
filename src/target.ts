/**
 * Deciding what to review, and turning that decision into a diff.
 *
 * Git state answers "what did you mean?" in nearly every case, so the tool
 * infers rather than asks: staged beats working tree beats branch-vs-base.
 * The inference is presented pre-selected and accepted on Enter, so the
 * common path is one keystroke and the uncommon path is still reachable.
 */

import * as git from './git.ts';
import type { ReviewTarget } from './types.ts';

/** A target the user could pick, with the label shown in the prompt. */
export interface TargetOption {
  target: ReviewTarget;
  label: string;
  detail: string;
}

export function describeTarget(target: ReviewTarget): string {
  switch (target.kind) {
    case 'staged':
      return 'staged changes';
    case 'working':
      return 'working tree';
    case 'branch':
      return `this branch vs ${target.base}`;
    case 'commit':
      return `commit ${target.ref}`;
  }
}

/**
 * Infer the target from repository state.
 *
 * Checks staged, then working tree, then non-default branch, and returns
 * `null` when none apply — the "nothing to review" exit path.
 */
export async function inferTarget(): Promise<ReviewTarget | null> {
  if (await git.hasStagedChanges()) return { kind: 'staged' };
  if (await git.isWorkingTreeDirty()) return { kind: 'working' };

  const [branch, base] = await Promise.all([git.currentBranch(), git.defaultBranch()]);
  if (branch && base && branch !== base && (await git.resolveRef(base))) {
    return { kind: 'branch', base };
  }
  return null;
}

/** Every target that makes sense right now, inferred one first. */
export async function availableTargets(inferred: ReviewTarget | null): Promise<TargetOption[]> {
  const options: TargetOption[] = [];

  if (await git.hasStagedChanges()) {
    options.push({
      target: { kind: 'staged' },
      label: 'Staged changes',
      detail: 'git diff --cached',
    });
  }
  if (await git.isWorkingTreeDirty()) {
    options.push({
      target: { kind: 'working' },
      label: 'Working tree',
      detail: 'git diff',
    });
  }

  const [branch, base] = await Promise.all([git.currentBranch(), git.defaultBranch()]);
  if (branch && base && branch !== base && (await git.resolveRef(base))) {
    options.push({
      target: { kind: 'branch', base },
      label: `Branch ${branch} vs ${base}`,
      detail: `git diff ${base}...HEAD`,
    });
  }

  if (await git.hasCommits()) {
    options.push({
      target: { kind: 'commit', ref: 'HEAD' },
      label: 'Last commit',
      detail: 'git show HEAD',
    });
  }

  if (!inferred) return options;

  // Surface the inference first so the default is also the top of the list.
  const key = (t: ReviewTarget) => `${t.kind}:${'base' in t ? t.base : 'ref' in t ? t.ref : ''}`;
  const inferredKey = key(inferred);
  return [
    ...options.filter((o) => key(o.target) === inferredKey),
    ...options.filter((o) => key(o.target) !== inferredKey),
  ];
}

export interface ConfirmOptions {
  /** Skip the prompt and take the inference as given. */
  yes: boolean;
  /** Overridden in tests; defaults to whether stdin and stdout are terminals. */
  interactive?: boolean;
}

/**
 * Confirm the inferred target, prompting only when it is worth prompting.
 *
 * The prompt is skipped entirely when `--yes` is passed or the session is not
 * a TTY, which keeps the tool usable from hooks, scripts and CI.
 */
export async function confirmTarget(
  inferred: ReviewTarget,
  options: ConfirmOptions,
): Promise<ReviewTarget> {
  const interactive =
    options.interactive ?? (Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY));

  if (options.yes || !interactive) return inferred;

  const choices = await availableTargets(inferred);
  if (choices.length <= 1) return inferred;

  const inferredIndex = 0; // availableTargets puts the inference first.
  process.stdout.write('\nWhat should I review?\n');
  choices.forEach((choice, i) => {
    const marker = i === inferredIndex ? '>' : ' ';
    const suffix = i === inferredIndex ? '  (inferred)' : '';
    process.stdout.write(`  ${marker} ${i + 1}. ${choice.label}${suffix}\n`);
    process.stdout.write(`       ${choice.detail}\n`);
  });
  process.stdout.write(`\nEnter to accept ${inferredIndex + 1}, or pick a number: `);

  const answer = (await readLine()).trim();
  process.stdout.write('\n');

  if (answer === '') return choices[inferredIndex]!.target;

  const picked = Number(answer);
  const chosen = Number.isInteger(picked) ? choices[picked - 1] : undefined;
  if (!chosen) {
    process.stdout.write(`Not a listed option; using the inferred target.\n`);
    return choices[inferredIndex]!.target;
  }
  return chosen.target;
}

/** Read one line from stdin. Resolves to an empty string on EOF. */
async function readLine(): Promise<string> {
  for await (const chunk of Bun.stdin.stream()) {
    const text = new TextDecoder().decode(chunk);
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
  }
  return '';
}

/**
 * Run the git command for a resolved target and return the raw unified diff.
 *
 * Each of the four variants maps to exactly one call in `git.ts`.
 */
export async function acquireDiff(target: ReviewTarget): Promise<string> {
  switch (target.kind) {
    case 'staged':
      return git.diffStaged();
    case 'working':
      return git.diffWorkingTree();
    case 'branch':
      return git.diffBranch(target.base);
    case 'commit':
      return git.showCommit(target.ref);
  }
}
