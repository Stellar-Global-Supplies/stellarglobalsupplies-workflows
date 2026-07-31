# Stellar Workflows — Cloudflare Migration Tracker

> Last updated: Phase 2 complete

---

## Architecture Decision Log

| Decision | Choice | Reason |
|---|---|---|
| Frontend hosting | Cloudflare Pages | Free, fast, zero config |
| Worker architecture | Fire-and-kill per job | Workers have 30s limit, no persistent state needed |
| Workflow orchestration | D1 job_queue table | Replaces Step Functions — simpler, infinite scale |
| AI — content writing | Bedrock Nova Pro | Brand voice quality, already paid |
| AI — data extraction | Groq Llama 70B | Free tier, fast, simple tasks |
| AI — web research | Tavily | Real web data, 1000 credits/month free |
| AI — image generation | Hugging Face FLUX | Already in codebase, stays free |
| Asset storage | Cloudflare R2 | Replaces S3 + CloudFront, 10GB free |
| Workflow engine data | Cloudflare D1 | job_queue, workflow_runs, schedules, approvals |
| Business data | Supabase (unchanged) | leads, social_posts, blog_posts, orders |

---

## Data Split

```
Cloudflare D1 (workflow engine)     Supabase (business data — unchanged)
────────────────────────────────    ──────────────────────────────────────
job_queue              ← new        leads
workflow_runs          ← moved      social_posts
workflow_schedules     ← moved      blog_posts
approval_queue         ← moved      orders
```

---

## Free Tier Budget

| Service | Free Limit | Estimated Usage | Status |
|---|---|---|---|
| CF Pages | Unlimited | 1 site | ✅ Free forever |
| CF Workers | 100k req/day | ~500-1000/day | ✅ Free forever |
| CF Cron | 5 crons | 2 used | ✅ Free forever |
| CF R2 | 10GB / 1M reads/month | ~2-3GB | ✅ Free forever |
| CF D1 | 5GB / 25M reads/day | <1GB | ✅ Free forever |
| Groq (Llama 70B) | 1,000 RPD | ~100-200/day | ✅ Comfortable |
| Tavily | 1,000 credits/month | ~300-600/month (~250 leads) | ✅ Comfortable |
| Bedrock Nova Pro | Pay per use | Same as today | 💰 Only real cost |
| Supabase | Free tier | Same as today | ✅ Free forever |

---

## Phase 0 — Setup ✅ DONE

- [x] Cloudflare account created — Pages + Workers + R2 + D1 enabled
- [x] Groq account — API key obtained
- [x] Tavily account — API key obtained
- [x] Bedrock access confirmed active
- [x] Supabase stays unchanged

---

## Phase 1 — Frontend to Cloudflare Pages ✅ DONE

**Files changed:**
| File | Action |
|---|---|
| `frontend/vite.config.js` | Replaced — added manualChunks for CF Pages 25MB file limit |
| `frontend/public/_redirects` | New — SPA routing fix for CF Pages |
| `wrangler.toml` | Removed — caused env var conflicts, dashboard vars are source of truth |

**Cloudflare Pages settings:**
| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `frontend` |
| Framework preset | Vite |

**Environment variables set in CF Pages dashboard (Production + Preview):**
| Variable | Source |
|---|---|
| `VITE_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon public key |
| `VITE_API_URL` | ⚠️ Still pointing to AWS API Gateway — changes in Phase 2 cutover |

**AWS services still running:** All (untouched)

---

## Phase 2 — Core Worker Infrastructure ✅ DONE

### Files delivered

**New repo location:** `workers/` at repo root (sibling to `frontend/` and `backend/`)

| File | Purpose | Replaces |
|---|---|---|
| `workers/wrangler.toml` | 3 Worker definitions + D1 + R2 bindings | — |
| `workers/package.json` | Wrangler dev dependency | — |
| `workers/src/api-router.js` | All HTTP routes | API Gateway + 4 Lambda handlers |
| `workers/src/job-runner.js` | Cron engine — picks + runs jobs | Step Functions + all workflow Lambdas (stubs for now) |
| `workers/src/schedule-runner.js` | Fires scheduled workflows | EventBridge |
| `workers/src/lib/supabase.js` | Supabase REST client | `shared/supabase_client.py` |
| `workers/src/lib/d1.js` | D1 client | — (new) |
| `workers/src/lib/utils.js` | Shared helpers + cron math | `shared/utils.py` |
| `workers/src/lib/assets.js` | R2 upload/read | S3 functions in `utils.py` |
| `workers/src/lib/bedrock.js` | Bedrock via AWS Sig V4 | `shared/bedrock_client.py` |
| `d1-schema.sql` | D1 table definitions | Supabase tables (moved) |

### D1 Setup Steps
```bash
# 1. Create D1 database
wrangler d1 create stellar-workflows

# 2. Copy the database_id output into wrangler.toml (REPLACE_WITH_YOUR_D1_DATABASE_ID)

