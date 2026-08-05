/**
 * cur-forwarder — Cloudflare Worker
 *
 * Self-contained CUR pipeline. No longer depends on cur_processor.py uploading
 * pre-processed JSON files. The worker does everything end-to-end:
 *
 *   1. Finds the latest CUR manifest.json in S3
 *      (bucket: stellarglobal-costing-bucket / prefix: awscost/awscost/)
 *   2. Downloads + decompresses the CUR CSV (gzip via DecompressionStream)
 *   3. Parses, transforms, and aggregates records exactly as cur_processor.py does:
 *        costs.json          → aws.cur.v2.service.*
 *        daily-costs.json    → aws.cur.v2.daily.*  + aws.cur.v2.monthly.*
 *        summary.json        → aws.cur.v2.summary.*
 *        costs-by-tag.json   → aws.cur.v2.tag.*
 *        costs-by-usage-group.json → aws.cur.v2.usage_group.*
 *   4. Deduplicates via per-row SHA fingerprints in Cloudflare KV
 *   5. Pushes new/revised metrics to New Relic Metric API (EU or US)
 *
 * Triggers (wrangler.toml):
 *   • Cron : "0 *8 * * *"   (every 8 h)
 *   • HTTP GET /run           (manual trigger)
 *
 * Required secrets (Secrets Store):
 *   BEDROCK_ACCESS_KEY_ID       — IAM key with s3:GetObject + s3:ListBucket on RAW_CUR_BUCKET
 *   BEDROCK_SECRET_ACCESS_KEY
 *   NEW_RELIC_LICENSE_KEY
 *
 * Required vars (wrangler.toml [vars]):
 *   NEW_RELIC_REGION = "eu"        # or "us"
 *   AWS_REGION       = "us-east-1"
 *   RAW_CUR_BUCKET   = "stellarglobal-costing-bucket"
 *
 * Required KV (wrangler.toml [[kv_namespaces]]):
 *   binding = "CUR_STATE_KV"
 */

// ── Constants ──────────────────────────────────────────────────────────────
const BATCH_SIZE          = 500;
const MAX_FP_PER_SOURCE   = 20_000;
const SNAPSHOT_STALE_REFRESH_HOURS = 24;
const INTERVAL_MS         = 86_400_000; // 1 day

// ── Service name map (ProductCode → human readable) ────────────────────────
const SERVICE_NAME_MAP = {
  AWSCloudFormation: 'AWS CloudFormation',
  AWSDataTransfer:   'AWS Data Transfer',
  AWSGlue:           'AWS Glue',
  AWSLambda:         'AWS Lambda',
  AWSQueueService:   'Amazon SQS',
  AWSSecretsManager: 'AWS Secrets Manager',
  AWSXRay:           'AWS X-Ray',
  AmazonApiGateway:  'Amazon API Gateway',
  AmazonBedrock:     'Amazon Bedrock',
  AmazonCloudFront:  'Amazon CloudFront',
  AmazonCloudWatch:  'Amazon CloudWatch',
  AmazonDynamoDB:    'Amazon DynamoDB',
  AmazonRoute53:     'Amazon Route 53',
  AmazonS3:          'Amazon S3',
  AmazonSNS:         'Amazon SNS',
  AmazonStates:      'AWS Step Functions',
  awskms:            'AWS KMS',
};

// ── Usage group patterns ───────────────────────────────────────────────────
const USAGE_GROUP_PATTERNS = [
  [/NovaLite/i,                     'bedrock-nova-lite'],
  [/NovaPro/i,                      'bedrock-nova-pro'],
  [/Claude/i,                       'bedrock-claude'],
  [/Titan/i,                        'bedrock-titan'],
  [/Lambda-GB-Second|Lambda-GB-Sec/i,'lambda-compute'],
  [/Request/i,                      'lambda-requests'],
  [/TimedStorage/i,                 's3-storage'],
  [/Requests-Tier1/i,               's3-put-requests'],
  [/Requests-Tier2/i,               's3-get-requests'],
  [/DataTransfer/i,                 'data-transfer'],
  [/CloudFront-Out/i,               'cloudfront-transfer'],
  [/GMD-Metrics|GetMetricData/i,    'cloudwatch-metrics-query'],
  [/MetricMonitorUsage/i,           'cloudwatch-alarms'],
  [/VendedLog/i,                    'cloudwatch-logs-ingestion'],
  [/DataScanned/i,                  'cloudwatch-logs-insights'],
  [/HostedZone/i,                   'route53-hosted-zones'],
  [/DNS-Queries/i,                  'route53-dns-queries'],
  [/AWSSecretsManager-Secrets/i,    'secrets-storage'],
  [/AWSSecretsManagerAPIRequest|AWSSecretsManager-API/i, 'secrets-api-calls'],
  [/ApiGatewayHttpRequest/i,        'apigw-http-requests'],
  [/WriteRequestUnits|WriteCapacity/i,'dynamodb-write'],
  [/ReadRequestUnits|ReadCapacity/i, 'dynamodb-read'],
  [/KMS-Requests/i,                 'kms-requests'],
  [/Catalog-Request/i,              'glue-catalog-requests'],
  [/Catalog-Storage/i,              'glue-catalog-storage'],
  [/StateTransition/i,              'stepfunctions-transitions'],
  [/XRay-TracesStored/i,            'xray-traces'],
  [/CloudFrontFunctions/i,          'cf-functions'],
  [/Invalidations/i,                'cf-invalidations'],
];

