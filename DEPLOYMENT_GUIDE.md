# Deployment Guide - Stellar Workflows Platform

This guide covers the complete deployment process for the Stellar Workflows Platform, including database migrations, worker deployments, and frontend setup.

---

## 📋 Prerequisites

- [ ] Cloudflare account with Workers access
- [ ] Supabase project
- [ ] GitHub repository (for blog PR creation)
- [ ] AWS Bedrock access (for AI features)
- [ ] Groq API key
- [ ] Tavily API key
- [ ] Gmail/Google OAuth credentials
- [ ] Facebook/Instagram API access
- [ ] Node.js 18+ installed
- [ ] Wrangler CLI installed (`npm install -g wrangler`)

---

## 🗄️ Step 1: Database Setup

### 1.1 Cloudflare D1 Database

The D1 database stores workflow execution data, job queues, schedules, and approvals.

**Create D1 Database:**
```bash
cd workers
wrangler d1 create stellar-workflows
```

**Apply Schema:**
```bash
# From project root
cd workers
wrangler d1 execute stellar-workflows --file=../d1/schema.sql

# Seed initial tech job schedules
wrangler d1 execute stellar-workflows --file=../d1/seed-tech-job-schedules.sql
```

**Verify Tables Created:**
```bash
wrangler d1 execute stellar-workflows --command="SELECT name FROM sqlite_master WHERE type='table'"
```

Expected tables:
- `job_queue`
- `workflow_runs`
- `workflow_schedules`
- `approval_queue`

### 1.2 Supabase Database

Supabase stores business data (leads, social posts, blog posts, orders).

**Apply Migrations:**
```bash
# From project root
cd supabase
# Apply migrations in order:
# 001_initial_schema.sql
# 002_hunter_usage.sql
# 003_approval_queue_workflow_run_id.sql
# 004_generated_content_assets.sql
# 005_supabase_migration.sql
```

**Verify Supabase Tables:**
```bash
# Check these tables exist in Supabase dashboard:
# - leads
# - social_posts
# - blog_posts
# - orders
# - generated_content_assets
```

---

## 🔐 Step 2: Environment Variables & Secrets

### 2.1 Cloudflare Workers Secrets

**For stellar-job-runner worker:**
```bash
cd workers
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put BEDROCK_ACCESS_KEY_ID
wrangler secret put BEDROCK_SECRET_ACCESS_KEY
wrangler secret put BEDROCK_REGION
wrangler secret put GROQ_API_KEY
wrangler secret put TAVILY_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put GMAIL_CLIENT_ID
wrangler secret put GMAIL_CLIENT_SECRET
wrangler secret put GMAIL_REFRESH_TOKEN
wrangler secret put SENDER_EMAIL
wrangler secret put LINKEDIN_NOTIFY_EMAILS
wrangler secret put FB_PAGE_ID
wrangler secret put FB_ACCESS_TOKEN
wrangler secret put IG_ACCOUNT_ID
wrangler secret put IG_ACCESS_TOKEN
wrangler secret put WEBSITE_REPO_OWNER
wrangler secret put WEBSITE_REPO_NAME
wrangler secret put WEBSITE_BASE_BRANCH
wrangler secret put WEBSITE_BLOG_DIR
```

**For workers-schedule-runner:**
```bash
cd workers-schedule-runner
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
```

### 2.2 Frontend Environment Variables

Create `.env` file in `frontend/`:

```env
VITE_API_URL=https://stellar-workflows-api.YOUR_SUBDOMAIN.workers.dev
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_POLL_INTERVAL=2000
```

---

## 🚀 Step 3: Deploy Workers

### 3.0 Deploy Forwarders FIRST (Critical!)

**⚠️ IMPORTANT:** Forwarder workers MUST be deployed before the job-runner, otherwise you'll get HTTP 404 errors.

```bash
# Deploy in this order:
cd workers-cur-forwarder && wrangler deploy
cd workers-postgres-forwader && wrangler deploy
cd workers-ai-sync && wrangler deploy
cd workers-s3-cleanup && wrangler deploy

# Verify each forwarder is accessible:
curl https://cur-forwarder.workwithprasadbhavsar.workers.dev
curl https://postgres-forwarder.workwithprasadbhavsar.workers.dev
curl https://ai-sync.workwithprasadbhavsar.workers.dev
curl https://s3-cleanup.workwithprasadbhavsar.workers.dev
```

