/**
 * Shared type contracts for the review pipeline.
 *
 * Everything that crosses a module boundary is declared here so the stages
 * (target -> diff -> chunk -> history -> review -> verify -> render) stay
 * independently testable and the renderer can be swapped without touching
 * the reviewer.
 */

/** How serious a finding is. Only `bug` affects the process exit code. */
export type Severity = 'bug' | 'risk' | 'nit';

/**
 * Result of the adversarial verification pass.
 *
 * - `survived`   - the model failed to argue the finding away
 * - `discarded`  - the counter-argument held; the finding is suppressed
 * - `unverified` - the verification ceiling was hit; passed through flagged
 */
export type Verdict = 'survived' | 'discarded' | 'unverified';

/** A single review comment produced by the model. */
export interface Finding {
  /** Repo-relative path, taken from the diff header. */
  file: string;
  /** Line in the post-image, or null when the finding is file-level. */
  line: number | null;
  severity: Severity;
  /** One-line summary. */
  title: string;
  /** The explanation shown to the user. */
  body: string;
  /** The exact diff/source text the finding is anchored to. */
  evidence: string;
  /**
   * Set when git history contributed to the finding — the differentiator.
   * Absent when the model reached the conclusion from the diff alone.
   */
  historyBasis?: string;
  verdict: Verdict;
  /** Why the verdict came out the way it did. Always populated post-verify. */
  verdictReason: string;
}

/** A finding as the model returns it, before verification assigns a verdict. */
export type RawFinding = Omit<Finding, 'verdict' | 'verdictReason'>;

/** What to review. Each variant maps to exactly one git command. */
export type ReviewTarget =
  | { kind: 'staged' }
  | { kind: 'working' }
  | { kind: 'branch'; base: string }
  | { kind: 'commit'; ref: string };

export type TargetKind = ReviewTarget['kind'];

/** Why a file never made it into the review. Reported, never silently dropped. */
export type ExclusionReason = 'binary' | 'lockfile' | 'generated' | 'oversized';

export interface ExcludedFile {
  path: string;
  reason: ExclusionReason;
  /** Byte size of the file's diff, present for the oversized case. */
  bytes?: number;
}

/** A line range on one side of a hunk header. */
export interface LineRange {
  start: number;
  /** Inclusive. Equals `start` for single-line ranges. */
  end: number;
}

/** One file's slice of the unified diff, after exclusion filtering. */
export interface DiffFile {
  path: string;
  /** The `diff --git ...` block verbatim, headers included. */
  patch: string;
  /** Line ranges touched in the pre-image — what `git blame` is run against. */
  oldRanges: LineRange[];
  /** Line ranges touched in the post-image — what findings are anchored to. */
  newRanges: LineRange[];
  /** True when the pre-image does not exist, so there is nothing to blame. */
  isNew: boolean;
}

/** The unit sent to the model: one file, or one slice of an oversized file. */
export interface Chunk {
  path: string;
  patch: string;
  oldRanges: LineRange[];
  newRanges: LineRange[];
  isNew: boolean;
  /** 1-based index of this chunk within its file. */
  part: number;
  /** How many chunks the file was split into. 1 for the common case. */
  partsTotal: number;
}

/** One commit as read out of `git log`. */
export interface CommitInfo {
  hash: string;
  shortHash: string;
  /** ISO-8601 author date. */
  date: string;
  author: string;
  subject: string;
}

/** A blame result for one of the touched line ranges. */
export interface BlameEntry {
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  line: number;
}

/**
 * The repository's own memory of the lines being changed.
 *
 * This is what existing reviewers do not feed the model: churn, prior fixes,
 * reverts and recency for the exact lines under review.
 */
export interface HistoryContext {
  path: string;
  /** False for new files and for any path git has no record of. */
  available: boolean;
  /** Human-readable reason when `available` is false. */
  unavailableReason?: string;
  commits: CommitInfo[];
  blame: BlameEntry[];
  /** Total commits touching this file within the log window. */
  totalCommits: number;
  /** Commits touching this file in the last 90 days. */
  recentCommits: number;
  /** Subjects of commits that look like fixes, reverts or regressions. */
  priorFixes: string[];
  /** Subjects of commits that are explicit reverts. */
  reverts: string[];
  /** Days since the most recent commit that touched the blamed lines. */
  daysSinceLastTouch: number | null;
  /** Distinct commits found by blame across the touched ranges. */
  distinctBlameCommits: number;
}

/** A chunk paired with the history that will be sent alongside it. */
export interface EnrichedChunk {
  chunk: Chunk;
  history: HistoryContext;
}

/** A non-fatal problem worth surfacing at the end of the run. */
export interface Warning {
  stage: 'diff' | 'history' | 'review' | 'verify';
  path?: string;
  message: string;
}

/** Everything the renderer needs. */
export interface ReviewResult {
  target: ReviewTarget;
  findings: Finding[];
  excluded: ExcludedFile[];
  warnings: Warning[];
  filesReviewed: number;
  chunksReviewed: number;
  verifyCallsUsed: number;
}
