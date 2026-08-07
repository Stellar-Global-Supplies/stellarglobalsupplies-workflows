/**
 * s3-cleanup — Cloudflare Worker
 *
 * Rewrite of s3_cleanup_job/s3_cleanup.py (Lambda) as a Cloudflare Worker.
 *
 * Enforces per-bucket object-age retention policies and ships structured
 * JSON logs to New Relic Log API (EU endpoint).
 *
 * Uses the SAME bedrock_* secrets as the main worker for AWS access —
 * no separate AWS credentials needed.
 *
 * Triggers (wrangler.toml):
 *   • Cron : "0 2 * * *"   (daily at 02:00 UTC)
 *   • HTTP GET /run         (manual trigger / workflow_dispatch equivalent)
 *
 * Required secrets (Secrets Store — store_id 2556bcd9458349f6b4ff2a3fc93bdba1):
 *   BEDROCK_ACCESS_KEY_ID
 *   BEDROCK_SECRET_ACCESS_KEY
 *   BEDROCK_REGION
 *   NEW_RELIC_LICENSE_KEY
 */

// ── Constants ──────────────────────────────────────────────────────────────
const NR_LOG_URL_EU = "https://log-api.eu.newrelic.com/log/v1";

// ── Bucket policies (mirrors s3_cleanup.py BUCKET_POLICIES) ─────────────────
const BUCKET_POLICIES = [
  { bucket: "stellarglobal-cf-logs",                                         prefix: "AWSLogs/471112840461/CloudFront/", max_age_days: 7 },
  { bucket: "stellar-oms-invoices-production",                               prefix: "",                                 max_age_days: 7 },
  { bucket: "stellar-wf-prod-assets",                                        prefix: "",                                 max_age_days: 7, exclude_prefixes: ["blog-images/"] },
  { bucket: "stellar-global-prod-data-9856add5",                             prefix: "",                                 max_age_days: 2 },
  { bucket: "stellar-global-prod-attachments-20260627040526193400000001",    prefix: "",                                 max_age_days: 2 },
  { bucket: "stellarglobal-costing-bucket",                                  prefix: "awscost/",                       max_age_days: 2 },
  { bucket: "stellarglobal-costing-bucket",                                  prefix: "processed/",                       max_age_days: 2 },
  { bucket: "stellar-nr-cloudtrail-logs-471112840461-prod",                  prefix: "",                                 max_age_days: 1 },
];

