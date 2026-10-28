-- 0001_init.sql — core schema. All timestamps are Unix epoch SECONDS (INTEGER).

CREATE TABLE users (
  tg_user_id        INTEGER PRIMARY KEY,
  username          TEXT,
  first_name        TEXT,
  language          TEXT    NOT NULL DEFAULT 'fa',
  is_blocked        INTEGER NOT NULL DEFAULT 0,
  block_reason      TEXT,
  settings_json     TEXT    NOT NULL DEFAULT '{}',
  -- conversation state machine (waiting for a title / caption / thumbnail upload ...)
  state             TEXT,
  state_json        TEXT,
  state_updated_at  INTEGER,
  total_jobs        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL
);

CREATE TABLE jobs (
  id                 TEXT PRIMARY KEY,
  short_id           TEXT    NOT NULL UNIQUE,   -- used inside Telegram callback_data (64 byte limit)
  user_id            INTEGER NOT NULL REFERENCES users(tg_user_id),
  chat_id            INTEGER NOT NULL,
  correlation_id     TEXT    NOT NULL,
  source_url         TEXT    NOT NULL,
  normalized_url     TEXT    NOT NULL,
  url_hash           TEXT    NOT NULL,
  status             TEXT    NOT NULL,
  extractor          TEXT,
  site               TEXT,
  title              TEXT,
  duration_seconds   INTEGER,
  thumbnail_url      TEXT,
  metadata_json      TEXT,                      -- InspectResult
  options_json       TEXT,                      -- QualityOption[] shown to the user
  selection_json     TEXT,                      -- JobSelection
  delivery_mode      TEXT,
  result_json        TEXT,                      -- DeliveryResult
  error_code         TEXT,
  error_message      TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 3,
  next_retry_at      INTEGER,
  progress_json      TEXT,
  last_heartbeat_at  INTEGER,
  status_message_id  INTEGER,                   -- the progress message we keep editing
  menu_message_id    INTEGER,                   -- the quality / options menu message
  menu_is_photo      INTEGER NOT NULL DEFAULT 0, -- 1 when the menu is a photo (edit its caption, not its text)
  cancel_requested   INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  started_at         INTEGER,
  finished_at        INTEGER,
  expires_at         INTEGER
);
CREATE INDEX idx_jobs_user_created  ON jobs(user_id, created_at DESC);
CREATE INDEX idx_jobs_status        ON jobs(status, updated_at);
CREATE INDEX idx_jobs_user_status   ON jobs(user_id, status);
CREATE INDEX idx_jobs_dedupe        ON jobs(user_id, url_hash, created_at DESC);
CREATE INDEX idx_jobs_retry         ON jobs(status, next_retry_at);

CREATE TABLE job_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT    NOT NULL,
  from_status  TEXT,
  to_status    TEXT    NOT NULL,
  at           INTEGER NOT NULL,
  detail       TEXT
);
CREATE INDEX idx_job_events_job ON job_events(job_id, id);

-- Telegram redelivers webhook updates on timeouts; this makes handling idempotent.
CREATE TABLE processed_updates (
  update_id    INTEGER PRIMARY KEY,
  received_at  INTEGER NOT NULL
);
CREATE INDEX idx_processed_updates_time ON processed_updates(received_at);

-- Fixed-window rate limiting counters.
CREATE TABLE rate_limits (
  key           TEXT    NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- Runtime-adjustable limits (admin commands) and flags.
CREATE TABLE app_config (
  key         TEXT PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  INTEGER
);

CREATE TABLE daily_stats (
  day     TEXT    NOT NULL,           -- YYYY-MM-DD (UTC)
  metric  TEXT    NOT NULL,
  value   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

-- Objects we put in R2 (custom thumbnails, link-delivery files, multipart staging).
CREATE TABLE r2_objects (
  object_key   TEXT PRIMARY KEY,
  job_id       TEXT    NOT NULL,
  purpose      TEXT    NOT NULL,      -- 'delivery' | 'thumbnail' | 'staging'
  size_bytes   INTEGER,
  sha256       TEXT,
  upload_id    TEXT,                  -- open multipart upload, cleared when completed
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX idx_r2_objects_expiry ON r2_objects(deleted_at, expires_at);
CREATE INDEX idx_r2_objects_job    ON r2_objects(job_id);
