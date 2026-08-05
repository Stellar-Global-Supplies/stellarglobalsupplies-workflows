/**
 * postgres-forwarder — Cloudflare Worker
 *
 * Collects pg_stat_* metrics from BOTH Supabase and NeonDB and ships them
 * to New Relic EU as separate namespaces:
 *   supabase.*   — metrics from Supabase Postgres
 *   neon.*       — metrics from NeonDB Postgres
 *
 * Each database has its own independent KV dedup state so a change in one
 * does not force a re-push of the other.
 *
 * Both databases are queried in parallel; a failure in one does not abort
 * the other — the run log reports per-source outcomes.
 *
 * Triggers (wrangler.toml):
 *   • Cron : "0 * * * *"   (every hour)
 *   • HTTP GET /run         (manual trigger / workflow_dispatch equivalent)
 *   • HTTP GET /run/supabase  (trigger only Supabase collection)
 *   • HTTP GET /run/neon      (trigger only Neon collection)
 *
 * ── Postgres connection options (per database) ─────────────────────────────
 *
 *   Supabase — connection string is built automatically from SUPABASE_URL +
 *   SUPABASE_SERVICE_KEY (already in Secrets Store) — no separate
 *   SUPABASE_DB_URL secret needed.
 *
 *   Neon — Cloudflare Hyperdrive (recommended):
 *     Creates a pooled connection; lowest latency for cron workers.
 *     wrangler hyperdrive create neon-db --connection-string="postgres://..."
 *     Then set bindings in wrangler.toml.
 *   OR — Direct connection string via secret:
 *     wrangler secret put ADMIN_NEON_DB_URL
 *     No extra bindings needed.
 *
 * ── Required bindings (wrangler.toml) ─────────────────────────────────────
 *   [[kv_namespaces]]
 *   binding = "PG_STATE_KV"          # shared KV — state keyed per source
 *
 *   # Option A (Neon):
 *   [[hyperdrive]]
 *   binding = "NEON_DB"
 *   id      = "<HYPERDRIVE_CONFIG_ID>"
 *
 * ── Required secrets ───────────────────────────────────────────────────────
 *   NEW_RELIC_LICENSE_KEY   (always required)
 *   SUPABASE_URL            (Supabase — project URL)
 *   SUPABASE_SERVICE_KEY    (Supabase — service role key, used as DB password)
 *   ADMIN_NEON_DB_URL       (Neon — connection string)
 */

import { Client } from "pg";

// Helper to resolve Cloudflare secrets (handles both string and secret objects)
async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  if (typeof val === 'string') return val
  return String(val)
}

/**
 * Build a Supabase Postgres connection string from SUPABASE_URL + SUPABASE_SERVICE_KEY.
 * Supabase URL format: https://<project-ref>.supabase.co
 * Connection string:   postgresql://postgres.<ref>:<service-key>@<ref>.pooler.supabase.com:5432/postgres
 */
async function buildSupabaseConnectionString(env) {
  const url = await resolveSecret(env.SUPABASE_URL)
  const key = await resolveSecret(env.SUPABASE_SERVICE_KEY)
  if (!url || !key) return null

  const ref = url.replace(/^https?:\/\//, '').split('.')[0]
  if (!ref) return null

  return `postgresql://postgres.${ref}:${encodeURIComponent(key)}@pooler.${ref}.supabase.com:6543/postgres`
}

// ── Constants ──────────────────────────────────────────────────────────────
const METRIC_BATCH_SIZE  = 2_000;
const INTERVAL_MS_1H     = 3_600_000;
const NR_METRIC_URL_EU   = "https://metric-api.eu.newrelic.com/metric/v1";
const NR_LOG_URL_EU      = "https://log-api.eu.newrelic.com/log/v1";

// KV state keys — one per database so dedup is fully independent
const KV_KEY_SUPABASE = "supabase-state";
const KV_KEY_NEON     = "neon-state";

// ── Worker entry point ─────────────────────────────────────────────────────
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runForwarder(env, "all"));
  },

  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    const routeMap = {
      "/run":          "all",
      "/run/supabase": "supabase",
      "/run/neon":     "neon",
    };

    const target = routeMap[pathname];
    if (target) {
      ctx.waitUntil(runForwarder(env, target));
      return new Response(
        JSON.stringify({ ok: true, message: `postgres-forwarder started (target=${target})` }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      [
        "postgres-forwarder worker",
        "GET /run           — run both Supabase + Neon",
        "GET /run/supabase  — run Supabase only",
        "GET /run/neon      — run Neon only",
      ].join("\n"),
      { status: 200 }
    );
  },
};

