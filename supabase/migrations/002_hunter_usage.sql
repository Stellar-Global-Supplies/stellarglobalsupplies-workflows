-- Hunter.io credit usage audit log
CREATE TABLE IF NOT EXISTS hunter_usage_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain          TEXT,
  email_found     TEXT,
  credits_before  INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE hunter_usage_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_users_all" ON hunter_usage_log FOR ALL USING (auth.role() = 'authenticated');

-- Monthly view for monitoring
CREATE OR REPLACE VIEW hunter_monthly_usage AS
SELECT
  DATE_TRUNC('month', created_at) AS month,
  COUNT(*)                         AS searches_used,
  50 - COUNT(*)                    AS credits_remaining_approx,
  COUNT(*) FILTER (WHERE email_found != '' AND email_found IS NOT NULL) AS emails_found
FROM hunter_usage_log
GROUP BY 1
ORDER BY 1 DESC;