### 3.1 Deploy stellar-job-runner

This is the main worker that executes workflow steps.

```bash
cd workers
wrangler deploy
```

**Verify Deployment:**
```bash
# Test health endpoint
curl https://stellar-workflows-api.YOUR_SUBDOMAIN.workers.dev/debug-env
```

Expected response:
```json
{
  "has_supabase_url": true,
  "has_supabase_key": true,
  "has_bedrock_key": true,
  "has_db": true
}
```

### 3.2 Deploy workers-schedule-runner

This worker handles scheduled workflow execution.

```bash
cd workers-schedule-runner
wrangler deploy
```

**Configure Cron Trigger:**
The schedule-runner should run every minute to check for due schedules.

In `workers-schedule-runner/wrangler.toml`:
```toml
[triggers]
crons = ["* * * * *"]  # Every minute
```

### 3.3 Deploy workers-job-runner

This worker picks up and executes pending jobs.

```bash
cd workers-job-runner
wrangler deploy
```

**Configure Cron Trigger:**
```toml
[triggers]
crons = ["* * * * *"]  # Every minute
```

---

## 🎨 Step 4: Deploy Frontend

### 4.1 Build Frontend

```bash
cd frontend
npm install
npm run build
```

### 4.2 Deploy to Cloudflare Pages

**Option A: Using Wrangler**
```bash
cd frontend
wrangler pages project create stellar-workflows-app
wrangler pages deploy dist
```

**Option B: Using Cloudflare Dashboard**
1. Go to Cloudflare Dashboard → Pages
2. Connect your GitHub repository
3. Select `frontend` folder as build directory
4. Set build command: `npm run build`
5. Set output directory: `dist`
6. Add environment variables from Step 2.2

---

## ✅ Step 5: Post-Deployment Verification

### 5.1 Test Workflow Execution

**Test Lead Generation Workflow:**
```bash
curl -X POST https://stellar-workflows-api.YOUR_SUBDOMAIN.workers.dev/workflows/lead-generation \
  -H "Content-Type: application/json" \
  -d '{
    "target_industry": "Manufacturing",
    "target_country": "India"
  }'
```

Expected response:
```json
{
  "workflowRunId": "uuid-here",
  "status": "queued",
  "firstStep": "lead_tavily_find_company"
}
```

**Check Workflow Status:**
```bash
curl https://stellar-workflows-api.YOUR_SUBDOMAIN.workers.dev/workflows/{runId}/status
```

### 5.2 Test Schedule Creation

```bash
curl -X POST https://stellar-workflows-api.YOUR_SUBDOMAIN.workers.dev/schedules \
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

### 5.3 Verify D1 Data

```bash
# Check workflow runs
wrangler d1 execute stellar-workflows --command="SELECT * FROM workflow_runs LIMIT 5"

# Check job queue
wrangler d1 execute stellar-workflows --command="SELECT * FROM job_queue LIMIT 5"

# Check approvals
wrangler d1 execute stellar-workflows --command="SELECT * FROM approval_queue LIMIT 5"
```

### 5.4 Verify Supabase Data

Check in Supabase dashboard:
- Leads table should have new entries
- Social posts table should have new posts
- Blog posts table should have new blogs

---

## 🔧 Step 6: Configure External Services

### 6.1 GitHub (for Blog PRs)

1. Create a GitHub Personal Access Token (PAT) with `repo` scope
2. Add to Workers secrets (Step 2.1)
3. Verify token works:
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.github.com/user
   ```

### 6.2 Gmail/Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create OAuth 2.0 credentials
3. Add Gmail API scope: `https://www.googleapis.com/auth/gmail.send`
4. Get refresh token using OAuth flow
5. Add credentials to Workers secrets

### 6.3 Facebook/Instagram