// ── App tag normalisation ──────────────────────────────────────────────────
const APP_TAG_GROUPS = {
  'oms':                'oms-app',
  'oms-app':            'oms-app',
  'oms_app':            'oms-app',
  'order-management':   'oms-app',
  'cleanup':            'cleanup-automation',
  'cleanup-automation': 'cleanup-automation',
  'cleanup_automation': 'cleanup-automation',
  'observe':            'observe-app',
  'observe-app':        'observe-app',
  'observer':           'observe-app',
  'workflow':           'workflow-platform',
  'workflow-platform':  'workflow-platform',
  'wf':                 'workflow-platform',
  'wf-platform':        'workflow-platform',
  'ops':                'ops-platform',
  'ops-platform':       'ops-platform',
  'ops_platform':       'ops-platform',
  'global':             'ops-platform',
  'stellar-ops':        'ops-platform',
  'quote':              'quote-app',
  'quote-app':          'quote-app',
  'quotation':          'quote-app',
};

function normalizeAppTag(tag) {
  if (!tag || !tag.trim()) return null;
  const lower = tag.toLowerCase().trim();
  if (APP_TAG_GROUPS[lower]) return APP_TAG_GROUPS[lower];
  let bestKey = null, bestLen = 0;
  for (const [key, canonical] of Object.entries(APP_TAG_GROUPS)) {
    if (lower.includes(key) && key.length > bestLen) {
      bestKey = canonical;
      bestLen = key.length;
    }
  }
  if (bestKey) return bestKey;
  return lower.replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || null;
}

// ── Resource-ID based app inference ───────────────────────────────────────
const RESOURCE_ID_PATTERNS = [
  [/stellar[-_]oms/i,                'oms-app'],
  [/order[-_]management/i,           'oms-app'],
  [/sgs[-_]quote/i,                  'quote-app'],
  [/stellar[-_]quote/i,              'quote-app'],
  [/stellar[-_]wf[-_]prod/i,         'workflow-platform'],
  [/stellar[-_]wf\b/i,               'workflow-platform'],
  [/workflow[-_]platform/i,          'workflow-platform'],
  [/stellar[-_]observe[-_]prod/i,    'observe-app'],
  [/stellar[-_]observe\b/i,          'observe-app'],
  [/stellar[-_]cleanup[-_]prod/i,    'cleanup-automation'],
  [/stellar[-_]cleanup\b/i,          'cleanup-automation'],
  [/stellar[-_]global[-_]prod/i,     'ops-platform'],
  [/stellarglobal[-_]ops/i,          'ops-platform'],
  [/stellar[-_]global\b/i,           'ops-platform'],
  [/stellarglobal/i,                 'ops-platform'],
  [/meta[-_]analytics/i,             'ops-platform'],
  [/stellar[-_]daily[-_]processor/i, 'ops-platform'],
  [/stellar[-_]report\b/i,           'ops-platform'],
  [/stellar[-_]auth\b/i,             'ops-platform'],
  [/stellar[-_]seed/i,               'ops-platform'],
  [/stellarglobal[-_]costing/i,      'ops-platform'],
  [/awscost|cur[-_]processor/i,      'ops-platform'],
];

function inferAppFromResourceId(resourceId) {
  if (!resourceId || resourceId.trim() === '' || resourceId.trim() === '-') return null;
  let rid = resourceId.trim();
  if (rid.startsWith('arn:')) rid = rid.split(':').pop();
  if (rid.includes('/')) rid = rid.replace(/\/$/, '').split('/').pop();
  const lower = rid.toLowerCase();
  for (const [pattern, canonical] of RESOURCE_ID_PATTERNS) {
    if (pattern.test(lower)) return canonical;
  }
  return null;
}

function getUsageGroup(usageType) {
  for (const [pattern, group] of USAGE_GROUP_PATTERNS) {
    if (pattern.test(usageType)) return group;
  }
  const stripped = usageType.replace(/^[A-Z0-9]+-/, '');
  return stripped.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'other';
}

// ── CSV Parser ─────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const result = [];
  let current = [];
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current.push('"');
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.join(''));
      current = [];
      i++;
      continue;
    } else {
      current.push(char);
    }
    i++;
  }
  result.push(current.join(''));
  return result;
}

// ── Record transformer ─────────────────────────────────────────────────────
const VALID_LINE_ITEM_TYPES = new Set([
  'Usage', 'SavingsPlanCoveredUsage', 'DiscountedUsage', 'RIFee', 'SavingsPlanRecurringFee',
]);

