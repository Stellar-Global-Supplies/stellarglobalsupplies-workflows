/**
 * Worker 1: API Router
 *
 * Data split:
 *   D1 (env.DB)          → job_queue, workflow_runs, workflow_schedules, approval_queue
 *   Supabase (env.*)     → leads, social_posts, blog_posts, orders
 *
 * All routes identical to before — frontend sees no difference.
 */

import { getClient }           from './lib/supabase.js'
import { getD1 }               from './lib/d1.js'
import { ok, err, preflight, nowIso, buildCron } from './lib/utils.js'
import { readJson }             from './lib/assets.js'
import { bedrockGenerateJson } from './lib/bedrock.js'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
}

function corsErr(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

export default {
  async fetch(request, env) {
    // Always handle OPTIONS first — before anything can throw
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    try {
      const url    = new URL(request.url)
      const path   = url.pathname
      const method = request.method
      const qs     = url.searchParams
      const sb     = getClient(env)
      const d1     = getD1(env)

      // GET /workflows/:runId/status — live progress polling
      if (path.match(/\/workflows\/[a-f0-9-]{36}\/status/) && method === 'GET')
        return handleWorkflowStatus(path, d1)

      // POST /workflows/:runId/stop|pause|continue — control running workflows
      const controlMatch = path.match(/\/workflows\/([a-f0-9-]{36})\/(stop|pause|continue)$/)
      if (controlMatch && method === 'POST')
        return handleWorkflowControl(controlMatch[1], controlMatch[2], d1)

      if (path.startsWith('/workflows/') && method === 'POST')
        return handleTrigger(path, request, d1)

      if (path.startsWith('/approvals'))
        return handleApprovals(path, method, request, qs, d1, env)

      if (path.startsWith('/data'))
        return handleData(path, method, request, qs, sb, d1, env)

      if (path.startsWith('/schedules'))
        return handleSchedules(path, method, request, qs, d1)

      // Temporary debug endpoint — remove after secrets confirmed
      if (path === '/debug-env' && method === 'GET') {
        return new Response(JSON.stringify({
          has_supabase_url:  !!env.SUPABASE_URL,
          has_supabase_key:  !!env.SUPABASE_SERVICE_KEY,
          has_bedrock_key:   !!env.BEDROCK_ACCESS_KEY_ID,
          has_db:            !!env.DB,
          supabase_url_preview: env.SUPABASE_URL ? env.SUPABASE_URL.slice(0,30) + '...' : 'MISSING',
        }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } })
      }

      return err('Not found', 404)

    } catch (e) {
      console.error('api-router unhandled error:', e)
      // Use corsErr here — guarantees CORS headers even on startup crashes
      return corsErr(`Internal error: ${e.message}`, 500)
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW TRIGGER
// ═══════════════════════════════════════════════════════════════════════════

const VALID_WORKFLOW_TYPES = [
  'lead-generation', 'lead-email-existing', 'social-product',
  'social-tech', 'blog', 'payment-followup',
]

const FIRST_STEP = {
  'lead-generation':    'lead_select_product_and_industry',
  'lead-email-existing':'lead_load_existing',
  'social-product':     'social_get_orders',
  'social-tech':        'social_get_orders',
  'blog':               'blog_generate_outline',
  'payment-followup':   'payment_fetch_overdue',
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW CONTROL — stop / pause / continue
// ═══════════════════════════════════════════════════════════════════════════

async function handleWorkflowControl(runId, action, d1) {
  const rows = await d1.select('workflow_runs', { id: runId, _limit: 1 })
  if (!rows.length) return err('Workflow run not found', 404)
  const run = rows[0]
  const now = nowIso()

  if (action === 'stop') {
    // Stop: mark as stopped, cancel all pending jobs
    await d1.update('workflow_runs', {
      status:       'stopped',
      completed_at: now,
      output:       { stopped: true },
    }, { id: runId })
    // Cancel all pending jobs for this run
    await d1.update('job_queue', {
      status:       'stopped',
      completed_at: now,
      error_msg:    'Workflow stopped by user',
    }, { workflow_run_id: runId, status: 'pending' })
    return ok({ message: 'Workflow stopped', runId })
  }

  if (action === 'pause') {
    if (run.status !== 'running') return err(`Workflow is ${run.status} — cannot pause`)
    await d1.update('workflow_runs', {
      status: 'paused',
    }, { id: runId })
    return ok({ message: 'Workflow paused', runId })
  }

  if (action === 'continue') {
    if (run.status !== 'paused') return err(`Workflow is ${run.status} — cannot continue`)
    await d1.update('workflow_runs', {
      status: 'running',
    }, { id: runId })
    return ok({ message: 'Workflow continued', runId })
  }

  return err(`Unknown action: ${action}`, 404)
}

async function handleTrigger(path, request, d1) {
  const wfType = path.replace('/workflows/', '').split('/')[0]
  if (!VALID_WORKFLOW_TYPES.includes(wfType))
    return err(`Unknown workflow type: ${wfType}. Valid: ${VALID_WORKFLOW_TYPES.join(', ')}`)

  const body  = await request.json().catch(() => ({}))
  
  // Validate required fields per workflow type
  const validationError = validateWorkflowInput(wfType, body)
  if (validationError) return err(validationError)
  
  const runId = crypto.randomUUID()
  const now   = nowIso()

  await d1.insert('workflow_runs', {
    id:            runId,
    workflow_type: wfType.replace(/-/g, '_'),
    status:        'running',
    input:         { ...body, workflowRunId: runId },
    started_at:    now,
  })

  await d1.insert('job_queue', {
    id:              crypto.randomUUID(),
    workflow_run_id: runId,
    workflow_type:   wfType.replace(/-/g, '_'),
    step_name:       FIRST_STEP[wfType],
    status:          'pending',
    payload:         { ...body, workflowRunId: runId },
    retry_count:     0,
    created_at:      now,
  })

  return ok({ workflowRunId: runId, status: 'queued', firstStep: FIRST_STEP[wfType] })
}


// ═══════════════════════════════════════════════════════════════════════════
// APPROVALS  — fully in D1
// ═══════════════════════════════════════════════════════════════════════════

async function handleApprovals(path, method, request, qs, d1, env) {
  const now = nowIso()

  // GET /approvals
  if (method === 'GET' && !path.includes('/approvals/')) {
    const status = qs.get('status') || 'pending'
    const wfType = qs.get('workflow_type') || ''
    const filters = { status, _order: 'created_at DESC', _limit: 50 }
    if (wfType) filters.workflow_type = wfType
    const rows = await d1.select('approval_queue', filters)
    return ok({ approvals: rows, count: rows.length })
  }

  const idMatch = path.match(/\/approvals\/([a-f0-9-]{36})/)
  if (!idMatch) return err('Missing approval ID')
  const approvalId = idMatch[1]

  const rows = await d1.select('approval_queue', { id: approvalId, _limit: 1 })
  if (!rows.length) return err('Approval not found', 404)
  const item = rows[0]

  if (path.endsWith('/email-action'))
    return handleEmailAction(item, approvalId, qs, d1, now)

  if (item.status !== 'pending') return err(`Approval already ${item.status}`)

  const body  = await request.json().catch(() => ({}))
  const note  = body.note  || ''
  const edits = body.edits || {}

  if (path.endsWith('/approve'))    return doApprove(d1, item, approvalId, note, edits, now, env)
  if (path.endsWith('/reject'))     return doReject(d1, item, approvalId, note, now)
  if (path.endsWith('/regenerate')) return doRegenerate(d1, item, approvalId, body, env)

  return err('Unknown approval action', 404)
}

async function doApprove(d1, item, approvalId, note, edits, now, env) {
  const payload = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload
  const gate    = payload.approvalGate || 'save'
  const wfType  = item.workflow_type   || ''
  const runId   = item.workflow_run_id || payload.workflowRunId

  if (edits) await persistEdits(d1, item, edits)

  if (!runId) {
    console.warn(`[doApprove] approvalId=${approvalId} approved but no runId — workflow not updated`)
  }

  if (wfType === 'payment_followup') {
    await d1.insert('job_queue', {
      id:              crypto.randomUUID(),
      workflow_run_id: runId,
      workflow_type:   wfType,
      step_name:       'payment_send_email',
      status:          'pending',
      payload:         { ...payload, approvalId, ...(edits.email || {}) },
      retry_count:     0,
      created_at:      now,
    })
  } else if (gate === 'save') {
    const nextStep = payload._nextStep
    if (nextStep) {
      await d1.insert('job_queue', {
        id:              crypto.randomUUID(),
        workflow_run_id: runId,
        workflow_type:   wfType,
        step_name:       nextStep,
        status:          'pending',
        payload:         { ...payload, approved: true, reviewNote: note },
        retry_count:     0,
        created_at:      now,
      })
    }
  } else if (gate === 'publish') {
    const postId = payload.postId || payload.post?.id
    if (!postId) return err('Cannot publish — no postId in payload')
    await d1.insert('job_queue', {
      id:              crypto.randomUUID(),
      workflow_run_id: runId,
      workflow_type:   wfType,
      step_name:       'social_post_to_platforms',
      status:          'pending',
      payload:         { ...payload, postId },
      retry_count:     0,
      created_at:      now,
    })
  }

  await d1.update('approval_queue', {
    status:        'approved',
    review_note:   note,
    reviewed_at:   now,
    token_used_at: now,
  }, { id: approvalId })

  if (runId) {
    // Set back to 'running' — more jobs are queued to execute
    await d1.update('workflow_runs', {
      status:       'running',
      output:       { approved: true, note, approvalId, gate },
    }, { id: runId })
  }

  return ok({ message: 'Approved', approvalId, gate })
}

async function doReject(d1, item, approvalId, note, now) {
  const payload = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload
  const gate    = payload.approvalGate || 'save'
  const wfType  = item.workflow_type   || ''
  const runId   = item.workflow_run_id || payload.workflowRunId

  await d1.update('approval_queue', {
    status:        'rejected',
    review_note:   note,
    reviewed_at:   now,
    token_used_at: now,
  }, { id: approvalId })

  if (runId) {
    await d1.update('workflow_runs', {
      status:       'failed',
      completed_at: now,
      error_msg:    note || 'Rejected by reviewer',
      output:       { approved: false, note, approvalId, gate },
    }, { id: runId })
  }

  return ok({ message: 'Rejected', approvalId })
}

async function doRegenerate(d1, item, approvalId, body, env) {
  const feedback = (body.feedback || '').trim()
  if (!feedback) return err('feedback is required')

  const payload = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload
  const post    = payload.post || {}
  const blog    = payload.blog || {}

  if (Object.keys(post).length) {
    const prompt = `Original content:
LINKEDIN: ${(post.linkedin || post.content || '').slice(0, 800)}
FACEBOOK: ${post.facebook || ''}
INSTAGRAM: ${post.instagram || ''}
Reviewer feedback: ${feedback}
Return JSON: { "linkedin": "...", "facebook": "...", "instagram": "..." }`

    const system = `You are a senior B2B marketing copywriter for Stellar Global Supplies.
Rewrite the social media post based on reviewer feedback.
Return ONLY valid JSON with keys: linkedin, facebook, instagram.
LinkedIn: 1500+ chars, structured paragraphs. Facebook/Instagram: under 300 chars with 3-5 hashtags.`

    const regen = await bedrockGenerateJson(env, prompt, system, 3000)
    await d1.update('approval_queue',
      { payload: { ...payload, post: { ...post, ...regen } } },
      { id: approvalId }
    )
    return ok({ message: 'Content regenerated', feedback, content: regen })
  }

  if (Object.keys(blog).length) {
    const prompt = `Original blog:
TITLE: ${blog.title || ''}
EXCERPT: ${blog.excerpt || ''}
CONTENT (first 1000 chars): ${(blog.content || '').slice(0, 1000)}
Reviewer feedback: ${feedback}
Return JSON: { "title": "...", "excerpt": "...", "content": "full markdown..." }`

    const system = `You are a professional content writer for Stellar Global Supplies.
Rewrite the blog post based on reviewer feedback.
Return ONLY valid JSON with keys: title, excerpt, content (full markdown).`

    const regen = await bedrockGenerateJson(env, prompt, system, 4000)
    await d1.update('approval_queue',
      { payload: { ...payload, blog: { ...blog, ...regen } } },
      { id: approvalId }
    )
    return ok({ message: 'Blog regenerated', feedback, content: regen })
  }

  return err('No regeneratable content found in this approval')
}

async function handleEmailAction(item, approvalId, qs, d1, now) {
  const token  = qs.get('token')  || ''
  const action = qs.get('action') || ''

  const htmlPage = (msg, isError) => {
    const colour = isError ? '#EF4444' : '#10B981'
    const icon   = isError ? '✕' : '✓'
    return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Stellar Approval</title></head>
<body style="margin:0;padding:40px;font-family:Arial,sans-serif;background:#f1f5f9;text-align:center">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
    <div style="font-size:48px;color:${colour}">${icon}</div>
    <h2 style="color:#0A2547;margin:16px 0 8px">${msg}</h2>
    <p><a href="https://app.stellarglobalsupplies.com/approvals" style="color:#1565C0">View approvals in dashboard</a></p>
  </div>
</body></html>`, { headers: { 'Content-Type': 'text/html' } })
  }

  if (!token || !action)       return htmlPage('Missing token or action.', true)
  if (item.email_token !== token) return htmlPage('Invalid link — token mismatch.', true)
  if (item.token_expires_at && new Date() > new Date(item.token_expires_at))
    return htmlPage('This link has expired. Use the dashboard instead.', true)
  if (item.token_used_at)      return htmlPage('This link has already been used.', false)
  if (item.status !== 'pending') return htmlPage(`Already ${item.status}.`, false)

  if (action === 'approve') {
    await doApprove(d1, item, approvalId, 'Approved via email', {}, now)
    return htmlPage('Approved! The workflow is continuing.', false)
  }
  if (action === 'reject') {
    await doReject(d1, item, approvalId, 'Rejected via email', now)
    return htmlPage('Rejected. Content discarded.', false)
  }
  return htmlPage(`Unknown action: ${action}`, true)
}

async function persistEdits(d1, item, edits) {
  // Note: social_posts and blog_posts live in Supabase, not D1.
  // Inline edit persistence for those tables happens in Phase 4 step handlers
  // where we have both d1 and sb clients. Here we only need the approval payload update.
  const payload  = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload
  const merged   = { ...payload }
  for (const key of ['post','blog','email']) {
    if (edits[key] && merged[key]) merged[key] = { ...merged[key], ...edits[key] }
  }
  await d1.update('approval_queue', { payload: merged }, { id: item.id })
}


// ═══════════════════════════════════════════════════════════════════════════
// DATA  — leads/posts/blogs/orders from Supabase, workflow_runs from D1
// ═══════════════════════════════════════════════════════════════════════════

async function handleData(path, method, request, qs, sb, d1, env) {
  const limit  = parseInt(qs.get('limit')  || '50')
  const offset = parseInt(qs.get('offset') || '0')
  const status = qs.get('status') || ''

  if (method === 'POST') return handleDataAction(path, request, sb, d1)

  // Supabase Storage content
  if (path.includes('/data/content')) {
    const key = qs.get('key')
    if (!key) return err('Missing content key')
    return ok({ content: await readJson(env, key) })
  }

  // Orders — Supabase
  if (path.includes('/data/orders/lookup')) {
    const orderId  = qs.get('order_id')     || ''
    const prodType = qs.get('product_type') || ''
    let params = 'order=created_at.desc&limit=1'
    if (orderId)  params = `id=eq.${orderId}&` + params
    if (prodType) params += `&product_type=eq.${prodType}`
    const rows = await sb.select('orders', params)
    return ok(rows[0] || null)
  }

  if (path.includes('/data/orders')) {
    let params = 'order=created_at.desc'
    const ps = qs.get('payment_status')
    if (ps) params += ps.includes('.') ? `&payment_status=${ps}` : `&payment_status=eq.${ps}`
    const os = qs.get('status')
    if (os) params += os.includes('.') ? `&status=${os}` : `&status=eq.${os}`
    params += `&limit=${limit}&offset=${offset}`
    const rows = await sb.select('orders', params)
    return ok({ orders: rows, count: rows.length })
  }

  // Leads — Supabase
  if (path.includes('/data/leads')) {
    let params = `order=created_at.desc&limit=${limit}&offset=${offset}`
    if (status) params += `&status=eq.${status}`
    const rows = await sb.select('leads', params)
    return ok({ leads: rows, count: rows.length })
  }

  // Social posts — Supabase
  if (path.includes('/data/social-posts')) {
    const type = qs.get('type') || ''
    let params = 'order=created_at.desc'
    if (type)   params += `&type=eq.${type}`
    if (status) params += `&status=eq.${status}`
    params += `&limit=${limit}&offset=${offset}`
    const rows = await sb.select('social_posts', params)
    return ok({ posts: rows, count: rows.length })
  }

  // Blog posts — Supabase
  if (path.includes('/data/blog-posts')) {
    let params = `order=created_at.desc&limit=${limit}&offset=${offset}`
    if (status) params += `&status=eq.${status}`
    const rows = await sb.select('blog_posts', params)
    return ok({ blogs: rows, count: rows.length })
  }

  // Workflow runs — D1
  if (path.includes('/data/workflow-runs')) {
    const wfType  = qs.get('workflow_type') || ''
    const filters = { _order: 'started_at DESC', _limit: limit, _offset: offset }
    if (wfType) filters.workflow_type = wfType
    if (status) filters.status = status
    const rows = await d1.select('workflow_runs', filters)
    return ok({ runs: rows, count: rows.length })
  }

  // Dashboard — mixed sources
  if (path.includes('/data/dashboard')) {
    const [leads, posts, blogs, pending, runs, costRuns] = await Promise.all([
      sb.select('leads',          'select=status'),
      sb.select('social_posts',   'select=status,type'),
      sb.select('blog_posts',     'select=status'),
      d1.select('approval_queue', { status: 'pending', _select: 'id,workflow_type', _limit: 200 }),
      d1.select('workflow_runs',  { _select: 'id,workflow_type,status,started_at,completed_at,cost_usd,input_tokens,output_tokens,image_count', _order: 'started_at DESC', _limit: 5 }),
      d1.select('workflow_runs',  { status: 'succeeded', _select: 'workflow_type,cost_usd', _order: 'started_at DESC', _limit: 200 }),
    ])

    const countBy = (rows, field) => rows.reduce((a, r) => {
      const v = r[field] || 'unknown'; a[v] = (a[v] || 0) + 1; return a
    }, {})

    const costByType = {}
    let totalCost = 0
    for (const r of costRuns) {
      const wt = r.workflow_type || 'unknown'
      const c  = parseFloat(r.cost_usd || 0)
      costByType[wt] = +((costByType[wt] || 0) + c).toFixed(6)
      totalCost += c
    }

    return ok({
      leads:             { total: leads.length, by_status: countBy(leads, 'status') },
      social_posts:      { total: posts.length, by_status: countBy(posts, 'status'), by_type: countBy(posts, 'type') },
      blogs:             { total: blogs.length, by_status: countBy(blogs, 'status') },
      pending_approvals: pending.length,
      workflow_runs:     runs,
      cost:              { total_usd: +totalCost.toFixed(6), by_type: costByType },
    })
  }

  return err('Unknown endpoint', 404)
}

async function handleDataAction(path, request, sb, d1) {
  const body = await request.json().catch(() => ({}))

  // POST /data/social-posts/:id/repost
  const repostMatch = path.match(/\/data\/social-posts\/([^/]+)\/repost$/)
  if (repostMatch) {
    const postId = repostMatch[1]
    const rows   = await sb.select('social_posts', `id=eq.${postId}&limit=1`)
    if (!rows.length) return err('Social post not found', 404)
    await sb.update('social_posts', { status: 'publishing' }, `id=eq.${postId}`)
    await d1.insert('job_queue', {
      id:              crypto.randomUUID(),
      workflow_run_id: null,
      workflow_type:   `social_${rows[0].type || 'product'}`,
      step_name:       'social_post_to_platforms',
      status:          'pending',
      payload:         { postId, post: rows[0] },
      retry_count:     0,
      created_at:      nowIso(),
    })
    return ok({ message: 'Repost queued', postId })
  }

  // POST /data/social-posts/:id/publish  → Gate 2 approval
  const publishMatch = path.match(/\/data\/social-posts\/([^/]+)\/publish$/)
  if (publishMatch) {
    const postId = publishMatch[1]
    const rows   = await sb.select('social_posts', `id=eq.${postId}&limit=1`)
    if (!rows.length) return err('Social post not found', 404)
    const post = rows[0]
    if (post.status !== 'approved_manual')
      return err(`Post must be approved_manual. Current: '${post.status}'`, 400)

    const approvalId = crypto.randomUUID()
    const platforms  = post.platforms || {}
    const active     = Object.entries(platforms).filter(([,v]) => v).map(([k]) => k).join(', ')

    await d1.insert('approval_queue', {
      id:              approvalId,
      workflow_type:   `social_${post.type || 'product'}`,
      workflow_run_id: null,
      reference_id:    postId,
      task_token:      `direct-publish-${crypto.randomUUID()}`,
      payload:         { post, postId, approvalGate: 'publish', _nextStep: 'social_post_to_platforms' },
      preview_html:    `<div style="font-family:Arial,sans-serif;max-width:600px">
        <h2>Publish Approval</h2>
        <p><strong>Title:</strong> ${post.title || ''}</p>
        <p><strong>Platforms:</strong> ${active}</p>
        <p style="white-space:pre-wrap">${(post.caption || post.content || '').slice(0, 500)}</p>
      </div>`,
      status:          'pending',
      created_at:      nowIso(),
    })
    await sb.update('social_posts', { status: 'publishing' }, `id=eq.${postId}`)
    return ok({ message: 'Publish approval queued', approvalId })
  }

  // POST /data/blog-posts/:id/republish
  const blogMatch = path.match(/\/data\/blog-posts\/([^/]+)\/republish$/)
  if (blogMatch) {
    const blogId = blogMatch[1]
    const rows   = await sb.select('blog_posts', `id=eq.${blogId}&limit=1`)
    if (!rows.length) return err('Blog post not found', 404)
    await d1.insert('job_queue', {
      id:              crypto.randomUUID(),
      workflow_run_id: null,
      workflow_type:   'blog',
      step_name:       'blog_create_github_pr',
      status:          'pending',
      payload:         { blogId, blog: rows[0] },
      retry_count:     0,
      created_at:      nowIso(),
    })
    return ok({ message: 'Blog PR creation queued', blogId })
  }

  return err('Unknown action', 404)
}


// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULES — fully in D1
// ═══════════════════════════════════════════════════════════════════════════

const VALID_SCHEDULE_TYPES = ['lead-generation','lead-email-existing','social-product','social-tech','blog']

function validateWorkflowInput(wfType, body) {
  switch (wfType) {
    case 'lead-generation':
      if (!body.location && !body.target_country) return 'Missing required field: location'
      break
    case 'lead-email-existing':
      if (!body.leadId && !body.lead_id) return 'Missing required field: leadId'
      break
    case 'social-product':
      if (!body.order_id && !body.product_name) return 'Missing required field: order_id or product_name'
      break
    case 'social-tech':
      if (!body.repo_name) return 'Missing required field: repo_name'
      break
    case 'blog':
      if (!body.topic && !body.custom_topic && !body.product_name) return 'Missing required field: topic, custom_topic, or product_name'
      break
    case 'payment-followup':
      // No required fields - uses default parameters
      break
  }
  return null
}

async function handleSchedules(path, method, request, qs, d1) {
  const idMatch = path.match(/\/schedules\/([a-f0-9-]{36})/)
  const sid     = idMatch ? idMatch[1] : null
  const toggle  = path.endsWith('/toggle')
  const body    = ['POST','PATCH'].includes(method)
    ? await request.json().catch(() => ({}))
    : {}

  if (method === 'GET'    && !sid)          return listSchedules(d1, qs)
  if (method === 'GET'    && sid)           return getSchedule(d1, sid)
  if (method === 'POST'   && !sid)          return createSchedule(d1, body)
  if (method === 'PATCH'  && sid && toggle) return toggleSchedule(d1, sid, body)
  if (method === 'PATCH'  && sid)           return updateSchedule(d1, sid, body)
  if (method === 'DELETE' && sid)           return deleteSchedule(d1, sid)

  return err('Unknown route', 404)
}

async function listSchedules(d1, qs) {
  const filters = { _order: 'created_at DESC' }
  if (qs.get('workflow_type')) filters.workflow_type = qs.get('workflow_type')
  const rows = await d1.select('workflow_schedules', filters)
  return ok({ schedules: rows, count: rows.length })
}

async function getSchedule(d1, sid) {
  const rows = await d1.select('workflow_schedules', { id: sid, _limit: 1 })
  if (!rows.length) return err('Schedule not found', 404)
  return ok({ schedule: rows[0] })
}

async function createSchedule(d1, body) {
  const valErr = validateSchedule(body, false)
  if (valErr) return err(valErr)

  const now = nowIso()
  const row = {
    id:           crypto.randomUUID(),
    workflow_type: body.workflow_type,
    label:        body.label.trim(),
    frequency:    body.frequency   || 'monthly',
    day_of_month: body.day_of_month ?? 1,
    days_of_week: body.days_of_week ?? [],
    run_time:     body.run_time    || '09:00',
    enabled:      body.enabled     ?? true ? 1 : 0,
    parameters:   body.parameters  || {},
    cron_utc:     buildCron({ ...body, frequency: body.frequency || 'monthly' }),
    created_at:   now,
    updated_at:   now,
  }
  const saved = await d1.insert('workflow_schedules', row)
  return ok({ schedule: saved, message: 'Schedule created' })
}

async function updateSchedule(d1, sid, body) {
  const rows = await d1.select('workflow_schedules', { id: sid, _limit: 1 })
  if (!rows.length) return err('Schedule not found', 404)

  const valErr = validateSchedule(body, true)
  if (valErr) return err(valErr)

  const merged = { ...rows[0], ...body }
  const update = { ...body, cron_utc: buildCron(merged), updated_at: nowIso() }
  delete update.id
  delete update.created_at

  if ('enabled' in update) update.enabled = update.enabled ? 1 : 0

  await d1.update('workflow_schedules', update, { id: sid })
  const updated = await d1.select('workflow_schedules', { id: sid, _limit: 1 })
  return ok({ schedule: updated[0], message: 'Schedule updated' })
}

async function deleteSchedule(d1, sid) {
  const rows = await d1.select('workflow_schedules', { id: sid, _limit: 1 })
  if (!rows.length) return err('Schedule not found', 404)
  await d1.delete('workflow_schedules', { id: sid })
  return ok({ message: 'Schedule deleted', id: sid })
}

async function toggleSchedule(d1, sid, body) {
  const rows = await d1.select('workflow_schedules', { id: sid, _limit: 1 })
  if (!rows.length) return err('Schedule not found', 404)
  const enabled = body.enabled ?? true
  await d1.update('workflow_schedules',
    { enabled: enabled ? 1 : 0, updated_at: nowIso() },
    { id: sid }
  )
  return ok({ id: sid, enabled, message: `Schedule ${enabled ? 'enabled' : 'disabled'}` })
}

function validateSchedule(body, partial) {
  if (!partial) {
    if (!body.workflow_type) return 'workflow_type is required'
    if (!VALID_SCHEDULE_TYPES.includes(body.workflow_type))
      return `workflow_type must be one of: ${VALID_SCHEDULE_TYPES.join(', ')}`
    if (!body.label?.trim()) return 'label is required'
    if (!body.run_time)      return 'run_time is required (HH:MM IST)'
  }
  if (body.frequency && !['daily','weekly','monthly'].includes(body.frequency))
    return 'frequency must be daily, weekly, or monthly'
  if (body.day_of_month != null && !(body.day_of_month >= 1 && body.day_of_month <= 28))
    return 'day_of_month must be between 1 and 28'
  return null
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW STATUS  — polled by WorkflowProgress component every 2s
// ═══════════════════════════════════════════════════════════════════════════

async function handleWorkflowStatus(path, d1) {
  const match = path.match(/\/workflows\/([a-f0-9-]{36})\/status/)
  if (!match) return err('Invalid run ID', 400)
  const runId = match[1]

  const [runs, jobs] = await Promise.all([
    d1.select('workflow_runs', { id: runId, _limit: 1 }),
    d1.select('job_queue', {
      workflow_run_id: runId,
      _order:          'created_at ASC',
      _limit:          50,
    }),
  ])

  if (!runs.length) return err('Workflow run not found', 404)
  const run = runs[0]

  return ok({
    runId,
    status:     run.status,
    startedAt:  run.started_at,
    completedAt: run.completed_at,
    errorMsg:   run.error_msg,
    jobs:       jobs.map(j => ({
      id:          j.id,
      step_name:   j.step_name,
      status:      j.status,
      retry_count: j.retry_count,
      error_msg:   j.error_msg,
      created_at:  j.created_at,
      picked_up_at: j.picked_up_at,
      completed_at: j.completed_at,
    })),
  })
}