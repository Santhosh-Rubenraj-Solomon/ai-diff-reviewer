#!/usr/bin/env bun
/**
 * Argument parsing, exit codes, and the run summary.
 *
 * Flags are `--key=value` or `--key value`. There are deliberately no `--no-x`
 * negation forms: they are the kind of flag that silently becomes a no-op and
 * nobody notices. Say `--context=off`, not `--no-context`.
 */

import { loadConfig, ConfigError, type Config, type ContextMode, type JudgeMode } from './config.ts';
import { configureLogger, log } from './logger.ts';
import { runReview } from './pipeline.ts';
import { createPlatform } from './platform/index.ts';
import { loadRules } from './rules/load.ts';
import { matchCounts } from './rules/match.ts';
import { Store } from './store/db.ts';
import type { RunResult, Severity } from './types.ts';

const VERSION = '1.0.0';

const USAGE = `aidr ${VERSION} — an LLM code reviewer for GitLab and GitHub

Usage:
  aidr review [options]          Review a merge request / pull request
  aidr rules check [options]     Validate .review rules; non-zero on error
  aidr runs list [--limit=N]     List recent runs
  aidr runs show <run-id>        Print one run record in full

Options:
  --platform=gitlab|github|local   Defaults to the CI environment, else local
  --project=<id>                   Project id (GitLab) or owner/repo (GitHub)
  --mr=<iid> | --pr=<number>       Merge request iid / pull request number
  --base=<ref>                     Local mode: ref to diff against
  --repo=<path>                    Repository root (default: cwd)
  --dry-run                        Print findings; post nothing
  --context=full|diff|off          Context depth (default: full)
  --judge=on|off                   Second-gate LLM judge (default: on)
  --model=<id>                     Review model (default: claude-opus-5)
  --judge-model=<id>               Judge model (default: claude-sonnet-5)
  --rules-dir=<path>               Rules directory (default: .review)
  --fail-on=critical|high|medium|low|none
                                   Exit 1 when a finding at or above this
                                   severity is posted (default: none)
  --strict                         Exit 1 on a partial run
  --log-format=human|json          Log output (default: human)
  --debug-dir=<path>               Write raw model output here (off by default)
  --help, --version

Exit codes:
  0  completed (or partial without --strict)
  1  interrupted, failed, partial with --strict, or --fail-on was met
`;

interface Args {
  command: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Args {
  const command: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      command.push(token);
      continue;
    }
    if (token.startsWith('--no-')) {
      throw new ConfigError(
        `unsupported flag \`${token}\`. Negation flags are not supported — use an explicit value, e.g. --context=off.`,
      );
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      index += 1;
    } else {
      flags.set(body, true);
    }
  }

  return { command, flags };
}