const TAG_COLUMNS = [
  'resourceTags/user:Application',
  'resourceTags/user:application',
  'resourceTags/user:App',
  'resourceTags/user:app',
  'resourceTags/user:Project',
  'resourceTags/user:project',
  'resourceTags/user:Team',
  'resourceTags/user:team',
  'resourceTags/user:Service',
  'resourceTags/user:service',
  'resourceTags/user:Environment',
];

function toFloat(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0.0 : n;
}

function transformRecord(headers, values) {
  // Build a fast lookup object
  const row = {};
  for (let i = 0; i < headers.length; i++) row[headers[i]] = values[i] || '';

  const lineItemType = row['lineItem/LineItemType'] || '';
  if (!VALID_LINE_ITEM_TYPES.has(lineItemType)) return null;

  const cost = toFloat(row['lineItem/UnblendedCost'] || '0');
  if (cost === 0.0) return null;

  const productCode = row['lineItem/ProductCode'] || row['product/servicecode'] || 'Unknown';
  const usageType   = row['lineItem/UsageType'] || '';
  const usageGroup  = getUsageGroup(usageType);
  const serviceName = SERVICE_NAME_MAP[productCode]
    || row['product/ProductName']
    || row['product/servicename']
    || productCode;
  const startDate   = row['lineItem/UsageStartDate'] || row['bill/BillingPeriodStartDate'] || '';
  const rawRegion   = row['product/regionCode'] || row['product/region'] || '';
  const region      = rawRegion ? rawRegion.replace(/[a-z]$/, '') : 'global';

  // Stage 1: cost-allocation tags
  let rawTag = '';
  for (const col of TAG_COLUMNS) {
    const val = row[col];
    if (val && val.trim()) { rawTag = val; break; }
  }
  let applicationTag = normalizeAppTag(rawTag);
  let tagSource = 'tag';

  // Stage 2: infer from resource ID
  const resourceId = row['lineItem/ResourceId'] || '';
  if (!applicationTag) {
    applicationTag = inferAppFromResourceId(resourceId);
    if (applicationTag) tagSource = 'resource_id';
  }
  if (!applicationTag) tagSource = 'none';

  return {
    timestamp:      startDate,
    applicationTag,
    tagSource,
    resourceId,
    account:        row['lineItem/UsageAccountId'] || row['bill/PayerAccountId'] || '',
    service:        productCode,
    serviceName,
    usageGroup,
    region,
    usageType,
    operation:      row['lineItem/Operation'] || '',
    lineItemType,
    cost,
    blendedCost:    toFloat(row['lineItem/BlendedCost'] || '0'),
    usageAmount:    toFloat(row['lineItem/UsageAmount'] || '0'),
  };
}

// ── Aggregators ────────────────────────────────────────────────────────────
function buildCostsJson(records) {
  const agg = {};
  for (const r of records) {
    const date = (r.timestamp || '').split('T')[0] || 'unknown';
    const key  = `${date}_${r.service}_${r.region}`;
    if (!agg[key]) {
      agg[key] = { date, service: r.service, serviceName: r.serviceName,
        region: r.region, totalCost: 0, totalBlendedCost: 0, totalUsage: 0, recordCount: 0 };
    }
    agg[key].totalCost        += r.cost;
    agg[key].totalBlendedCost += r.blendedCost;
    agg[key].totalUsage       += r.usageAmount;
    agg[key].recordCount      += 1;
  }
  return Object.values(agg).map(v => ({
    ...v,
    totalCost:        round6(v.totalCost),
    totalBlendedCost: round6(v.totalBlendedCost),
    totalUsage:       round6(v.totalUsage),
  }));
}

function buildDailyCostsJson(records, billingPeriod) {
  const dailyMap = {};
  for (const r of records) {
    const date = (r.timestamp || '').split('T')[0] || 'unknown';
    if (!dailyMap[date]) dailyMap[date] = {};
    const svc = r.service;
    if (!dailyMap[date][svc]) {
      dailyMap[date][svc] = { service: svc, serviceName: r.serviceName, cost: 0 };
    }
    dailyMap[date][svc].cost += r.cost;
  }

  const dailyCosts = Object.keys(dailyMap).sort().map(date => {
    const services = Object.values(dailyMap[date])
      .map(s => ({ service: s.service, serviceName: s.serviceName, cost: round6(s.cost) }))
      .sort((a, b) => b.cost - a.cost);
    const totalCost = round6(services.reduce((s, x) => s + x.cost, 0));
    return { date, totalCost, services };
  });

  const monthlyTotal = round6(dailyCosts.reduce((s, d) => s + d.totalCost, 0));
  const start8 = (billingPeriod.start || '').replace(/[^0-9]/g, '').slice(0, 8);
  const end8   = (billingPeriod.end   || '').replace(/[^0-9]/g, '').slice(0, 8);

  return {
    billingPeriod: { start: start8, end: end8 },
    dailyCosts,
    monthlyTotal,
    generatedAt: new Date().toISOString(),
  };
}

