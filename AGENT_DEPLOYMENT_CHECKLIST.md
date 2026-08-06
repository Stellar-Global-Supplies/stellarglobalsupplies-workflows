# 🤖 Agent Deployment Checklist — Stellar Workflows Platform

> **Purpose:** This document is a step-by-step checklist for an AI agent (or developer) to successfully deploy the Stellar Workflows Platform to production. Follow every section in order. Do not skip steps.

---

## 📋 Table of Contents

1. [Pre-Deployment Prerequisites](#1-pre-deployment-prerequisites)
2. [Folder Structure to Create/Verify](#2-folder-structure-to-createverify)
3. [Database Setup (D1 + Supabase)](#3-database-setup-d1--supabase)
4. [Secrets & Environment Variables](#4-secrets--environment-variables)
5. [Frontend File Changes](#5-frontend-file-changes)
6. [Worker File Changes](#6-worker-file-changes)
7. [Schedules & Cron Configuration](#7-schedules--cron-configuration)
8. [Deployment Order (CRITICAL)](#8-deployment-order-critical)
9. [Post-Deployment Verification](#9-post-deployment-verification)
10. [Monitoring & Troubleshooting](#10-monitoring--troubleshooting)
11. [Rollback Procedures](#11-rollback-procedures)
12. [Final Go-Live Checklist](#12-final-go-live-checklist)

---

## 1. Pre-Deployment Prerequisites

### 1.1 Accounts & Access Required

- [ ] **Cloudflare account** with:
  - Workers access
  - Pages access
  - D1 database access
  - KV namespace access
  - Secrets Store access
- [ ] **Supabase project** (existing or new)
- [ ] **GitHub repository** (for blog PR creation)
- [ ] **AWS account** with Bedrock access (Nova Pro model)
- [ ] **Groq API key**
- [ ] **Tavily API key**
- [ ] **Gmail/Google OAuth credentials** (Client ID, Client Secret, Refresh Token)
- [ ] **Facebook App** (Page ID + Access Token)
- [ ] **Instagram Graph API** (Account ID + Access Token)
- [ ] **New Relic account** (License Key) — for forwarders
- [ ] **Brevo account** (API Key) — for brevo-sync
- [ ] **NeonDB database** (Admin URL) — for ai-sync, postgres-forwarder, brevo-sync

### 1.2 Local Tools

- [ ] Node.js 18+ installed
- [ ] Wrangler CLI installed: `npm install -g wrangler`
- [ ] Git CLI installed
- [ ] AWS CLI installed (for forwarders that read S3)
- [ ] `jq` installed (for JSON parsing in scripts)

### 1.3 Verify Cloudflare Login

```bash
wrangler whoami
```

Expected: Shows your Cloudflare account email and account ID.

---

## 2. Folder Structure to Create/Verify

### 2.1 Required Top-Level Folders

```
stellarglobalsupplies-workflows/
├── d1/                          # D1 schema + seed files
├── frontend/                    # React SPA (Cloudflare Pages)
├── supabase/                    # Supabase migrations
│   └── migrations/
├── workers/                     # Main API Router worker
│   ├── src/
│   │   ├── api-router.js
│   │   ├── job-runner.js
│   │   ├── schedule-runner.js
│   │   ├── steps/
│   │   └── lib/
│   └── wrangler.toml
├── workers-job-runner/          # Job execution worker (cron every minute)
├── workers-schedule-runner/     # Schedule execution worker (cron every minute)
├── workers-cur-forwarder/       # AWS CUR → New Relic forwarder
├── workers-postgres-forwader/   # Postgres metrics → New Relic forwarder
├── workers-ai-sync/             # Supabase → Neon data sync
├── workers-s3-cleanup/          # S3 retention policy cleanup
├── workers-brevo-sync/          # Supabase → Brevo contact sync
├── docs/                        # Documentation & scripts
└── AGENT_DEPLOYMENT_CHECKLIST.md  # This file
```

### 2.2 Verify Each Folder Has Required Files

| Folder | Required Files | Status |
|--------|---------------|--------|
| `d1/` | `schema.sql`, `seed-tech-job-schedules.sql` | ☐ |
| `frontend/` | `package.json`, `vite.config.js`, `index.html`, `src/`, `public/_redirects`, `.env.example` | ☐ |
| `workers/` | `wrangler.toml`, `package.json`, `src/api-router.js`, `src/job-runner.js`, `src/schedule-runner.js`, `src/steps/*.js`, `src/lib/*.js` | ☐ |
| `workers-job-runner/` | `wrangler.toml`, `package.json` | ☐ |
| `workers-schedule-runner/` | `wrangler.toml`, `package.json` | ☐ |
| `workers-cur-forwarder/` | `wrangler.toml`, `package.json`, `index.js` | ☐ |
| `workers-postgres-forwader/` | `wrangler.toml`, `package.json`, `index.js` | ☐ |
| `workers-ai-sync/` | `wrangler.toml`, `package.json`, `index.js` | ☐ |
| `workers-s3-cleanup/` | `wrangler.toml`, `package.json`, `index.js` | ☐ |
| `workers-brevo-sync/` | `wrangler.toml`, `package.json`, `index.js` | ☐ |
| `supabase/migrations/` | `001_initial_schema.sql` through `006_leads_needs_review.sql` | ☐ |

### 2.3 Create Missing Folders (if any)

```bash
mkdir -p d1 frontend supabase/migrations workers/src/steps workers/src/lib \
  workers-job-runner workers-schedule-runner workers-cur-forwarder \
  workers-postgres-forwader workers-ai-sync workers-s3-cleanup workers-brevo-sync docs
```

---

## 3. Database Setup (D1 + Supabase)

### 3.1 Cloudflare D1 Database

**Step 1: Create D1 database**

```bash
cd workers
wrangler d1 create stellar-workflows
```

**Step 2: Copy the `database_id` from output** and update in ALL of these files:

| File | Field to Update |
|------|----------------|
| `workers/wrangler.toml` | `database_id` |
| `workers-job-runner/wrangler.toml` | `database_id` |
| `workers-schedule-runner/wrangler.toml` | `database_id` |

**Step 3: Apply schema**

```bash
cd workers
wrangler d1 execute stellar-workflows --file=../d1/schema.sql
```

**Step 4: Seed initial tech job schedules**

```bash
wrangler d1 execute stellar-workflows --file=../d1/seed-tech-job-schedules.sql
```

**Step 5: Verify tables created**

```bash
wrangler d1 execute stellar-workflows --command="SELECT name FROM sqlite_master WHERE type='table'"
```

Expected tables:
- `job_queue`
- `workflow_runs`
- `workflow_schedules`
- `approval_queue`

### 3.2 Supabase Database

**Step 1: Apply migrations in order** (via Supabase SQL Editor or CLI):

```bash
# Order matters — apply sequentially:
# 001_initial_schema.sql
# 002_hunter_usage.sql
# 003_approval_queue_workflow_run_id.sql
# 004_generated_content_assets.sql
# 005_supabase_migration.sql
# 006_leads_needs_review.sql
```

**Step 2: Verify tables exist in Supabase dashboard:**

- `leads`
- `email_drafts`
- `social_posts`
- `blog_posts`
- `approval_queue`
- `workflow_runs`
- `hunter_usage_log`
- `orders` (should already exist)

**Step 3: Verify RLS policies are enabled** — all tables should have `auth_users_all` policy.

### 3.3 KV Namespaces (for forwarders)

**Step 1: Create KV namespaces if not already created:**

```bash
# For cur-forwarder
wrangler kv:namespace create CUR_STATE_KV

# For postgres-forwarder
wrangler kv:namespace create PG_STATE_KV
```

**Step 2: Update the KV namespace IDs** in:
- `workers-cur-forwarder/wrangler.toml` → `CUR_STATE_KV.id`
- `workers-postgres-forwader/wrangler.toml` → `PG_STATE_KV.id`

---

## 4. Secrets & Environment Variables

### 4.1 Cloudflare Secrets Store

All workers reference a **Secrets Store** with `store_id = "2556bcd9458349f6b4ff2a3fc93bdba1"`.

**Verify the Secrets Store exists** in Cloudflare Dashboard → Workers & Pages → Secrets Store.

**Required secrets in the store:**

| Secret Name | Used By | Description |
|-------------|---------|-------------|
| `SUPABASE_URL` | All workers | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | All workers | Supabase service role key |
| `BEDROCK_ACCESS_KEY_ID` | workers, job-runner, cur-forwarder, s3-cleanup | AWS access key |
| `BEDROCK_SECRET_ACCESS_KEY` | workers, job-runner, cur-forwarder, s3-cleanup | AWS secret key |
| `BEDROCK_REGION` | workers, job-runner, s3-cleanup | AWS region (e.g. `us-east-1`) |
| `GROQ_API_KEY` | job-runner | Groq API key |
| `TAVILY_API_KEY` | job-runner | Tavily API key |
| `GMAIL_CLIENT_ID` | job-runner | Google OAuth client ID |
| `GMAIL_CLIENT_SECRET` | job-runner | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | job-runner | Google OAuth refresh token |
| `SENDER_EMAIL` | job-runner | From email address |
| `REVIEWER_EMAIL` | job-runner | Approval reviewer email |
| `API_BASE_URL` | job-runner | Base URL for API |
| `GITHUB_TOKEN` | job-runner | GitHub PAT with `repo` scope |
| `WEBSITE_REPO_OWNER` | job-runner | GitHub repo owner |
| `WEBSITE_REPO_NAME` | job-runner | GitHub repo name |
| `WEBSITE_BASE_BRANCH` | job-runner | Base branch (e.g. `main`) |
| `WEBSITE_BLOG_DIR` | job-runner | Blog directory in repo |
| `LINKEDIN_NOTIFY_EMAILS` | job-runner | Comma-separated emails |
| `FB_PAGE_ID` | job-runner | Facebook page ID |
| `FB_ACCESS_TOKEN` | job-runner | Facebook access token |
| `IG_ACCOUNT_ID` | job-runner | Instagram account ID |
| `IG_ACCESS_TOKEN` | job-runner | Instagram access token |
| `NEW_RELIC_LICENSE_KEY` | cur-forwarder, postgres-forwarder, s3-cleanup | New Relic ingest key |
| `SUPABASE_DB_URL` | postgres-forwarder | Supabase direct DB connection string |
| `ADMIN_NEON_DB_URL` | postgres-forwarder, ai-sync, brevo-sync | NeonDB admin connection string |
| `BREVO_API_KEY` | brevo-sync | Brevo API key |

### 4.2 Frontend Environment Variables

**Create `frontend/.env` file:**

```env
VITE_API_URL=https://stellar-workflows-api.YOUR_SUBDOMAIN.workers.dev
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_POLL_INTERVAL=2000
```

**⚠️ CRITICAL:** The `VITE_API_URL` must point to the **deployed API Router worker URL**, NOT the AWS API Gateway URL.

### 4.3 Worker Variables (non-secret)

**`workers-cur-forwarder/wrangler.toml` `[vars]` section:**

```toml
[vars]
NEW_RELIC_REGION = "eu"          # change to "us" if NR account is in US
AWS_REGION       = "us-east-1"
RAW_CUR_BUCKET   = "stellarglobal-costing-bucket"
```

---

## 5. Frontend File Changes

### 5.1 Files to Verify/Update

| File | Action | Notes |
|------|--------|-------|
| `frontend/vite.config.js` | ✅ Verify | Must have `manualChunks` for CF Pages 25MB limit |
| `frontend/public/_redirects` | ✅ Verify | Must contain: `/*    /index.html   200` |
| `frontend/src/lib/supabase.js` | ✅ Verify | Uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` |
| `frontend/src/services/api.js` | ✅ Verify | Uses `VITE_API_URL` as base URL |
| `frontend/.env` | ✏️ Create | Copy from `.env.example`, fill values |
| `frontend/package.json` | ✅ Verify | Dependencies installed |

### 5.2 Key Frontend Configurations

**`vite.config.js`** — must include manualChunks:

```js
build: {
  outDir: 'dist',
  sourcemap: false,
  rollupOptions: {
    output: {
      manualChunks: {
        vendor:    ['react', 'react-dom', 'react-router-dom'],
        supabase:  ['@supabase/supabase-js'],
        query:     ['@tanstack/react-query'],
        ui:        ['lucide-react', 'react-hot-toast', 'react-markdown'],
      },
    },
  },
},
```

**`public/_redirects`** — must exist for SPA routing:

```
/*    /index.html   200
```

### 5.3 Build & Deploy Frontend

```bash
cd frontend
npm install
npm run build
```

**Verify build output:**
- `dist/` folder created
- No file exceeds 25MB
- `dist/index.html` exists

**Deploy to Cloudflare Pages:**

```bash
wrangler pages project create stellar-workflows-app
wrangler pages deploy dist
```

**Or via Dashboard:**
1. Cloudflare Dashboard → Pages → Create Project
2. Connect GitHub repo
3. Root directory: `frontend`
4. Build command: `npm run build`
5. Output directory: `dist`
6. Framework preset: Vite
7. Add env vars: `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

---

## 6. Worker File Changes

### 6.1 Main API Router (`workers/`)

**Verify `wrangler.toml`:**
- [ ] `name = "stellarglobalsupplies-workflows"`
- [ ] `main = "src/api-router.js"`
- [ ] D1 binding `DB` → correct `database_id`
- [ ] Secrets Store bindings → correct `store_id`
- [ ] `[ai]` binding for Workers AI (FLUX image generation)

**Verify `src/api-router.js`:**
- [ ] All routes present: `/workflows/*`, `/approvals/*`, `/data/*`, `/schedules/*`
- [ ] CORS headers configured
- [ ] OPTIONS preflight handled
- [ ] Uses `getD1(env)` and `getClient(env)` correctly

### 6.2 Job Runner (`workers-job-runner/`)

**Verify `wrangler.toml`:**
- [ ] `name = "stellar-job-runner"`
- [ ] `main = "../workers/src/job-runner.js"`
- [ ] Cron trigger: `crons = ["* * * * *"]`
- [ ] D1 binding `DB` → correct `database_id`
- [ ] **Service bindings** for all forwarders:
  - `SVC_CUR_FORWARDER` → `service = "cur-forwarder"`
  - `SVC_POSTGRES_FORWARDER` → `service = "postgres-forwarder"`
  - `SVC_AI_SYNC` → `service = "ai-sync"`
  - `SVC_S3_CLEANUP` → `service = "s3-cleanup"`
  - `SVC_BREVO_SYNC` → `service = "brevo-sync"`
- [ ] `[ai]` binding for Workers AI
- [ ] All Secrets Store bindings present

**⚠️ CRITICAL:** The service bindings reference the **worker names** (e.g. `cur-forwarder`), not URLs. These must match the deployed worker names exactly.

### 6.3 Schedule Runner (`workers-schedule-runner/`)

**Verify `wrangler.toml`:**
- [ ] `name = "stellar-schedule-runner"`
- [ ] `main = "../workers/src/schedule-runner.js"`
- [ ] Cron trigger: `crons = ["* * * * *"]`
- [ ] D1 binding `DB` → correct `database_id`
- [ ] Secrets Store bindings for `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`

### 6.4 Forwarder Workers

**`workers-cur-forwarder/wrangler.toml`:**
- [ ] `name = "cur-forwarder"`
- [ ] `main = "index.js"`
- [ ] Cron: `crons = ["0 */8 * * *"]` (every 8 hours)
- [ ] KV namespace `CUR_STATE_KV` → correct ID
- [ ] `[vars]` section with `NEW_RELIC_REGION`, `AWS_REGION`, `RAW_CUR_BUCKET`
- [ ] Secrets: `NEW_RELIC_LICENSE_KEY`, `BEDROCK_ACCESS_KEY_ID`, `BEDROCK_SECRET_ACCESS_KEY`

**`workers-postgres-forwader/wrangler.toml`:**
- [ ] `name = "postgres-forwarder"`
- [ ] `main = "index.js"`
- [ ] `compatibility_flags = ["nodejs_compat"]` (required for `pg` driver)
- [ ] KV namespace `PG_STATE_KV` → correct ID
- [ ] Secrets: `NEW_RELIC_LICENSE_KEY`, `SUPABASE_DB_URL`, `ADMIN_NEON_DB_URL`

**`workers-ai-sync/wrangler.toml`:**
- [ ] `name = "ai-sync"`
- [ ] `main = "index.js"`
- [ ] `compatibility_flags = ["nodejs_compat"]`
- [ ] Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ADMIN_NEON_DB_URL`

**`workers-s3-cleanup/wrangler.toml`:**
- [ ] `name = "s3-cleanup"`
- [ ] `main = "index.js"`
- [ ] `compatibility_flags = ["nodejs_compat"]`
- [ ] Secrets: `BEDROCK_ACCESS_KEY_ID`, `BEDROCK_SECRET_ACCESS_KEY`, `BEDROCK_REGION`, `NEW_RELIC_LICENSE_KEY`

**`workers-brevo-sync/wrangler.toml`:**
- [ ] `name = "brevo-sync"`
- [ ] `main = "index.js"`
- [ ] `compatibility_flags = ["nodejs_compat"]`
- [ ] Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ADMIN_NEON_DB_URL`, `BREVO_API_KEY`
- [ ] **No cron trigger** — scheduling is via D1 `workflow_schedules` table

### 6.5 Install Dependencies

```bash
# For each worker folder with dependencies:
cd workers-postgres-forwader && npm install
cd workers-ai-sync && npm install
cd workers-brevo-sync && npm install
```

---

## 7. Schedules & Cron Configuration

### 7.1 Worker-Level Cron Triggers

| Worker | Cron | Purpose |
|--------|------|---------|
| `stellar-schedule-runner` | `* * * * *` | Check schedules every minute |
| `stellar-job-runner` | `* * * * *` | Pick up pending jobs every minute |
| `cur-forwarder` | `0 */8 * * *` | Every 8 hours (fallback if schedule-runner fails) |
| `postgres-forwarder` | *(none — via D1 schedule)* | Controlled by workflow_schedules |
| `ai-sync` | *(none — via D1 schedule)* | Controlled by workflow_schedules |
| `s3-cleanup` | *(none — via D1 schedule)* | Controlled by workflow_schedules |
| `brevo-sync` | *(none — via D1 schedule)* | Controlled by workflow_schedules |

### 7.2 D1 `workflow_schedules` Table

**Seed data creates these schedules:**

| Schedule ID | Workflow Type | Cron (UTC) | Frequency |
|-------------|--------------|------------|-----------|
| `cur-forwarder-schedule-001` | `cur-forwarder` | `0 */8 * * *` | Every 8 hours |
| `postgres-forwarder-schedule-001` | `postgres-forwarder` | `0 * * * *` | Every hour |
| `ai-sync-schedule-001` | `ai-sync` | `0 * * * *` | Every hour |
| `s3-cleanup-schedule-001` | `s3-cleanup` | `0 2 * * *` | Daily at 2 AM UTC |

**Verify seed data:**

```bash
wrangler d1 execute stellar-workflows --command="SELECT workflow_type, label, cron_utc, enabled FROM workflow_schedules"
```

**⚠️ IMPORTANT:** The `brevo-sync` schedule is **NOT** in the seed file. You must add it manually:

```sql
INSERT OR IGNORE INTO workflow_schedules (
  id, workflow_type, label, frequency, run_time, cron_utc, enabled, parameters, created_at, updated_at
) VALUES (
  'brevo-sync-schedule-001',
  'brevo-sync',
  'Brevo Sync - Every 6 Hours',
  'daily',
  '00:00',
  '0 */6 * * *',
  1,
  '{}',
  datetime('now'),
  datetime('now')
);
```

### 7.3 Schedule Runner Logic

The `schedule-runner.js`:
1. Runs every minute via cron
2. Reads all `enabled=1` schedules from D1
3. Checks if `cron_utc` is due using `cronIsDue()`
4. Creates a `workflow_runs` entry + `job_queue` entry
5. Updates `last_run_at` on the schedule

**First step mapping (in `schedule-runner.js`):**

| Workflow Type | First Step |
|---------------|-----------|
| `lead-generation` | `lead_tavily_find_company` |
| `lead-email-existing` | `lead_load_existing` |
| `social-product` | `social_get_orders` |
| `social-tech` | `social_get_orders` |
| `blog` | `blog_generate_outline` |
| `cur-forwarder` | `cur_run_forwarder` |
| `postgres-forwarder` | `pg_run_forwarder` |
| `ai-sync` | `ai_sync_run` |
| `s3-cleanup` | `s3_cleanup_run` |
| `brevo-sync` | `brevo_sync_run` |

---

## 8. Deployment Order (CRITICAL)

> **⚠️ Deploy in this EXACT order. Forwarders MUST be deployed before job-runner.**

### Step 1: Deploy Forwarders FIRST

```bash
# 1. CUR Forwarder
cd workers-cur-forwarder
npm install
wrangler deploy

# 2. Postgres Forwarder
cd ../workers-postgres-forwader
npm install
wrangler deploy

# 3. AI Sync
cd ../workers-ai-sync
npm install
wrangler deploy

# 4. S3 Cleanup
cd ../workers-s3-cleanup
npm install
wrangler deploy

# 5. Brevo Sync
cd ../workers-brevo-sync
npm install
wrangler deploy
```

**Verify each forwarder is accessible:**

```bash
curl https://cur-forwarder.YOUR_SUBDOMAIN.workers.dev
curl https://postgres-forwarder.YOUR_SUBDOMAIN.workers.dev
curl https://ai-sync.YOUR_SUBDOMAIN.workers.dev
curl https://s3-cleanup.YOUR_SUBDOMAIN.workers.dev
curl https://brevo-sync.YOUR_SUBDOMAIN.workers.dev
```

Each should return a response (not 404).

### Step 2: Deploy Main API Router

```bash
cd workers
npm install
wrangler deploy
```

**Verify health endpoint:**

```bash
curl https://stellarglobalsupplies-workflows.YOUR_SUBDOMAIN.workers.dev/debug-env
```

Expected:
```json
{
  "has_supabase_url": true,
  "has_supabase_key": true,
  "has_bedrock_key": true,
  "has_db": true
}
```

### Step 3: Deploy Schedule Runner

```bash
cd workers-schedule-runner
npm install
wrangler deploy
```

### Step 4: Deploy Job Runner LAST

```bash
cd workers-job-runner
npm install
wrangler deploy
```

### Step 5: Deploy Frontend

```bash
cd frontend
npm install
npm run build
wrangler pages deploy dist
```

---

## 9. Post-Deployment Verification

### 9.1 Test API Router

```bash
# Test health
curl https://stellarglobalsupplies-workflows.YOUR_SUBDOMAIN.workers.dev/debug-env

# Test CORS preflight
curl -X OPTIONS https://stellarglobalsupplies-workflows.YOUR_SUBDOMAIN.workers.dev/workflows/lead-generation \
  -H "Origin: https://workflow.stellarglobalsupplies.com" \
  -H "Access-Control-Request-Method: POST"
```

### 9.2 Test Workflow Execution

**Lead Generation:**
```bash
curl -X POST https://stellarglobalsupplies-workflows.YOUR_SUBDOMAIN.workers.dev/workflows/lead-generation \
  -H "Content-Type: application/json" \
  -d '{
    "target_industry": "Manufacturing",
    "target_country": "India"
  }'
```

**Check status:**
```bash
curl https://stellarglobalsupplies-workflows.YOUR_SUBDOMAIN.workers.dev/workflows/{runId}/status
```

### 9.3 Test Schedule Creation

```bash
curl -X POST https://stellarglobalsupplies-workflows.YOUR_SUBDOMAIN.workers.dev/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "workflow_type": "lead-generation",
    "label": "Test Schedule",
    "frequency": "daily",
    "run_time": "09:00",
    "parameters": {
      "target_industry": "Manufacturing",
      "target_country": "India"
    }
  }'
```

### 9.4 Verify D1 Data

```bash
# Check workflow runs
wrangler d1 execute stellar-workflows --command="SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT 5"

# Check job queue
wrangler d1 execute stellar-workflows --command="SELECT * FROM job_queue ORDER BY created_at DESC LIMIT 5"

# Check schedules
wrangler d1 execute stellar-workflows --command="SELECT * FROM workflow_schedules"

# Check approvals
wrangler d1 execute stellar-workflows --command="SELECT * FROM approval_queue LIMIT 5"
```

### 9.5 Verify Forwarder Service Bindings

**Trigger a tech job manually:**

```bash
# Trigger via API
curl -X POST https://stellarglobalsupplies-workflows.YOUR_SUBDOMAIN.workers.dev/workflows/cur-forwarder \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Check job-runner logs:**
```bash
cd workers-job-runner
wrangler tail
```

Look for:
```
[tech-jobs] triggering CUR via service binding
[tech-jobs] triggered: {"ok":true,...}
```

### 9.6 Verify Frontend

- [ ] Open `https://workflow.stellarglobalsupplies.com` in browser
- [ ] Login page loads
- [ ] Login with Supabase credentials works
- [ ] Dashboard loads with data
- [ ] All pages accessible: Leads, Social, Tech, Blog, Approvals, Content, Workflow Runs, History, Schedules, Payment Followup, Tech Jobs
- [ ] No console errors

---

## 10. Monitoring & Troubleshooting

### 10.1 Monitor Worker Logs

```bash
# Real-time logs for each worker
cd workers && wrangler tail
cd workers-job-runner && wrangler tail
cd workers-schedule-runner && wrangler tail
cd workers-cur-forwarder && wrangler tail
cd workers-postgres-forwader && wrangler tail
cd workers-ai-sync && wrangler tail
cd workers-s3-cleanup && wrangler tail
cd workers-brevo-sync && wrangler tail
```

### 10.2 Common Issues & Fixes

| Issue | Symptom | Fix |
|-------|---------|-----|
| **Forwarder 404** | `step cur_run_forwarder failed` | Deploy forwarders BEFORE job-runner. Verify service bindings in `workers-job-runner/wrangler.toml` |
| **D1 not found** | `D1_ERROR` in logs | Verify `database_id` in all `wrangler.toml` files matches the created D1 database |
| **Secrets not resolving** | `undefined` for env vars | Verify Secrets Store `store_id` is correct. Check Cloudflare Dashboard → Secrets Store |
| **CORS errors** | Frontend can't reach API | Verify CORS headers in `api-router.js`. Check `VITE_API_URL` in frontend `.env` |
| **Cron not firing** | No jobs in queue | Verify `[triggers] crons` in `wrangler.toml`. Check worker is deployed |
| **Schedule not triggering** | No workflow_runs created | Check `workflow_schedules` table has `enabled=1`. Verify `cron_utc` is correct |
| **Service binding error** | `Service binding not configured` | Verify `[[services]]` section in `workers-job-runner/wrangler.toml` |
| **pg driver error** | `pg is not defined` | Verify `compatibility_flags = ["nodejs_compat"]` in forwarder `wrangler.toml` |
| **Frontend blank page** | White screen | Check `_redirects` file exists. Verify `VITE_API_URL` is correct. Check browser console |

### 10.3 D1 Monitoring Queries

```bash
# Pending jobs
wrangler d1 execute stellar-workflows --command="SELECT status, COUNT(*) FROM job_queue GROUP BY status"

# Failed workflows
wrangler d1 execute stellar-workflows --command="SELECT * FROM workflow_runs WHERE status='failed' ORDER BY started_at DESC LIMIT 10"

# Stuck jobs (older than 1 hour)
wrangler d1 execute stellar-workflows --command="SELECT * FROM job_queue WHERE status='pending' AND created_at < datetime('now', '-1 hour')"
```

---

## 11. Rollback Procedures

### 11.1 Rollback a Worker

```bash
# Rollback to previous version
cd workers
wrangler rollback
```

### 11.2 Rollback Frontend

- Cloudflare Dashboard → Pages → Deployments → select previous deployment → Rollback

### 11.3 Rollback D1 Schema

```bash
# D1 doesn't support automatic rollback — restore from backup
# Create a backup first:
wrangler d1 export stellar-workflows --output=backup.sql
```

---

## 12. Final Go-Live Checklist

### ✅ Pre-Deployment
- [ ] All accounts/access verified
- [ ] All API keys obtained
- [ ] D1 database created
- [ ] Supabase migrations applied
- [ ] KV namespaces created
- [ ] Secrets Store populated
- [ ] All `wrangler.toml` files updated with correct IDs

### ✅ Deployment
- [ ] Forwarders deployed (cur, postgres, ai-sync, s3-cleanup, brevo)
- [ ] Main API Router deployed
- [ ] Schedule Runner deployed
- [ ] Job Runner deployed
- [ ] Frontend built and deployed
- [ ] All workers accessible via `.workers.dev` URLs

### ✅ Post-Deployment
- [ ] Health endpoint returns all `true`
- [ ] Test workflow executed successfully
- [ ] Test schedule created successfully
- [ ] Approval emails sending
- [ ] Social posts publishing
- [ ] Blog PRs creating
- [ ] Forwarders triggering via service bindings
- [ ] Frontend loads and all pages work
- [ ] No errors in worker logs
- [ ] D1 data being written correctly
- [ ] Supabase data being written correctly

### ✅ Monitoring Setup
- [ ] `wrangler tail` configured for all workers
- [ ] D1 monitoring queries documented
- [ ] New Relic dashboards configured (for forwarders)
- [ ] Alerting set up (if applicable)

### ✅ Documentation
- [ ] README.md updated with live URLs
- [ ] Team access granted (Cloudflare, Supabase, GitHub)
- [ ] Support contact documented

---

## 📝 Notes for the Agent

1. **Never deploy job-runner before forwarders** — this causes 404 errors on service bindings.
2. **Always verify `database_id`** matches the actual D1 database created.
3. **Secrets Store `store_id`** must be consistent across all `wrangler.toml` files.
4. **The `brevo-sync` schedule is NOT in the seed file** — add it manually.
5. **Frontend `VITE_API_URL`** must point to the Workers API, not AWS.
6. **Service bindings use worker names**, not URLs.
7. **`nodejs_compat` flag** is required for workers using the `pg` driver.
8. **Cron expressions in D1** are in UTC, while schedule `run_time` is in IST.
9. **The `_redirects` file** is essential for SPA routing on Cloudflare Pages.
10. **Always test with `wrangler dev` locally** before deploying to production.

---

*Last updated: 2026-06-08*