function str(flags: Args['flags'], key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

function bool(flags: Args['flags'], key: string): boolean {
  return flags.get(key) === true || flags.get(key) === 'true';
}

function configFrom(args: Args): Config {
  const { flags } = args;
  const overrides: Parameters<typeof loadConfig>[1] = {};

  const platform = str(flags, 'platform');
  if (platform === 'gitlab' || platform === 'github' || platform === 'local') {
    overrides.platform = platform;
  }
  const project = str(flags, 'project');
  if (project) overrides.projectId = project;
  const requestId = str(flags, 'mr') ?? str(flags, 'pr');
  if (requestId) overrides.requestId = requestId;
  if (bool(flags, 'dry-run')) overrides.dryRun = true;
  if (bool(flags, 'strict')) overrides.strict = true;

  const context = str(flags, 'context');
  if (context === 'full' || context === 'diff' || context === 'off') {
    overrides.context = context as ContextMode;
  }
  const judge = str(flags, 'judge');
  if (judge === 'on' || judge === 'off') overrides.judge = judge as JudgeMode;

  const failOn = str(flags, 'fail-on');
  if (failOn) overrides.failOn = failOn as Severity | 'none';

  const model = str(flags, 'model');
  if (model) overrides.reviewModel = model;
  const judgeModel = str(flags, 'judge-model');
  if (judgeModel) overrides.judgeModel = judgeModel;

  const logFormat = str(flags, 'log-format');
  if (logFormat === 'json' || logFormat === 'human') overrides.logFormat = logFormat;
  const debugDir = str(flags, 'debug-dir');
  if (debugDir) overrides.debugDir = debugDir;
  const rulesDir = str(flags, 'rules-dir');
  if (rulesDir) overrides.rulesDir = rulesDir;

  const cfg = loadConfig(process.env, overrides);
  // The local adapter cannot post; make that explicit rather than failing late.
  if (cfg.platform === 'local') cfg.dryRun = true;
  return cfg;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

export function exitCodeFor(result: RunResult, cfg: Config): number {
  if (result.status === 'failed' || result.status === 'interrupted') return 1;
  if (result.status === 'partial' && cfg.strict) return 1;
  if (cfg.failOn !== 'none') {
    const bar = SEVERITY_RANK[cfg.failOn];
    if (result.findingsPosted.some((finding) => SEVERITY_RANK[finding.severity] >= bar)) return 1;
  }
  return 0;
}

function printFindings(result: RunResult): void {
  if (result.findingsPosted.length === 0) {
    process.stdout.write('\nNo findings.\n');
  }
  for (const finding of result.findingsPosted) {
    process.stdout.write(
      `\n${finding.severity.toUpperCase()} ${finding.category} — ${finding.path}:${finding.line}\n` +
        `  ${finding.title}\n` +
        `  ${finding.body.split('\n').join('\n  ')}\n` +
        (finding.ruleIds.length ? `  rules: ${finding.ruleIds.join(', ')}\n` : '') +
        `  confidence: ${finding.confidence.toFixed(2)}\n`,
    );
  }
  if (result.findingsDropped.length > 0) {
    process.stdout.write(`\nDropped before posting (${result.findingsDropped.length}):\n`);
    for (const finding of result.findingsDropped) {
      process.stdout.write(`  - ${finding.path}:${finding.line} — ${finding.dropReason}\n`);
    }
  }
}

async function commandReview(args: Args): Promise<number> {
  const cfg = configFrom(args);
  configureLogger({ format: cfg.logFormat });

  if (!cfg.anthropicApiKey) {
    // Not fatal: the SDK also resolves an `ant auth login` profile. But an
    // unset key is the usual cause of an interrupted run, so say so up front
    // rather than only in the error list at the end.
    log.warn(
      'ANTHROPIC_API_KEY is not set; the SDK will fall back to a stored credential profile',
      {},
    );
  }

  const repoRoot = str(args.flags, 'repo') ?? process.cwd();
  const localBase = str(args.flags, 'base');

  const result = await runReview(cfg, { repoRoot, localBase });

  printFindings(result);
  process.stdout.write(
    `\nstatus=${result.status} reviewed=${result.filesReviewed.length} ` +
      `skipped=${result.filesSkipped.length} posted=${result.findingsPosted.length} ` +
      `dropped=${result.findingsDropped.length} cost=$${result.costUsd.toFixed(4)} ` +
      `run=${result.runId}\n`,
  );
  for (const entry of result.degradations) process.stdout.write(`  degraded: ${entry}\n`);
  for (const entry of result.errors) process.stdout.write(`  error [${entry.stage}]: ${entry.message}\n`);

  return exitCodeFor(result, cfg);
}

async function commandRulesCheck(args: Args): Promise<number> {
  const cfg = configFrom(args);
  configureLogger({ format: cfg.logFormat });

  const repoRoot = str(args.flags, 'repo') ?? process.cwd();
  const platform = createPlatform(cfg, { repoRoot, localBase: str(args.flags, 'base') });

  const result = await loadRules(platform, {
    rulesDir: cfg.rulesDir,
    fileMaxBytes: cfg.ruleFileMaxBytes,
    totalMaxBytes: cfg.ruleTotalMaxBytes,
  });

  const paths = await platform.listTargetBranchTree('').catch(() => []);
  const counts = matchCounts(result.rules, paths);

  process.stdout.write(`Loaded ${result.rules.length} rule(s) from ${cfg.rulesDir}\n`);
  for (const rule of result.rules) {
    const scope = rule.global ? 'global' : rule.globs.join(', ');
    const matched = counts.get(rule.id) ?? 0;
    const warning = !rule.global && matched === 0 ? '  <-- matches nothing' : '';
    process.stdout.write(
      `  ${rule.id}  [${scope}]  severity=${rule.severity} priority=${rule.priority} matches=${matched}${warning}\n`,
    );
  }

  for (const dropped of result.dropped) {
    process.stderr.write(`dropped: ${dropped.sourcePath} (${dropped.id}) — ${dropped.reason}\n`);
  }
  for (const error of result.errors) {
    process.stderr.write(`error: ${error.sourcePath} — ${error.message}\n`);
  }

  const unmatched = result.rules.filter(
    (rule) => !rule.global && (counts.get(rule.id) ?? 0) === 0,
  );
  if (unmatched.length > 0) {
    process.stderr.write(
      `error: ${unmatched.length} scoped rule(s) match no file in the repository\n`,
    );
  }

  return result.errors.length > 0 || result.dropped.length > 0 || unmatched.length > 0 ? 1 : 0;
}

function commandRuns(args: Args): number {
  const cfg = configFrom(args);
  const store = new Store(cfg.stateDbPath);
  const [, sub, runId] = args.command;

  if (sub === 'show') {
    if (!runId) {
      process.stderr.write('usage: aidr runs show <run-id>\n');
      return 1;
    }
    const run = store.getRun(runId);
    if (!run) {
      process.stderr.write(`no run with id ${runId}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return 0;
  }

  const limit = Number(str(args.flags, 'limit') ?? 20);
  for (const run of store.listRuns(Number.isFinite(limit) ? limit : 20)) {
    process.stdout.write(
      `${run.createdAt}  ${run.status.padEnd(11)}  ${run.headSha.slice(0, 10)}  ${run.runId}\n`,
    );
  }
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (args.flags.has('help') || args.command.length === 0) {
    process.stdout.write(USAGE);
    return args.command.length === 0 && !args.flags.has('help') ? 1 : 0;
  }
  if (args.flags.has('version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    switch (args.command[0]) {
      case 'review':
        return await commandReview(args);
      case 'rules':
        if (args.command[1] !== 'check') {
          process.stderr.write('usage: aidr rules check\n');
          return 1;
        }
        return await commandRulesCheck(args);
      case 'runs':
        return commandRuns(args);
      default:
        process.stderr.write(`unknown command: ${args.command[0]}\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`configuration error:\n${err.message}\n`);
      return 1;
    }
    log.error('unhandled failure', { error: err instanceof Error ? err.stack : String(err) });
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
