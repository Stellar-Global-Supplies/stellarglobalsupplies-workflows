# 🚀 Stellar Global Supplies — Workflows Platform

Intelligent automation platform for **[stellarglobalsupplies.com](https://stellarglobalsupplies.com)** — hosted at `workflow.stellarglobalsupplies.com`.

---

## Architecture

```
workflow.stellarglobalsupplies.com
         │
    CloudFront (CDN)
         │
      S3 Bucket (React SPA)
         │
   Supabase Auth (login)
         │
   API Gateway (HTTP API)
    ┌────┴──────────────────────────┐
    │                               │
 Lambda                         Lambda
(workflow-trigger)          (approval-handler, data-handler)
    │
AWS Step Functions ──── waitForTaskToken ──── Lambda (create-approval)
    │                                              │
    ├── Lead Generation                      Supabase DB
    │   ├── generate_leads (Nova AI + Hunter.io)   │
    │   ├── check_duplicate                   approval_queue
    │   ├── save_lead                         leads
    │   ├── draft_email (Nova AI)             email_drafts
    │   ├── [HUMAN APPROVAL]
    │   ├── send_email (Gmail OAuth)
    │   └── schedule_followup
    │
    ├── Social Product Post
    │   ├── get_orders (Supabase orders table)
    │   ├── generate_post (Nova AI text + Nova Canvas image)
    │   ├── [HUMAN APPROVAL]
    │   └── post_to_platforms (FB API, Instagram API, LinkedIn manual)
    │
    ├── Tech Showcase Post
    │   ├── read_s3_context ({repo}/ai_context.md)
    │   ├── generate_post (Nova AI)
    │   ├── [HUMAN APPROVAL]
    │   └── post_to_platforms
    │
    └── Blog Post → GitHub PR
        ├── generate_blog (Nova AI text + Nova Canvas image)
        ├── [HUMAN APPROVAL]
        └── create_github_pr (branch → commit → PR)
```

---

## Workflows

### 1. Lead Generation
- AI (Amazon Nova) identifies a target company in your chosen industry/country
- **Hunter.io** finds a verified real email (50 credits/month conserved with smart credit guard)
- Falls back to AI-generated free email when credits are low
- Deduplicates by email AND company name before saving
- AI drafts personalised outreach email → awaits approval → sends via Gmail OAuth
- Schedules 5-day follow-up via EventBridge

### 2. Product Social Posts
- Pulls order data from Supabase `orders` table
- Nova Canvas generates a product image
- Nova Pro writes platform-specific captions (FB / Instagram / LinkedIn)
- Awaits approval → posts to Facebook & Instagram APIs (LinkedIn marked manual)
- Deduplicates by `order_id`

### 3. Tech Showcase Posts
- Reads `{repo_name}/ai_context.md` from S3
- Nova generates a tech post tailored to the repo context + custom prompt
- Awaits approval → posts to all platforms

### 4. Blog Post → GitHub PR
- Nova writes a full SEO blog post with frontmatter
- Nova Canvas generates a 1200×630 featured image
- Awaits approval → creates branch, commits `.md` file, opens PR on website repo

---

## Tech Stack

| Layer       | Technology |
|-------------|-----------|
| Frontend    | React 18 + Vite + Tailwind CSS |
| Auth        | Supabase Auth |
| Database    | Supabase (PostgreSQL) |
| CDN/Hosting | S3 + CloudFront |
| DNS         | Route 53 → `workflow.stellarglobalsupplies.com` |
| API         | API Gateway HTTP API v2 |
| Compute     | Python 3.11 Lambda |
| Orchestration | AWS Step Functions |
| AI Text     | Amazon Nova Pro (Bedrock) |
| AI Images   | Amazon Nova Canvas (Bedrock) |
| Email leads | Hunter.io (50 credits/month, credit-guarded) |
| Email send  | Gmail OAuth (refresh token in SSM) |
| Social      | Facebook Graph API, Instagram Graph API |
| Blog deploy | GitHub REST API (branch + PR) |
| IaC         | Terraform 1.7 |
| CI/CD       | GitHub Actions (OIDC, no static keys) |

---

## Quick Start

### Prerequisites
- AWS account with Bedrock Nova enabled in `us-east-1`
- Supabase project created
- Route 53 hosted zone for `stellarglobalsupplies.com`
- ACM certificate for `*.stellarglobalsupplies.com` (us-east-1)
- Hunter.io free account (50 searches/month)
- Gmail OAuth app credentials
- Facebook / Instagram developer app
- GitHub PAT with `repo` write access (for blog PRs)

### 1 — Run Supabase migrations
```bash
# In Supabase dashboard → SQL Editor, run:
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_hunter_usage.sql
```

### 2 — Store secrets in SSM
```bash
chmod +x docs/setup-ssm-params.sh
./docs/setup-ssm-params.sh
```

### 3 — Set GitHub Secrets
See `docs/github-secrets.md` for the full list.

### 4 — Add Lambda env var for Hunter.io
In `terraform/main.tf` `local.lambda_env`, add:
```hcl
HUNTER_API_KEY_PARAM = "/stellar-wf/hunter/api_key"
```

### 5 — Deploy infrastructure
```bash
cd terraform
terraform init
terraform apply \
  -var="supabase_url=YOUR_URL" \
  -var="supabase_service_key=YOUR_KEY" \
  -var="acm_certificate_arn=YOUR_ARN" \
  -var="website_repo_owner=your-org" \
  -var="website_repo_name=stellar-website"
```

### 6 — Deploy backend
```bash
# Push to main branch → GitHub Actions deploy-backend.yml runs automatically
git push origin main
```

### 7 — Deploy frontend
```bash
cd frontend
cp .env.example .env.local
# Fill in Supabase URL, anon key, and API Gateway URL
npm install && npm run build
# Or push to main → deploy-frontend.yml runs automatically
```

### 8 — Create a Supabase user
```sql
-- In Supabase Auth → Users → Invite user
-- or via SQL:
SELECT auth.signup('admin@stellarglobalsupplies.com', 'your-password');
```

---

## Hunter.io Credit Conservation

The system protects your 50 monthly credits with three guards:

1. **Minimum reserve**: Always keeps 3 credits as buffer — never uses the last few
2. **Domain deduplication**: Skips Hunter.io if the domain is already in your leads table (checked before consuming a credit)
3. **Account check first**: Queries Hunter.io account API for current balance before every search
4. **Audit log**: Every credit consumption is logged to `hunter_usage_log` table with the `hunter_monthly_usage` view for monitoring
5. **AI fallback**: If Hunter.io is skipped for any reason, AI generates a realistic free email (Gmail/Outlook) so the workflow continues

---

## Environment Variables (Lambda)

All sensitive values are stored in SSM Parameter Store as SecureString.
Non-sensitive config is in Lambda environment variables (set via Terraform).

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Service role key |
| `ASSETS_BUCKET` | Private S3 bucket for AI-generated images (served through CloudFront) |
| `BEDROCK_TEXT_MODEL` | `amazon.nova-lite-v1:0` |
| `BEDROCK_IMAGE_MODEL` | `amazon.nova-canvas-v1:0` |
| `SENDER_EMAIL` | Gmail sender address |
| `HUNTER_API_KEY_PARAM` | SSM path to Hunter.io key |
| `GMAIL_CLIENT_ID_PARAM` | SSM path |
| `GMAIL_CLIENT_SECRET_PARAM` | SSM path |
| `GMAIL_REFRESH_TOKEN_PARAM` | SSM path |
| `FB_PAGE_ID_PARAM` | SSM path |
| `FB_ACCESS_TOKEN_PARAM` | SSM path |
| `IG_ACCOUNT_ID_PARAM` | SSM path |
| `IG_ACCESS_TOKEN_PARAM` | SSM path |
| `GITHUB_TOKEN_PARAM` | SSM path |
| `WEBSITE_REPO_OWNER` | GitHub org/user |
| `WEBSITE_REPO_NAME` | Website repo name |

---

## Project Structure

```
workflows-platform/
├── frontend/                  # React + Vite + Tailwind SPA
│   ├── src/
│   │   ├── pages/             # Dashboard, LeadGen, Social, Tech, Blog, Approvals, History
│   │   ├── components/        # Layout, UI kit (Modal, Badge, StatCard, etc.)
│   │   ├── contexts/          # AuthContext (Supabase)
│   │   ├── services/          # API client
│   │   └── lib/               # Supabase client
│   └── package.json
├── backend/
│   ├── lambdas/
│   │   ├── shared/            # supabase_client, bedrock_client, hunter_client, utils
│   │   ├── lead_generation/   # generate, check_dup, save, draft, approval, send, followup
│   │   ├── social_media/      # get_orders, generate_post, post_to_platforms
│   │   ├── tech_post/         # read_s3_context
│   │   ├── blog_post/         # generate_blog, create_github_pr
│   │   └── api/               # workflow_trigger, approval_handler, data_handler
│   └── step_functions/        # State machine JSON for all 4 workflows
├── terraform/                 # All AWS infrastructure as code
├── supabase/migrations/       # PostgreSQL schema
├── docs/                      # Setup scripts, secrets reference
└── .github/workflows/         # CI/CD (infra, backend, frontend)
```