function buildSummaryJson(records, billingPeriod) {
  const start8 = (billingPeriod.start || '').replace(/[^0-9]/g, '').slice(0, 8);
  const month  = start8.length >= 6 ? `${start8.slice(0, 4)}-${start8.slice(4, 6)}` : 'unknown';

  const svcMap = {};
  for (const r of records) {
    if (!svcMap[r.service]) svcMap[r.service] = { service: r.service, serviceName: r.serviceName, cost: 0 };
    svcMap[r.service].cost += r.cost;
  }

  const services = Object.values(svcMap)
    .map(s => ({ service: s.service, serviceName: s.serviceName, cost: round6(s.cost) }))
    .sort((a, b) => b.cost - a.cost);

  return [{ month, totalCost: round6(services.reduce((s, x) => s + x.cost, 0)), services }];
}

function buildCostsByTagJson(records, billingPeriod) {
  const start8 = (billingPeriod.start || '').replace(/[^0-9]/g, '').slice(0, 8);
  const appMap  = {};

  for (const r of records) {
    const app = r.applicationTag || 'uncategorized';
    if (!appMap[app]) appMap[app] = {};
    const svc = r.service;
    if (!appMap[app][svc]) {
      appMap[app][svc] = { service: svc, serviceName: r.serviceName, cost: 0 };
    }
    appMap[app][svc].cost += r.cost;
  }

  const byApplication = [];
  let uncategorized   = { totalCost: 0, services: [] };

  for (const [app, svcMap] of Object.entries(appMap)) {
    const services = Object.values(svcMap)
      .map(s => ({ service: s.service, serviceName: s.serviceName, cost: round6(s.cost) }))
      .sort((a, b) => b.cost - a.cost);
    const totalCost = round6(services.reduce((s, x) => s + x.cost, 0));
    if (app === 'uncategorized') {
      uncategorized = { totalCost, services };
    } else {
      byApplication.push({ application: app, totalCost, services });
    }
  }

  byApplication.sort((a, b) => b.totalCost - a.totalCost);

  return {
    billingPeriod: { start: start8, end: (billingPeriod.end || '').replace(/[^0-9]/g, '').slice(0, 8) },
    byApplication,
    uncategorized,
    generatedAt: new Date().toISOString(),
  };
}

function buildCostsByUsageGroupJson(records) {
  const grpMap = {};
  for (const r of records) {
    const date = (r.timestamp || '').split('T')[0] || 'unknown';
    const key  = `${date}|${r.service}|${r.usageGroup}`;
    if (!grpMap[key]) {
      grpMap[key] = { date, service: r.service, serviceName: r.serviceName,
        usageGroup: r.usageGroup, region: r.region || 'global',
        totalCost: 0, usageAmount: 0, recordCount: 0 };
    }
    grpMap[key].totalCost   += r.cost;
    grpMap[key].usageAmount += r.usageAmount;
    grpMap[key].recordCount += 1;
  }
  return Object.values(grpMap)
    .map(v => ({ ...v, totalCost: round6(v.totalCost), usageAmount: round6(v.usageAmount) }))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : b.totalCost - a.totalCost);
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

// ── CSV processing pipeline ────────────────────────────────────────────────
function processCsvText(csvText, billingPeriod, log) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) { log.warn('No data rows in CSV'); return null; }

  const headers = parseCsvLine(lines[0]);
  log.info(`CSV: ${headers.length} columns, ${lines.length - 1} rows`);

  const tagCols = headers.filter(h => h.toLowerCase().includes('tag') || h.includes('resourceTags'));
  log.info(`Tag columns: ${tagCols.length > 0 ? tagCols.join(', ') : 'NONE'}`);

  const records = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.length !== headers.length) { skipped++; continue; }
    const rec = transformRecord(headers, values);
    if (rec) records.push(rec);
  }

  log.info(`Transformed: ${records.length} cost records, skipped: ${skipped}`);
  if (!records.length) { log.warn('No cost records'); return null; }

  // Tag resolution stats
  const tagCount      = records.filter(r => r.tagSource === 'tag').length;
  const resourceCount = records.filter(r => r.tagSource === 'resource_id').length;
  const noneCount     = records.filter(r => r.tagSource === 'none').length;
  log.info(`Tagging: ${tagCount} via cost-allocation tags, ${resourceCount} via resource-ID, ${noneCount} uncategorized`);

  return {
    costs:              buildCostsJson(records),
    dailyCosts:         buildDailyCostsJson(records, billingPeriod),
    summary:            buildSummaryJson(records, billingPeriod),
    costsByTag:         buildCostsByTagJson(records, billingPeriod),
    costsByUsageGroup:  buildCostsByUsageGroupJson(records),
  };
}

// ── S3 helpers (AWS Signature V4 — no SDK needed) ──────────────────────────
async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256',
    typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signedS3Request(method, bucket, key, region, accessKeyId, secretKey, body = '') {
  const host       = `${bucket}.s3.${region}.amazonaws.com`;
  const path       = `/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
  const now        = new Date();
  const amzDate    = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp  = amzDate.slice(0, 8);
  const bodyHash   = await sha256Hex(body);
  const headers    = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': bodyHash };
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const credentialScope  = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign     = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const kDate    = await hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion  = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const sigBuf   = await hmacSha256(kSigning, stringToSign);
  const signature = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(`https://${host}${path}`, {
    method,
    headers: {
      Authorization: authorization,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': bodyHash,
    },
  });
}