// ── Main orchestrator ──────────────────────────────────────────────────────
async function runForwarder(env, target = "all") {
  const log   = makeLogger("postgres-forwarder");
  const runTs = new Date().toISOString();
  const start = Date.now();
  log.info(`=== Postgres → New Relic  target=${target}  run_at=${runTs} ===`);

  const nrKey = await resolveSecret(env.NEW_RELIC_LICENSE_KEY);
  if (!nrKey) {
    log.error("NEW_RELIC_LICENSE_KEY is not set. Aborting.");
    return { statusCode: 1, error: "missing NEW_RELIC_LICENSE_KEY" };
  }

  // ── Build the list of databases to collect from ────────────────────────
  const sources = await buildSources(env, target, log);
  if (!sources.length) {
    log.error("No database sources configured for the requested target. Aborting.");
    return { statusCode: 1, error: "no sources configured" };
  }

  // ── Collect from all sources in parallel ──────────────────────────────
  const collectionResults = await Promise.allSettled(
    sources.map((src) => collectSource(src, env, log))
  );

  // ── Per-source: dedup → ship ──────────────────────────────────────────
  const runSummaries = [];
  let totalSent = 0;

  for (let i = 0; i < sources.length; i++) {
    const src    = sources[i];
    const result = collectionResults[i];
    const srcLog = makeLogger(src.name);

    if (result.status === "rejected") {
      srcLog.error(`Collection failed: ${result.reason?.message ?? result.reason}`);
      runSummaries.push({ source: src.name, statusCode: 1, error: String(result.reason) });
      continue;
    }

    const metrics = result.value;
    srcLog.info(`${metrics.length} metric(s) collected`);

    if (!metrics.length) {
      srcLog.warn("No metrics — nothing to ship.");
      runSummaries.push({ source: src.name, statusCode: 0, sent: 0, skipped: false });
      continue;
    }

    // ── Dedup ────────────────────────────────────────────────────────────
    const fingerprint = await metricsFingerprint(metrics);
    const state       = await loadState(env.PG_STATE_KV, src.kvKey);
    const prevHash    = state.sha256;

    if (prevHash === fingerprint) {
      srcLog.info(`Metrics unchanged (sha256=${fingerprint.slice(0, 12)}) — skipping ingest`);
      runSummaries.push({ source: src.name, statusCode: 0, sent: 0, skipped: true });
      continue;
    }

    // ── Ship ─────────────────────────────────────────────────────────────
    const summary = await shipMetrics(metrics, src.serviceName, nrKey, srcLog);

    if (summary.failed > 0) {
      srcLog.error(`${summary.failed} metric(s) failed — state not advanced for ${src.name}`);
      runSummaries.push({ source: src.name, statusCode: 1, ...summary, skipped: false });
      continue;
    }

    totalSent += summary.sent;

    // ── Persist state ─────────────────────────────────────────────────────
    await saveState(env.PG_STATE_KV, src.kvKey, {
      sha256:               fingerprint,
      last_successful_push: runTs,
      metric_count:         metrics.length,
      sent:                 summary.sent,
      failed:               summary.failed,
      batches:              summary.batches,
    });

    runSummaries.push({ source: src.name, statusCode: 0, ...summary, skipped: false });
  }

  // ── Ship combined run log ─────────────────────────────────────────────
  const elapsed = (Date.now() - start) / 1000;
  await shipRunLog(
    {
      target,
      run_at:      runTs,
      duration_s:  elapsed,
      total_sent:  totalSent,
      sources:     runSummaries,
    },
    nrKey,
    log
  );

  log.info(`=== Run complete in ${elapsed.toFixed(2)}s  total_sent=${totalSent} ===`);
  return { statusCode: 0, summaries: runSummaries };
}

// ── Source registry ────────────────────────────────────────────────────────
/**
 * Builds the list of database sources to collect from.
 * Each source carries everything needed: connection config, metric namespace,
 * NR service.name tag, and its own KV state key.
 */
