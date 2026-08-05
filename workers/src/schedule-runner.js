/**
 * Worker 3: Schedule Runner
 * Triggered by CF Cron every minute.
 * Reads workflow_schedules from D1, finds ones due now, inserts trigger jobs into D1 job_queue.
 * Replaces EventBridge entirely.
 */

import { getD1 }              from './lib/d1.js'
import { nowIso, cronIsDue }  from './lib/utils.js'

const FIRST_STEP = {
  'lead-generation':     'lead_tavily_find_company',
  'lead_generation':     'lead_tavily_find_company',
  'lead-email-existing': 'lead_load_existing',
  'lead_email_existing': 'lead_load_existing',
  'social-product':      'social_get_orders',
  'social_product':      'social_get_orders',
  'social-tech':         'social_get_orders',
  'social_tech':         'social_get_orders',
  'blog':                'blog_generate_outline',
  'cur-forwarder':       'cur_run_forwarder',
  'postgres-forwarder':  'pg_run_forwarder',
  'ai-sync':             'ai_sync_run',
  's3-cleanup':          's3_cleanup_run',
  'brevo-sync':          'brevo_sync_run',
  'brevo_sync':          'brevo_sync_run',
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkSchedules(env))
  },

  async fetch(request, env) {
    if (request.method !== 'POST')
      return new Response('POST to trigger manually', { status: 405 })
    await checkSchedules(env)
    return new Response('Schedule check executed', { status: 200 })
  }
}

async function checkSchedules(env) {
  const d1  = getD1(env)
  const now = new Date()

  const schedules = await d1.select('workflow_schedules', {
    enabled: 1,
    _limit:  100,
  })

  console.log(`[schedule-runner] checking ${schedules.length} enabled schedules`)

  for (const schedule of schedules) {
    try {
      await maybeRun(schedule, d1, now)
    } catch (e) {
      console.error(`[schedule-runner] error for schedule ${schedule.id}:`, e)
    }
  }
}

async function maybeRun(schedule, d1, now) {
  const cron = schedule.cron_utc
  if (!cron) {
    console.warn(`[schedule-runner] schedule ${schedule.id} has no cron_utc — skipping`)
    return
  }

  if (!cronIsDue(cron, now)) return

  // Avoid double-trigger within 90s window
  const wfType  = schedule.workflow_type.replace(/-/g, '_')
  const recent  = await d1.select('job_queue', {
    workflow_type: wfType,
    status:        'pending',
    _order:        'created_at DESC',
    _limit:        1,
  })

  if (recent.length) {
    const lastCreated = new Date(recent[0].created_at)
    if ((now - lastCreated) < 90_000) {
      console.log(`[schedule-runner] skipping ${schedule.id} — job queued recently`)
      return
    }
  }

  const firstStep = FIRST_STEP[schedule.workflow_type]
  if (!firstStep) {
    console.warn(`[schedule-runner] no first step for: ${schedule.workflow_type}`)
    return
  }

  const runId     = crypto.randomUUID()
  const nowIsoStr = nowIso()
  const params    = typeof schedule.parameters === 'string'
    ? JSON.parse(schedule.parameters)
    : (schedule.parameters || {})

  await d1.insert('workflow_runs', {
    id:            runId,
    workflow_type: wfType,
    status:        'running',
    input:         {
      ...params,
      workflowRunId: runId,
      scheduledBy:   schedule.id,
      scheduleLabel: schedule.label,
    },
    started_at: nowIsoStr,
  })

  await d1.insert('job_queue', {
    id:              crypto.randomUUID(),
    workflow_run_id: runId,
    workflow_type:   wfType,
    step_name:       firstStep,
    status:          'pending',
    payload:         { ...params, workflowRunId: runId, scheduleId: schedule.id },
    retry_count:     0,
    created_at:      nowIsoStr,
  })

  await d1.update('workflow_schedules', {
    last_run_at: nowIsoStr,
  }, { id: schedule.id })

  console.log(`[schedule-runner] triggered ${wfType} run=${runId} from schedule ${schedule.id}`)
}