1. Create Facebook App at [developers.facebook.com](https://developers.facebook.com/)
2. Get Page ID and Access Token
3. Add Instagram Basic Display API
4. Add credentials to Workers secrets

### 6.4 AWS Bedrock

1. Enable Bedrock in AWS Console
2. Request access to Nova Pro model
3. Create IAM user with Bedrock access
4. Add credentials to Workers secrets

---

## 📊 Step 7: Monitoring & Maintenance

### 7.1 Monitor Worker Logs

```bash
# Real-time logs
cd workers
wrangler tail

# Filter for errors
wrangler tail --status error
```

### 7.2 Monitor D1 Database

```bash
# Check job queue size
wrangler d1 execute stellar-workflows --command="SELECT status, COUNT(*) FROM job_queue GROUP BY status"

# Check failed workflows
wrangler d1 execute stellar-workflows --command="SELECT * FROM workflow_runs WHERE status='failed' ORDER BY started_at DESC LIMIT 10"
```

### 7.3 Monitor Supabase

Use Supabase dashboard to monitor:
- Lead conversion rates
- Social post engagement
- Blog post performance
- API usage

---

## 🚨 Troubleshooting

### Issue: Workflows not executing

**Check:**
1. Job runner cron is configured correctly
2. D1 database is accessible
3. Workers have correct secrets
4. Check worker logs for errors

```bash
wrangler d1 execute stellar-workflows --command="SELECT * FROM job_queue WHERE status='pending'"
```

### Issue: Approval emails not sending

**Check:**
1. Gmail credentials are correct
2. Refresh token is valid
3. SENDER_EMAIL is configured
4. Check worker logs for Gmail errors

### Issue: Social posts not publishing

**Check:**
1. Facebook/Instagram credentials are correct
2. Page IDs are correct
3. Access tokens have not expired
4. Check post_results in social_posts table

### Issue: Blog PRs not creating

**Check:**
1. GitHub token has repo scope
2. Repository owner/name are correct
3. Base branch exists
4. Check worker logs for GitHub API errors

---

## 🔄 Step 8: Updates & Migrations

### 8.1 Deploy Code Changes

```bash
# Deploy workers
cd workers
wrangler deploy

# Deploy frontend
cd frontend
npm run build
wrangler pages deploy dist
```

### 8.2 Database Migrations

**D1 Schema Changes:**
```bash
# Create new migration file
# Then apply:
wrangler d1 execute stellar-workflows --file=../d1/migrations/006_new_feature.sql
```

**Supabase Migrations:**
```bash
cd supabase/migrations
# Apply via Supabase dashboard or CLI
```

### 8.3 Rollback Procedure

If deployment fails:

```bash
# Rollback worker to previous version
cd workers
wrangler rollback

# Rollback frontend
# Use Cloudflare Dashboard → Pages → Deployments → Rollback
```

---

## 📝 Step 9: Documentation

### 9.1 Update README

After deployment, update `README.md` with:
- Live application URL
- API endpoint URL
- Admin credentials
- Support contact

### 9.2 Share Access

Provide team members with:
- Frontend URL
- Supabase dashboard access
- Cloudflare Workers dashboard access
- GitHub repository access

---

## 🎯 Step 10: Go Live Checklist

- [ ] All workers deployed successfully
- [ ] Frontend deployed and accessible
- [ ] D1 schema applied
- [ ] Supabase migrations applied
- [ ] All environment variables configured
- [ ] External APIs configured (GitHub, Gmail, Facebook, etc.)
- [ ] Test workflow executed successfully
- [ ] Test schedule created successfully
- [ ] Approval emails sending
- [ ] Social posts publishing
- [ ] Blog PRs creating
- [ ] Monitoring configured
- [ ] Team access granted
- [ ] Documentation updated

---

## 🆘 Support

If you encounter issues during deployment:

1. Check worker logs: `wrangler tail`
2. Check D1 database: `wrangler d1 execute stellar-workflows --command="..."`
3. Check Supabase logs in dashboard
4. Review error messages in this guide's Troubleshooting section

---

## 📅 Post-Deployment

**First 24 Hours:**
- Monitor worker logs continuously
- Check D1 job queue every hour
- Verify scheduled workflows are firing
- Test all workflow types manually

**First Week:**
- Review error logs daily
- Check API usage/costs
- Monitor approval queue
- Verify social post publishing

**Ongoing:**
- Weekly log review
- Monthly cost analysis
- Quarterly security audit
- Regular dependency updates