-- Seed Data: Initial schedules for tech job workflows
-- Execute via: wrangler d1 execute stellar-workflows --file=d1/seed-tech-job-schedules.sql
--
-- This creates the initial schedule entries for the 4 tech job workflows
-- that were previously triggered via individual worker crons.

-- Insert CUR Forwarder schedule (every 8 hours: 0 */8 * * *)
-- Note: frequency is 'daily' as per D1 schema constraint (only daily/weekly/monthly allowed)
-- The actual timing is controlled by cron_utc field
INSERT OR IGNORE INTO workflow_schedules (
  id,
  workflow_type,
  label,
  frequency,
  run_time,
  cron_utc,
  enabled,
  parameters,
  created_at,
  updated_at
) VALUES (
  'cur-forwarder-schedule-001',
  'cur-forwarder',
  'CUR Forwarder - Every 8 Hours',
  'daily',
  '00:00',
  '0 */8 * * *',
  1,
  '{}',
  datetime('now'),
  datetime('now')
);

-- Insert Postgres Forwarder schedule (every hour: 0 * * * *)
-- Note: frequency is 'daily' as per D1 schema constraint (only daily/weekly/monthly allowed)
-- The actual timing is controlled by cron_utc field
INSERT OR IGNORE INTO workflow_schedules (
  id,
  workflow_type,
  label,
  frequency,
  run_time,
  cron_utc,
  enabled,
  parameters,
  created_at,
  updated_at
) VALUES (
  'postgres-forwarder-schedule-001',
  'postgres-forwarder',
  'Postgres Forwarder - Hourly',
  'daily',
  '00:00',
  '0 * * * *',
  1,
  '{}',
  datetime('now'),
  datetime('now')
);

-- Insert AI Sync schedule (every hour: 0 * * * *)
-- Note: frequency is 'daily' as per D1 schema constraint (only daily/weekly/monthly allowed)
-- The actual timing is controlled by cron_utc field
INSERT OR IGNORE INTO workflow_schedules (
  id,
  workflow_type,
  label,
  frequency,
  run_time,
  cron_utc,
  enabled,
  parameters,
  created_at,
  updated_at
) VALUES (
  'ai-sync-schedule-001',
  'ai-sync',
  'AI Data Sync - Hourly',
  'daily',
  '00:00',
  '0 * * * *',
  1,
  '{}',
  datetime('now'),
  datetime('now')
);

-- Insert S3 Cleanup schedule (daily at 2 AM UTC: 0 2 * * *)
INSERT OR IGNORE INTO workflow_schedules (
  id,
  workflow_type,
  label,
  frequency,
  run_time,
  cron_utc,
  enabled,
  parameters,
  created_at,
  updated_at
) VALUES (
  's3-cleanup-schedule-001',
  's3-cleanup',
  'S3 Cleanup - Daily at 2 AM',
  'daily',
  '07:30',  -- 2 AM UTC = 7:30 AM IST
  '0 2 * * *',
  1,
  '{}',
  datetime('now'),
  datetime('now')
);

-- Verification query
-- SELECT workflow_type, label, cron_utc, enabled, frequency
-- FROM workflow_schedules
-- WHERE workflow_type IN ('cur-forwarder', 'postgres-forwarder', 'ai-sync', 's3-cleanup')
-- ORDER BY workflow_type;