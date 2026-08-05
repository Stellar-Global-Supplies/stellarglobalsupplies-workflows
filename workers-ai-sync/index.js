/**
 * ai-sync — Cloudflare Worker
 *
 * Rewrite of .github/workflows/sync.yml + stellar-ai-sync-job/sync_to_neon.py
 *
 * Syncs a STRICT READ-ONLY whitelisted subset of Supabase data to Neon
 * Postgres for Stellar AI's enterprise context feature. No PII leaves
 * the platform — orders and quotes are aggregated in JS before writing.
 *
 * DATA POLICY ENFORCED IN CODE:
 *   - Only whitelisted tables are ever touched
 *   - Only whitelisted columns per table are ever selected
 *   - Orders and Quotes are aggregated in JS — raw rows never written to Neon
 *   - All syncs use UPSERT — never DELETE records
 *   - Sync is idempotent — safe to run multiple times
 *   - No raw SQL is ever passed from the AI to this database
 *
 * Triggers (wrangler.toml):
 *   • Cron : "0 * * * *"   (every hour, matching the GHA schedule)
 *   • HTTP GET /run         (manual trigger / workflow_dispatch equivalent)
 *
 * Required secrets (Secrets Store — store_id 2556bcd9458349f6b4ff2a3fc93bdba1):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   ADMIN_NEON_DB_URL
 */

import { Client } from "pg";

// ── DATA POLICY: WHITELIST ──────────────────────────────────────────────────
// Each entry defines EXACTLY which columns are fetched from Supabase.
// Adding a column here is the ONLY way it reaches Neon.
//
// ALLOWED (no PII, business intelligence only):
//   suppliers, customers    - name + GSTIN only (no contact info)
//   top_sku                 - product catalogue
//   sales, purchases        - invoice totals + dates (no party contact)
//   sales_items, purchase_items - line-item analytics
//   orders (AGGREGATED)     - monthly counts + amounts only, no customer identity
//   quotes (AGGREGATED)     - monthly counts + amounts only, no customer identity
//
// BLOCKED (PII, financial strategy, internal ops):
//   orders raw columns: customer_name, phone, email, payment_status (raw),
//                       invoice_url, tracking_token, invoice_s3_key,
//                       created_by, updated_by
//   leads, email_drafts, quote_customers, social_posts, blog_posts,
//   workflow_runs, workflow_schedules, cto_savings_*, ops_social_posts,
//   observe_meta_analytics_cache, ingestion_files, order_items (raw)

const SYNC_TABLES = {
  suppliers: {
    columns:     ["supplier_name", "gstin"],
    primaryKey:  "supplier_name",
    neonTable:   "suppliers",
    pageSize:    500,
  },
  customers: {
    columns:     ["customer_name", "gstin"],
    primaryKey:  "customer_name",
    neonTable:   "customers",
    pageSize:    500,
  },
  top_sku: {
    columns:     ["sku", "material_type", "hsn_sac"],
    primaryKey:  "sku",
    neonTable:   "top_sku",
    pageSize:    500,
  },
  sales: {
    columns:     ["invoice_no", "invoice_date", "customer_name",
                  "invoice_type", "total_amount"],
    primaryKey:  "invoice_no",
    neonTable:   "sales",
    pageSize:    1000,
  },
  purchases: {
    columns:     ["invoice_no", "invoice_date", "supplier_name",
                  "invoice_type", "total_amount"],
    primaryKey:  "invoice_no",
    neonTable:   "purchases",
    pageSize:    1000,
  },
  sales_items: {
    columns:     ["row_key", "invoice_no", "invoice_date",
                  "customer_name", "item_name", "quantity", "unit",
                  "material_type", "base_amount", "gst_rate",
                  "gst_amount", "total_amount"],
    primaryKey:  "row_key",
    neonTable:   "sales_items",
    pageSize:    2000,
  },
  purchase_items: {
    columns:     ["row_key", "invoice_no", "invoice_date",
                  "supplier_name", "item_name", "quantity", "unit",
                  "material_type", "base_amount", "gst_rate",
                  "gst_amount", "total_amount"],
    primaryKey:  "row_key",
    neonTable:   "purchase_items",
    pageSize:    2000,
  },

  // Orders — fetch only non-PII columns, aggregate in JS before writing to Neon
  orders: {
    columns:     ["status", "payment_status", "sale_cost",
                  "cgst_total", "sgst_total", "created_at"],
    primaryKey:  null,
    neonTable:   "orders_monthly_summary",
    pageSize:    5000,
    aggregate:   true,
  },

  // Quotes — fetch only non-PII columns, aggregate in JS before writing to Neon
  quotes: {
    columns:     ["status", "date", "grand_total",
                  "cgst_amount", "sgst_amount", "igst_amount"],
    primaryKey:  null,
    neonTable:   "quotes_monthly_summary",
    pageSize:    2000,
    aggregate:   true,
  },
};