# 3. Run schema
wrangler d1 execute stellar-workflows --file=d1-schema.sql

# 4. Deploy all 3 workers
npm install && npm run deploy
```

### Secrets to add in CF Dashboard (per Worker — all 3)
| Secret | Worker(s) |
|---|---|
| `SUPABASE_URL` | All 3 |
| `SUPABASE_SERVICE_KEY` | All 3 |
| `BEDROCK_ACCESS_KEY_ID` | stellar-api, stellar-job-runner |
| `BEDROCK_SECRET_ACCESS_KEY` | stellar-api, stellar-job-runner |
| `BEDROCK_REGION` | stellar-api, stellar-job-runner |
| `GROQ_API_KEY` | stellar-job-runner |
| `TAVILY_API_KEY` | stellar-job-runner |
| `R2_PUBLIC_URL` | stellar-api, stellar-job-runner |

### Update frontend after deploy
In CF Pages dashboard → Environment Variables:
```
VITE_API_URL = https://stellar-api.<your-subdomain>.workers.dev
```

### What's stubbed (Phase 4 fills in)
All step handlers in `job-runner.js` are stubs — they log and advance to next step.
Infrastructure works end-to-end. AWS keeps running in parallel.

**AWS services still running:** All (parallel, untouched)

---

## Phase 3 — Assets to Cloudflare R2 🔲 TODO

**Goal:** Replace S3 + CloudFront with R2.

**Steps:**
- [ ] Create R2 bucket `stellar-assets` in CF dashboard
- [ ] Enable public access on bucket — get public URL
- [ ] Set `R2_PUBLIC_URL` secret on Workers
- [ ] Write + run one-time migration script: copy all objects from S3 → R2
- [ ] Update all image URLs in Supabase DB from CloudFront URL → R2 URL
- [ ] Verify R2 URLs load correctly in frontend
- [ ] After 30 days confirm no S3 references remain → decommission S3 + CloudFront

**Files to change:** None — `assets.js` already writes to R2. Step handlers in Phase 4 use it automatically.

---

## Phase 4 — Port Workflows One by One 🔲 TODO

All workflows stay on AWS until their Workers port is validated.
Port order: simplest → most complex.

### 4a — Payment Followup 🔲 TODO
**Steps to implement in job-runner.js:**
- [ ] `payment_fetch_overdue` — query Supabase orders where payment_status=overdue
- [ ] `payment_bedrock_draft_email` — call Bedrock, generate followup email JSON
- [ ] `payment_send_email` — send via email provider, update order status in Supabase

**Estimated effort:** 2 days

---

### 4b — Social Product Post 🔲 TODO
**Steps to implement:**
- [ ] `social_get_orders` — fetch recent orders from Supabase
- [ ] `social_bedrock_generate_post` — Bedrock generates LinkedIn/FB/IG content JSON
- [ ] `social_image_submit` — POST to HF Gradio FLUX endpoint, save event_id to payload
- [ ] `social_image_poll` — GET HF Gradio status; if pending re-insert self; if done upload to R2
- [ ] `social_post_to_platforms` — post to LinkedIn/Facebook/Instagram APIs, update Supabase

**Estimated effort:** 3 days

---

### 4c — Social Tech Post 🔲 TODO
**Steps to implement:**
- [ ] `social_get_orders` — shared with 4b, reads tech context from R2
- [ ] Everything else identical to 4b

**Estimated effort:** 2 days (reuse 4b)

---

### 4d — Blog Post 🔲 TODO
**Steps to implement:**
- [ ] `blog_generate_outline` — Bedrock generates structured outline JSON
- [ ] `blog_generate_content` — Bedrock generates full markdown from outline
- [ ] `blog_image_submit` — HF Gradio FLUX (same pattern as social)
- [ ] `blog_image_poll` — poll + upload to R2 (same pattern as social)
- [ ] `blog_create_github_pr` — GitHub API: create branch, commit MDX file, open PR

**Estimated effort:** 3 days

---

### 4e — Lead Email Existing 🔲 TODO
**Steps to implement:**
- [ ] `lead_load_existing` — fetch lead from Supabase by ID
- [ ] `lead_bedrock_draft_email` — Bedrock drafts personalised outreach email
- [ ] `lead_send_email` — send via email provider, update lead status

**Estimated effort:** 2 days

---

### 4f — Lead Generation (new pipeline) 🔲 TODO
**Steps to implement:**
- [ ] `lead_tavily_find_company` — Tavily search for real companies (1 credit)
- [ ] `lead_groq_extract_company` — Groq extracts structured company JSON
- [ ] `lead_check_duplicate` — query Supabase leads, skip if domain exists
- [ ] `lead_tavily_find_contact` — Tavily search LinkedIn + company (1 credit)
- [ ] `lead_tavily_scrape_website` — Tavily scrape contact page (1 credit)
- [ ] `lead_groq_extract_email` — Groq extracts email with fallback chain
- [ ] `lead_save` — insert lead row into Supabase
- [ ] `lead_bedrock_draft_email` — Bedrock writes personalised B2B outreach
- [ ] `lead_send_email` — send + schedule followup job

**Email fallback chain (in groq_extract_email):**
```
Found email on website?          → use it
Other emails found at domain?    → guess firstname@domain.com
Domain known, no emails?         → procurement@domain.com
Nothing found?                   → mark needs_review, skip send
```

**Estimated effort:** 1 week

---

### 4g — Advertising Workflow 🔲 TODO (build natively — never on AWS)
**Steps to implement:**
- [ ] `ad_tavily_research` — Tavily keyword + competitor research (2 credits)
- [ ] `ad_groq_analyse` — Groq analyses competition + audience
- [ ] `ad_bedrock_generate_variations` — Bedrock writes A/B ad copy JSON
- [ ] `ad_image_submit_a` + `ad_image_submit_b` — parallel FLUX jobs
- [ ] `ad_image_poll_a` + `ad_image_poll_b` — poll + R2 upload
- [ ] `ad_approval_gate` — human reviews both variations
- [ ] `ad_deploy_to_platform` — Meta/Google Ads API
- [ ] `ad_schedule_performance_check` — insert future-dated job
- [ ] `ad_check_performance` — fetch metrics, Groq analyses
- [ ] `ad_conditionally_rerun` — insert new ad workflow if underperforming

**Estimated effort:** 1.5 weeks

---

### 4h — Newsletter Workflow 🔲 TODO (build natively — never on AWS)
**Steps to implement:**
- [ ] `nl_tavily_research_topics` — broad + specific search (2 credits)
- [ ] `nl_groq_select_topics` — Groq picks best 3 topics
- [ ] `nl_bedrock_generate_content` — Bedrock writes full newsletter
- [ ] `nl_tavily_fetch_links` — supporting article links (1 credit)
- [ ] `nl_groq_format` — Groq formats final HTML newsletter
- [ ] `nl_approval_gate` — human reviews
- [ ] `nl_pull_segments` — fetch subscriber segments from Supabase
- [ ] `nl_send_batch` — send 500 at a time, self-inserts until done
- [ ] `nl_record_metrics` — store open/click rates

**Estimated effort:** 1 week

---

## Phase 5 — Decommission AWS 🔲 TODO

Do this only after ALL workflows validated on Workers for 1+ week.

- [ ] Disable all EventBridge rules
- [ ] Monitor Step Functions — confirm zero executions for 7 days
- [ ] Remove Step Functions state machines
- [ ] Remove Lambda functions (all)
- [ ] Remove API Gateway
- [ ] Remove IAM roles created for Lambda/Step Functions
- [ ] Keep S3 read-only for 30 days → decommission after R2 confirmed
- [ ] Keep Bedrock access — still in use via Workers
- [ ] Update Terraform / remove stacks
- [ ] Final `VITE_API_URL` confirmed pointing to Workers (done in Phase 2)

---

## Summary

| Phase | Description | Status | Est. Effort |
|---|---|---|---|
| 0 | Accounts + setup | ✅ Done | 2 days |
| 1 | Frontend → CF Pages | ✅ Done | 3-5 days |
| 2 | Core Worker infrastructure + D1 | ✅ Done | 1 week |
| 3 | Assets → R2 | 🔲 Todo | 2-3 days |
| 4a | Payment Followup workflow | 🔲 Todo | 2 days |
| 4b | Social Product Post workflow | 🔲 Todo | 3 days |
| 4c | Social Tech Post workflow | 🔲 Todo | 2 days |
| 4d | Blog Post workflow | 🔲 Todo | 3 days |
| 4e | Lead Email Existing workflow | 🔲 Todo | 2 days |
| 4f | Lead Generation workflow (rebuilt) | 🔲 Todo | 1 week |
| 4g | Advertising workflow (new) | 🔲 Todo | 1.5 weeks |
| 4h | Newsletter workflow (new) | 🔲 Todo | 1 week |
| 5 | Decommission AWS | 🔲 Todo | 3-5 days |
| **Total** | | | **~6-7 weeks** |

---

## AWS Services Status

| Service | Status | Decommission in |
|---|---|---|
| API Gateway | 🟡 Running | Phase 2 cutover |
| Lambda (API handlers) | 🟡 Running | Phase 2 cutover |
| Lambda (workflow steps) | 🟡 Running | Phase 4 per workflow |
| Step Functions | 🟡 Running | Phase 4 per workflow |
| EventBridge | 🟡 Running | Phase 2 cutover |
| S3 + CloudFront | 🟡 Running | Phase 3 + 30 day buffer |
| Bedrock | 🟢 Keeping | Never — still used |
| IAM roles | 🟡 Running | Phase 5 |