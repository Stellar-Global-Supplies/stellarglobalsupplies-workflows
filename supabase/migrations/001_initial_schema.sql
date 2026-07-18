-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- LEADS
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name    TEXT NOT NULL,
  website         TEXT,
  email           TEXT UNIQUE NOT NULL,
  phone           TEXT,
  industry        TEXT,
  address         TEXT,
  contact_name    TEXT,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','emailed','followed_up','converted','rejected')),
  source          TEXT NOT NULL DEFAULT 'ai_generated',
  workflow_run_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_leads_email  ON leads(email);
CREATE INDEX idx_leads_status ON leads(status);

-- ============================================================
-- EMAIL DRAFTS
-- ============================================================
CREATE TABLE IF NOT EXISTS email_drafts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  is_followup BOOLEAN NOT NULL DEFAULT FALSE,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','approved','sent','rejected')),
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_email_drafts_lead_id ON email_drafts(lead_id);
CREATE INDEX idx_email_drafts_status  ON email_drafts(status);

-- ============================================================
-- SOCIAL POSTS
-- ============================================================
CREATE TABLE IF NOT EXISTS social_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL CHECK (type IN ('product','tech')),
  title           TEXT,
  content         TEXT NOT NULL,
  content_hash    TEXT GENERATED ALWAYS AS (md5(content)) STORED,
  image_url       TEXT,
  image_s3_key    TEXT,
  platforms       JSONB NOT NULL DEFAULT '{"facebook":false,"instagram":false,"linkedin":false}',
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','approved','posting','posted','rejected','partial')),
  order_id        TEXT,
  repo_name       TEXT,
  prompt          TEXT,
  post_results    JSONB DEFAULT '{}',
  posted_at       TIMESTAMPTZ,
  workflow_run_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_social_posts_order_unique
  ON social_posts(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_social_posts_type   ON social_posts(type);
CREATE INDEX idx_social_posts_status ON social_posts(status);

-- ============================================================
-- BLOG POSTS
-- ============================================================
CREATE TABLE IF NOT EXISTS blog_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  excerpt         TEXT,
  content         TEXT NOT NULL,
  image_url       TEXT,
  image_s3_key    TEXT,
  tags            JSONB DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','approved','pr_created','published','rejected')),
  pr_url          TEXT,
  pr_number       INTEGER,
  author          TEXT DEFAULT 'Stellar Global Supplies',
  workflow_run_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_blog_posts_status ON blog_posts(status);
CREATE INDEX idx_blog_posts_slug   ON blog_posts(slug);

-- ============================================================
-- APPROVAL QUEUE
-- ============================================================
CREATE TABLE IF NOT EXISTS approval_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type   TEXT NOT NULL
                  CHECK (workflow_type IN ('lead_email','lead_followup','social_product','social_tech','blog')),
  reference_id    UUID NOT NULL,
  task_token      TEXT NOT NULL,
  payload         JSONB DEFAULT '{}',
  preview_html    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired')),
  reviewed_by     TEXT,
  review_note     TEXT,
  reviewed_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_approval_queue_status        ON approval_queue(status);
CREATE INDEX idx_approval_queue_workflow_type ON approval_queue(workflow_type);
CREATE INDEX idx_approval_queue_reference_id  ON approval_queue(reference_id);

-- ============================================================
-- WORKFLOW RUNS
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type TEXT NOT NULL
                CHECK (workflow_type IN ('lead_generation','social_product','social_tech','blog')),
  execution_arn TEXT,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','succeeded','failed','stopped','timed_out')),
  input         JSONB DEFAULT '{}',
  output        JSONB DEFAULT '{}',
  error_msg     TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX idx_workflow_runs_type   ON workflow_runs(workflow_type);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);

-- ============================================================
-- ROW LEVEL SECURITY (for Supabase auth)
-- ============================================================
ALTER TABLE leads          ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_drafts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_posts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_posts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs  ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users full access (single-tenant admin app)
CREATE POLICY "auth_users_all" ON leads          FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_users_all" ON email_drafts   FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_users_all" ON social_posts   FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_users_all" ON blog_posts     FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_users_all" ON approval_queue FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "auth_users_all" ON workflow_runs  FOR ALL USING (auth.role() = 'authenticated');

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tr_leads_updated         BEFORE UPDATE ON leads         FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_social_posts_updated  BEFORE UPDATE ON social_posts  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_blog_posts_updated    BEFORE UPDATE ON blog_posts    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