// ── Neon DDL ─────────────────────────────────────────────────────────────────
const NEON_DDL = `
CREATE TABLE IF NOT EXISTS suppliers (
    supplier_name TEXT PRIMARY KEY,
    gstin         TEXT,
    synced_at     TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers (
    customer_name TEXT PRIMARY KEY,
    gstin         TEXT,
    synced_at     TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS top_sku (
    sku           TEXT PRIMARY KEY,
    material_type TEXT,
    hsn_sac       TEXT,
    synced_at     TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sales (
    invoice_no    TEXT PRIMARY KEY,
    invoice_date  DATE,
    customer_name TEXT,
    invoice_type  TEXT,
    total_amount  NUMERIC DEFAULT 0,
    synced_at     TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchases (
    invoice_no    TEXT PRIMARY KEY,
    invoice_date  DATE,
    supplier_name TEXT,
    invoice_type  TEXT,
    total_amount  NUMERIC DEFAULT 0,
    synced_at     TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sales_items (
    row_key       TEXT PRIMARY KEY,
    invoice_no    TEXT,
    invoice_date  DATE,
    customer_name TEXT,
    item_name     TEXT,
    quantity      NUMERIC DEFAULT 0,
    unit          TEXT,
    material_type TEXT,
    base_amount   NUMERIC DEFAULT 0,
    gst_rate      NUMERIC DEFAULT 0,
    gst_amount    NUMERIC DEFAULT 0,
    total_amount  NUMERIC DEFAULT 0,
    synced_at     TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_items (
    row_key       TEXT PRIMARY KEY,
    invoice_no    TEXT,
    invoice_date  DATE,
    supplier_name TEXT,
    item_name     TEXT,
    quantity      NUMERIC DEFAULT 0,
    unit          TEXT,
    material_type TEXT,
    base_amount   NUMERIC DEFAULT 0,
    gst_rate      NUMERIC DEFAULT 0,
    gst_amount    NUMERIC DEFAULT 0,
    total_amount  NUMERIC DEFAULT 0,
    synced_at     TIMESTAMPTZ DEFAULT now()
);

-- Orders: monthly aggregated summary - no customer identity whatsoever
CREATE TABLE IF NOT EXISTS orders_monthly_summary (
    month          TEXT    NOT NULL,
    status         TEXT    NOT NULL,
    payment_status TEXT    NOT NULL,
    order_count    INTEGER DEFAULT 0,
    total_sales    NUMERIC DEFAULT 0,
    total_cgst     NUMERIC DEFAULT 0,
    total_sgst     NUMERIC DEFAULT 0,
    grand_total    NUMERIC DEFAULT 0,
    synced_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (month, status, payment_status)
);

-- Quotes: monthly aggregated summary - no customer identity whatsoever
CREATE TABLE IF NOT EXISTS quotes_monthly_summary (
    month           TEXT    NOT NULL,
    status          TEXT    NOT NULL,
    quote_count     INTEGER DEFAULT 0,
    total_value     NUMERIC DEFAULT 0,
    total_cgst      NUMERIC DEFAULT 0,
    total_sgst      NUMERIC DEFAULT 0,
    total_igst      NUMERIC DEFAULT 0,
    avg_quote_value NUMERIC DEFAULT 0,
    synced_at       TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (month, status)
);

-- Internal audit log - never queried by AI
CREATE TABLE IF NOT EXISTS _sync_log (
    id          SERIAL PRIMARY KEY,
    table_name  TEXT NOT NULL,
    rows_synced INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'ok',
    error_msg   TEXT,
    synced_at   TIMESTAMPTZ DEFAULT now()
);
`;