async function s3ListObjects(bucket, prefix, region, keyId, secret) {
  const host      = `${bucket}.s3.${region}.amazonaws.com`;
  const queryStr  = `list-type=2&max-keys=100&prefix=${encodeURIComponent(prefix)}`;
  const path      = '/';
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash  = await sha256Hex('');
  const signedHeaders   = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `GET\n${path}\n${queryStr}\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;
  const credentialScope  = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign     = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const kDate    = await hmacSha256(`AWS4${secret}`, dateStamp);
  const kRegion  = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const sigBuf   = await hmacSha256(kSigning, stringToSign);
  const signature = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

  const authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(`https://${host}${path}?${queryStr}`, {
    headers: {
      Authorization: authorization,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': bodyHash,
    },
  });
}

async function s3GetObject(bucket, key, region, keyId, secret) {
  return signedS3Request('GET', bucket, key, region, keyId, secret);
}

// ── Gzip decompression ─────────────────────────────────────────────────────
async function decompressGzip(arrayBuffer) {
  const ds     = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(arrayBuffer);
  writer.close();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total  = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset   = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(result);
}

// ── Parse S3 ListObjectsV2 XML response ────────────────────────────────────
function parseS3ListXml(xml) {
  const objects = [];
  const regex   = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const block       = match[1];
    const keyMatch    = /<Key>(.*?)<\/Key>/.exec(block);
    const dateMatch   = /<LastModified>(.*?)<\/LastModified>/.exec(block);
    if (keyMatch) {
      objects.push({
        key:          keyMatch[1],
        lastModified: dateMatch ? new Date(dateMatch[1]) : new Date(0),
      });
    }
  }
  return objects;
}

