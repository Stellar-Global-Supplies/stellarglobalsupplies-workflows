/**
 * cur-forwarder — Cloudflare Worker
 *
 * Rewrite of .github/workflows/forward-cur.yml
 *
 * What it does:
 *   1. Downloads 5 pre-transformed CUR JSON files from Supabase Storage
 *      (bucket: stellar-assets / path: cur-forwarder/) that your existing
 *      automation (cur_processor.py) writes:
 *        costs.json, daily-costs.json, summary.json,
 *        costs-by-tag.json, costs-by-usage-group.json
 *   2. De-duplicates metrics using per-row SHA-256 fingerprints stored in
 *      Cloudflare KV (mirrors the Python cur-state.json / state branch pattern).
 *   3. Pushes new / revised metrics as gauges to the New Relic Metric API
 *      (namespace aws.cur.v2.*).
 *   4. Deletes the consumed JSON files from Supabase Storage after successful
 *      processing — files are consumed & cleaned up within each run.
 *
 * Triggers (wrangler.toml):
 *   • Cron: "0 *8 * * *"   (every 8 h, matching the GHA schedule)
 *   • HTTP GET /run          (manual trigger, equivalent to workflow_dispatch)
 *
 * Required bindings (wrangler.toml):
 *   [vars]
 *   NEW_RELIC_REGION = "eu"          # or "us"
 *
 *   [[kv_namespaces]]
 *   binding = "CUR_STATE_KV"         # KV namespace for dedup state
 *   id      = "<KV_NAMESPACE_ID>"
 *
 * Required secrets (Secrets Store — store_id 2556bcd9458349f6b4ff2a3fc93bdba1):
 *   NEW_RELIC_LICENSE_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

// ── Constants ──────────────────────────────────────────────────────────────
const BATCH_SIZE = 500;
const MAX_FP_PER_SOURCE = 20_000;
const SNAPSHOT_STALE_REFRESH_HOURS = 24;
const INTERVAL_MS = 86_400_000; // 1 day — all CUR metrics are daily

// CUR JSON file paths inside Supabase Storage (bucket: stellar-assets / path: cur-forwarder/)
const CUR_STORAGE_BUCKET = 'stellar-assets'
const CUR_STORAGE_PATH   = 'cur-forwarder'

const CUR_FILES = {
  costs: "costs.json",
  "daily-costs": "daily-costs.json",
  summary: "summary.json",
  "costs-by-tag": "costs-by-tag.json",
  "costs-by-usage-group": "costs-by-usage-group.json",
};

// ── Worker entry point ─────────────────────────────────────────────────────
export default {
  // Cron trigger (scheduled event)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runForwarder(env));
  },

  // HTTP trigger (manual dispatch via GET /run)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      ctx.waitUntil(runForwarder(env));
      return new Response(
        JSON.stringify({ ok: true, message: "CUR forwarder started" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("cur-forwarder worker\nPOST /run to trigger manually", {
      status: 200,
    });
  },
};

// ── Main orchestrator ──────────────────────────────────────────────────────
async function runForwarder(env) {
  const log = makeLogger("cur-forwarder");
  const nrUrl = newRelicMetricsUrl(env.NEW_RELIC_REGION || "eu");
  log.info(`New Relic endpoint: ${nrUrl}`);

  const runTsMs = Date.now(); // Snapshot-file timestamp (see Python note on 48h window)
  const state = await loadState(env.CUR_STATE_KV, "cur-state");
  const sourcesState = state.sources ?? {};

  const stats = {
    costs_metrics: 0,
    daily_metrics: 0,
    summary_metrics: 0,
    tags_metrics: 0,
    usage_group_metrics: 0,
    total_metrics: 0,
    skipped_unchanged: 0,
    updated_sources: 0,
  };

  // ── Time-series sources (per-row fingerprint dedup) ──────────────────────
  const timeseriesSources = [
    { name: "costs", file: CUR_FILES.costs, collect: collectCosts, stat: "costs_metrics" },
    {
      name: "daily-costs",
      file: CUR_FILES["daily-costs"],
      collect: collectDaily,
      stat: "daily_metrics",
      runTsMs,
    },
    {
      name: "costs-by-usage-group",
      file: CUR_FILES["costs-by-usage-group"],
      collect: collectUsageGroup,
      stat: "usage_group_metrics",
    },
  ];

  for (const src of timeseriesSources) {
    const data = await loadSupabaseJson(env, src.file, log);
    if (!data || (Array.isArray(data) ? data.length === 0 : Object.keys(data).length === 0)) {
      log.warn(`${src.name}: no data, skipping`);
      continue;
    }

    const srcState = sourcesState[src.name] ?? {};
    const sentPoints = srcState.sent_points ?? {};

    const allMetrics = src.collect(data, src.runTsMs ?? null);
    if (!allMetrics.length) {
      log.info(`${src.name}: collector produced no metrics`);
      continue;
    }

    const { toPush, updatedSentPoints } = filterNewOrRevised(allMetrics, sentPoints, log);

    if (!toPush.length) {
      log.info(`${src.name}: all ${allMetrics.length} points already sent and unchanged — skipping`);
      stats.skipped_unchanged++;
      continue;
    }

    await pushMetrics(toPush, nrUrl, env.NEW_RELIC_LICENSE_KEY, log);

    // Prune fingerprints to cap KV size
    const pruned = pruneFingerprints(updatedSentPoints, MAX_FP_PER_SOURCE);
    if (pruned > 0) log.info(`${src.name}: pruned ${pruned} stale fingerprints`);

    const now = new Date().toISOString();
    sourcesState[src.name] = {
      ...srcState,
      sent_points: updatedSentPoints,
      last_successful_push: now,
      metric_count: toPush.length,
      total_points_tracked: Object.keys(updatedSentPoints).length,
      source_file: src.file,
    };
    state.sources = sourcesState;
    state.updated_at = now;
    await saveState(env.CUR_STATE_KV, "cur-state", state);
    await deleteSupabaseJson(env, src.file, log);

    stats[src.stat] = toPush.length;
    stats.total_metrics += toPush.length;
    stats.updated_sources++;
  }

  // ── Snapshot sources (whole-file hash dedup) ─────────────────────────────
  const snapshotSources = [
    { name: "summary", file: CUR_FILES.summary, collect: (d) => collectSummary(d, runTsMs), stat: "summary_metrics" },
    {
      name: "costs-by-tag",
      file: CUR_FILES["costs-by-tag"],
      collect: (d) => collectTags(d, runTsMs),
      stat: "tags_metrics",
    },
  ];

  for (const src of snapshotSources) {
    const data = await loadSupabaseJson(env, src.file, log);
    if (!data || (Array.isArray(data) ? data.length === 0 : Object.keys(data).length === 0)) {
      log.warn(`${src.name}: no data, skipping`);
      continue;
    }

    const contentHash = await normaliseSnapshot(data);
    const srcState = sourcesState[src.name] ?? {};
    const previousHash = srcState.sha256;
    const lastPush = srcState.last_successful_push ?? null;
    const unchanged = contentHash === previousHash;
    const stale = isStale(lastPush, SNAPSHOT_STALE_REFRESH_HOURS);

    if (unchanged && !stale) {
      log.info(
        `${src.name}: costs unchanged (sha256=${contentHash.slice(0, 12)}) and last pushed ${lastPush} (< ${SNAPSHOT_STALE_REFRESH_HOURS}h ago) — skipping`
      );
      stats.skipped_unchanged++;
      continue;
    }

    if (unchanged && stale) {
      log.info(
        `${src.name}: costs unchanged but last push was ${lastPush || "never"} (> ${SNAPSHOT_STALE_REFRESH_HOURS}h ago) — refreshing`
      );
    }

    const metrics = src.collect(data);
    if (!metrics.length) {
      log.info(`${src.name}: collector produced no metrics`);
      continue;
    }

    await pushMetrics(metrics, nrUrl, env.NEW_RELIC_LICENSE_KEY, log);

    const now = new Date().toISOString();
    sourcesState[src.name] = {
      ...srcState,
      sha256: contentHash,
      last_successful_push: now,
      metric_count: metrics.length,
      source_file: src.file,
    };
    state.sources = sourcesState;
    state.updated_at = now;
    await saveState(env.CUR_STATE_KV, "cur-state", state);
    await deleteSupabaseJson(env, src.file, log);

    stats[src.stat] = metrics.length;
    stats.total_metrics += metrics.length;
    stats.updated_sources++;
  }

  log.info(`Run complete: ${JSON.stringify(stats)}`);
  return stats;
}

// ── Supabase Storage helpers ──────────────────────────────────────────────
async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  if (typeof val === 'string') return val
  return String(val)
}

async function storageBase(env) {
  const url = await resolveSecret(env.SUPABASE_URL)
  return `${url.replace(/\/$/, '')}/storage/v1`
}

async function storageKey(key) {
  return `${CUR_STORAGE_PATH}/${key}`
}

async function loadSupabaseJson(env, key, log) {
  try {
    const base  = await storageBase(env)
    const sKey  = storageKey(key)
    const url   = `${base}/object/public/${CUR_STORAGE_BUCKET}/${sKey}`
    const res   = await fetch(url)
    if (!res.ok) {
      log.warn(`Supabase Storage fetch failed: ${res.status} for ${sKey}`);
      return null;
    }
    const text = await res.text();
    return JSON.parse(text);
  } catch (err) {
    log.error(`Failed to load ${key} from Supabase Storage: ${err.message}`);
    return null;
  }
}

async function deleteSupabaseJson(env, key, log) {
  try {
    const base      = await storageBase(env)
    const sKey      = storageKey(key)
    const url       = `${base}/object/${CUR_STORAGE_BUCKET}/${sKey}`
    const svcKey    = await resolveSecret(env.SUPABASE_SERVICE_KEY)
    const res       = await fetch(url, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${svcKey}` },
    })
    if (!res.ok) {
      log.warn(`Delete failed ${res.status} for ${sKey}`)
      return false
    }
    log.info(`Deleted ${sKey} after successful processing`)
    return true
  } catch (err) {
    log.error(`Failed to delete ${key}: ${err.message}`)
    return false
  }
}

// ── KV state persistence ───────────────────────────────────────────────────
async function loadState(kv, key) {
  try {
    const raw = await kv.get(key, { type: "json" });
    return raw && typeof raw === "object" ? raw : { sources: {} };
  } catch {
    return { sources: {} };
  }
}

async function saveState(kv, key, state) {
  await kv.put(key, JSON.stringify(state));
}

// ── Deduplication ──────────────────────────────────────────────────────────
function filterNewOrRevised(metrics, sentPoints, log) {
  const toPush = [];
  const updatedSentPoints = { ...sentPoints };

  for (const m of metrics) {
    const attrs = m.attributes ?? {};
    const fpParts = {
      name: m.name,
      ts: m.timestamp,
      file: attrs.file ?? "",
      service: attrs.service ?? "",
      service_name: attrs.service_name ?? "",
      region: attrs.region ?? "",
      date: attrs.date ?? "",
      usage_group: attrs.usage_group ?? "",
      application: attrs.application ?? "",
    };
    const fp = stableHash(fpParts).slice(0, 20);
    const costH = costHash(m.value);

    if (updatedSentPoints[fp] === costH) continue;
    toPush.push(m);
    updatedSentPoints[fp] = costH;
  }

  const skipped = metrics.length - toPush.length;
  if (skipped > 0) {
    log.info(`  Dedup: ${skipped} unchanged points skipped, ${toPush.length} new/revised to push`);
  }
  return { toPush, updatedSentPoints };
}

function pruneFingerprints(sentPoints, maxFp) {
  const keys = Object.keys(sentPoints);
  if (keys.length <= maxFp) return 0;
  const toDrop = keys.slice(0, keys.length - maxFp);
  for (const k of toDrop) delete sentPoints[k];
  return toDrop.length;
}

// ── Hashing ────────────────────────────────────────────────────────────────
function stableHash(value) {
  // synchronous djb2 — deterministic for fingerprint equality checks
  const str = JSON.stringify(value, Object.keys(value).sort());
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash).toString(16).padStart(8, "0") + str.length.toString(16);
}

async function sha256Hex(value) {
  const str = JSON.stringify(value, null, 0);
  const buf = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function costHash(value) {
  // Stable short hash of a rounded cost — detects AWS retroactive revisions
  const rounded = Math.round(parseFloat(value) * 1e6) / 1e6;
  return stableHash({ v: rounded.toFixed(6) }).slice(0, 12);
}

async function normaliseSnapshot(data) {
  // Strip volatile fields before hashing so identical costs always produce the same hash
  const clean = Array.isArray(data)
    ? data.map((item) => {
        const c = { ...item };
        delete c.generatedAt;
        return c;
      })
    : (() => {
        const c = { ...data };
        delete c.generatedAt;
        delete c.updated_at;
        return c;
      })();
  return sha256Hex(clean);
}

function isStale(lastPushIso, hours) {
  if (!lastPushIso) return true;
  try {
    const last = new Date(lastPushIso);
    return (Date.now() - last.getTime()) > hours * 3_600_000;
  } catch {
    return true;
  }
}

// ── Metric builders ────────────────────────────────────────────────────────
function makeGauge(name, value, timestampMs, attrs) {
  return {
    name,
    type: "gauge",
    value: Math.round(parseFloat(value) * 1e8) / 1e8,
    timestamp: timestampMs,
    "interval.ms": INTERVAL_MS,
    attributes: Object.fromEntries(
      Object.entries(attrs).map(([k, v]) => [k, String(v)])
    ),
  };
}

// ── Collectors ─────────────────────────────────────────────────────────────

/** costs.json — granular daily cost per service per region */
function collectCosts(data) {
  const metrics = [];
  for (const row of data) {
    const ts = dateToTsMs(row.date);
    const attrs = {
      source: "cur",
      file: "costs",
      service: row.service,
      service_name: row.serviceName,
      region: row.region ?? "us-east-1",
      date: row.date,
    };
    metrics.push(makeGauge("aws.cur.v2.service.unblended_cost", row.totalCost, ts, attrs));
    metrics.push(makeGauge("aws.cur.v2.service.blended_cost", row.totalBlendedCost, ts, attrs));
    metrics.push(makeGauge("aws.cur.v2.service.usage_quantity", row.totalUsage, ts, attrs));
    metrics.push(makeGauge("aws.cur.v2.service.record_count", row.recordCount, ts, attrs));
  }
  return metrics;
}

