# GitHub Actions — Required Repository Secrets
# Settings → Secrets and variables → Actions → New repository secret

# ── AWS (OIDC recommended — no static keys) ────────────────────
AWS_REGION                  = us-east-1
AWS_ROLE_ARN                = arn:aws:iam::ACCOUNT:role/github-actions-deploy

# ── Supabase ────────────────────────────────────────────────────
SUPABASE_URL                = https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY           = eyJ...  (anon/public key)
SUPABASE_SERVICE_KEY        = eyJ...  (service_role key — only used by Terraform/Lambda)

# ── API Gateway (set after first terraform apply) ───────────────
API_GATEWAY_URL             = https://XXXXX.execute-api.us-east-1.amazonaws.com

# ── ACM Certificate ─────────────────────────────────────────────
ACM_CERT_ARN                = arn:aws:acm:us-east-1:ACCOUNT:certificate/XXXX

# ── S3 / CloudFront (set after first terraform apply) ───────────
FRONTEND_S3_BUCKET          = stellar-wf-prod-frontend
LAMBDA_CODE_BUCKET          = stellar-wf-prod-lambda-code
CLOUDFRONT_DISTRIBUTION_ID  = EXXXXXXXXXX

# ── GitHub PAT for SSM seeding ──────────────────────────────────
TOKEN_PAT                   = ghp_...

# ── Website GitHub Repo ─────────────────────────────────────────
WEBSITE_REPO_OWNER          = your-org-or-username
WEBSITE_REPO_NAME           = stellar-website
