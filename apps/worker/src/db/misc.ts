/** Small D1 helpers: webhook idempotency, rate limits, runtime config, stats, R2 object tracking. */

// ───────────── webhook idempotency ─────────────

/** True the first time an update_id is seen. Telegram redelivers on timeouts; we must not act twice. */
export async function claimUpdate(db: D1Database, updateId: number, now: number): Promise<boolean> {
  const res = await db.prepare("INSERT OR IGNORE INTO processed_updates (update_id, received_at) VALUES (?, ?)").bind(updateId, now).run();
  return (res.meta.changes ?? 0) > 0;
}

// ───────────── rate limiting (fixed window) ─────────────

export interface RateResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

export async function rateLimit(db: D1Database, key: string, limit: number, windowSeconds: number, now: number): Promise<RateResult> {
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return { allowed: count <= limit, count, limit, retryAfterSeconds: Math.max(windowStart + windowSeconds - now, 1) };
}

// ───────────── runtime config (admin adjustable) ─────────────

export async function getAppConfig(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare("SELECT key, value FROM app_config").all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function setAppConfig(db: D1Database, key: string, value: string, by: number | null, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_config (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4`,
    )
    .bind(key, value, now, by)
    .run();
}

export async function deleteAppConfig(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM app_config WHERE key = ?").bind(key).run();
}

// ───────────── stats ─────────────

export function dayKey(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

export async function bumpStat(db: D1Database, metric: string, now: number, by = 1): Promise<void> {
  await db
    .prepare(
      `INSERT INTO daily_stats (day, metric, value) VALUES (?1, ?2, ?3)
       ON CONFLICT(day, metric) DO UPDATE SET value = value + ?3`,
    )
    .bind(dayKey(now), metric, by)
    .run();
}

export async function readStats(db: D1Database, days: number, now: number): Promise<Record<string, number>> {
  const since = dayKey(now - days * 86400);
  const { results } = await db
    .prepare("SELECT metric, SUM(value) AS total FROM daily_stats WHERE day >= ? GROUP BY metric")
    .bind(since)
    .all<{ metric: string; total: number }>();
  return Object.fromEntries(results.map((r) => [r.metric, r.total]));
}

// ───────────── R2 object bookkeeping ─────────────

export interface R2ObjectRow {
  object_key: string;
  job_id: string;
  purpose: "delivery" | "thumbnail" | "staging";
  size_bytes: number | null;
  sha256: string | null;
  upload_id: string | null;
  created_at: number;
  expires_at: number;
  deleted_at: number | null;
}

export async function trackR2Object(
  db: D1Database,
  row: { key: string; jobId: string; purpose: R2ObjectRow["purpose"]; uploadId?: string | null; expiresAt: number; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO r2_objects (object_key, job_id, purpose, upload_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(object_key) DO UPDATE SET upload_id = excluded.upload_id, expires_at = excluded.expires_at`,
    )
    .bind(row.key, row.jobId, row.purpose, row.uploadId ?? null, row.now, row.expiresAt)
    .run();
}

export async function completeR2Object(db: D1Database, key: string, size: number, sha256: string | null): Promise<void> {
  await db.prepare("UPDATE r2_objects SET size_bytes = ?, sha256 = ?, upload_id = NULL WHERE object_key = ?").bind(size, sha256, key).run();
}

export async function getR2ObjectByJob(db: D1Database, jobId: string, purpose: R2ObjectRow["purpose"]): Promise<R2ObjectRow | null> {
  return db
    .prepare("SELECT * FROM r2_objects WHERE job_id = ? AND purpose = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .bind(jobId, purpose)
    .first<R2ObjectRow>();
}

export async function getR2Object(db: D1Database, key: string): Promise<R2ObjectRow | null> {
  return db.prepare("SELECT * FROM r2_objects WHERE object_key = ?").bind(key).first<R2ObjectRow>();
}

export async function listExpiredR2Objects(db: D1Database, now: number, limit = 50): Promise<R2ObjectRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM r2_objects WHERE deleted_at IS NULL AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?")
    .bind(now, limit)
    .all<R2ObjectRow>();
  return results;
}

/** Multipart uploads that never completed (job died mid-upload). */
export async function listAbandonedUploads(db: D1Database, olderThan: number, limit = 20): Promise<R2ObjectRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM r2_objects WHERE deleted_at IS NULL AND upload_id IS NOT NULL AND created_at < ? LIMIT ?")
    .bind(olderThan, limit)
    .all<R2ObjectRow>();
  return results;
}

export async function markR2Deleted(db: D1Database, key: string, now: number): Promise<void> {
  await db.prepare("UPDATE r2_objects SET deleted_at = ?, upload_id = NULL WHERE object_key = ?").bind(now, key).run();
}

// ───────────── housekeeping ─────────────

export async function purgeBookkeeping(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM processed_updates WHERE received_at < ?").bind(now - 3 * 86400),
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 2 * 86400),
    db.prepare("DELETE FROM daily_stats WHERE day < ?").bind(dayKey(now - 120 * 86400)),
    db.prepare("DELETE FROM r2_objects WHERE deleted_at IS NOT NULL AND deleted_at < ?").bind(now - 7 * 86400),
  ]);
}
