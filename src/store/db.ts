/**
 * Run state, posted-comment identity, and the per-file result cache.
 *
 * One SQLite file, queryable after the fact. State is keyed by
 * `platform:project:request` (and content hashes within that) — never by MR
 * number alone in a temp dir, where two projects' !12 collide and CI throws
 * the whole thing away between jobs anyway.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Finding, RunResult } from '../types.ts';

export interface Scope {
  platform: string;
  projectId: string;
  requestId: string;
}

export interface PostedComment {
  fingerprint: string;
  commentId: string;
  threadId: string | null;
  fallback: boolean;
  headSha: string;
  resolved: boolean;
}

export function scopeKey(scope: Scope): string {
  return `${scope.platform}:${scope.projectId}:${scope.requestId}`;
}

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id        TEXT PRIMARY KEY,
        scope         TEXT NOT NULL,
        head_sha      TEXT NOT NULL,
        status        TEXT NOT NULL,
        model         TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        rules_hash    TEXT NOT NULL,
        cost_usd      REAL NOT NULL,
        duration_ms   INTEGER NOT NULL,
        created_at    TEXT NOT NULL,
        payload       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comments (
        scope        TEXT NOT NULL,
        fingerprint  TEXT NOT NULL,
        comment_id   TEXT NOT NULL,
        thread_id    TEXT,
        fallback     INTEGER NOT NULL DEFAULT 0,
        head_sha     TEXT NOT NULL,
        resolved     INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (scope, fingerprint)
      );

      CREATE TABLE IF NOT EXISTS summaries (
        scope      TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_cache (
        key        TEXT PRIMARY KEY,
        findings   TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS runs_scope_idx ON runs (scope, created_at DESC);
    `);
  }

  // ---- per-file result cache (content-addressed, never path-addressed) ----

  cacheGet(key: string): Finding[] | null {
    const row = this.db
      .query<{ findings: string }, [string]>('SELECT findings FROM file_cache WHERE key = ?')
      .get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.findings) as Finding[];
    } catch {
      return null;
    }
  }

  cachePut(key: string, findings: Finding[]): void {
    this.db
      .query('INSERT OR REPLACE INTO file_cache (key, findings, created_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(findings), new Date().toISOString());
  }

  // ---- posted comment identity ----

  getComment(scope: Scope, fingerprint: string): PostedComment | null {
    const row = this.db
      .query<
        {
          fingerprint: string;
          comment_id: string;
          thread_id: string | null;
          fallback: number;
          head_sha: string;
          resolved: number;
        },
        [string, string]
      >('SELECT * FROM comments WHERE scope = ? AND fingerprint = ?')
      .get(scopeKey(scope), fingerprint);
    return row ? toPostedComment(row) : null;
  }

  listComments(scope: Scope): PostedComment[] {
    const rows = this.db
      .query<
        {
          fingerprint: string;
          comment_id: string;
          thread_id: string | null;
          fallback: number;
          head_sha: string;
          resolved: number;
        },
        [string]
      >('SELECT * FROM comments WHERE scope = ?')
      .all(scopeKey(scope));
    return rows.map(toPostedComment);
  }

  putComment(scope: Scope, comment: PostedComment): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO comments
           (scope, fingerprint, comment_id, thread_id, fallback, head_sha, resolved, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scopeKey(scope),
        comment.fingerprint,
        comment.commentId,
        comment.threadId,
        comment.fallback ? 1 : 0,
        comment.headSha,
        comment.resolved ? 1 : 0,
        new Date().toISOString(),
      );
  }

  markResolved(scope: Scope, fingerprint: string): void {
    this.db
      .query('UPDATE comments SET resolved = 1 WHERE scope = ? AND fingerprint = ?')
      .run(scopeKey(scope), fingerprint);
  }

  // ---- the single summary comment ----

  getSummaryId(scope: Scope): string | null {
    const row = this.db
      .query<{ comment_id: string }, [string]>('SELECT comment_id FROM summaries WHERE scope = ?')
      .get(scopeKey(scope));
    return row?.comment_id ?? null;
  }

  setSummaryId(scope: Scope, commentId: string): void {
    this.db
      .query('INSERT OR REPLACE INTO summaries (scope, comment_id, updated_at) VALUES (?, ?, ?)')
      .run(scopeKey(scope), commentId, new Date().toISOString());
  }

  // ---- run records ----

  saveRun(result: RunResult): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO runs
           (run_id, scope, head_sha, status, model, prompt_version, rules_hash,
            cost_usd, duration_ms, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.runId,
        scopeKey(result),
        result.headSha,
        result.status,
        result.model,
        result.promptVersion,
        result.rulesHash,
        result.costUsd,
        result.durationMs,
        new Date().toISOString(),
        JSON.stringify(result),
      );
  }

  getRun(runId: string): RunResult | null {
    const row = this.db
      .query<{ payload: string }, [string]>('SELECT payload FROM runs WHERE run_id = ?')
      .get(runId);
    if (!row) return null;
    return JSON.parse(row.payload) as RunResult;
  }

  listRuns(limit = 20): { runId: string; status: string; headSha: string; createdAt: string }[] {
    return this.db
      .query<
        { run_id: string; status: string; head_sha: string; created_at: string },
        [number]
      >('SELECT run_id, status, head_sha, created_at FROM runs ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        runId: row.run_id,
        status: row.status,
        headSha: row.head_sha,
        createdAt: row.created_at,
      }));
  }

  close(): void {
    this.db.close();
  }
}

function toPostedComment(row: {
  fingerprint: string;
  comment_id: string;
  thread_id: string | null;
  fallback: number;
  head_sha: string;
  resolved: number;
}): PostedComment {
  return {
    fingerprint: row.fingerprint,
    commentId: row.comment_id,
    threadId: row.thread_id,
    fallback: row.fallback === 1,
    headSha: row.head_sha,
    resolved: row.resolved === 1,
  };
}
