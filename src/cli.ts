#!/usr/bin/env bun
/**
 * Entry point. Wires the pipeline and owns the process exit code.
 *
 * target -> diff -> filter -> chunk -> history -> review -> verify -> render
 */

import { chunkFiles, filterDiff } from './chunk.ts';
import { config } from './config.ts';
import { GeminiError } from './gemini.ts';
import { enrichChunk } from './history.ts';
import * as git from './git.ts';
import { render, renderStatusLine } from './render/terminal.ts';
import { runReviewPass } from './review.ts';
import { acquireDiff, confirmTarget, describeTarget, inferTarget } from './target.ts';
import type { EnrichedChunk, ReviewTarget, Warning } from './types.ts';
import { runVerifyPass } from './verify.ts';

const VERSION = '0.1.0';

const HELP = `aidr — AI diff reviewer

Reviews your local git diff with Gemini. Feeds the model the repository's own
history of the lines you touched, then makes every finding survive an attempt
to refute it before you ever see it.

USAGE
  aidr [target] [options]

TARGET  (inferred from git state when omitted)
  --staged              review staged changes            (git diff --cached)
  --working             review the working tree          (git diff)
  --branch [base]       review this branch vs its base   (git diff base...HEAD)
  --commit <ref>        review a single commit           (git show ref)

OPTIONS
  -y, --yes             accept the inferred target without prompting
  -v, --verbose         also show findings that verification discarded
      --model <name>    model for the review pass    (default ${config.reviewModel})
      --verify-model <name>
                        model for the verify pass    (default ${config.verifyModel})
      --concurrency <n> parallel model calls         (default ${config.concurrency})
      --max-verify <n>  verification call ceiling    (default ${config.maxVerifyCalls})
  -h, --help            show this
      --version         print the version

ENVIRONMENT
  GEMINI_API_KEY        required — https://aistudio.google.com/apikey

EXIT CODES
  0  no surviving bug-severity findings
  1  at least one surviving bug-severity finding
  2  the tool could not run

Every option has an AIDR_-prefixed environment variable; see src/config.ts.`;

interface Options {
  target: ReviewTarget | null;
  yes: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    target: null,
    yes: false,
    verbose: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const peek = () => {
      const next = argv[i + 1];
      return next && !next.startsWith('-') ? argv[++i] : undefined;
    };

