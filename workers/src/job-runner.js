/**
 * Worker 2: Job Runner
 * Triggered by CF Cron every minute.
 * Picks ONE pending job from D1 job_queue, executes it, inserts next job, dies.
 *
 * D1  → job_queue, workflow_runs, approval_queue
 * Supabase → leads, social_posts, blog_posts, orders (accessed in Phase 4 step handlers)
 */

import { getD1 }     from './lib/d1.js'
import { nowIso }    from './lib/utils.js'
import {
  paymentFetchOverdue,
  paymentBedrockDraftEmail,
  paymentApprovalGate,
  paymentSendEmail,
} from './steps/payment-followup.js'

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNextJob(env))
  },

  async fetch(request, env) {
    if (request.method !== 'POST')
      return new Response('POST to trigger manually', { status: 405 })
    await runNextJob(env)
    return new Response('Job runner executed', { status: 200 })
  }
}

async function runNextJob(env) {
  const d1 = getD1(env)

  const pending = await d1.select('job_queue', {
    status:  'pending',
    _order:  'created_at ASC',
    _limit:  1,
  })

  if (!pending.length) {
    console.log('[job-runner] no pending jobs')
    return
  }

  const job = pending[0]
  const now = nowIso()

  // Lock the job atomically — only update if still pending
  await d1.update('job_queue', {
    status:       'running',
    picked_up_at: now,
  }, { id: job.id, status: 'pending' })

  // Re-fetch to confirm we got the lock
  const locked = await d1.select('job_queue', { id: job.id, status: 'running', _limit: 1 })
  if (!locked.length) {
    console.log(`[job-runner] job ${job.id} already picked up by another instance`)
    return
  }

  console.log(`[job-runner] running job ${job.id} step=${job.step_name}`)

  try {
    await executeStep(job, d1, env)
  } catch (e) {
    console.error(`[job-runner] step ${job.step_name} failed:`, e)
    await handleFailure(d1, job, e.message)
  }
}

async function executeStep(job, d1, env) {
  const handler = STEP_HANDLERS[job.step_name]
  if (!handler) throw new Error(`Unknown step: ${job.step_name}`)

  const ctx = {
    d1,
    env,
    job,
    workflow_run_id: job.workflow_run_id,
    workflow_type:   job.workflow_type,
    payload:         typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload,
  }

  await handler(ctx)
  await markDone(d1, job.id)
}

async function markDone(d1, jobId) {
  await d1.update('job_queue', {
    status:       'done',
    completed_at: nowIso(),
  }, { id: jobId })
}

async function markWaitingForApproval(d1, jobId) {
  await d1.update('job_queue', {
    status: 'waiting_for_approval',
  }, { id: jobId })
}

async function handleFailure(d1, job, errorMsg) {
  const maxRetries = 3
  const retryCount = (job.retry_count || 0) + 1

  if (retryCount <= maxRetries) {
    await d1.update('job_queue', {
      status:      'pending',
      retry_count: retryCount,
      error_msg:   errorMsg,
    }, { id: job.id })
    console.log(`[job-runner] retry ${retryCount}/${maxRetries} for job ${job.id}`)
  } else {
    await d1.update('job_queue', {
      status:       'failed',
      error_msg:    errorMsg,
      completed_at: nowIso(),
    }, { id: job.id })

    if (job.workflow_run_id) {
      await d1.update('workflow_runs', {
        status:       'failed',
        completed_at: nowIso(),
        error_msg:    `Step ${job.step_name} failed after ${maxRetries} retries: ${errorMsg}`,
      }, { id: job.workflow_run_id })
    }
  }
}

/**
 * Insert next job in the chain.
 * Called by every step handler to advance the workflow.
 */
export async function nextJob(ctx, stepName, payloadOverride = {}) {
  const { d1, workflow_run_id, workflow_type, payload } = ctx
  await d1.insert('job_queue', {
    id:              crypto.randomUUID(),
    workflow_run_id,
    workflow_type,
    step_name:       stepName,
    status:          'pending',
    payload:         { ...payload, ...payloadOverride },
    retry_count:     0,
    created_at:      nowIso(),
  })
}

/**
 * Insert approval gate — pauses workflow until human approves.
 * The next job is inserted by api-router when approval comes in.
 */
