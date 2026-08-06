/**
 * Tech Jobs — Step Handlers
 *
 * Trigger forwarder Workers via Cloudflare Service Bindings (direct worker-to-worker,
 * no HTTP, no DNS, no workers.dev — eliminates the 1042 "worker not found" error).
 *
 * Steps:
 *   cur_run_forwarder     → env.SVC_CUR_FORWARDER.fetch('http://x/run')
 *   pg_run_forwarder      → env.SVC_POSTGRES_FORWARDER.fetch('http://x/run')
 *   ai_sync_run           → env.SVC_AI_SYNC.fetch('http://x/run')
 *   s3_cleanup_run        → env.SVC_S3_CLEANUP.fetch('http://x/run')
 *
 * Required service bindings on workers-job-runner (wrangler.toml [[services]]):
 *   SVC_CUR_FORWARDER       → service = "cur-forwarder"
 *   SVC_POSTGRES_FORWARDER  → service = "postgres-forwarder"
 *   SVC_AI_SYNC             → service = "ai-sync"
 *   SVC_S3_CLEANUP          → service = "s3-cleanup"
 */

async function triggerForwarder(svcBinding, label, logPrefix) {
  if (!svcBinding) {
    throw new Error(`Service binding for ${label} is not configured on workers-job-runner`)
  }

  console.log(`[${logPrefix}] triggering ${label} via service binding`)

  // Service bindings require a valid URL — the hostname is ignored, only the path matters
  const res = await svcBinding.fetch('http://worker/run', {
    method:  'GET',
    headers: { Accept: 'application/json' },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${label} forwarder returned HTTP ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = await res.json().catch(() => null)
  console.log(`[${logPrefix}] triggered: ${JSON.stringify(data)}`)

  return { ok: true, message: `${label} forwarder started`, response: data }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step: Run CUR Forwarder
// Calls https://<cur-forwarder>/run — pushes AWS CUR metrics to New Relic
// ═══════════════════════════════════════════════════════════════════════════

export async function curRunForwarder(ctx) {
  const { env } = ctx
  const result = await triggerForwarder(env.SVC_CUR_FORWARDER, 'CUR', 'cur_run_forwarder')

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
  const result = await triggerForwarder(env.SVC_POSTGRES_FORWARDER, 'Postgres', 'pg_run_forwarder')

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
  const result = await triggerForwarder(env.SVC_AI_SYNC, 'AI Sync', 'ai_sync_run')

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
  const result = await triggerForwarder(env.SVC_S3_CLEANUP, 'S3 Cleanup', 's3_cleanup_run')

  if (ctx.workflow_run_id) {
    await ctx.d1.update('workflow_runs', {
      output: { ...result, step: 's3_cleanup_run' },
    }, { id: ctx.workflow_run_id })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step: Run Brevo Sync
// Calls https://<brevo-sync>/run — syncs Supabase contacts to NeonDB + Brevo
// ═══════════════════════════════════════════════════════════════════════════

export async function brevoSyncRun(ctx) {
  const { env } = ctx
  const result = await triggerForwarder(env.SVC_BREVO_SYNC, 'Brevo Sync', 'brevo_sync_run')

  if (ctx.workflow_run_id) {
    await ctx.d1.update('workflow_runs', {
      output: { ...result, step: 'brevo_sync_run' },
    }, { id: ctx.workflow_run_id })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step: Run Brevo Campaign
// Calls brevo-campaign worker via service binding — builds HTML, creates
// Brevo email campaign, and sends it. Accepts full campaign params in payload.
// ═══════════════════════════════════════════════════════════════════════════

export async function brevoCampaignRun(ctx) {
  const { env, payload } = ctx

  if (!env.SVC_BREVO_CAMPAIGN) {
    throw new Error('Service binding SVC_BREVO_CAMPAIGN is not configured on stellarglobalsupplies-workflows')
  }

  console.log(`[brevo_campaign_run] triggering campaign for "${payload.productTitle}" → lists ${JSON.stringify(payload.listIds)}`)

  // POST the full payload — campaign worker needs the product params
  const res = await env.SVC_BREVO_CAMPAIGN.fetch('http://worker/run', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`brevo-campaign worker returned HTTP ${res.status}: ${body.slice(0, 300)}`)
  }

  const data = await res.json().catch(() => null)
  console.log(`[brevo_campaign_run] started: ${JSON.stringify(data)}`)

  if (ctx.workflow_run_id) {
    await ctx.d1.update('workflow_runs', {
      output: { ...data, step: 'brevo_campaign_run' },
    }, { id: ctx.workflow_run_id })
  }
}