/** daily-costs.json — daily total cost + per-service breakdown */
function collectDaily(data, runTsMs) {
  const metrics = [];
  const bpRaw = (data.billingPeriod?.start ?? "").replace(/[^0-9]/g, "").slice(0, 8);
  const billingPeriod =
    bpRaw.length >= 6 ? `${bpRaw.slice(0, 4)}-${bpRaw.slice(4, 6)}` : "unknown";

  for (const day of data.dailyCosts ?? []) {
    const ts = dateToTsMs(day.date);
    const dayAttrs = { source: "cur", file: "daily-costs", date: day.date, billing_period: billingPeriod };
    metrics.push(makeGauge("aws.cur.v2.daily.total_cost", day.totalCost, ts, dayAttrs));
    for (const svc of day.services ?? []) {
      metrics.push(
        makeGauge("aws.cur.v2.daily.service_cost", svc.cost, ts, {
          ...dayAttrs,
          service: svc.service,
          service_name: svc.serviceName,
        })
      );
    }
  }

  if (data.monthlyTotal) {
    metrics.push(
      makeGauge("aws.cur.v2.monthly.total_cost", data.monthlyTotal, runTsMs, {
        source: "cur",
        file: "daily-costs",
        billing_period: billingPeriod,
      })
    );
  }
  return metrics;
}