async function buildSources(env, target, log) {
  // Build Supabase connection string from existing secrets (async)
  const supabaseConn = env.SUPABASE_DB
    ? env.SUPABASE_DB.connectionString
    : await buildSupabaseConnectionString(env)

  const all = [
    {
      name:        "supabase",
      kvKey:       KV_KEY_SUPABASE,
      namespace:   "supabase",          // metric name prefix  e.g. supabase.db.size_bytes
      serviceName: "supabase-monitor",  // NR service.name attribute
      connectionString: supabaseConn,
    },
    {
      name:        "neon",
      kvKey:       KV_KEY_NEON,
      namespace:   "neon",              // metric name prefix  e.g. neon.db.size_bytes
      serviceName: "neon-monitor",      // NR service.name attribute
      connectionString: env.NEON_DB
        ? env.NEON_DB.connectionString
        : await resolveSecret(env.ADMIN_NEON_DB_URL),
    },
  ];

  return all.filter((src) => {
    // Filter by target
    if (target !== "all" && src.name !== target) return false;

    // Skip if no connection string available
    if (!src.connectionString) {
      log.warn(
        `${src.name}: no connection string found ` +
        `(set SUPABASE_URL + SUPABASE_SERVICE_KEY, or ADMIN_NEON_DB_URL / NEON_DB Hyperdrive) — skipping`
      );
      return false;
    }

    return true;
  });
}

// ── Postgres collection ────────────────────────────────────────────────────
async function collectSource(src, _env, log) {
  const srcLog = makeLogger(src.name);
  srcLog.info(`Connecting to ${src.name} Postgres…`);

  const client = new Client({
    connectionString: src.connectionString,
    connectionTimeoutMillis: 10_000,
    statement_timeout:       30_000,
    query_timeout:           30_000,
  });

  await client.connect();
  srcLog.info("Connected.");

  try {
    return await runCollectors(client, src.namespace, srcLog);
  } finally {
    await client.end().catch(() => {});
    srcLog.info("Connection closed.");
  }
}

/**
 * Runs all pg_stat_* collectors against an open client.
 * `namespace` is the metric name prefix ("supabase" or "neon").
 */
async function runCollectors(client, namespace, log) {
  const collectors = [
    ["db_size",     collectDbSize],
    ["connections", collectConnections],
    ["table_stats", collectTableStats],
    ["bgwriter",    collectBgwriter],
    ["statements",  collectStatements],
  ];

  const allMetrics = [];
  for (const [name, fn] of collectors) {
    try {
      const result = await fn(client, namespace);
      log.info(`  ${name.padEnd(15)} → ${result.length} metric(s)`);
      allMetrics.push(...result);
    } catch (err) {
      log.error(`  Collector '${name}' failed: ${err.message}`);
    }
  }
  return allMetrics;
}

// ── Individual collectors ──────────────────────────────────────────────────
// Each collector now accepts `namespace` so the same code produces
// "supabase.db.size_bytes" for Supabase and "neon.db.size_bytes" for Neon.

async function collectDbSize(client, ns) {
  const { rows } = await client.query(`
    SELECT
      pg_database_size(current_database()) AS size_bytes,
      current_database()                   AS db_name
  `);
  if (!rows.length) return [];
  return [gauge(`${ns}.db.size_bytes`, rows[0].size_bytes, { db_name: rows[0].db_name, source: ns })];
}

async function collectConnections(client, ns) {
  const { rows } = await client.query(`
    SELECT state, COUNT(*) AS count
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY state
  `);

  const stateMap = {
    "active":                          "active",
    "idle":                            "idle",
    "idle in transaction":             "idle_in_transaction",
    "idle in transaction (aborted)":   "idle_in_transaction_aborted",
  };

  const totals = {};
  for (const row of rows) {
    const label = stateMap[row.state] ?? (row.state === null ? "unknown" : "other");
    totals[label] = (totals[label] ?? 0) + Number(row.count);
  }

  const total   = Object.values(totals).reduce((a, b) => a + b, 0);
  const metrics = [gauge(`${ns}.connections.total`, total, { source: ns })];
  for (const [state, cnt] of Object.entries(totals)) {
    metrics.push(gauge(`${ns}.connections.by_state`, cnt, { state, source: ns }));
  }
  return metrics;
}