// ── Worker entry point ─────────────────────────────────────────────────────
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  },

  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/run") {
      ctx.waitUntil(runCleanup(env));
      return new Response(
        JSON.stringify({ ok: true, message: "S3 cleanup started" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("s3-cleanup worker\nGET /run to trigger manually", { status: 200 });
  },
};

// ── Main orchestrator ──────────────────────────────────────────────────────
async function runCleanup(env) {
  const log   = makeLogger("s3-cleanup");
  const runId = crypto.randomUUID();
  const start = Date.now();
  log.info(`=== S3 Cleanup Starting  run_id=${runId} ===`);

  const nrKey = await resolveSecret(env.NEW_RELIC_LICENSE_KEY);
  if (!nrKey) {
    log.error("NEW_RELIC_LICENSE_KEY is not set. Aborting.");
    return { ok: false, error: "missing NEW_RELIC_LICENSE_KEY" };
  }

  const accessKey = await resolveSecret(env.BEDROCK_ACCESS_KEY_ID);
  const secretKey = await resolveSecret(env.BEDROCK_SECRET_ACCESS_KEY);
  const region    = await resolveSecret(env.BEDROCK_REGION) || "us-east-1";

  if (!accessKey || !secretKey) {
    log.error("AWS credentials not set (BEDROCK_ACCESS_KEY_ID / BEDROCK_SECRET_ACCESS_KEY). Aborting.");
    return { ok: false, error: "missing AWS credentials" };
  }

  const s3 = new S3Client(accessKey, secretKey, region);

  const bucketSummaries = [];
  const errors = [];

  for (const policy of BUCKET_POLICIES) {
    const label = policy.prefix ? `${policy.bucket}/${policy.prefix}` : policy.bucket;

    try {
      // ── Check if bucket exists ──────────────────────────────────────────
      const exists = await s3.bucketExists(policy.bucket);
      if (!exists) {
        log.warn(`Bucket '${policy.bucket}' does not exist or is inaccessible — skipping`);
        await emitLog(nrKey, "cleanup.bucket.skipped", runId, {
          bucket: policy.bucket,
          prefix: policy.prefix || "",
          reason: "bucket_not_found",
        });
        bucketSummaries.push({
          bucket: policy.bucket,
          prefix: policy.prefix,
          deleted_count: 0,
          deleted_size_bytes: 0,
          deleted_size_mb: 0.0,
          skipped: true,
        });
        continue;
      }

      // ── List expired objects ───────────────────────────────────────────
      const expired = await listExpiredObjects(s3, policy, log);
      log.info(`  ${label}: ${expired.length} expired object(s) found`);

      await emitLog(nrKey, "cleanup.bucket.scanned", runId, {
        bucket: policy.bucket,
        prefix: policy.prefix || "",
        max_age_days: policy.max_age_days,
        expired_count: expired.length,
      });

      if (!expired.length) {
        bucketSummaries.push({
          bucket: policy.bucket,
          prefix: policy.prefix,
          deleted_count: 0,
          deleted_size_bytes: 0,
          deleted_size_mb: 0.0,
        });
        continue;
      }

      // ── Delete expired objects ─────────────────────────────────────────
      const deletedCount = await deleteObjects(s3, policy.bucket, expired.map(o => o.key), log);
      const totalBytes   = expired.reduce((sum, o) => sum + o.size, 0);

      await emitLog(nrKey, "cleanup.bucket.completed", runId, {
        bucket: policy.bucket,
        prefix: policy.prefix || "",
        deleted_count: deletedCount,
        deleted_size_bytes: totalBytes,
        deleted_size_mb: round2(totalBytes / 1024 / 1024),
      });

      bucketSummaries.push({
        bucket: policy.bucket,
        prefix: policy.prefix,
        deleted_count: deletedCount,
        deleted_size_bytes: totalBytes,
        deleted_size_mb: round2(totalBytes / 1024 / 1024),
      });
    } catch (err) {
      const msg = err.message;
      log.error(`  ${label}: FAILED — ${msg}`);
      errors.push(`${label}: ${msg}`);
      await emitLog(nrKey, "cleanup.bucket.failed", runId, {
        bucket: policy.bucket,
        prefix: policy.prefix || "",
        error: msg,
      });
      bucketSummaries.push({
        bucket: policy.bucket,
        prefix: policy.prefix,
        deleted_count: 0,
        deleted_size_bytes: 0,
        deleted_size_mb: 0.0,
        error: msg,
      });
    }
  }

  const durationMs = Date.now() - start;
  const totalDeleted = bucketSummaries.reduce((s, b) => s + b.deleted_count, 0);
  const totalSizeBytes = bucketSummaries.reduce((s, b) => s + b.deleted_size_bytes, 0);

  await emitLog(nrKey, "cleanup.run.completed", runId, {
    duration_ms: durationMs,
    total_deleted: totalDeleted,
    total_size_bytes: totalSizeBytes,
    total_size_mb: round2(totalSizeBytes / 1024 / 1024),
    buckets_processed: bucketSummaries.length,
  });

  log.info(`=== Run complete in ${durationMs}ms  total_deleted=${totalDeleted}  errors=${errors.length} ===`);
  if (errors.length) {
    errors.forEach(e => log.error(`  - ${e}`));
    return { ok: false, errors, summaries: bucketSummaries };
  }
  log.info("All buckets processed successfully");
  return { ok: true, summaries: bucketSummaries, total_deleted: totalDeleted };
}

// ── S3 helpers ─────────────────────────────────────────────────────────────

async function resolveSecret(val) {
  if (!val) return undefined;
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get();
  if (typeof val === 'string') return val;
  return String(val);
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * List all expired objects for a bucket policy.
 * Mirrors _list_expired_objects from s3_cleanup.py.
 */
async function listExpiredObjects(s3, policy, log) {
  const expired = [];
  const now = new Date();
  let continuationToken = null;

  while (true) {
    const { objects, isTruncated, nextToken } = await s3.listObjects(
      policy.bucket,
      policy.prefix,
      continuationToken
    );

    for (const obj of objects) {
      const key = obj.Key || "";

      // Exclude prefixes (e.g. blog-images/)
      if (policy.exclude_prefixes && policy.exclude_prefixes.some(ex => key.startsWith(ex))) {
        continue;
      }

      const lastModified = new Date(obj.LastModified);
      const ageDays = (now - lastModified) / (1000 * 60 * 60 * 24);

      if (ageDays >= policy.max_age_days) {
        expired.push({
          key: key,
          size: obj.Size || 0,
          last_modified: lastModified.toISOString(),
          age_days: Math.floor(ageDays),
        });
      }
    }

    if (!isTruncated) break;
    continuationToken = nextToken;
  }

  return expired;
}

/**
 * Batch-delete objects (max 1000 per S3 request).
 * Mirrors _delete_objects from s3_cleanup.py.
 */
async function deleteObjects(s3, bucket, keys, log) {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const count = await s3.deleteObjects(bucket, chunk);
    deleted += count;
  }
  return deleted;
}

// ── New Relic log shipping ─────────────────────────────────────────────────
async function emitLog(licenseKey, event, runId, details) {
  const payload = [{
    timestamp: Date.now(),
    message:   `s3-cleanup: ${event}`,
    attributes: {
      "service.name": "s3-cleanup",
      logtype:        "s3_cleanup_run",
      event,
      run_id:         runId,
      ...details,
    },
  }];

  try {
    const resp = await fetch(NR_LOG_URL_EU, {
      method:  "POST",
      headers: { "Api-Key": licenseKey, "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error(`[s3-cleanup] NR log ship failed: HTTP ${resp.status}`);
    }
  } catch (err) {
    console.error(`[s3-cleanup] NR log ship error: ${err.message}`);
  }
}

// ── S3 Client (SigV4 via pure fetch + Web Crypto) ──────────────────────────
class S3Client {
  constructor(accessKeyId, secretAccessKey, region) {
    this.accessKeyId     = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region          = region;
    this.endpoint        = `https://s3.${region}.amazonaws.com`;
  }

  /**
   * Check if a bucket exists via HeadBucket.
   * Returns true if the bucket exists and is accessible, false otherwise.
   */
  async bucketExists(bucket) {
    const url = `${this.endpoint}/${encodeURIComponent(bucket)}`;
    const headers = await this._sign("HEAD", url, "", "s3", this.region);
    const res = await fetch(url, { method: "HEAD", headers });

    // 200 = exists, 404 = not found, 403 = access denied (may still exist)
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    if (res.status === 403) {
      // Bucket may exist but we don't have access — treat as skip
      console.warn(`[s3-cleanup] Bucket '${bucket}' returned 403 (access denied) — skipping`);
      return false;
    }
    // Other errors — treat as not accessible
    console.warn(`[s3-cleanup] Bucket '${bucket}' returned HTTP ${res.status} — skipping`);
    return false;
  }

  /**
   * List objects v2 with pagination.
   */
  async listObjects(bucket, prefix, continuationToken) {
    const url = new URL(`${this.endpoint}/${encodeURIComponent(bucket)}`);
    url.searchParams.set("list-type", "2");
    if (prefix) url.searchParams.set("prefix", prefix);
    url.searchParams.set("max-keys", "1000");
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);

    const headers = await this._sign("GET", url.toString(), "", "s3", this.region);
    const res = await fetch(url.toString(), { method: "GET", headers });

    if (!res.ok) {
      throw new Error(`S3 ListObjectsV2 ${bucket} HTTP ${res.status}: ${await res.text()}`);
    }

    const text = await res.text();
    const data = parseXml(text);

    const objects = (data.Contents || []).map(obj => ({
      Key:          obj.Key?.[0] || "",
      Size:         parseInt(obj.Size?.[0] || "0", 10),
      LastModified: obj.LastModified?.[0] || "",
    }));

    const isTruncated = data.IsTruncated?.[0] === "true";
    const nextToken = data.NextContinuationToken?.[0] || null;

    return { objects, isTruncated, nextToken };
  }

  /**
   * Batch delete up to 1000 objects.
   */
  async deleteObjects(bucket, keys) {
    if (!keys.length) return 0;

    const url = `${this.endpoint}/${encodeURIComponent(bucket)}/?delete`;

    // Build XML body
    const xml = keys.map(k =>
      `<Object><Key>${escapeXml(k)}</Key></Object>`
    ).join("");
    const body = `<?xml version="1.0" encoding="UTF-8"?><Delete>${xml}</Delete>`;

    const headers = await this._sign("POST", url, body, "s3", this.region);
    headers["Content-Type"] = "application/xml";

    const res = await fetch(url, { method: "POST", headers, body });

    if (!res.ok) {
      throw new Error(`S3 DeleteObjects ${bucket} HTTP ${res.status}: ${await res.text()}`);
    }

    const text = await res.text();
    const data = parseXml(text);
    return (data.Deleted || []).length;
  }

  // ── SigV4 signing ────────────────────────────────────────────────────────
  async _sign(method, url, body, service, region) {
    const u = new URL(url);
    const now = new Date();
    const amzDate = formatAmzDate(now);
    const dateStamp = formatDateStamp(now);

    const bodyHash = await sha256Hex(body || "");

    // Canonical headers
    const canonicalHeaders = [
      `host:${u.host}`,
      `x-amz-content-sha256:${bodyHash}`,
      `x-amz-date:${amzDate}`,
    ].join("\n") + "\n";

    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

    // Canonical URI — S3 uses path-style
    const canonicalUri = u.pathname;

    // Canonical query string
    const canonicalQuery = u.search.slice(1);

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join("\n");

    const signingKey = await getSigningKey(this.secretAccessKey, dateStamp, region, service);
    const signature = await hmacHex(signingKey, stringToSign);

    return {
      "Content-Type":         "application/xml",
      "x-amz-content-sha256": bodyHash,
      "x-amz-date":           amzDate,
      Authorization:          `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }
}

// ── SigV4 crypto helpers (same approach as workers/src/lib/bedrock.js) ────
async function getSigningKey(secret, date, region, service) {
  const kDate    = await hmacRaw(`AWS4${secret}`, date);
  const kRegion  = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  return hmacRaw(kService, "aws4_request");
}

async function hmacRaw(key, data) {
  const k = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function hmacHex(key, data) {
  return toHex(await hmacRaw(key, data));
}

async function sha256Hex(data) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)));
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function formatAmzDate(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function formatDateStamp(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// ── Minimal XML parser (no external deps) ──────────────────────────────────
function parseXml(xml) {
  const result = {};
  const tagRegex = /<(\/?)(\w+)[^>]*?(\/?)>/g;
  let match;
  const stack = [result];

  while ((match = tagRegex.exec(xml)) !== null) {
    const isClosing = match[1] === "/";
    const tagName = match[2];
    const isSelfClosing = match[3] === "/";

    if (isClosing) {
      if (stack.length > 1) stack.pop();
    } else if (isSelfClosing) {
      // Self-closing tag — skip
    } else {
      const parent = stack[stack.length - 1];
      if (!parent[tagName]) parent[tagName] = [];
      const child = {};
      parent[tagName].push(child);
      stack.push(child);
    }
  }

  // Extract text content for leaf nodes
  const textRegex = />([^<]+)</g;
  while ((match = textRegex.exec(xml)) !== null) {
    const text = match[1].trim();
    if (text) {
      // Find the most recent open tag
      const tagMatch = xml.slice(0, match.index).match(/<(\w+)[^>]*>$/);
      if (tagMatch) {
        const tagName = tagMatch[1];
        const parent = stack[stack.length - 1];
        if (parent[tagName]) {
          parent[tagName][parent[tagName].length - 1] = text;
        }
      }
    }
  }

  return result;
}

function escapeXml(str) {
  const amp = String.fromCharCode(38);
  const map = {
    '&': amp + 'amp;',
    '<': amp + 'lt;',
    '>': amp + 'gt;',
    '"': amp + 'quot;',
    "'": amp + 'apos;',
  };
  return str.replace(/[&<>"']/g, (c) => map[c]);
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