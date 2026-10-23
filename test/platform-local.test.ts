import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPlatform } from '../src/platform/local.ts';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: cwd,
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`);
  return out;
}

let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'aidr-local-'));
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/keep.ts'), 'export const a = 1;\n');
  await writeFile(join(repo, 'src/gone.ts'), 'export const g = 1;\n');
  await writeFile(join(repo, 'src/before.ts'), 'export const moved = 1;\nexport const m2 = 2;\nexport const m3 = 3;\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');

  await git(repo, 'checkout', '-q', '-b', 'feature');
  await writeFile(join(repo, 'src/keep.ts'), 'export const a = 2;\n');
  await rm(join(repo, 'src/gone.ts'));
  await git(repo, 'mv', 'src/before.ts', 'src/after.ts');
  await writeFile(join(repo, 'package-lock.json'), '{}\n');
  await mkdir(join(repo, '.review'), { recursive: true });
  await writeFile(join(repo, '.review/rule.md'), '---\nid: r\n---\nbody\n');
  await mkdir(join(repo, '.review/node_modules'), { recursive: true });
  await writeFile(join(repo, '.review/node_modules/x.md'), 'ignored');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'Feature subject', '-m', 'Feature body');
  // Uncommitted working-tree change is part of the local review.
  await writeFile(join(repo, 'src/keep.ts'), 'export const a = 3;\n');
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('LocalPlatform', () => {
  test('diffs the working tree against the merge base with the base branch', async () => {
    const platform = new LocalPlatform({ repoRoot: repo, maxFileBytes: 100_000 });
    const cs = await platform.fetchChangeSet();

    const mainSha = (await git(repo, 'rev-parse', 'main')).trim();
    const headSha = (await git(repo, 'rev-parse', 'HEAD')).trim();
    expect(cs.platform).toBe('local');
    expect(cs.baseSha).toBe(mainSha);
    expect(cs.startSha).toBe(mainSha);
    expect(cs.headSha).toBe(headSha);
    expect(cs.requestId).toBe('feature');
    expect(cs.targetBranch).toBe('main');
    expect(cs.title).toBe('Feature subject');
    expect(cs.description).toBe('Feature body');

    const byPath = Object.fromEntries(cs.files.map((f) => [f.path, f]));
    expect(byPath['src/keep.ts']!.headContent).toBe('export const a = 3;\n'); // uncommitted edit included
    expect(byPath['src/after.ts']!.status).toBe('renamed');
    expect(byPath['src/after.ts']!.oldPath).toBe('src/before.ts');
    expect(byPath['.review/rule.md']).toBeDefined();

    const skipped = Object.fromEntries(cs.skipped.map((s) => [s.path, s.reason]));
    expect(skipped['src/gone.ts']).toBe('deleted');
    expect(skipped['package-lock.json']).toBe('lockfile');
  });

  test('an explicit base ref is used as given', async () => {
    const platform = new LocalPlatform({ repoRoot: repo, base: 'main', maxFileBytes: 100_000 });
    const cs = await platform.fetchChangeSet();
    expect(cs.targetBranch).toBe('main');
  });

  test('a git failure is reported with the command and stderr', async () => {
    const platform = new LocalPlatform({ repoRoot: repo, base: 'no-such-ref', maxFileBytes: 100_000 });
    await expect(platform.fetchChangeSet()).rejects.toThrow(/git diff .* failed/);
  });

  test('reads come from the working tree and return null when missing', async () => {
    const platform = new LocalPlatform({ repoRoot: repo, maxFileBytes: 100_000 });
    expect(await platform.fetchFileAtSha('src/keep.ts', 'ignored')).toBe('export const a = 3;\n');
    expect(await platform.fetchFileFromTargetBranch('.review/rule.md')).toContain('id: r');
    expect(await platform.fetchFileAtSha('nope.ts', 'x')).toBeNull();
  });

  test('listTargetBranchTree walks the prefix and skips ignored directories', async () => {
    const platform = new LocalPlatform({ repoRoot: repo, maxFileBytes: 100_000 });
    expect(await platform.listTargetBranchTree('.review')).toEqual(['.review/rule.md']);
    expect(await platform.listTargetBranchTree('does-not-exist')).toEqual([]);
  });

  test('the archive is the checkout itself and there are no own notes', async () => {
    const platform = new LocalPlatform({ repoRoot: repo, maxFileBytes: 100_000 });
    expect(await platform.fetchRepoArchive('x', '/unused')).toBe(repo);
    expect(await platform.listOwnNotes()).toEqual([]);
  });

  test('every write path refuses loudly, pointing at --dry-run', async () => {
    const platform = new LocalPlatform({ repoRoot: repo, maxFileBytes: 100_000 });
    await expect(platform.postInline()).rejects.toThrow('--dry-run');
    await expect(platform.postGeneralNote()).rejects.toThrow('--dry-run');
    await expect(platform.updateNote()).rejects.toThrow('--dry-run');
    await expect(platform.resolveThread()).rejects.toThrow('--dry-run');
  });
});
