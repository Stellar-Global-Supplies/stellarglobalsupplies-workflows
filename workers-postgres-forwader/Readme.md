# stellarglobalsupplies-new-relic-forwarder — Cloudflare Workers

Rewrites of the two active GitHub Actions workflows as Cloudflare Workers.

| GHA Workflow | Worker | Schedule |
|---|---|---|
| `forward-cur.yml` | `cur-forwarder/` | Every 8 h (`0 */8 * * *`) |
| `forward-supabase.yml` | `supabase-forwarder/` (Supabase only) | Every 1 h (`0 * * * *`) |
| _(new)_ | `postgres-forwarder/` (**Supabase + NeonDB combined**) | Every 1 h (`0 * * * *`) |
| `forward-logs.yml` | **RETIRED** — not rewritten | — |
| `new-relic-alerts.yml` | Terraform deploy — not applicable to a Worker | — |

> **Recommendation:** use `postgres-forwarder/` going forward. It supersedes `supabase-forwarder/` and adds NeonDB support in the same worker run with independent per-source dedup state.

---

## cur-forwarder

**What it does** (identical behaviour to the GHA workflow):

1. Reads five pre-transformed CUR JSON files from **Supabase Storage** (`stellar-assets` bucket, `cur-forwarder/` path):
   `costs.json`, `daily-costs.json`, `summary.json`,
   `costs-by-tag.json`, `costs-by-usage-group.json`
2. Deduplicates per-row by SHA fingerprint stored in **KV**
   (replaces `cur-state.json` on the Git `state` branch).
3. Pushes new / revised metrics as gauges to the **New Relic Metric API**
   under the `aws.cur.v2.*` namespace.
4. Deletes the consumed JSON files from Supabase Storage after successful processing.
5. Prunes the KV fingerprint store to ≤ 20,000 entries per source
   (mirrors the GHA prune step).

### Setup

```bash
cd cur-forwarder
npm install

# 1. Create a KV namespace
wrangler kv:namespace create CUR_STATE_KV
# Copy the returned id into wrangler.toml → kv_namespaces[].id

# 2. Ensure cur_processor.py uploads the 5 JSON files to Supabase Storage
#    under the `stellar-assets` bucket, `cur-forwarder/` path

# 3. Set secrets via Cloudflare Secrets Store (store_id 2556bcd9458349f6b4ff2a3fc93bdba1):
#    NEW_RELIC_LICENSE_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

# 4. (optional) Change NEW_RELIC_REGION in wrangler.toml to "us" if needed

# 5. Deploy
wrangler deploy
```

### Storage

The worker reads CUR JSON files from **Supabase Storage** (bucket: `stellar-assets`, path: `cur-forwarder/`).
Update `cur_processor.py` to upload the JSON files there instead of R2/S3.
After each successful run, the forwarder **deletes** the consumed files — files are consumed
and cleaned up within the same run.

### Manual trigger

```
GET https://cur-forwarder.<your-subdomain>.workers.dev/run
```

### State mapping

| Python (GHA) | Cloudflare Worker |
|---|---|
| `cur-state.json` on `state` branch | KV key `cur-state` in `CUR_STATE_KV` |
| `state.sources[name].sent_points` | Nested inside the same KV value |
| `state.sources[name].last_successful_push` | Same |

---

## supabase-forwarder

**What it does** (identical behaviour to the GHA workflow):

1. Connects to Supabase Postgres and queries the same `pg_stat_*` views
   as `supabase/collectors/supabase_collector.py`.
2. Deduplicates the metric set by SHA-256 fingerprint stored in **KV**
   (replaces `supabase-state.json` on the Git `state` branch).
3. Ships metrics to the **New Relic Metric API** and a structured run log
   to the **New Relic Log API** (EU endpoints).

### Postgres connection — choose one

**Option A — Cloudflare Hyperdrive (recommended)**

Hyperdrive proxies and pools Postgres connections, which is ideal for a
cron worker that opens a new connection on every invocation.

```bash
wrangler hyperdrive create supabase-db \
  --connection-string="postgresql://postgres:[PASS]@db.[REF].supabase.co:5432/postgres"
# Copy the returned id into wrangler.toml → hyperdrive[].id, then uncomment the block
```

**Option B — Direct connection via existing secrets**

The worker builds the Supabase connection string automatically from the
already-configured `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` secrets —
no separate `SUPABASE_DB_URL` secret needed.

### Setup

```bash
cd supabase-forwarder
npm install

# 1. Create a KV namespace
wrangler kv:namespace create SUPABASE_STATE_KV
# Copy the returned id into wrangler.toml

# 2. Configure Postgres (Option A or B above)

# 3. Set secrets
wrangler secret put NEW_RELIC_LICENSE_KEY
# Supabase connection auto-built from SUPABASE_URL + SUPABASE_SERVICE_KEY (already configured)

# 4. Deploy
wrangler deploy
```

### Manual trigger

```
GET https://supabase-forwarder.<your-subdomain>.workers.dev/run
```

### State mapping

| Python (GHA) | Cloudflare Worker |
|---|---|
| `supabase-state.json` on `state` branch | KV key `supabase-state` in `SUPABASE_STATE_KV` |
| `sha256` field | Same |
| `last_successful_push` | Same |

