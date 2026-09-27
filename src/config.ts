/**
 * env -> typed config, one source of truth.
 *
 * Platform CI variables are read directly so the CI job stays one line. CLI
 * flags override env. Secrets come from the environment only — there is no
 * config file in $HOME, so CI and local behave identically.
 */

import { z } from 'zod';
import type { PlatformName, Severity } from './types.ts';
import { isPriced } from './review/pricing.ts';
import { isJevModel } from './review/jev.ts';

export const PROMPT_VERSION = 'v1';

export type ContextMode = 'full' | 'diff' | 'off';
export type JudgeMode = 'on' | 'off';

export interface Config {
  platform: PlatformName;
  apiUrl: string;
  token: string | null;
  projectId: string;
  requestId: string;
  anthropicApiKey: string | null;

  reviewModel: string;
  judgeModel: string;
  /** Retried here when the review model declines a request. Never silent. */
  fallbackModel: string | null;

  /** Set when `judgeModel` names a TypeSafe decision model. */
  jev: {
    endpoint: string;
    apiKey: string | null;
  };
  reviewEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  judgeEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;

  dryRun: boolean;
  strict: boolean;
  failOn: Severity | 'none';
  context: ContextMode;
  judge: JudgeMode;

  concurrency: number;
  maxFilesPerBatch: number;
  /** Share of the model's context window we will fill with input. */
  inputBudgetRatio: number;
  runDeadlineMs: number;
  budgetUsd: number;
  confidenceThreshold: number;
  maxFileBytes: number;

  rulesDir: string;
  ruleFileMaxBytes: number;
  ruleTotalMaxBytes: number;