async function collectTableStats(client, ns) {
  const { rows } = await client.query(`
    SELECT
      schemaname,
      relname                                  AS table_name,
      n_live_tup                               AS live_rows,
      n_dead_tup                               AS dead_rows,
      n_tup_ins                                AS rows_inserted,
      n_tup_upd                                AS rows_updated,
      n_tup_del                                AS rows_deleted,
      seq_scan,
      idx_scan,
      pg_total_relation_size(relid)            AS total_size_bytes
    FROM pg_stat_user_tables
    ORDER BY n_live_tup DESC
  `);

  const metrics = [];
  for (const row of rows) {
    const attrs = { schema: row.schemaname, table_name: row.table_name, source: ns };
    metrics.push(
      gauge(`${ns}.table.live_rows`,        row.live_rows,        attrs),
      gauge(`${ns}.table.dead_rows`,        row.dead_rows,        attrs),
      count(`${ns}.table.rows_inserted`,    row.rows_inserted,    attrs),
      count(`${ns}.table.rows_updated`,     row.rows_updated,     attrs),
      count(`${ns}.table.rows_deleted`,     row.rows_deleted,     attrs),
      count(`${ns}.table.seq_scans`,        row.seq_scan,         attrs),
      count(`${ns}.table.idx_scans`,        row.idx_scan ?? 0,    attrs),
      gauge(`${ns}.table.total_size_bytes`, row.total_size_bytes, attrs)
    );
  }
  return metrics;
}

async function collectBgwriter(client, ns) {
  const { rows } = await client.query(`
    SELECT
      checkpoints_timed,
      checkpoints_req,
      buffers_checkpoint,
      buffers_clean,
      buffers_backend,
      buffers_alloc
    FROM pg_stat_bgwriter
  `);
  if (!rows.length) return [];
  const row = rows[0];
  const attrs = { source: ns };
  return [
    count(`${ns}.bgwriter.checkpoints_timed`,  row.checkpoints_timed,  attrs),
    count(`${ns}.bgwriter.checkpoints_req`,    row.checkpoints_req,    attrs),
    count(`${ns}.bgwriter.buffers_checkpoint`, row.buffers_checkpoint, attrs),
    count(`${ns}.bgwriter.buffers_clean`,      row.buffers_clean,      attrs),
    count(`${ns}.bgwriter.buffers_backend`,    row.buffers_backend,    attrs),
    count(`${ns}.bgwriter.buffers_alloc`,      row.buffers_alloc,      attrs),
  ];
}

async function collectStatements(client, ns) {
  let rows;
  try {
    ({ rows } = await client.query(`
      SELECT
        query,
        calls,
        total_exec_time,
        mean_exec_time,
        rows,
        shared_blks_hit,
        shared_blks_read
      FROM pg_stat_statements
      WHERE query NOT LIKE '%pg_stat%'
      ORDER BY mean_exec_time DESC
      LIMIT 20
    `));
  } catch (err) {
    // pg_stat_statements extension may not be installed — soft-skip
    console.warn(`[${ns}] pg_stat_statements not available: ${err.message}`);
    return [];
  }

  const metrics = [];
  for (const row of rows) {
    const queryLabel = (row.query ?? "").slice(0, 200).replace(/\n/g, " ");
    const attrs = { query: queryLabel, source: ns };
    metrics.push(
      gauge(`${ns}.statements.mean_exec_time_ms`, row.mean_exec_time,     attrs),
      count(`${ns}.statements.calls`,             row.calls,              attrs),
      count(`${ns}.statements.rows`,              row.rows,               attrs),
      count(`${ns}.statements.blks_hit`,          row.shared_blks_hit,    attrs),
      count(`${ns}.statements.blks_read`,         row.shared_blks_read,   attrs)
    );
  }
  return metrics;
}

// ── Metric builders ────────────────────────────────────────────────────────
function nowMs() { return Date.now(); }

function gauge(name, value, attributes = {}) {
  return {
    name,
    type:       "gauge",
    value:      value !== null && value !== undefined ? parseFloat(value) : 0,
    timestamp:  nowMs(),
    attributes,
  };
}

