import type { DeliveryResult, ErrorCode, InspectResult, JobSelection, JobStatus } from "@tvd/shared-types";
import { ACTIVE_STATUSES, canTransition, TERMINAL_STATUSES } from "@tvd/shared-types";
import type { OptionsBundle } from "../services/formats";
import type { JobRow } from "./types";

const RUNNING: JobStatus[] = ["downloading", "processing", "uploading"];

export function newJobId(): string {
  return `job_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** 10 URL-safe chars used inside callback_data (Telegram caps callback_data at 64 bytes). */
export function newShortId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export interface NewJob {
  userId: number;
  chatId: number;
  sourceUrl: string;
  normalizedUrl: string;
  urlHash: string;
  maxAttempts: number;
  now: number;
}

export async function createJob(db: D1Database, input: NewJob): Promise<JobRow> {
  const id = newJobId();
  const shortId = newShortId();
  const correlationId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO jobs (id, short_id, user_id, chat_id, correlation_id, source_url, normalized_url, url_hash, status, max_attempts, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', ?9, ?10, ?10)`,
      )
      .bind(id, shortId, input.userId, input.chatId, correlationId, input.sourceUrl, input.normalizedUrl, input.urlHash, input.maxAttempts, input.now),
    db
      .prepare("INSERT INTO job_events (job_id, from_status, to_status, at, detail) VALUES (?, NULL, 'queued', ?, 'created')")
      .bind(id, input.now),
    db.prepare("UPDATE users SET total_jobs = total_jobs + 1 WHERE tg_user_id = ?").bind(input.userId),
  ]);
  const row = await getJob(db, id);
  if (!row) throw new Error("job insert failed");
  return row;
}

export async function getJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
}

export async function getJobByShortId(db: D1Database, shortId: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE short_id = ?").bind(shortId).first<JobRow>();
}

/** Columns a transition may update. Keys map 1:1 to column names; nothing else can be written. */
export interface JobPatch {
  extractor?: string | null;
  site?: string | null;
  title?: string | null;
  duration_seconds?: number | null;
  thumbnail_url?: string | null;
  metadata_json?: string | null;
  options_json?: string | null;
  selection_json?: string | null;
  delivery_mode?: string | null;
  result_json?: string | null;
  error_code?: ErrorCode | null;
  error_message?: string | null;
  attempts?: number;
  next_retry_at?: number | null;
  progress_json?: string | null;
  last_heartbeat_at?: number | null;
  status_message_id?: number | null;
  menu_message_id?: number | null;
  menu_is_photo?: number;
  cancel_requested?: number;
  started_at?: number | null;
  finished_at?: number | null;
  expires_at?: number | null;
}

const PATCH_COLUMNS = new Set<string>([
  "extractor", "site", "title", "duration_seconds", "thumbnail_url", "metadata_json", "options_json", "selection_json",
  "delivery_mode", "result_json", "error_code", "error_message", "attempts", "next_retry_at", "progress_json",
  "last_heartbeat_at", "status_message_id", "menu_message_id", "menu_is_photo", "cancel_requested", "started_at", "finished_at", "expires_at",
]);

function buildSet(patch: JobPatch): { sql: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCH_COLUMNS.has(key)) throw new Error(`illegal job column: ${key}`);
    if (value === undefined) continue;
    parts.push(`${key} = ?`);
    values.push(value);
  }
  return { sql: parts.join(", "), values };
}

/**
 * Compare-and-set state transition. Succeeds only if the job is still in `from` — so a queue redelivery, a
 * duplicated callback or a racing cancel can never apply the same step twice. Returns true when applied.
 * The audit row in job_events is written in the same D1 batch (one transaction) and only if the update applied.
 */
export async function transition(
  db: D1Database,
  jobId: string,
  from: JobStatus,
  to: JobStatus,
  now: number,
  patch: JobPatch = {},
  detail: string | null = null,
  /** Atomic capacity check: only transition while fewer than `maxRunning` jobs are downloading/processing/uploading. */
  guard?: { maxRunning: number },
): Promise<boolean> {
  if (!canTransition(from, to)) throw new Error(`illegal transition ${from} -> ${to}`);
  const extra = buildSet({ ...patch, ...(TERMINAL_STATUSES.includes(to) && patch.finished_at === undefined ? { finished_at: now } : {}) });
  const set = ["status = ?", "updated_at = ?", ...(extra.sql ? [extra.sql] : [])].join(", ");
  const capacity = guard ? " AND (SELECT COUNT(*) FROM jobs WHERE status IN ('downloading','processing','uploading')) < ?" : "";
  const results = await db.batch([
    db.prepare(`UPDATE jobs SET ${set} WHERE id = ? AND status = ?${capacity}`).bind(to, now, ...extra.values, jobId, from, ...(guard ? [guard.maxRunning] : [])),
    db
      .prepare("INSERT INTO job_events (job_id, from_status, to_status, at, detail) SELECT ?, ?, ?, ?, ? WHERE changes() > 0")
      .bind(jobId, from, to, now, detail),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

/** Update non-status columns (progress, message ids, heartbeats). No state change, no audit row. */
export async function patchJob(db: D1Database, jobId: string, patch: JobPatch, now: number): Promise<void> {
  const { sql, values } = buildSet(patch);
  if (!sql) return;
  await db.prepare(`UPDATE jobs SET ${sql}, updated_at = ? WHERE id = ?`).bind(...values, now, jobId).run();
}

export async function touchJob(db: D1Database, jobId: string, now: number): Promise<void> {
  await db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").bind(now, jobId).run();
}

export async function countsByStatus(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all<{ status: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.status, r.n]));
}

export async function oldestAge(db: D1Database, status: JobStatus, now: number): Promise<number | null> {
  const row = await db.prepare("SELECT MIN(updated_at) AS t FROM jobs WHERE status = ?").bind(status).first<{ t: number | null }>();
  return row?.t ? now - row.t : null;
}

export function jobIsTerminal(job: Pick<JobRow, "status">): boolean {
  return TERMINAL_STATUSES.includes(job.status);
}

export async function countActiveForUser(db: D1Database, userId: number): Promise<number> {
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status IN (${placeholders})`)
    .bind(userId, ...ACTIVE_STATUSES)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countByStatus(db: D1Database, statuses: readonly JobStatus[]): Promise<number> {
  const placeholders = statuses.map(() => "?").join(",");
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN (${placeholders})`).bind(...statuses).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countRunning(db: D1Database): Promise<number> {
  return countByStatus(db, RUNNING);
}

/** Existing job for the same user and URL that should be reused instead of starting another. */
export async function findDuplicate(db: D1Database, userId: number, urlHash: string, since: number): Promise<JobRow | null> {
  const reusable: JobStatus[] = [...ACTIVE_STATUSES, "ready"];
  const placeholders = reusable.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM jobs WHERE user_id = ? AND url_hash = ? AND created_at >= ? AND status IN (${placeholders})
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId, urlHash, since, ...reusable)
    .first<JobRow>();
}