  stateDbPath: string;
  cacheDir: string;
  debugDir: string | null;
  logFormat: 'json' | 'human';
  promptVersion: string;
}

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const EnvSchema = z.object({
  REVIEWER_PLATFORM: z.enum(['gitlab', 'github', 'local']).optional(),
  REVIEWER_API_URL: z.string().optional(),
  REVIEWER_TOKEN: z.string().optional(),
  REVIEWER_PROJECT_ID: z.string().optional(),
  REVIEWER_MR_IID: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  REVIEWER_REVIEW_MODEL: z.string().optional(),
  REVIEWER_JUDGE_MODEL: z.string().optional(),
  REVIEWER_FALLBACK_MODEL: z.string().optional(),
  REVIEWER_JEV_ENDPOINT: z.string().optional(),
  REVIEWER_JEV_API_KEY: z.string().optional(),
  TYPESAFE_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  REVIEWER_REVIEW_EFFORT: z.enum(EFFORTS).optional(),
  REVIEWER_JUDGE_EFFORT: z.enum(EFFORTS).optional(),

  REVIEWER_CONTEXT: z.enum(['full', 'diff', 'off']).optional(),
  REVIEWER_JUDGE: z.enum(['on', 'off']).optional(),
  REVIEWER_FAIL_ON: z.enum([...SEVERITIES, 'none']).optional(),
  REVIEWER_CONCURRENCY: z.string().optional(),
  REVIEWER_BUDGET_USD: z.string().optional(),
  REVIEWER_CONFIDENCE: z.string().optional(),
  REVIEWER_DEADLINE_MS: z.string().optional(),
  REVIEWER_RULES_DIR: z.string().optional(),
  REVIEWER_STATE_DB: z.string().optional(),
  REVIEWER_CACHE_DIR: z.string().optional(),
  REVIEWER_DEBUG_DIR: z.string().optional(),
  REVIEWER_LOG_FORMAT: z.enum(['json', 'human']).optional(),

  // GitLab CI
  CI_API_V4_URL: z.string().optional(),
  CI_MERGE_REQUEST_PROJECT_ID: z.string().optional(),
  CI_MERGE_REQUEST_IID: z.string().optional(),
  CI_PROJECT_ID: z.string().optional(),
  // GitHub Actions
  GITHUB_REPOSITORY: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_API_URL: z.string().optional(),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface Overrides {
  platform?: PlatformName;
  projectId?: string;
  requestId?: string;
  dryRun?: boolean;
  strict?: boolean;
  context?: ContextMode;
  judge?: JudgeMode;
  failOn?: Severity | 'none';
  reviewModel?: string;
  judgeModel?: string;
  logFormat?: 'json' | 'human';
  debugDir?: string;
  rulesDir?: string;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`expected a number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export class ConfigError extends Error {}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Overrides = {},
): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      `invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  const e = parsed.data;

  const platform: PlatformName =
    overrides.platform ??
    e.REVIEWER_PLATFORM ??
    (e.CI_MERGE_REQUEST_IID ? 'gitlab' : e.GITHUB_REPOSITORY ? 'github' : 'local');

  const projectId =
    overrides.projectId ??
    e.REVIEWER_PROJECT_ID ??
    e.CI_MERGE_REQUEST_PROJECT_ID ??
    e.CI_PROJECT_ID ??
    e.GITHUB_REPOSITORY ??
    '';

  const requestId = overrides.requestId ?? e.REVIEWER_MR_IID ?? e.CI_MERGE_REQUEST_IID ?? '';

  const apiUrl =
    e.REVIEWER_API_URL ??
    (platform === 'gitlab'
      ? (e.CI_API_V4_URL ?? 'https://gitlab.com/api/v4')
      : (e.GITHUB_API_URL ?? 'https://api.github.com'));

  const token = e.REVIEWER_TOKEN ?? e.GITHUB_TOKEN ?? null;

  const reviewModel = overrides.reviewModel ?? e.REVIEWER_REVIEW_MODEL ?? 'claude-opus-5';
  const judgeModel = overrides.judgeModel ?? e.REVIEWER_JUDGE_MODEL ?? 'claude-sonnet-5';

  const cfg: Config = {
    platform,
    apiUrl: apiUrl.replace(/\/$/, ''),
    token,
    projectId,
    requestId,
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,

    reviewModel,
    judgeModel,
    // Security-shaped diffs occasionally trip the safety classifiers on the
    // frontier models; a declined batch is retried here and reported.
    fallbackModel:
      e.REVIEWER_FALLBACK_MODEL === 'none' ? null : (e.REVIEWER_FALLBACK_MODEL ?? 'claude-opus-4-8'),
    jev: {
      // Reachable three ways (TypeSafe direct, OpenRouter, Cloudflare) and in
      // early access, so the endpoint is configuration rather than a constant.
      endpoint: e.REVIEWER_JEV_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone',
      apiKey: e.REVIEWER_JEV_API_KEY ?? e.TYPESAFE_API_KEY ?? e.OPENROUTER_API_KEY ?? null,
    },
    reviewEffort: e.REVIEWER_REVIEW_EFFORT ?? 'xhigh',
    judgeEffort: e.REVIEWER_JUDGE_EFFORT ?? 'low',
    // Generous on purpose: thinking is on by default on the 5-family and shares
    // this ceiling with the response, so a tight cap truncates mid-answer.
    maxTokens: 32_000,

    dryRun: overrides.dryRun ?? false,
    strict: overrides.strict ?? false,
    failOn: overrides.failOn ?? e.REVIEWER_FAIL_ON ?? 'none',
    context: overrides.context ?? e.REVIEWER_CONTEXT ?? 'full',
    judge: overrides.judge ?? e.REVIEWER_JUDGE ?? 'on',

    concurrency: Math.max(1, num(e.REVIEWER_CONCURRENCY, 3)),
    maxFilesPerBatch: 12,
    inputBudgetRatio: 0.65,
    runDeadlineMs: num(e.REVIEWER_DEADLINE_MS, 15 * 60 * 1000),
    budgetUsd: num(e.REVIEWER_BUDGET_USD, 2),
    confidenceThreshold: num(e.REVIEWER_CONFIDENCE, 0.6),
    maxFileBytes: 256 * 1024,

    rulesDir: overrides.rulesDir ?? e.REVIEWER_RULES_DIR ?? '.review',
    ruleFileMaxBytes: 10 * 1024,
    ruleTotalMaxBytes: 50 * 1024,

    stateDbPath: e.REVIEWER_STATE_DB ?? '.aidr/state.sqlite',
    cacheDir: e.REVIEWER_CACHE_DIR ?? '.aidr/cache',
    debugDir: overrides.debugDir ?? e.REVIEWER_DEBUG_DIR ?? null,
    logFormat: overrides.logFormat ?? e.REVIEWER_LOG_FORMAT ?? 'human',
    promptVersion: PROMPT_VERSION,
  };

  validate(cfg);
  return cfg;
}

/** Preconditions that should fail the run before a single token is spent. */
function validate(cfg: Config): void {
  const problems: string[] = [];

  if (cfg.platform !== 'local') {
    if (!cfg.projectId) problems.push('REVIEWER_PROJECT_ID is required for a hosted platform');
    if (!cfg.requestId) problems.push('REVIEWER_MR_IID is required for a hosted platform');
    if (!cfg.token) problems.push('REVIEWER_TOKEN (or GITHUB_TOKEN) is required');
  }
  if (cfg.confidenceThreshold < 0 || cfg.confidenceThreshold > 1) {
    problems.push('REVIEWER_CONFIDENCE must be between 0 and 1');
  }
  if (cfg.budgetUsd <= 0) problems.push('REVIEWER_BUDGET_USD must be greater than 0');
  if (cfg.judge === 'on' && isJevModel(cfg.judgeModel) && !cfg.jev.apiKey) {
    problems.push(
      'a Jev judge needs REVIEWER_JEV_API_KEY (or TYPESAFE_API_KEY / OPENROUTER_API_KEY)',
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(problems.join('\n'));
  }
}

/**
 * Models we cannot price. Not fatal — the run records a degradation so an
 * unpriced model can never masquerade as a free one.
 */
export function unpricedModels(cfg: Config): string[] {
  const models = [cfg.reviewModel];
  if (cfg.judge === 'on') models.push(cfg.judgeModel);
  return [...new Set(models)].filter((m) => !isPriced(m));
}
