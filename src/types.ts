/**
 * Core data model.
 *
 * Every stage of the pipeline is a function from one of these shapes to another.
 * Nothing here knows about Claude, GitLab or GitHub — those live behind the
 * platform adapters and the review stage.
 */

export type PlatformName = 'gitlab' | 'github' | 'local';

export type SkipReason =
  | 'binary'
  | 'vendored'
  | 'generated'
  | 'lockfile'
  | 'too-large'
  | 'deleted'
  | 'ignored'
  | 'no-content';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffLine {
  kind: 'add' | 'del' | 'context';
  /** Line number on the base side. null for added lines. */
  oldLine: number | null;
  /** Line number on the head side. null for removed lines. */
  newLine: number | null;
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ChangedFile {
  /** Path on the head side. */
  path: string;
  /** Set only on renames. */
  oldPath?: string;
  status: FileStatus;
  hunks: Hunk[];
  /** File content at headSha. null for deleted, binary or oversized files. */
  headContent: string | null;
  baseContent?: string | null;
  /** sha256 of headContent (empty string hashed when null) — the cache key. */
  contentHash: string;
  language: string | null;
  additions: number;
  deletions: number;
  skipped?: SkipReason;
}

export interface ChangeSet {
  platform: PlatformName;
  projectId: string;
  /** MR iid on GitLab, PR number on GitHub, branch name locally. */
  requestId: string;
  webUrl?: string;
  title: string;
  description: string;
  /** Everything downstream is pinned to these three. Never read by branch name. */
  baseSha: string;
  startSha: string;
  headSha: string;
  /** Target branch — rules are read from here, never from the source branch. */
  targetBranch: string;
  files: ChangedFile[];
  /** Law 3: a skip is a recorded event, never a silent one. */
  skipped: { path: string; reason: SkipReason }[];
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type Category =
  | 'bug'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'test'
  | 'style';

export interface Finding {
  /** Fingerprint — stable across runs. See publish/fingerprint.ts. */
  id: string;
  path: string;
  /** Head-side line number. Must fall inside a hunk of `path`. */
  line: number;
  endLine?: number;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  /** Verbatim snippet from headContent. Checked mechanically in verify.ts. */
  evidence: string;
  suggestion?: string;
  /** Which rules produced this finding — the unit of per-rule measurement. */
  ruleIds: string[];
  /** Model-reported, 0..1. */
  confidence: number;
  verdict?: 'kept' | 'dropped';
  dropReason?: string;
  /** Set when verify.ts corrected a line number that was off but recoverable. */
  lineCorrectedFrom?: number;
}

export type RunStatus = 'completed' | 'partial' | 'interrupted' | 'failed';

export interface StageError {
  stage: string;
  message: string;
}

export interface RunResult {
  runId: string;
  /** The only thing the CLI exit code reads. */
  status: RunStatus;
  platform: PlatformName;
  projectId: string;
  requestId: string;
  headSha: string;
  model: string;
  promptVersion: string;
  rulesHash: string;
  filesReviewed: string[];
  filesSkipped: { path: string; reason: string }[];
  findingsPosted: Finding[];
  findingsDropped: Finding[];
  /** Named degradations — context engine off, rules dropped, model fallback. */
  degradations: string[];
  costUsd: number;
  durationMs: number;
  errors: StageError[];
}

export interface Rule {
  id: string;
  /** Empty means "global" only when the frontmatter omitted `globs` entirely. */
  globs: string[];
  /** True when the rule declared no globs and therefore applies everywhere. */
  global: boolean;
  severity: Severity;
  priority: number;
  body: string;
  sourcePath: string;
  bytes: number;
}

export interface RuleLoadResult {
  rules: Rule[];
  /** Rules rejected outright — a malformed rule is never promoted to global. */
  errors: { sourcePath: string; message: string }[];
  /** Rules dropped by the byte budget, in the order they were dropped. */
  dropped: { id: string; sourcePath: string; reason: string }[];
  /** sha256 over the surviving rule bodies — part of the cache key. */
  rulesHash: string;
}

export interface RippleSnippet {
  path: string;
  symbol: string;
  startLine: number;
  text: string;
}

export interface FileContext {
  file: ChangedFile;
  numberedDiff: string;
  /** Null when the head file was dropped by the token budget. */
  numberedHeadContent: string | null;
  /** Present when the full body was dropped but an outline survived. */
  symbolOutline: string | null;
  ripple: RippleSnippet[];
  rules: Rule[];
}

export interface Batch {
  index: number;
  files: FileContext[];
  estimatedInputTokens: number;
}

export interface PostedRef {
  /** Provider-side identity we can edit or resolve later. */
  commentId: string;
  threadId?: string;
  /** True when we fell back to a general note because the position was rejected. */
  fallback: boolean;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}