export async function insertApprovalGate(ctx, nextStep, approvalData) {
  const { d1, workflow_run_id, workflow_type, payload, job } = ctx
  const approvalId = crypto.randomUUID()
  const now        = nowIso()

  await d1.insert('approval_queue', {
    id:              approvalId,
    workflow_type,
    workflow_run_id,
    reference_id:    approvalData.referenceId || null,
    task_token:      `wf-${workflow_run_id}-${job.id}`,
    payload:         { ...payload, approvalGate: 'save', _nextStep: nextStep },
    preview_html:    approvalData.previewHtml || '',
    status:          'pending',
    created_at:      now,
  })

  await markWaitingForApproval(d1, job.id)

  if (workflow_run_id) {
    await d1.update('workflow_runs', {
      status: 'awaiting_approval',
    }, { id: workflow_run_id })
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// STEP HANDLERS
// Phase 2: stubs — log and advance. Phase 4: real implementations.
// ═══════════════════════════════════════════════════════════════════════════

const STEP_HANDLERS = {

  // ── Lead Generation ──────────────────────────────────────────────────────
  lead_tavily_find_company:   async (ctx) => { console.log('[stub] lead_tavily_find_company');   await nextJob(ctx, 'lead_groq_extract_company') },
  lead_groq_extract_company:  async (ctx) => { console.log('[stub] lead_groq_extract_company');  await nextJob(ctx, 'lead_check_duplicate') },
  lead_check_duplicate:       async (ctx) => { console.log('[stub] lead_check_duplicate');       await nextJob(ctx, 'lead_tavily_find_contact') },
  lead_tavily_find_contact:   async (ctx) => { console.log('[stub] lead_tavily_find_contact');   await nextJob(ctx, 'lead_tavily_scrape_website') },
  lead_tavily_scrape_website: async (ctx) => { console.log('[stub] lead_tavily_scrape_website'); await nextJob(ctx, 'lead_groq_extract_email') },
  lead_groq_extract_email:    async (ctx) => { console.log('[stub] lead_groq_extract_email');    await nextJob(ctx, 'lead_save') },
  lead_save:                  async (ctx) => { console.log('[stub] lead_save');                  await nextJob(ctx, 'lead_bedrock_draft_email') },
  lead_bedrock_draft_email:   async (ctx) => {
    console.log('[stub] lead_bedrock_draft_email')
    await insertApprovalGate(ctx, 'lead_send_email', { previewHtml: '<p>Lead email draft (stub)</p>' })
  },
  lead_send_email:            async (ctx) => { console.log('[stub] lead_send_email') },

  // ── Lead Email Existing ───────────────────────────────────────────────────
  lead_load_existing:         async (ctx) => { console.log('[stub] lead_load_existing'); await nextJob(ctx, 'lead_bedrock_draft_email') },

  // ── Social Product / Tech ─────────────────────────────────────────────────
  social_get_orders:            async (ctx) => { console.log('[stub] social_get_orders');            await nextJob(ctx, 'social_bedrock_generate_post') },
  social_bedrock_generate_post: async (ctx) => { console.log('[stub] social_bedrock_generate_post'); await nextJob(ctx, 'social_image_submit') },
  social_image_submit:          async (ctx) => { console.log('[stub] social_image_submit');          await nextJob(ctx, 'social_image_poll', { imageEventId: 'stub-event-id' }) },
  social_image_poll:            async (ctx) => {
    console.log('[stub] social_image_poll')
    await insertApprovalGate(ctx, 'social_post_to_platforms', { previewHtml: '<p>Social post ready (stub)</p>' })
  },
  social_post_to_platforms:   async (ctx) => { console.log('[stub] social_post_to_platforms') },

  // ── Blog ──────────────────────────────────────────────────────────────────
  blog_generate_outline:   async (ctx) => { console.log('[stub] blog_generate_outline');  await nextJob(ctx, 'blog_generate_content') },
  blog_generate_content:   async (ctx) => { console.log('[stub] blog_generate_content');  await nextJob(ctx, 'blog_image_submit') },
  blog_image_submit:       async (ctx) => { console.log('[stub] blog_image_submit');      await nextJob(ctx, 'blog_image_poll', { imageEventId: 'stub-event-id' }) },
  blog_image_poll:         async (ctx) => {
    console.log('[stub] blog_image_poll')
    await insertApprovalGate(ctx, 'blog_create_github_pr', { previewHtml: '<p>Blog post ready (stub)</p>' })
  },
  blog_create_github_pr:   async (ctx) => { console.log('[stub] blog_create_github_pr') },

  // ── Payment Followup ─────────────────────────────────────────── LIVE ✓ ──
  payment_fetch_overdue:       (ctx) => paymentFetchOverdue(ctx),
  payment_bedrock_draft_email: (ctx) => paymentBedrockDraftEmail(ctx),
  payment_approval_gate:       (ctx) => paymentApprovalGate(ctx),
  payment_send_email:          (ctx) => paymentSendEmail(ctx),
}