/** summary.json — monthly cost per service */
function collectSummary(data, runTsMs) {
  const metrics = [];
  for (const monthRow of data) {
    const month = monthRow.month;
    const monthAttrs = { source: "cur", file: "summary", billing_period: month };
    metrics.push(makeGauge("aws.cur.v2.summary.monthly_total", monthRow.totalCost, runTsMs, monthAttrs));
    for (const svc of monthRow.services ?? []) {
      metrics.push(
        makeGauge("aws.cur.v2.summary.service_cost", svc.cost, runTsMs, {
          ...monthAttrs,
          service: svc.service,
          service_name: svc.serviceName,
        })
      );
    }
  }
  return metrics;
}

/** costs-by-tag.json — cost breakdown by application tag + uncategorized */
function collectTags(data, runTsMs) {
  const metrics = [];
  const bpRaw = data.billingPeriod?.start ?? "";
  const billingPeriod = bpRaw.length >= 6 ? `${bpRaw.slice(0, 4)}-${bpRaw.slice(4, 6)}` : "unknown";
  const baseAttrs = { source: "cur", file: "costs-by-tag", billing_period: billingPeriod };

  for (const app of data.byApplication ?? []) {
    const appAttrs = { ...baseAttrs, application: app.application ?? "unknown", tagged: "true" };
    metrics.push(makeGauge("aws.cur.v2.tag.app_total_cost", app.totalCost ?? 0, runTsMs, appAttrs));
    for (const svc of app.services ?? []) {
      metrics.push(
        makeGauge("aws.cur.v2.tag.app_service_cost", svc.cost, runTsMs, {
          ...appAttrs,
          service: svc.service,
          service_name: svc.serviceName,
        })
      );
    }
  }

  const uncat = data.uncategorized ?? {};
  if (uncat && Object.keys(uncat).length) {
    const uncatAttrs = { ...baseAttrs, application: "uncategorized", tagged: "false" };
    metrics.push(makeGauge("aws.cur.v2.tag.uncategorized_total", uncat.totalCost ?? 0, runTsMs, uncatAttrs));
    for (const svc of uncat.services ?? []) {
      metrics.push(
        makeGauge("aws.cur.v2.tag.uncategorized_service", svc.cost, runTsMs, {
          ...uncatAttrs,
          service: svc.service,
          service_name: svc.serviceName,
        })
      );
    }
  }
  return metrics;
}

