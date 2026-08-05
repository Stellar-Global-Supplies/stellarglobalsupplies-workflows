/**
 * Tech Jobs — Step Handlers
 *
 * Trigger remote Cloudflare Workers (forwarders) via HTTP for on-demand runs.
 * Each forwarder has its own cron schedule for automated runs — this handler
 * enables manual triggering from the Tech Jobs page.
 *
 * Steps:
 *   cur_run_forwarder     → calls CUR forwarder /run endpoint
 *   pg_run_forwarder      → calls Postgres forwarder /run endpoint
 *   ai_sync_run           → calls AI Sync worker /run endpoint
 *   s3_cleanup_run        → calls S3 Cleanup worker /run endpoint
 *
 * Required vars on workers-job-runner:
 *   CUR_FORWARDER_URL       e.g. https://cur-forwarder.<subdomain>.workers.dev
 *   POSTGRES_FORWARDER_URL  e.g. https://postgres-forwarder.<subdomain>.workers.dev
 *   AI_SYNC_URL             e.g. https://ai-sync.<subdomain>.workers.dev
 *   S3_CLEANUP_URL          e.g. https://s3-cleanup.<subdomain>.workers.dev
 */

// Helper to resolve Cloudflare secrets (handles both string and secret objects)
async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  if (typeof val === 'string') return val
  return String(val)
}

async function triggerForwarder(env, urlVarName, label, logPrefix) {
  const url = await resolveSecret(env[urlVarName])
  if (!url) {
    const msg = `${urlVarName} is not configured on workers-job-runner`
    console.warn(`[${logPrefix}] WARNING: ${msg}`)
    return { 
      ok: false, 
      message: msg, 
      skipped: true,
      reason: 'URL not configured'
    }
  }

  const base = url.replace(/\/$/, '')
  const runUrl = `${base}/run`

  console.log(`[${logPrefix}] triggering ${runUrl}`)

  try {
    const res = await fetch(runUrl, {
      method:  'GET',
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(25_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const msg = `${label} forwarder returned HTTP ${res.status}: ${body.slice(0, 200)}`
      console.warn(`[${logPrefix}] WARNING: ${msg}`)
      return { 
        ok: false, 
        message: msg, 
        skipped: true,
        reason: `HTTP ${res.status}`,
        statusCode: res.status
      }
    }

    const data = await res.json().catch(() => null)
    console.log(`[${logPrefix}] triggered: ${JSON.stringify(data)}`)

    return { ok: true, message: `${label} forwarder started`, response: data }
  } catch (error) {
    const msg = `${label} forwarder failed: ${error.message}`
    console.warn(`[${logPrefix}] WARNING: ${msg}`)
    return { 
      ok: false, 
      message: msg, 
      skipped: true,
      reason: error.message
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step: Run CUR Forwarder
// Calls https://<cur-forwarder>/run — pushes AWS CUR metrics to New Relic
// ═══════════════════════════════════════════════════════════════════════════

export async function curRunForwarder(ctx) {
  const { env } = ctx
  const result = await triggerForwarder(env, 'CUR_FORWARDER_URL', 'CUR', 'cur_run_forwarder')

  if (ctx.workflow_run_id) {
    await ctx.d1.update('workflow_runs', {
      output: { ...result, step: 'cur_run_forwarder' },
    }, { id: ctx.workflow_run_id })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step: Run Postgres Forwarder
// Calls https://<postgres-forwarder>/run — collects pg_stat_* metrics from
// Supabase + Neon and ships to New Relic
// ═══════════════════════════════════════════════════════════════════════════

export async function pgRunForwarder(ctx) {
  const { env } = ctx
  const result = await triggerForwarder(env, 'POSTGRES_FORWARDER_URL', 'Postgres', 'pg_run_forwarder')

  if (ctx.workflow_run_id) {
    await ctx.d1.update('workflow_runs', {
      output: { ...result, step: 'pg_run_forwarder' },
    }, { id: ctx.workflow_run_id })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step: Run AI Sync
// Calls https://<ai-sync>/run — syncs whitelisted Supabase data to Neon
// ═══════════════════════════════════════════════════════════════════════════

export async function aiSyncRun(ctx) {
  const { env } = ctx
  const result = await triggerForwarder(env, 'AI_SYNC_URL', 'AI Sync', 'ai_sync_run')

  if (ctx.workflow_run_id) {
    await ctx.d1.update('workflow_runs', {
      output: { ...result, step: 'ai_sync_run' },
    }, { id: ctx.workflow_run_id })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step: Run S3 Cleanup
// Calls https://<s3-cleanup>/run — enforces per-bucket S3 retention policies
// ═══════════════════════════════════════════════════════════════════════════

export async function s3CleanupRun(ctx) {
  const { env } = ctx
  const result = await triggerForwarder(env, 'S3_CLEANUP_URL', 'S3 Cleanup', 's3_cleanup_run')

  if (ctx.workflow_run_id) {
    await ctx.d1.update('workflow_runs', {
      output: { ...result, step: 's3_cleanup_run' },
    }, { id: ctx.workflow_run_id })
  }
}
