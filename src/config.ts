/**
 * Tunables, all overridable by environment variable.
 *
 * The two model names are deliberately separate values that default to the
 * same string. The two-tier design (cheap model reads, strong model judges) is
 * economically right in principle, but the recall ceiling is set entirely by
 * the reading pass — verification can remove findings, never add them. Until
 * there is real output to judge, picking tiers is guesswork, so the default
 * keeps them identical and the option costs nothing.
 */

/** Model used when neither pass is configured explicitly. */
export const DEFAULT_MODEL = 'gemini-2.5-flash';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  /** Model for the high-volume reading pass. */
  reviewModel: process.env.AIDR_REVIEW_MODEL ?? DEFAULT_MODEL,
  /** Model for the low-volume judging pass. */
  verifyModel: process.env.AIDR_VERIFY_MODEL ?? DEFAULT_MODEL,

  /** Any single file whose diff exceeds this is excluded, not truncated. */
  maxFileDiffBytes: num('AIDR_MAX_FILE_DIFF_BYTES', 60_000),
  /** A file diff over this is split along hunk boundaries. */
  maxChunkBytes: num('AIDR_MAX_CHUNK_BYTES', 20_000),

  /** How many review calls are in flight at once. */
  concurrency: num('AIDR_CONCURRENCY', 4),
  /** Hard ceiling on verification calls; findings beyond it pass through flagged. */
  maxVerifyCalls: num('AIDR_MAX_VERIFY_CALLS', 40),

  /** How many commits of file history to read. */
  logDepth: num('AIDR_LOG_DEPTH', 20),
  /** Window, in days, for the "recent churn" signal. */
  churnWindowDays: num('AIDR_CHURN_WINDOW_DAYS', 90),

  /** Per-request timeout for the Gemini API, in milliseconds. */
  requestTimeoutMs: num('AIDR_REQUEST_TIMEOUT_MS', 90_000),
  /** Retries on transient (429/5xx/network) failures. */
  requestRetries: num('AIDR_REQUEST_RETRIES', 2),
};

export type Config = typeof config;

/** Paths that are never worth a model call. */
export const LOCKFILE_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)mix\.lock$/,
  /(^|\/)Podfile\.lock$/,
  /(^|\/)packages\.lock\.json$/,
];

export const GENERATED_PATTERNS: RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)third_party\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)out\//,
  /(^|\/)coverage\//,
  /(^|\/)\.next\//,
  /(^|\/)\.nuxt\//,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /\.min\.(js|css|mjs|cjs)$/,
  /\.bundle\.js$/,
  /\.map$/,
  /\.pb\.(go|ts|js|py)$/,
  /_pb2\.py$/,
  /\.generated\.[^/]+$/,
  /(^|\/)generated\//,
];
