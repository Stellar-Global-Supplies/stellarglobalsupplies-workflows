# ai-sync — Cloudflare Worker

Rewrite of `stellar-ai-sync-job/sync_to_neon.py` + `.github/workflows/sync.yml`.

Syncs a **whitelisted, PII-safe subset** of Supabase data to Neon Postgres for Stellar AI's enterprise context feature. No PII ever leaves the platform.

## What it does

1. Fetches whitelisted columns from 9 Supabase tables (paginated).
2. Aggregates `orders` and `quotes` into monthly buckets in JS — raw rows never reach Neon.
3. Ensures Neon schema with `CREATE TABLE IF NOT EXISTS`.
4. Upserts everything — idempotent, never deletes.
5. Writes per-table results to `_sync_log` audit table.
6. Per-table error isolation — one failure doesn't abort the rest.

## Allowed tables (whitelist)

| Table | Columns | Neon table |
|---|---|---|
| `suppliers` | `supplier_name`, `gstin` | `suppliers` |
| `customers` | `customer_name`, `gstin` | `customers` |
| `top_sku` | `sku`, `material_type`, `hsn_sac` | `top_sku` |
| `sales` | `invoice_no`, `invoice_date`, `customer_name`, `invoice_type`, `total_amount` | `sales` |
| `purchases` | `invoice_no`, `invoice_date`, `supplier_name`, `invoice_type`, `total_amount` | `purchases` |
| `sales_items` | `row_key`, `invoice_no`, `invoice_date`, `customer_name`, `item_name`, `quantity`, `unit`, `material_type`, `base_amount`, `gst_rate`, `gst_amount`, `total_amount` | `sales_items` |
| `purchase_items` | `row_key`, `invoice_no`, `invoice_date`, `supplier_name`, `item_name`, `quantity`, `unit`, `material_type`, `base_amount`, `gst_rate`, `gst_amount`, `total_amount` | `purchase_items` |
| `orders` (AGGREGATED) | `status`, `payment_status`, `sale_cost`, `cgst_total`, `sgst_total`, `created_at` | `orders_monthly_summary` |
| `quotes` (AGGREGATED) | `status`, `date`, `grand_total`, `cgst_amount`, `sgst_amount`, `igst_amount` | `quotes_monthly_summary` |

## Setup

```bash
cd workers-ai-sync
npm install

# 1. Set secrets via Cloudflare Secrets Store (store_id 2556bcd9458349f6b4ff2a3fc93bdba1):
#    SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_NEON_DB_URL

# 2. Deploy
wrangler deploy
```

## Manual trigger

```
GET https://ai-sync.<your-subdomain>.workers.dev/run
```

## Cron

Deployed with `crons = ["0 * * * *"]` — every hour, matching the GHA schedule.

## Retiring the GHA workflow

Once this worker is deployed and verified, remove/disable `stellar-ai-sync-job/sync.yml` from GitHub Actions.