---

## Metrics collected — Supabase

| Metric name | Type | Description |
|---|---|---|
| `supabase.db.size_bytes` | gauge | Total database size |
| `supabase.connections.total` | gauge | Total connections |
| `supabase.connections.by_state` | gauge | Connections per state (active / idle / …) |
| `supabase.table.live_rows` | gauge | Live row count per table |
| `supabase.table.dead_rows` | gauge | Dead row count per table |
| `supabase.table.rows_inserted` | count | Cumulative inserts per table |
| `supabase.table.rows_updated` | count | Cumulative updates per table |
| `supabase.table.rows_deleted` | count | Cumulative deletes per table |
| `supabase.table.seq_scans` | count | Sequential scans per table |
| `supabase.table.idx_scans` | count | Index scans per table |
| `supabase.table.total_size_bytes` | gauge | Total on-disk size per table |
| `supabase.bgwriter.*` | count | Background writer stats |
| `supabase.statements.mean_exec_time_ms` | gauge | Mean execution time (top 20 slow queries) |
| `supabase.statements.calls` | count | Call count per query |
| `supabase.statements.rows` | count | Rows returned per query |
| `supabase.statements.blks_hit` | count | Buffer cache hits per query |
| `supabase.statements.blks_read` | count | Disk reads per query |

## Metrics collected — CUR

All metrics are in the `aws.cur.v2.*` namespace, matching what the Python
forwarder produced. See the original `forward_cur.py` for full documentation.

---

## Key design differences vs GHA

| Concern | GitHub Actions | Cloudflare Worker |
|---|---|---|
| Trigger | `schedule:` + `workflow_dispatch:` | Cron binding + HTTP `/run` |
| AWS credentials | OIDC role assumption | Not needed — R2 is accessed via binding |
| State storage | `cur-state.json` / `state.json` on `state` branch | Cloudflare KV |
| Python runtime | `ubuntu-latest` + `setup-python` | Native JS / Web APIs |
| Postgres driver | `psycopg2` | `pg` npm package via `node_compat` |
| Concurrency guard | `concurrency: group` | Single-instance cron (Workers guarantee this) |
| Secrets | GitHub Secrets | Wrangler secrets / env vars |

---

## postgres-forwarder (Supabase + NeonDB combined)

**What it does:**

1. Connects to **both** Supabase and NeonDB Postgres in parallel.
2. Runs the same five `pg_stat_*` collectors against each.
3. Emits metrics under separate namespaces: `supabase.*` and `neon.*`.
4. Deduplicates each source independently in KV — a change in Neon doesn't re-push Supabase data.
5. Ships to New Relic with per-source `service.name` tags (`supabase-monitor` / `neon-monitor`) so you can filter dashboards by database.
6. A single combined run-log entry is posted to the New Relic Log API.

### Setup

```bash
cd postgres-forwarder
npm install

# 1. Create a single shared KV namespace
wrangler kv:namespace create PG_STATE_KV
# Copy the returned id into wrangler.toml → kv_namespaces[].id

# 2. Configure Postgres connections — direct connection strings via secrets

# Supabase — direct Postgres connection string (pooler, port 6543):
#   postgresql://postgres.<ref>:<password>@pooler.<ref>.supabase.com:6543/postgres
# URL-encode the password if it contains special characters.
wrangler secret put SUPABASE_DB_URL

# Neon — direct Postgres connection string (SSL required):
#   postgresql://[USER]:[PASS]@[HOST].neon.tech/[DBNAME]?sslmode=require
wrangler secret put ADMIN_NEON_DB_URL

# 3. Set the New Relic secret
wrangler secret put NEW_RELIC_LICENSE_KEY

# 4. Deploy
wrangler deploy
```

### Manual triggers

```
GET /run           — collect from both Supabase and Neon
GET /run/supabase  — collect from Supabase only
GET /run/neon      — collect from Neon only
```

### Metric namespaces

| Source | Metric prefix | NR `service.name` |
|---|---|---|
| Supabase | `supabase.*` | `supabase-monitor` |
| NeonDB | `neon.*` | `neon-monitor` |

All collected metric names are identical between sources — only the prefix changes:

| Metric (Supabase example) | Neon equivalent |
|---|---|
| `supabase.db.size_bytes` | `neon.db.size_bytes` |
| `supabase.connections.total` | `neon.connections.total` |
| `supabase.table.live_rows` | `neon.table.live_rows` |
| `supabase.bgwriter.*` | `neon.bgwriter.*` |
| `supabase.statements.mean_exec_time_ms` | `neon.statements.mean_exec_time_ms` |

### State mapping

| Key in KV (`PG_STATE_KV`) | Covers |
|---|---|
| `supabase-state` | Supabase dedup SHA-256, last push time, metric count |
| `neon-state` | Neon dedup SHA-256, last push time, metric count |

### NeonDB connection string format

Neon uses a standard Postgres wire-protocol URL with SSL required:

```
postgresql://[ROLE]:[PASSWORD]@[HOST].neon.tech/[DBNAME]?sslmode=require
```

Find it in the Neon console → your project → **Connection Details** → **Connection string**.