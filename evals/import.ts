#!/usr/bin/env bun
/**
 * Freeze a real merge request into a golden-set fixture.
 *
 * The seed cases in `cases/` are illustrative. A golden set that means
 * anything is built from your own history — this makes that one command per
 * merge request, after which you fill in `expected` and `forbidden` by hand.
 * That labelling is the part nobody can automate, and the part that makes the
 * numbers worth reading.
 *
 *   bun run evals/import.ts --platform=github --project=owner/repo --pr=412 --split=train
 *   bun run evals/import.ts --platform=gitlab --project=1234 --mr=88 --split=holdout
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createPlatform } from '../src/platform/index.ts';
import type { EvalCase } from './case.ts';

const HERE = new URL('.', import.meta.url).pathname;

function flag(name: string): string | undefined {
  const match = process.argv.find((token) => token.startsWith(`--${name}=`));
  return match?.slice(name.length + 3);
}

function renderDiff(hunks: { lines: { kind: string; text: string }[]; oldStart: number; oldLines: number; newStart: number; newLines: number }[]): string {
  return hunks
    .map((hunk) => {
      const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      const body = hunk.lines.map((line) => {
        const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        return `${marker}${line.text}`;
      });
      return [header, ...body].join('\n');
    })
    .join('\n');
}

async function main(): Promise<number> {
  const split = flag('split') ?? 'train';
  if (split !== 'train' && split !== 'holdout') {
    process.stderr.write('--split must be train or holdout\n');
    return 1;
  }

  const cfg = loadConfig(process.env, {
    platform: flag('platform') as 'gitlab' | 'github' | undefined,
    projectId: flag('project'),
    requestId: flag('mr') ?? flag('pr'),
    dryRun: true,
  });

  const platform = createPlatform(cfg, { repoRoot: process.cwd() });
  const changeSet = await platform.fetchChangeSet();

  const id =
    flag('id') ??
    `${changeSet.platform}-${changeSet.projectId.replace(/[^\w-]/g, '-')}-${changeSet.requestId}`;

  const evalCase: EvalCase = {
    id,
    split,
    source: changeSet.webUrl ?? `${changeSet.platform}:${changeSet.projectId}!${changeSet.requestId}`,
    title: changeSet.title,
    description: changeSet.description,
    targetBranch: changeSet.targetBranch,
    headSha: changeSet.headSha,
    files: changeSet.files.map((file) => ({
      path: file.path,
      status: file.status,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      diff: renderDiff(file.hunks),
      headContent: file.headContent,
    })),
    // Labelling is manual on purpose: these are the human judgements the
    // whole harness is measured against.
    expected: [],
    forbidden: [],
    stubFindings: [],
  };

  const outDir = join(HERE, 'cases');
  await mkdir(outDir, { recursive: true });
  const outPath = flag('out') ?? join(outDir, `${id}.json`);
  await writeFile(outPath, `${JSON.stringify(evalCase, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `wrote ${outPath}\n` +
      `  ${evalCase.files.length} file(s), ${changeSet.skipped.length} skipped\n` +
      '  next: fill in "expected" (findings a human made or would have made)\n' +
      '        and "forbidden" (noise you never want to see again)\n',
  );
  return 0;
}

process.exit(await main());