function count(name, value, attributes = {}) {
  return {
    name,
    type:          "count",
    value:         value !== null && value !== undefined ? parseFloat(value) : 0,
    "interval.ms": INTERVAL_MS_1H,
    timestamp:     nowMs(),
    attributes,
  };
}

// ── Fingerprint / dedup ────────────────────────────────────────────────────
async function metricsFingerprint(metrics) {
  const fingerprintable = metrics.map((m) => ({
    name:          m.name,
    type:          m.type,
    value:         m.value,
    "interval.ms": m["interval.ms"],
    attributes:    m.attributes,
  }));
  return sha256Hex(fingerprintable);
}

async function sha256Hex(value) {
  const str    = JSON.stringify(value, null, 0);
  const buf    = new TextEncoder().encode(str);
  const hBuf   = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── KV state persistence ───────────────────────────────────────────────────
async function loadState(kv, key) {
  try {
    const raw = await kv.get(key, { type: "json" });
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

async function saveState(kv, key, state) {
  await kv.put(key, JSON.stringify(state));
}

// ── New Relic shipping ─────────────────────────────────────────────────────
async function shipMetrics(metrics, serviceName, licenseKey, log) {
  // Inject common attributes — serviceName differs per source so NR can
  // filter "supabase-monitor" vs "neon-monitor" independently.
  const commonAttrs = {
    "service.name": serviceName,
    collector:      "postgres-forwarder-worker",
  };
  for (const m of metrics) {
    m.attributes = { ...commonAttrs, ...m.attributes };
  }

  let sent = 0, failed = 0, batches = 0;

  for (let i = 0; i < metrics.length; i += METRIC_BATCH_SIZE) {
    const batch = metrics.slice(i, i + METRIC_BATCH_SIZE);
    batches++;
    const payload = [{ metrics: batch }];

    try {
      const resp = await fetchWithRetry(
        NR_METRIC_URL_EU,
        {
          method:  "POST",
          headers: { "Api-Key": licenseKey, "Content-Type": "application/json" },
          body:    JSON.stringify(payload),
        },
        3
      );

      if (resp.ok) {
        sent += batch.length;
        log.info(`Metric batch ${batches} accepted (HTTP ${resp.status})`);
      } else {
        failed += batch.length;
        const body = await resp.text();
        log.error(`Metric batch ${batches} HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }
    } catch (err) {
      failed += batch.length;
      log.error(`Metric batch ${batches} request error: ${err.message}`);
    }
  }

  log.info(`Metrics — sent=${sent}  failed=${failed}  batches=${batches}`);
  return { sent, failed, batches };
}

async function shipRunLog(runSummary, licenseKey, log) {
  const payload = [{
    timestamp:  Date.now(),
    message:    `postgres-forwarder run completed — total_sent=${runSummary.total_sent ?? 0}`,
    attributes: {
      "service.name": "postgres-forwarder",
      logtype:        "postgres_forwarder_run",
      ...runSummary,
      // Flatten sources array into a JSON string for NR attribute compatibility
      sources: JSON.stringify(runSummary.sources ?? []),
    },
  }];

  try {
    const resp = await fetch(NR_LOG_URL_EU, {
      method:  "POST",
      headers: { "Api-Key": licenseKey, "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    if (resp.ok) {
      log.info(`Run log shipped (HTTP ${resp.status})`);
    } else {
      log.error(`Failed to ship run log: HTTP ${resp.status}`);
    }
  } catch (err) {
    log.error(`Failed to ship run log: ${err.message}`);
  }
}

// ── HTTP with retry ────────────────────────────────────────────────────────
async function fetchWithRetry(url, options, maxRetries) {
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const resp = await fetch(url, options);
      if (!RETRYABLE.has(resp.status)) return resp;
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Logger ─────────────────────────────────────────────────────────────────
function makeLogger(name) {
  const prefix = `[${name}]`;
  return {
    info:  (msg) => console.log( `${new Date().toISOString()}  INFO   ${prefix}  ${msg}`),
    warn:  (msg) => console.warn(`${new Date().toISOString()}  WARN   ${prefix}  ${msg}`),
    error: (msg) => console.error(`${new Date().toISOString()}  ERROR  ${prefix}  ${msg}`),
  };
}