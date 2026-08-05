# s3-cleanup — Cloudflare Worker

Rewrite of `s3_cleanup_job/s3_cleanup.py` (Lambda) as a Cloudflare Worker.

Enforces per-bucket object-age retention policies and ships structured JSON
logs to New Relic Log API (EU endpoint).

## What it does

1. Iterates through 7 bucket policies (some buckets have multiple prefix rules).
2. **Checks if each bucket exists** via `HeadBucket` — if the bucket doesn't exist
   (404) or is inaccessible (403), it logs a skip event and moves to the next bucket.
3. Lists objects via `ListObjectsV2` (paginated, max 1000 per page).
4. Filters by prefix and exclude_prefixes (e.g. `blog-images/`).
5. Deletes objects older than `max_age_days` via `DeleteObjects` (batch max 1000).
6. Emits structured JSON logs to New Relic for each bucket scanned/completed/skipped/failed.

## Bucket policies

| Bucket | Prefix | Exclude | Max Age |
|---|---|---|---|
| `stellarglobal-cf-logs` | `AWSLogs/471112840461/CloudFront/` | — | 7 days |
| `stellar-oms-invoices-production` | (all) | — | 7 days |
| `stellar-wf-prod-assets` | (all) | `blog-images/` | 7 days |
| `stellar-global-prod-data-9856add5` | (all) | — | 2 days |
| `stellar-global-prod-attachments-20260627040526193400000001` | (all) | — | 2 days |
| `stellarglobal-costing-bucket` | `awscost/` | — | 2 days |
| `stellarglobal-costing-bucket` | `processed/` | — | 2 days |

## AWS credentials

Uses the **same `bedrock_*` secrets** as the main worker — no separate AWS credentials needed:
- `BEDROCK_ACCESS_KEY_ID`
- `BEDROCK_SECRET_ACCESS_KEY`
- `BEDROCK_REGION`

## Setup

```bash
cd workers-s3-cleanup
npm install

# 1. Set secrets via Cloudflare Secrets Store (store_id 2556bcd9458349f6b4ff2a3fc93bdba1):
#    BEDROCK_ACCESS_KEY_ID, BEDROCK_SECRET_ACCESS_KEY, BEDROCK_REGION, NEW_RELIC_LICENSE_KEY

# 2. Deploy
wrangler deploy
```

## Manual trigger

```
GET https://s3-cleanup.<your-subdomain>.workers.dev/run
```

## Cron

Deployed with `crons = ["0 2 * * *"]` — daily at 02:00 UTC.

## Bucket existence check

Before processing each bucket, the worker calls `HeadBucket`:
- **200** → bucket exists, proceed with cleanup
- **404** → bucket doesn't exist, log skip and move to next bucket
- **403** → access denied (bucket may exist but IAM lacks `s3:ListBucket`), log skip and move on

This ensures the worker never fails if a bucket has been deleted or renamed.
