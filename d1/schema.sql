-- D1 Schema — Stellar Workflows Engine
-- Run via: wrangler d1 execute stellar-workflows --file=d1-schema.sql
--
-- Tables moving from Supabase to D1:
--   job_queue          (new — never existed in Supabase)
--   workflow_runs      (moving from Supabase)
--   workflow_schedules (moving from Supabase)
--   approval_queue     (moving from Supabase)


-- ── job_queue ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_queue (
  id               TEXT PRIMARY KEY,
  workflow_run_id  TEXT,
  workflow_type    TEXT NOT NULL,
  step_name        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','done','failed','waiting_for_approval')),
  payload          TEXT NOT NULL DEFAULT '{}',   -- JSON string
  retry_count      INTEGER NOT NULL DEFAULT 0,
  error_msg        TEXT,
  created_at       TEXT NOT NULL,
  picked_up_at     TEXT,
  completed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_queue_pending
  ON job_queue (status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_job_queue_run
  ON job_queue (workflow_run_id);


-- ── workflow_runs ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_runs (
  id            TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','succeeded','failed','stopped','timed_out','awaiting_approval','paused')),
  input         TEXT DEFAULT '{}',       -- JSON string
  output        TEXT,                    -- JSON string
  error_msg     TEXT,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  cost_usd      REAL DEFAULT 0,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  image_count   INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON workflow_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_type
  ON workflow_runs (workflow_type, started_at DESC);


-- ── workflow_schedules ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_schedules (
  id            TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  label         TEXT NOT NULL,
  frequency     TEXT NOT NULL DEFAULT 'monthly'
                CHECK (frequency IN ('daily','weekly','monthly')),
  day_of_month  INTEGER DEFAULT 1,
  days_of_week  TEXT DEFAULT '[]',     -- JSON string array
  run_time      TEXT DEFAULT '09:00',  -- HH:MM IST
  enabled       INTEGER NOT NULL DEFAULT 1,  -- 0 or 1 (D1 has no BOOLEAN)
  parameters    TEXT DEFAULT '{}',     -- JSON string
  cron_utc      TEXT,                  -- CF cron format in UTC
  last_run_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_enabled
  ON workflow_schedules (enabled, workflow_type);


-- ── approval_queue ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_queue (
  id               TEXT PRIMARY KEY,
  workflow_type    TEXT NOT NULL,
  workflow_run_id  TEXT,
  reference_id     TEXT,
  task_token       TEXT,
  payload          TEXT DEFAULT '{}',      -- JSON string
  preview_html     TEXT DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','expired')),
  review_note      TEXT,
  email_token      TEXT,
  token_expires_at TEXT,
  token_used_at    TEXT,
  reviewed_at      TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_queue_status
  ON approval_queue (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_queue_run
  ON approval_queue (workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_approval_queue_token
  ON approval_queue (email_token)
  WHERE email_token IS NOT NULL;