// ── Worker entry point ─────────────────────────────────────────────────────
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },

  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/run") {
      ctx.waitUntil(runSync(env));
      return new Response(
        JSON.stringify({ ok: true, message: "AI sync started" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("ai-sync worker\nGET /run to trigger manually", { status: 200 });
  },
};

// ── Main sync orchestrator ──────────────────────────────────────────────────
async function runSync(env) {
  const log = makeLogger("ai-sync");
  log.info("=== Stellar AI — Neon Sync Starting ===");
  log.info(`Tables: ${Object.keys(SYNC_TABLES).join(', ')}`);

  const start    = Date.now();
  const errors   = [];

  try {
    const neonConn = new Client({
      connectionString: await resolveSecret(env.ADMIN_NEON_DB_URL),
      connectionTimeoutMillis: 10_000,
      statement_timeout:       120_000,
      query_timeout:           120_000,
    });
    await neonConn.connect();
    log.info("Connected to Neon.");

    try {
      // Ensure schema
      await neonConn.query(NEON_DDL);
      log.info("Schema ready.");

      // Sync each table — per-table error isolation
      for (const [tableName, config] of Object.entries(SYNC_TABLES)) {
        try {
          const count = await syncTable(env, neonConn, tableName, config, log);
          await logSync(neonConn, tableName, count, 'ok', null);
        } catch (err) {
          const msg = err.message;
          log.error(`  FAILED ${tableName}: ${msg}`);
          await logSync(neonConn, tableName, 0, 'error', msg || String(err));
          errors.push(`${tableName}: ${msg || err}`);
        }
      }
    } finally {
      await neonConn.end().catch(() => {});
      log.info("Neon connection closed.");
    }
  } catch (err) {
    log.error(`Fatal: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log.info(`=== Run complete in ${elapsed}s with ${errors.length} error(s) ===`);
  if (errors.length) {
    errors.forEach(e => log.error(`  - ${e}`));
    return { ok: false, errors };
  }
  log.info("All tables synced successfully");
  return { ok: true, duration_s: parseFloat(elapsed) };
}

// ── Supabase fetch helpers ──────────────────────────────────────────────────
async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  if (typeof val === 'string') return val
  return String(val)
}

async function fetchAllPages(env, tableName, columns, pageSize, log) {
  const baseUrl = (await resolveSecret(env.SUPABASE_URL)).replace(/\/$/, '')
  const svcKey  = await resolveSecret(env.SUPABASE_SERVICE_KEY)
  const colStr  = columns.join(',')
  const allRows = []
  let offset = 0

  while (true) {
    const url = `${baseUrl}/rest/v1/${tableName}?select=${encodeURIComponent(colStr)}&offset=${offset}&limit=${pageSize}`
    const res = await fetch(url, {
      headers: {
        apikey:        svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
    })
    if (!res.ok) {
      throw new Error(`Supabase fetch ${tableName} HTTP ${res.status}: ${await res.text()}`)
    }
    const rows = await res.json()
    allRows.push(...rows)
    offset += rows.length
    log.info(`  ${tableName}: fetched ${offset} rows so far...`)

    if (rows.length < pageSize) break
  }
  return allRows
}

// ── Aggregates ──────────────────────────────────────────────────────────────
function aggregateOrders(rawRows) {
  /** Monthly buckets. Never expose customer identity. */
  const buckets = new Map()

  for (const r of rawRows) {
    if (!r.created_at) continue
    const month   = String(r.created_at).slice(0, 7)  // YYYY-MM
    const status  = r.status        || 'Unknown'
    const pstatus = r.payment_status || 'Unknown'
    const key = `${month}|${status}|${pstatus}`

    let b = buckets.get(key)
    if (!b) {
      b = { month, status, payment_status: pstatus, order_count: 0, total_sales: 0, total_cgst: 0, total_sgst: 0, grand_total: 0 }
      buckets.set(key, b)
    }
    b.order_count += 1
    const sale = parseFloat(r.sale_cost   ?? 0)
    const cgst = parseFloat(r.cgst_total  ?? 0)
    const sgst = parseFloat(r.sgst_total  ?? 0)
    b.total_sales  = round2(b.total_sales + sale)
    b.total_cgst   = round2(b.total_cgst  + cgst)
    b.total_sgst   = round2(b.total_sgst  + sgst)
    b.grand_total  = round2(b.grand_total + sale + cgst + sgst)
  }
  return Array.from(buckets.values())
}

function aggregateQuotes(rawRows) {
  /** Monthly buckets. Never expose customer identity. */
  const buckets = new Map()

  for (const r of rawRows) {
    if (!r.date) continue
    const month  = String(r.date).slice(0, 7)
    const status = r.status || 'Unknown'
    const key = `${month}|${status}`

    let b = buckets.get(key)
    if (!b) {
      b = { month, status, quote_count: 0, total_value: 0, total_cgst: 0, total_sgst: 0, total_igst: 0, _vals: [] }
      buckets.set(key, b)
    }
    const val = parseFloat(r.grand_total ?? 0)
    b.quote_count += 1
    b.total_value = round2(b.total_value + val)
    b.total_cgst  = round2(b.total_cgst + parseFloat(r.cgst_amount ?? 0))
    b.total_sgst  = round2(b.total_sgst + parseFloat(r.sgst_amount ?? 0))
    b.total_igst  = round2(b.total_igst + parseFloat(r.igst_amount ?? 0))
    b._vals.push(val)
  }

  return Array.from(buckets.values()).map(b => {
    const vals = b._vals
    delete b._vals
    b.avg_quote_value = vals.length ? round2(vals.reduce((a, v) => a + v, 0) / vals.length) : 0
    return b
  })
}

function round2(n) { return Math.round(n * 100) / 100 }

// ── Neon upsert helpers ─────────────────────────────────────────────────────
async function upsertRows(conn, neonTable, rows, columns, primaryKey, log) {
  if (!rows.length) return 0
  const colNames = [...columns, 'synced_at']
  const colsStr  = colNames.join(', ')
  const phs      = colNames.map((_, i) => `$${i + 1}`).join(', ')
  const updateCols = columns.filter(c => c !== primaryKey)
  const updateStr  = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ') + ', synced_at = now()'
  const sql = `INSERT INTO ${neonTable} (${colsStr}) VALUES (${phs}) ON CONFLICT (${primaryKey}) DO UPDATE SET ${updateStr}`

  const now = new Date().toISOString()
  for (const row of rows) {
    const params = [...columns.map(c => row[c] ?? null), now]
    await conn.query(sql, params)
  }
  return rows.length
}

async function upsertSummary(conn, neonTable, rows, pkCols, log) {
  if (!rows.length) return 0
  const dataCols = Object.keys(rows[0])
  const allCols  = [...dataCols, 'synced_at']
  const colsStr  = allCols.join(', ')
  const phs      = allCols.map((_, i) => `$${i + 1}`).join(', ')
  const pkStr    = pkCols.join(', ')
  const updateCols = dataCols.filter(c => !pkCols.includes(c))
  const updateStr  = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ') + ', synced_at = now()'
  const sql = `INSERT INTO ${neonTable} (${colsStr}) VALUES (${phs}) ON CONFLICT (${pkStr}) DO UPDATE SET ${updateStr}`

  const now = new Date().toISOString()
  for (const row of rows) {
    const params = [...dataCols.map(c => row[c] ?? null), now]
    await conn.query(sql, params)
  }
  return rows.length
}

async function logSync(conn, tableName, rowsSynced, status = 'ok', errorMsg = null) {
  await conn.query(
    `INSERT INTO _sync_log (table_name, rows_synced, status, error_msg) VALUES ($1, $2, $3, $4)`,
    [tableName, rowsSynced, status, errorMsg]
  )
}

// ── Per-table sync ──────────────────────────────────────────────────────────
async function syncTable(env, conn, tableName, config, log) {
  const neonTable = config.neonTable
  const columns   = config.columns

  log.info(`Syncing ${tableName} -> ${neonTable}`)

  const rawRows = await fetchAllPages(env, tableName, columns, config.pageSize, log)
  log.info(`  ${tableName}: ${rawRows.length} raw rows fetched`)

  if (!rawRows.length) {
    log.info(`  ${tableName}: nothing to sync`)
    return 0
  }

  if (config.aggregate) {
    let agg, pkCols
    if (tableName === 'orders') {
      agg   = aggregateOrders(rawRows)
      pkCols = ['month', 'status', 'payment_status']
    } else if (tableName === 'quotes') {
      agg   = aggregateQuotes(rawRows)
      pkCols = ['month', 'status']
    } else {
      return 0
    }
    const count = await upsertSummary(conn, neonTable, agg, pkCols, log)
    log.info(`  ${tableName}: ${count} monthly buckets written to Neon`)
    return count
  }

  // Standard table sync
  const cleanRows = rawRows.map(row => {
    const clean = {}
    for (const c of columns) if (c in row) clean[c] = row[c]
    return clean
  })
  const count = await upsertRows(conn, neonTable, cleanRows, columns, config.primaryKey, log)
  log.info(`  ${tableName}: ${count} rows upserted`)
  return count
}

// ── Logger ─────────────────────────────────────────────────────────────────
function makeLogger(name) {
  const prefix = `[${name}]`
  return {
    info:  (msg) => console.log( `${new Date().toISOString()}  INFO   ${prefix}  ${msg}`),
    warn:  (msg) => console.warn(`${new Date().toISOString()}  WARN   ${prefix}  ${msg}`),
    error: (msg) => console.error(`${new Date().toISOString()}  ERROR  ${prefix}  ${msg}`),
  }
}