export async function listJobsForUser(db: D1Database, userId: number, limit: number, offset: number): Promise<JobRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE user_id = ? AND status != 'ready' ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(userId, limit, offset)
    .all<JobRow>();
  return results;
}

export async function countJobsForUser(db: D1Database, userId: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status != 'ready'").bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listActiveJobsForUser(db: D1Database, userId: number): Promise<JobRow[]> {
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT * FROM jobs WHERE user_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC`)
    .bind(userId, ...ACTIVE_STATUSES)
    .all<JobRow>();
  return results;
}

export async function listJobsByStatus(db: D1Database, statuses: readonly JobStatus[], limit: number): Promise<JobRow[]> {
  const placeholders = statuses.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`)
    .bind(...statuses, limit)
    .all<JobRow>();
  return results;
}

export async function listRunningJobs(db: D1Database): Promise<JobRow[]> {
  return listJobsByStatus(db, RUNNING, 100);
}

/** Jobs sitting in `status` whose last update is older than `olderThan` (epoch seconds). */
export async function listStale(db: D1Database, status: JobStatus, olderThan: number, limit = 50): Promise<JobRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE status = ? AND updated_at < ? ORDER BY updated_at ASC LIMIT ?")
    .bind(status, olderThan, limit)
    .all<JobRow>();
  return results;
}

export async function listRetryDue(db: D1Database, now: number, limit = 50): Promise<JobRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE status = 'retry_wait' AND next_retry_at IS NOT NULL AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT ?")
    .bind(now, limit)
    .all<JobRow>();
  return results;
}

export async function deleteUserHistory(db: D1Database, userId: number): Promise<number> {
  const terminal = TERMINAL_STATUSES.map(() => "?").join(",");
  const ids = await db
    .prepare(`SELECT id FROM jobs WHERE user_id = ? AND status IN (${terminal})`)
    .bind(userId, ...TERMINAL_STATUSES)
    .all<{ id: string }>();
  if (ids.results.length === 0) return 0;
  const stmts: D1PreparedStatement[] = [];
  for (const { id } of ids.results) {
    stmts.push(db.prepare("DELETE FROM job_events WHERE job_id = ?").bind(id));
    stmts.push(db.prepare("DELETE FROM jobs WHERE id = ?").bind(id));
  }
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  return ids.results.length;
}

export async function purgeOldJobs(db: D1Database, olderThan: number): Promise<number> {
  const terminal = TERMINAL_STATUSES.map(() => "?").join(",");
  const old = await db
    .prepare(`SELECT id FROM jobs WHERE status IN (${terminal}) AND COALESCE(finished_at, updated_at) < ? LIMIT 200`)
    .bind(...TERMINAL_STATUSES, olderThan)
    .all<{ id: string }>();
  const stmts: D1PreparedStatement[] = [];
  for (const { id } of old.results) {
    stmts.push(db.prepare("DELETE FROM job_events WHERE job_id = ?").bind(id));
    stmts.push(db.prepare("DELETE FROM jobs WHERE id = ?").bind(id));
  }
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  return old.results.length;
}

export async function listEvents(db: D1Database, jobId: string, limit = 30): Promise<{ from_status: string | null; to_status: string; at: number; detail: string | null }[]> {
  const { results } = await db
    .prepare("SELECT from_status, to_status, at, detail FROM job_events WHERE job_id = ? ORDER BY id ASC LIMIT ?")
    .bind(jobId, limit)
    .all<{ from_status: string | null; to_status: string; at: number; detail: string | null }>();
  return results;
}

// ───────────── typed JSON accessors ─────────────

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const jobMetadata = (job: JobRow) => parseJson<InspectResult>(job.metadata_json);
export const jobOptions = (job: JobRow): OptionsBundle =>
  parseJson<OptionsBundle>(job.options_json) ?? { quick: [], advanced: [], audioTracks: [] };
export const jobSelection = (job: JobRow) => parseJson<JobSelection>(job.selection_json);
export const jobResult = (job: JobRow) => parseJson<DeliveryResult>(job.result_json);