    switch (arg) {
      case '--staged':
        options.target = { kind: 'staged' };
        break;
      case '--working':
        options.target = { kind: 'working' };
        break;
      case '--branch':
        options.target = { kind: 'branch', base: peek() ?? '' };
        break;
      case '--commit':
        options.target = { kind: 'commit', ref: peek() ?? 'HEAD' };
        break;
      case '-y':
      case '--yes':
        options.yes = true;
        break;
      case '-v':
      case '--verbose':
        options.verbose = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '--model':
        config.reviewModel = peek() ?? config.reviewModel;
        break;
      case '--verify-model':
        config.verifyModel = peek() ?? config.verifyModel;
        break;
      case '--concurrency': {
        const value = Number(peek());
        if (Number.isFinite(value) && value > 0) config.concurrency = value;
        break;
      }
      case '--max-verify': {
        const value = Number(peek());
        if (Number.isFinite(value) && value >= 0) config.maxVerifyCalls = value;
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}\nRun \`aidr --help\`.`);
    }
  }

  return options;
}

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (!(await git.isGitRepo())) {
    note('Not a git repository. aidr reads diffs from local git.');
    return 2;
  }
  if (!(await git.hasCommits())) {
    note('This repository has no commits yet, so there is no diff to review.');
    return 2;
  }

  // --- Target -------------------------------------------------------------
  let target: ReviewTarget;
  if (options.target) {
    target = await resolveExplicitTarget(options.target);
  } else {
    const inferred = await inferTarget();
    if (!inferred) {
      note('Nothing to review: no staged changes, a clean working tree, and no branch to compare.');
      return 0;
    }
    target = await confirmTarget(inferred, { yes: options.yes });
  }

  // --- Diff, filter, chunk ------------------------------------------------
  const rawDiff = await acquireDiff(target);
  if (!rawDiff.trim()) {
    note(`Nothing to review: ${describeTarget(target)} produced an empty diff.`);
    return 0;
  }

  const { files, excluded } = filterDiff(rawDiff);
  if (files.length === 0) {
    note(
      `Nothing to review: all ${excluded.length} changed file(s) were excluded ` +
        `(${[...new Set(excluded.map((f) => f.reason))].join(', ')}).`,
    );
    return 0;
  }

  const chunks = chunkFiles(files);
  process.stdout.write(`${renderStatusLine({ target, filesReviewed: files.length })}\n`);

  // --- History ------------------------------------------------------------
  const warnings: Warning[] = [];
  const enriched: EnrichedChunk[] = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        return { chunk, history: await enrichChunk(chunk) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push({ stage: 'history', path: chunk.path, message });
        return {
          chunk,
          history: {
            path: chunk.path,
            available: false,
            unavailableReason: 'history lookup failed',
            commits: [],
            blame: [],
            totalCommits: 0,
            recentCommits: 0,
            priorFixes: [],
            reverts: [],
            daysSinceLastTouch: null,
            distinctBlameCommits: 0,
          },
        };
      }
    }),
  );

  // --- Review -------------------------------------------------------------
  const progress = makeProgress();
  const review = await runReviewPass(enriched, config.concurrency, (done, total) =>
    progress(`reviewing ${done}/${total} chunk(s)`),
  );
  warnings.push(...review.warnings);

  // --- Verify -------------------------------------------------------------
  const contextByFile = new Map<string, string>();
  for (const chunk of chunks) {
    const existing = contextByFile.get(chunk.path);
    contextByFile.set(chunk.path, existing ? `${existing}\n${chunk.patch}` : chunk.patch);
  }

  const verify = await runVerifyPass(
    review.findings,
    contextByFile,
    config.concurrency,
    config.maxVerifyCalls,
    (done, total) => progress(`verifying ${done}/${total} finding(s)`),
  );
  warnings.push(...verify.warnings);
  progress.clear();

  // --- Render -------------------------------------------------------------
  process.stdout.write(
    `${render(
      {
        target,
        findings: verify.findings,
        excluded,
        warnings,
        filesReviewed: files.length,
        chunksReviewed: chunks.length,
        verifyCallsUsed: verify.callsUsed,
      },
      { verbose: options.verbose },
    )}\n`,
  );

  const blocking = verify.findings.some(
    (finding) => finding.severity === 'bug' && finding.verdict !== 'discarded',
  );
  return blocking ? 1 : 0;
}

/** Validate a target the user asked for explicitly, filling in defaults. */
async function resolveExplicitTarget(target: ReviewTarget): Promise<ReviewTarget> {
  if (target.kind === 'branch' && !target.base) {
    const base = await git.defaultBranch();
    if (!base) throw new Error('Could not determine a default branch. Pass one: --branch main');
    return { kind: 'branch', base };
  }
  if (target.kind === 'branch' && !(await git.resolveRef(target.base))) {
    throw new Error(`Base ref not found: ${target.base}`);
  }
  if (target.kind === 'commit' && !(await git.resolveRef(target.ref))) {
    throw new Error(`Commit not found: ${target.ref}`);
  }
  return target;
}

/** A single-line status indicator that stays out of the way when piped. */
function makeProgress() {
  const active = Boolean(process.stderr.isTTY);
  let width = 0;

  const write = (message: string) => {
    if (!active) return;
    process.stderr.write(`\r${message.padEnd(width)}`);
    width = Math.max(width, message.length);
  };
  write.clear = () => {
    if (active && width > 0) process.stderr.write(`\r${' '.repeat(width)}\r`);
  };
  return write;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (err) {
    if (err instanceof GeminiError) note(err.message);
    else if (err instanceof git.GitError) note(err.message);
    else note(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