/** costs-by-usage-group.json — granular daily cost per service + usageGroup */
function collectUsageGroup(data) {
  const metrics = [];
  for (const row of data) {
    const ts = dateToTsMs(row.date);
    const attrs = {
      source: "cur",
      file: "costs-by-usage-group",
      service: row.service,
      service_name: row.serviceName,
      usage_group: row.usageGroup,
      region: row.region ?? "global",
      date: row.date,
    };
    metrics.push(makeGauge("aws.cur.v2.usage_group.cost", row.totalCost, ts, attrs));
    metrics.push(makeGauge("aws.cur.v2.usage_group.usage_quantity", row.usageAmount, ts, attrs));
    metrics.push(makeGauge("aws.cur.v2.usage_group.record_count", row.recordCount, ts, attrs));
  }
  return metrics;
}

// ── New Relic push ─────────────────────────────────────────────────────────
function buildPayload(metrics) {
  return [
    {
      common: {
        attributes: { forwarder: "cloudflare-worker-cur", data_type: "cur" },
        "interval.ms": INTERVAL_MS,
      },
      metrics,
    },
  ];
}

async function pushMetrics(metrics, nrUrl, licenseKey, log) {
  if (!metrics.length) {
    log.warn("No metrics to push");
    return;
  }

  let totalPushed = 0;
  for (let i = 0; i < metrics.length; i += BATCH_SIZE) {
    const batch = metrics.slice(i, i + BATCH_SIZE);
    const payload = buildPayload(batch);

    const resp = await fetch(nrUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": licenseKey,
      },
      body: JSON.stringify(payload),
    });

    const body = await resp.text();
    log.info(`NR Metrics HTTP ${resp.status} batch ${i}-${i + batch.length}: ${body.slice(0, 200)}`);

    if (resp.status !== 200 && resp.status !== 202) {
      throw new Error(`NR Metric API returned HTTP ${resp.status}: ${body}`);
    }
    totalPushed += batch.length;
  }

  log.info(`Total metrics pushed: ${totalPushed}`);
}

// ── Utilities ──────────────────────────────────────────────────────────────
function dateToTsMs(dateStr) {
  // 'YYYY-MM-DD' → Unix ms at noon UTC (avoids DST edge cases)
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.getTime();
}

function newRelicMetricsUrl(region) {
  return region.toLowerCase() === "eu"
    ? "https://metric-api.eu.newrelic.com/metric/v1"
    : "https://metric-api.newrelic.com/metric/v1";
}

function makeLogger(name) {
  const prefix = `[${name}]`;
  return {
    info: (msg) => console.log(`${new Date().toISOString()} ${prefix} INFO  ${msg}`),
    warn: (msg) => console.warn(`${new Date().toISOString()} ${prefix} WARN  ${msg}`),
    error: (msg) => console.error(`${new Date().toISOString()} ${prefix} ERROR ${msg}`),
  };
}