// ── Find and load latest CUR manifest from S3 ─────────────────────────────
async function fetchLatestCurFromS3(env, log) {
  const bucket  = env.RAW_CUR_BUCKET || 'stellarglobal-costing-bucket';
  const region  = env.AWS_REGION     || 'us-east-1';
  const keyId   = await resolveSecret(env.BEDROCK_ACCESS_KEY_ID);
  const secret  = await resolveSecret(env.BEDROCK_SECRET_ACCESS_KEY);

  if (!keyId || !secret) throw new Error('BEDROCK_ACCESS_KEY_ID / BEDROCK_SECRET_ACCESS_KEY not configured');

  log.info(`Listing S3 objects in s3://${bucket}/awscost/awscost/`);
  const listRes = await s3ListObjects(bucket, 'awscost/awscost/', region, keyId, secret);
  if (!listRes.ok) throw new Error(`S3 list failed: HTTP ${listRes.status}`);

  const xml     = await listRes.text();
  const objects = parseS3ListXml(xml);
  log.info(`Found ${objects.length} objects in bucket`);

  const manifests = objects
    .filter(o => o.key.toLowerCase().endsWith('manifest.json'))
    .sort((a, b) => b.lastModified - a.lastModified);

  if (!manifests.length) throw new Error('No manifest.json found in S3 bucket');

  const manifestKey = manifests[0].key;
  log.info(`Loading manifest: ${manifestKey}`);
  const manifestRes = await s3GetObject(bucket, manifestKey, region, keyId, secret);
  if (!manifestRes.ok) throw new Error(`Failed to download manifest: HTTP ${manifestRes.status}`);

  const manifest = await manifestRes.json();
  const billingPeriod = manifest.billingPeriod || {};
  const reportKeys    = manifest.reportKeys    || [];

  if (!reportKeys.length) throw new Error('Manifest has no reportKeys');

  log.info(`Billing period: ${billingPeriod.start} → ${billingPeriod.end}, ${reportKeys.length} report file(s)`);

  // Download and process all report CSV files (usually just one)
  let allRecordsText = '';
  let headersLine    = '';

  for (const reportKey of reportKeys) {
    log.info(`Downloading report: ${reportKey}`);
    const res = await s3GetObject(bucket, reportKey, region, keyId, secret);
    if (!res.ok) throw new Error(`Failed to download report ${reportKey}: HTTP ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    let csvText;
    if (reportKey.endsWith('.gz')) {
      csvText = await decompressGzip(arrayBuffer);
    } else {
      csvText = new TextDecoder().decode(arrayBuffer);
    }

    const lines = csvText.split('\n').filter(l => l.trim());
    if (!lines.length) continue;

    if (!headersLine) {
      headersLine    = lines[0];
      allRecordsText = csvText;
    } else {
      // Append rows (skip header of subsequent files)
      allRecordsText += '\n' + lines.slice(1).join('\n');
    }
  }

  if (!allRecordsText) throw new Error('No CSV content downloaded from S3');
  return { csvText: allRecordsText, billingPeriod };
}

// ── Secret resolver ────────────────────────────────────────────────────────
async function resolveSecret(val) {
  if (!val) return undefined;
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get();
  if (typeof val === 'string') return val;
  return String(val);
}

// ── KV state ───────────────────────────────────────────────────────────────
async function loadState(kv, key) {
  try {
    const raw = await kv.get(key, { type: 'json' });
    return (raw && typeof raw === 'object') ? raw : { sources: {} };
  } catch { return { sources: {} }; }
}

async function saveState(kv, key, state) {
  await kv.put(key, JSON.stringify(state));
}

// ── Deduplication ──────────────────────────────────────────────────────────
function stableHash(value) {
  const str  = JSON.stringify(value, Object.keys(value).sort());
  let hash   = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash).toString(16).padStart(8, '0') + str.length.toString(16);
}

function costHash(value) {
  const rounded = Math.round(parseFloat(value) * 1e6) / 1e6;
  return stableHash({ v: rounded.toFixed(6) }).slice(0, 12);
}

function filterNewOrRevised(metrics, sentPoints, log) {
  const toPush = [];
  const updated = { ...sentPoints };
  for (const m of metrics) {
    const attrs = m.attributes ?? {};
    const fp = stableHash({
      name: m.name, ts: m.timestamp,
      file: attrs.file ?? '', service: attrs.service ?? '',
      service_name: attrs.service_name ?? '', region: attrs.region ?? '',
      date: attrs.date ?? '', usage_group: attrs.usage_group ?? '',
      application: attrs.application ?? '',
    }).slice(0, 20);
    const ch = costHash(m.value);
    if (updated[fp] === ch) continue;
    toPush.push(m);
    updated[fp] = ch;
  }
  const skipped = metrics.length - toPush.length;
  if (skipped > 0) log.info(`  Dedup: ${skipped} unchanged, ${toPush.length} new/revised`);
  return { toPush, updatedSentPoints: updated };
}

function pruneFingerprints(sentPoints, max) {
  const keys = Object.keys(sentPoints);
  if (keys.length <= max) return 0;
  const drop = keys.slice(0, keys.length - max);
  for (const k of drop) delete sentPoints[k];
  return drop.length;
}

async function normaliseSnapshot(data) {
  const clean = Array.isArray(data)
    ? data.map(item => { const c = { ...item }; delete c.generatedAt; return c; })
    : (() => { const c = { ...data }; delete c.generatedAt; delete c.updated_at; return c; })();
  const str  = JSON.stringify(clean, null, 0);
  const buf  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isStale(lastPushIso, hours) {
  if (!lastPushIso) return true;
  try { return (Date.now() - new Date(lastPushIso).getTime()) > hours * 3_600_000; }
  catch { return true; }
}

// ── Metric builders ────────────────────────────────────────────────────────
function makeGauge(name, value, timestampMs, attrs) {
  return {
    name, type: 'gauge',
    value: Math.round(parseFloat(value) * 1e8) / 1e8,
    timestamp: timestampMs,
    'interval.ms': INTERVAL_MS,
    attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)])),
  };
}

function dateToTsMs(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getTime();
}

// ── Collectors (JSON → NR metrics) ────────────────────────────────────────
function collectCosts(data) {
  return data.flatMap(row => {
    const ts = dateToTsMs(row.date);
    const attrs = { source: 'cur', file: 'costs', service: row.service,
      service_name: row.serviceName, region: row.region ?? 'us-east-1', date: row.date };
    return [
      makeGauge('aws.cur.v2.service.unblended_cost',  row.totalCost,        ts, attrs),
      makeGauge('aws.cur.v2.service.blended_cost',    row.totalBlendedCost, ts, attrs),
      makeGauge('aws.cur.v2.service.usage_quantity',  row.totalUsage,       ts, attrs),
      makeGauge('aws.cur.v2.service.record_count',    row.recordCount,      ts, attrs),
    ];
  });
}

function collectDaily(data, runTsMs) {
  const metrics = [];
  const bpRaw = (data.billingPeriod?.start ?? '').replace(/[^0-9]/g, '').slice(0, 8);
  const bp    = bpRaw.length >= 6 ? `${bpRaw.slice(0, 4)}-${bpRaw.slice(4, 6)}` : 'unknown';

  for (const day of data.dailyCosts ?? []) {
    const ts       = dateToTsMs(day.date);
    const dayAttrs = { source: 'cur', file: 'daily-costs', date: day.date, billing_period: bp };
    metrics.push(makeGauge('aws.cur.v2.daily.total_cost', day.totalCost, ts, dayAttrs));
    for (const svc of day.services ?? []) {
      metrics.push(makeGauge('aws.cur.v2.daily.service_cost', svc.cost, ts,
        { ...dayAttrs, service: svc.service, service_name: svc.serviceName }));
    }
  }
  if (data.monthlyTotal != null) {
    metrics.push(makeGauge('aws.cur.v2.monthly.total_cost', data.monthlyTotal, runTsMs,
      { source: 'cur', file: 'daily-costs', billing_period: bp }));
  }
  return metrics;
}

function collectSummary(data, runTsMs) {
  return data.flatMap(monthRow => {
    const attrs = { source: 'cur', file: 'summary', billing_period: monthRow.month };
    return [
      makeGauge('aws.cur.v2.summary.monthly_total', monthRow.totalCost, runTsMs, attrs),
      ...(monthRow.services ?? []).map(svc =>
        makeGauge('aws.cur.v2.summary.service_cost', svc.cost, runTsMs,
          { ...attrs, service: svc.service, service_name: svc.serviceName }))
    ];
  });
}

function collectTags(data, runTsMs) {
  const metrics = [];
  const bpRaw = data.billingPeriod?.start ?? '';
  const bp    = bpRaw.length >= 6 ? `${bpRaw.slice(0, 4)}-${bpRaw.slice(4, 6)}` : 'unknown';
  const base  = { source: 'cur', file: 'costs-by-tag', billing_period: bp };

  for (const app of data.byApplication ?? []) {
    const appAttrs = { ...base, application: app.application ?? 'unknown', tagged: 'true' };
    metrics.push(makeGauge('aws.cur.v2.tag.app_total_cost', app.totalCost ?? 0, runTsMs, appAttrs));
    for (const svc of app.services ?? []) {
      metrics.push(makeGauge('aws.cur.v2.tag.app_service_cost', svc.cost, runTsMs,
        { ...appAttrs, service: svc.service, service_name: svc.serviceName }));
    }
  }

  const uncat = data.uncategorized ?? {};
  if (uncat && Object.keys(uncat).length) {
    const uncatAttrs = { ...base, application: 'uncategorized', tagged: 'false' };
    metrics.push(makeGauge('aws.cur.v2.tag.uncategorized_total', uncat.totalCost ?? 0, runTsMs, uncatAttrs));
    for (const svc of uncat.services ?? []) {
      metrics.push(makeGauge('aws.cur.v2.tag.uncategorized_service', svc.cost, runTsMs,
        { ...uncatAttrs, service: svc.service, service_name: svc.serviceName }));
    }
  }
  return metrics;
}

function collectUsageGroup(data) {
  return data.flatMap(row => {
    const ts = dateToTsMs(row.date);
    const attrs = { source: 'cur', file: 'costs-by-usage-group', service: row.service,
      service_name: row.serviceName, usage_group: row.usageGroup,
      region: row.region ?? 'global', date: row.date };
    return [
      makeGauge('aws.cur.v2.usage_group.cost',          row.totalCost,   ts, attrs),
      makeGauge('aws.cur.v2.usage_group.usage_quantity', row.usageAmount, ts, attrs),
      makeGauge('aws.cur.v2.usage_group.record_count',  row.recordCount, ts, attrs),
    ];
  });
}

// ── New Relic push ─────────────────────────────────────────────────────────
function newRelicMetricsUrl(region) {
  return (region || 'eu').toLowerCase() === 'eu'
    ? 'https://metric-api.eu.newrelic.com/metric/v1'
    : 'https://metric-api.newrelic.com/metric/v1';
}

async function pushMetrics(metrics, nrUrl, licenseKey, log) {
  if (!metrics.length) { log.warn('No metrics to push'); return; }
  let totalPushed = 0;
  for (let i = 0; i < metrics.length; i += BATCH_SIZE) {
    const batch   = metrics.slice(i, i + BATCH_SIZE);
    const payload = [{ common: { attributes: { forwarder: 'cloudflare-worker-cur', data_type: 'cur' }, 'interval.ms': INTERVAL_MS }, metrics: batch }];
    const resp    = await fetch(nrUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': licenseKey },
      body: JSON.stringify(payload),
    });
    const body = await resp.text();
    log.info(`NR Metrics HTTP ${resp.status} batch ${i}–${i + batch.length}: ${body.slice(0, 200)}`);
    if (resp.status !== 200 && resp.status !== 202) {
      throw new Error(`NR Metric API returned HTTP ${resp.status}: ${body}`);
    }
    totalPushed += batch.length;
  }
  log.info(`Total metrics pushed: ${totalPushed}`);
}

// ── Main orchestrator ──────────────────────────────────────────────────────
async function runForwarder(env) {
  const log      = makeLogger('cur-forwarder');
  const nrUrl    = newRelicMetricsUrl(env.NEW_RELIC_REGION || 'eu');
  const licenseKey = await resolveSecret(env.NEW_RELIC_LICENSE_KEY);
  const runTsMs  = Date.now();

  log.info(`=== CUR Forwarder start  run_at=${new Date(runTsMs).toISOString()} ===`);
  log.info(`New Relic endpoint: ${nrUrl}`);

  if (!licenseKey) { log.error('NEW_RELIC_LICENSE_KEY not set'); return; }

  // ── Step 1: Fetch + parse CUR from S3 ─────────────────────────────────
  let aggregated;
  try {
    const { csvText, billingPeriod } = await fetchLatestCurFromS3(env, log);
    aggregated = processCsvText(csvText, billingPeriod, log);
    if (!aggregated) { log.warn('No aggregated data produced — nothing to ship'); return; }
  } catch (err) {
    log.error(`S3 fetch/processing failed: ${err.message}`);
    return;
  }

  // ── Step 2: Load KV state ─────────────────────────────────────────────
  const state        = await loadState(env.CUR_STATE_KV, 'cur-state');
  const sourcesState = state.sources ?? {};

  const stats = { total_metrics: 0, skipped_unchanged: 0, updated_sources: 0 };

  // ── Step 3: Time-series sources (per-row fingerprint dedup) ───────────
  const timeseriesSources = [
    { name: 'costs',                data: aggregated.costs,             collect: collectCosts,      stat: 'costs_metrics' },
    { name: 'daily-costs',          data: aggregated.dailyCosts,        collect: d => collectDaily(d, runTsMs), stat: 'daily_metrics' },
    { name: 'costs-by-usage-group', data: aggregated.costsByUsageGroup, collect: collectUsageGroup, stat: 'usage_group_metrics' },
  ];

  for (const src of timeseriesSources) {
    if (!src.data || (Array.isArray(src.data) ? !src.data.length : !Object.keys(src.data).length)) {
      log.warn(`${src.name}: no data`); continue;
    }
    const srcState   = sourcesState[src.name] ?? {};
    const sentPoints = srcState.sent_points ?? {};
    const allMetrics = src.collect(src.data);
    if (!allMetrics.length) { log.info(`${src.name}: no metrics produced`); continue; }

    const { toPush, updatedSentPoints } = filterNewOrRevised(allMetrics, sentPoints, log);
    if (!toPush.length) { log.info(`${src.name}: all unchanged — skipping`); stats.skipped_unchanged++; continue; }

    await pushMetrics(toPush, nrUrl, licenseKey, log);

    const pruned = pruneFingerprints(updatedSentPoints, MAX_FP_PER_SOURCE);
    if (pruned > 0) log.info(`${src.name}: pruned ${pruned} stale fingerprints`);

    const now = new Date().toISOString();
    sourcesState[src.name] = { ...srcState, sent_points: updatedSentPoints,
      last_successful_push: now, metric_count: toPush.length,
      total_points_tracked: Object.keys(updatedSentPoints).length };
    state.sources = sourcesState; state.updated_at = now;
    await saveState(env.CUR_STATE_KV, 'cur-state', state);

    stats.total_metrics += toPush.length; stats.updated_sources++;
  }

  // ── Step 4: Snapshot sources (whole-file hash dedup) ──────────────────
  const snapshotSources = [
    { name: 'summary',      data: aggregated.summary,    collect: d => collectSummary(d, runTsMs) },
    { name: 'costs-by-tag', data: aggregated.costsByTag, collect: d => collectTags(d, runTsMs)   },
  ];

  for (const src of snapshotSources) {
    if (!src.data || (Array.isArray(src.data) ? !src.data.length : !Object.keys(src.data).length)) {
      log.warn(`${src.name}: no data`); continue;
    }

    const contentHash  = await normaliseSnapshot(src.data);
    const srcState     = sourcesState[src.name] ?? {};
    const unchanged    = contentHash === srcState.sha256;
    const stale        = isStale(srcState.last_successful_push ?? null, SNAPSHOT_STALE_REFRESH_HOURS);

    if (unchanged && !stale) {
      log.info(`${src.name}: unchanged and fresh — skipping`); stats.skipped_unchanged++; continue;
    }

    const metrics = src.collect(src.data);
    if (!metrics.length) { log.info(`${src.name}: no metrics produced`); continue; }

    await pushMetrics(metrics, nrUrl, licenseKey, log);

    const now = new Date().toISOString();
    sourcesState[src.name] = { ...srcState, sha256: contentHash,
      last_successful_push: now, metric_count: metrics.length };
    state.sources = sourcesState; state.updated_at = now;
    await saveState(env.CUR_STATE_KV, 'cur-state', state);

    stats.total_metrics += metrics.length; stats.updated_sources++;
  }

  log.info(`=== Run complete: ${JSON.stringify(stats)} ===`);
  return stats;
}

// ── Worker entry point ─────────────────────────────────────────────────────
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runForwarder(env));
  },
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/run') {
      ctx.waitUntil(runForwarder(env));
      return new Response(JSON.stringify({ ok: true, message: 'CUR forwarder started' }),
        { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('cur-forwarder worker\nGET /run to trigger manually', { status: 200 });
  },
};

// ── Logger ─────────────────────────────────────────────────────────────────
function makeLogger(name) {
  const prefix = `[${name}]`;
  return {
    info:  msg => console.log( `${new Date().toISOString()} ${prefix} INFO  ${msg}`),
    warn:  msg => console.warn( `${new Date().toISOString()} ${prefix} WARN  ${msg}`),
    error: msg => console.error(`${new Date().toISOString()} ${prefix} ERROR ${msg}`),
  };
}