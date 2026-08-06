/**
 * Worker 2: Job Runner
 * Triggered by CF Cron every minute.
 * Picks ONE pending job from D1 job_queue, executes it, inserts next job, dies.
 *
 * D1  → job_queue, workflow_runs, approval_queue
 * Supabase → leads, social_posts, blog_posts, orders (accessed in Phase 4 step handlers)
 */

import { getD1 }     from './lib/d1.js'
import {
  socialGetOrders,
  socialBedrockGeneratePost,
  socialImageSubmit,
  socialPostToPlatforms,
  socialGetTechContext,
  socialTechGeneratePost,
  socialTechImageSubmit,
} from './steps/social-post.js'
import { nowIso }    from './lib/utils.js'
import {
  paymentFetchOverdue,
  paymentBedrockDraftEmail,
  paymentApprovalGate,
  paymentSendEmail,
} from './steps/payment-followup.js'
import {
  blogGenerateOutline,
  blogGenerateContent,
  blogImageSubmit,
  blogCreateGithubPr,
} from './steps/blog-post.js'
import {
  leadLoadExisting,
  leadBedrockDraftEmail as leadEmailBedrockDraftEmail,
  leadApprovalGate as leadEmailApprovalGate,
  leadSendEmail as leadEmailSendEmail,
} from './steps/lead-email.js'
import {
  leadSelectProductAndIndustry,
  leadTavilyFindBuyers,
  leadGroqExtractCompany,
  leadCheckDuplicate,
  leadTavilyFindContact,
  leadTavilyScrapeWebsite,
  leadGroqExtractEmail,
  leadSave,
  leadGenBedrockDraftEmail,
  leadGenApprovalGate,
  leadGenSendEmail,
} from './steps/lead-gen.js'
import {
  curRunForwarder,
  pgRunForwarder,
  aiSyncRun,
  s3CleanupRun,
  brevoSyncRun,
  brevoCampaignRun,
} from './steps/tech-jobs.js'

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

  // Skip jobs from paused or stopped workflows
  if (job.workflow_run_id) {
    const run = await d1.select('workflow_runs', { id: job.workflow_run_id, _limit: 1 })
    if (run.length) {
      if (run[0].status === 'paused') {
        console.log(`[job-runner] workflow ${job.workflow_run_id} is paused — skipping job ${job.id}`)
        return
      }
      if (run[0].status === 'stopped') {
        console.log(`[job-runner] workflow ${job.workflow_run_id} is stopped — marking job ${job.id} as stopped`)
        await d1.update('job_queue', {
          status:       'stopped',
          completed_at: now,
          error_msg:    'Workflow was stopped',
        }, { id: job.id })
        return
      }
    }
  }

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

  let payload
  try {
    payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload
  } catch (e) {
    throw new Error(`Invalid JSON in job payload: ${e.message}. Job ID: ${job.id}`)
  }

  const ctx = {
    d1,
    env,
    job,
    workflow_run_id: job.workflow_run_id,
    workflow_type:   job.workflow_type,
    payload,
  }

  await handler(ctx)
  await markDone(d1, job.id)

  // After marking the job done, check if the workflow chain is complete
  // (no more pending jobs for this run). If so, mark workflow_run as succeeded.
  // Add a small delay to allow other instances to pick up newly queued jobs
  if (job.workflow_run_id) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    const remaining = await d1.select('job_queue', {
      workflow_run_id: job.workflow_run_id,
      status:          'pending',
      _limit:          1,
    })
    if (!remaining.length) {
      // Also check if there are running jobs (other instances may have picked up)
      const running = await d1.select('job_queue', {
        workflow_run_id: job.workflow_run_id,
        status:          'running',
        _limit:          1,
      })
      if (!running.length) {
        // No pending AND no running jobs — chain is complete
        const run = await d1.select('workflow_runs', { id: job.workflow_run_id, _limit: 1 })
        if (run.length && run[0].status === 'running') {
          await d1.update('workflow_runs', {
            status:       'succeeded',
            completed_at: nowIso(),
          }, { id: job.workflow_run_id })
          console.log(`[job-runner] workflow ${job.workflow_run_id} completed successfully`)
        }
      }
    }
  }
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

  // ── Lead Generation ────────────────────────────────────────── LIVE ✓ ──
  lead_select_product_and_industry: (ctx) => leadSelectProductAndIndustry(ctx),
  lead_tavily_find_buyers:          (ctx) => leadTavilyFindBuyers(ctx),
  lead_groq_extract_company:   (ctx) => leadGroqExtractCompany(ctx),
  lead_check_duplicate:        (ctx) => leadCheckDuplicate(ctx),
  lead_tavily_find_contact:    (ctx) => leadTavilyFindContact(ctx),
  lead_tavily_scrape_website:  (ctx) => leadTavilyScrapeWebsite(ctx),
  lead_groq_extract_email:     (ctx) => leadGroqExtractEmail(ctx),
  lead_save:                   (ctx) => leadSave(ctx),
  lead_gen_draft_email:        (ctx) => leadGenBedrockDraftEmail(ctx),
  lead_gen_approval_gate:      (ctx) => leadGenApprovalGate(ctx),
  lead_gen_send_email:         (ctx) => leadGenSendEmail(ctx),

  // ── Lead Email Existing ────────────────────────────────────── LIVE ✓ ──
  lead_load_existing:          (ctx) => leadLoadExisting(ctx),
  lead_email_draft_email:      (ctx) => leadEmailBedrockDraftEmail(ctx),
  lead_approval_gate:          (ctx) => leadEmailApprovalGate(ctx),
  lead_send_email:             (ctx) => leadEmailSendEmail(ctx),

  // ── Social Product ─────────────────────────────────────────── LIVE ✓ ──
  social_get_orders:            (ctx) => socialGetOrders(ctx),
  social_bedrock_generate_post: (ctx) => socialBedrockGeneratePost(ctx),
  social_image_submit:          (ctx) => socialImageSubmit(ctx),
  social_post_to_platforms:     (ctx) => socialPostToPlatforms(ctx),

  // ── Social Tech ─────────────────────────────────────────────── LIVE ✓ ──
  social_get_tech_context:      (ctx) => socialGetTechContext(ctx),
  social_tech_generate_post:    (ctx) => socialTechGeneratePost(ctx),
  social_tech_image_submit:     (ctx) => socialTechImageSubmit(ctx),
  // social_post_to_platforms shared between product and tech

  // ── Blog ──────────────────────────────────────────────────── LIVE ✓ ──
  blog_generate_outline:   (ctx) => blogGenerateOutline(ctx),
  blog_generate_content:   (ctx) => blogGenerateContent(ctx),
  blog_image_submit:       (ctx) => blogImageSubmit(ctx),
  // blog_image_poll removed — Workers AI FLUX is synchronous
  blog_create_github_pr:   (ctx) => blogCreateGithubPr(ctx),

  // ── Payment Followup ─────────────────────────────────────────── LIVE ✓ ──
  payment_fetch_overdue:       (ctx) => paymentFetchOverdue(ctx),
  payment_bedrock_draft_email: (ctx) => paymentBedrockDraftEmail(ctx),
  payment_approval_gate:       (ctx) => paymentApprovalGate(ctx),
  payment_send_email:          (ctx) => paymentSendEmail(ctx),

  // ── Tech Jobs (forwarders) ──────────────────────────────────── LIVE ✓ ──
  cur_run_forwarder:           (ctx) => curRunForwarder(ctx),
  pg_run_forwarder:            (ctx) => pgRunForwarder(ctx),
  ai_sync_run:                 (ctx) => aiSyncRun(ctx),
  s3_cleanup_run:              (ctx) => s3CleanupRun(ctx),

  // ── Brevo Contact Sync ──────────────────────────────────────────── LIVE ✓ ──
  brevo_sync_run:              (ctx) => brevoSyncRun(ctx),

  // ── Brevo Email Campaign ─────────────────────────────────────────── LIVE ✓ ──
  brevo_campaign_run:          (ctx) => brevoCampaignRun(ctx),
}