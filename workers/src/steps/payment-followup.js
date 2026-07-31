/**
 * Payment Followup — Step Handlers
 * Ports: fetch_overdue_orders.py + draft_payment_email.py
 *        + create_payment_approval.py + send_payment_email.py
 *
 * Steps:
 *   payment_fetch_overdue        → fetch orders from Supabase
 *   payment_bedrock_draft_email  → Bedrock drafts email
 *   payment_approval_gate        → insert approval_queue row, pause
 *   payment_send_email           → send via Gmail OAuth (triggered on approve)
 *
 * Required secrets on stellar-job-runner Worker:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   BEDROCK_ACCESS_KEY_ID
 *   BEDROCK_SECRET_ACCESS_KEY
 *   BEDROCK_REGION
 *   GMAIL_CLIENT_ID
 *   GMAIL_CLIENT_SECRET
 *   GMAIL_REFRESH_TOKEN
 *   SENDER_EMAIL               sales@stellarglobalsupplies.com
 *   REVIEWER_EMAIL             internal team email for approval notifications
 *   API_BASE_URL               https://stellarglobalsupplies-workflows.workwithprasadbhavsar.workers.dev
 */

import { bedrockGenerateJson } from '../lib/bedrock.js'
import { getClient }           from '../lib/supabase.js'
import { nowIso }              from '../lib/utils.js'
import { nextJob, insertApprovalGate } from '../job-runner.js'

const SENDER_NAME    = 'Stellar Global Supplies Team'
const COMPANY_WEBSITE = 'https://stellarglobalsupplies.com'

const BEDROCK_SYSTEM = `You are a professional accounts receivable executive for Stellar Global Supplies,
a B2B industrial and commercial supplies company based in India.
Write polite but firm payment follow-up emails that:
- Are warm and respectful — this is a valued customer
- Clearly state what is owed and why
- Make it easy for the customer to act (contact us, pay, ask questions)
- Never sound threatening or aggressive
- Use formal Indian business English
- Include a clear subject line`


// ═══════════════════════════════════════════════════════════════════════════
// Step 1: Fetch Overdue Orders
// Mirrors: fetch_overdue_orders.py
// ═══════════════════════════════════════════════════════════════════════════

export async function paymentFetchOverdue(ctx) {
  const { payload, env } = ctx
  const sb      = getClient(env)
  const orderId = payload.orderId || payload.order_id

  if (orderId) {
    // Single order triggered from UI
    const rows = await sb.select('orders', `id=eq.${orderId}&limit=1`)
    if (!rows.length) throw new Error(`Order ${orderId} not found`)

    const order = rows[0]
    if (order.payment_status !== 'After 30 days') {
      throw new Error(
        `Order ${orderId} has payment_status='${order.payment_status}', expected 'After 30 days'`
      )
    }

    console.log(`[payment_fetch_overdue] single order=${orderId} customer=${order.customer_name}`)
    await nextJob(ctx, 'payment_bedrock_draft_email', { order, orderId: order.id, isBatch: false })
    return
  }

  // Batch — all overdue orders
  const rows = await sb.select(
    'orders',
    `payment_status=eq.After%2030%20days&order=created_at.asc&limit=50`
  )

  console.log(`[payment_fetch_overdue] batch: found ${rows.length} overdue orders`)

  if (!rows.length) {
    console.log('[payment_fetch_overdue] no overdue orders — workflow complete')
    return  // nothing to do, mark done
  }

  // Insert one job per order — each runs independently through the chain
  const { d1, workflow_run_id, workflow_type } = ctx
  for (const order of rows) {
    await d1.insert('job_queue', {
      id:              crypto.randomUUID(),
      workflow_run_id,
      workflow_type,
      step_name:       'payment_bedrock_draft_email',
      status:          'pending',
      payload:         { ...payload, order, orderId: order.id, isBatch: true },
      retry_count:     0,
      created_at:      nowIso(),
    })
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Draft Email with Bedrock
// Mirrors: draft_payment_email.py
// ═══════════════════════════════════════════════════════════════════════════

export async function paymentBedrockDraftEmail(ctx) {
  const { payload, env } = ctx
  const order = payload.order || {}

  if (!order.id) throw new Error('Missing order in payload')

  const senderEmail  = env.SENDER_EMAIL || 'sales@stellarglobalsupplies.com'
  const saleCost     = parseFloat(order.sale_cost    || 0)
  const cgst         = parseFloat(order.cgst_total   || 0)
  const sgst         = parseFloat(order.sgst_total   || 0)
  const total        = saleCost + cgst + sgst
  const orderDate    = (order.created_at || '').slice(0, 10)
  const fmt          = n => `₹${parseFloat(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`

  const prompt = `Draft a payment follow-up email from ${SENDER_NAME} to ${order.customer_name || 'Valued Customer'}.

ORDER DETAILS (include all of this in the email):
- Order Date:      ${orderDate}
- Customer Name:   ${order.customer_name || ''}
- Product:         ${order.material || ''} (${order.product_type || ''})
- Quantity:        ${order.quantity || ''} ${order.unit || 'Pieces'}
- Base Amount:     ${fmt(saleCost)}
- CGST:            ${fmt(cgst)}
- SGST:            ${fmt(sgst)}
- Total Payable:   ${fmt(total)}
- Delivery:        ${order.delivery_timeline || 'N/A'}
- Payment Terms:   After 30 days (now due)
- Order Status:    ${order.status || 'Delivered'}

EMAIL REQUIREMENTS:
1. Subject line that clearly indicates this is a payment follow-up
2. Opening: thank them for their business and reference the specific order
3. State the total amount due (${fmt(total)}) and that payment was due after 30 days of delivery
4. Include the full order breakdown (product, qty, base, GST, total)
5. Ask them to arrange payment at the earliest convenience
6. Provide contact details: email (${senderEmail}) and website (${COMPANY_WEBSITE})
7. Keep a warm but professional tone throughout
8. Sign off as ${SENDER_NAME}

Return JSON with exactly these fields:
{
  "subject": "Payment Follow-up: [Product] Order – ${fmt(total)} Due",
  "body": "full professional email body with all order details, amount breakdown, and polite payment request"
}`

  const draft = await bedrockGenerateJson(env, prompt, BEDROCK_SYSTEM, 1500)

  console.log(`[payment_bedrock_draft_email] drafted for order=${order.id} customer=${order.customer_name} total=${fmt(total)}`)

  await nextJob(ctx, 'payment_approval_gate', {
    emailDraft: {
      ...draft,
      to:            order.email || '',
      customer_name: order.customer_name || '',
      total_payable: total,
      order_id:      order.id,
    },
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 3: Create Approval Gate
// Mirrors: create_payment_approval.py
// ═══════════════════════════════════════════════════════════════════════════

export async function paymentApprovalGate(ctx) {
  const { payload, env, d1, workflow_run_id, workflow_type, job } = ctx
  const order      = payload.order      || {}
  const emailDraft = payload.emailDraft || {}

  if (!emailDraft.subject) throw new Error('Missing emailDraft in payload')

  const approvalId   = crypto.randomUUID()
  const emailToken   = crypto.randomUUID().replace(/-/g, '')
  const expiresAt    = new Date(Date.now() + 60 * 60 * 1000).toISOString()  // 1 hour
  const now          = nowIso()
  const apiBase      = (env.API_BASE_URL || '').replace(/\/$/, '')
  const approveUrl   = `${apiBase}/approvals/${approvalId}/email-action?token=${emailToken}&action=approve`
  const rejectUrl    = `${apiBase}/approvals/${approvalId}/email-action?token=${emailToken}&action=reject`
  const senderEmail  = env.SENDER_EMAIL || 'sales@stellarglobalsupplies.com'

  const approvalPayload = {
    approvalGate:  'save',
    workflowType:  'payment_followup',
    orderId:       order.id,
    order,
    email: {
      to:      emailDraft.to      || '',
      subject: emailDraft.subject || '',
      body:    emailDraft.body    || '',
    },
    totalPayable:  emailDraft.total_payable || 0,
    customerName:  emailDraft.customer_name || '',
  }

  // Build preview HTML for dashboard
  const bodyPreview = (emailDraft.body || '').slice(0, 600)
  const previewHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <h2 style="color:#0A2547">Payment Follow-up — ${order.customer_name || ''}</h2>
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:20px">
        <p><strong>To:</strong> ${emailDraft.to || ''}</p>
        <p><strong>Subject:</strong> ${emailDraft.subject || ''}</p>
        <p><strong>Total Payable:</strong> ₹${parseFloat(emailDraft.total_payable || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
        <hr style="border:none;border-top:1px solid #E2E8F0"/>
        <div style="white-space:pre-wrap;font-size:13px">${bodyPreview}${bodyPreview.length === 600 ? '...' : ''}</div>
      </div>
    </div>`

  await d1.insert('approval_queue', {
    id:              approvalId,
    workflow_type:   'payment_followup',
    workflow_run_id,
    reference_id:    order.id || null,
    task_token:      `payment-direct-${crypto.randomUUID()}`,
    payload:         approvalPayload,
    preview_html:    previewHtml,
    status:          'pending',
    email_token:     emailToken,
    token_expires_at: expiresAt,
    created_at:      now,
  })

  console.log(`[payment_approval_gate] approval_id=${approvalId} order=${order.id} customer=${order.customer_name}`)

  // Send notification email to reviewer
  try {
    const reviewerEmail = env.REVIEWER_EMAIL
    if (reviewerEmail) {
      await sendApprovalNotification(env, {
        to:          reviewerEmail,
        approvalId,
        emailToken,
        approveUrl,
        rejectUrl,
        order,
        emailDraft,
        senderEmail,
      })
    }
  } catch (e) {
    console.warn(`[payment_approval_gate] notification email failed: ${e.message}`)
    // Don't throw — approval row is already created, workflow can continue via dashboard
  }

  // Mark job as waiting for approval
  await d1.update('job_queue', { status: 'waiting_for_approval' }, { id: job.id })
  if (workflow_run_id) {
    await d1.update('workflow_runs', { status: 'awaiting_approval' }, { id: workflow_run_id })
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 4: Send Email
// Mirrors: send_payment_email.py
// Triggered by api-router on approval — inserted as a new job_queue row
// ═══════════════════════════════════════════════════════════════════════════

export async function paymentSendEmail(ctx) {
  const { payload, env } = ctx
  const order       = payload.order      || {}
  const emailData   = payload.email      || {}
  const approvalId  = payload.approvalId
  const senderEmail = env.SENDER_EMAIL   || 'sales@stellarglobalsupplies.com'

  const to      = emailData.to      || order.email || ''
  const subject = emailData.subject || 'Payment Follow-up'
  const body    = emailData.body    || ''

  if (!to) throw new Error('No recipient email address on order')

  const html         = buildHtmlEmail(subject, body, order)
  const accessToken  = await getGmailToken(env)
  const result       = await sendViaGmail(accessToken, to, subject, html, senderEmail)

  console.log(`[payment_send_email] sent to=${to} messageId=${result.id} order=${order.id}`)

  // Update approval status in D1
  if (approvalId) {
    try {
      await ctx.d1.update('approval_queue', {
        status:      'approved',
        reviewed_at: nowIso(),
      }, { id: approvalId })
    } catch (e) {
      console.warn(`[payment_send_email] approval update failed: ${e.message}`)
    }
  }

  // Update order in Supabase to note followup sent
  try {
    const sb = getClient(env)
    await sb.update('orders', {
      payment_followup_sent_at: nowIso(),
    }, `id=eq.${order.id}`)
  } catch (e) {
    // Column may not exist — non-fatal
    console.warn(`[payment_send_email] order update failed (non-fatal): ${e.message}`)
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Gmail helpers — mirrors _get_gmail_token + _send_via_gmail in both Lambdas
// ═══════════════════════════════════════════════════════════════════════════

async function getGmailToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Gmail token refresh failed ${res.status}: ${t}`)
  }
  const data = await res.json()
  return data.access_token
}

async function sendViaGmail(accessToken, to, subject, html, sender) {
  const mime = [
    `From: Stellar Global Supplies <${sender}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    html,
  ].join('\r\n')

  const raw = btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Gmail send failed ${res.status}: ${t}`)
  }
  return res.json()
}

async function sendApprovalNotification(env, { to, approvalId, emailToken, approveUrl, rejectUrl, order, emailDraft, senderEmail }) {
  const customer    = order.customer_name || ''
  const bodyPreview = (emailDraft.body || '').slice(0, 600)
  const total       = parseFloat(emailDraft.total_payable || 0)
    .toLocaleString('en-IN', { minimumFractionDigits: 2 })

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
        style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:#0A2547;padding:24px 32px">
            <div style="color:#F59E0B;font-size:20px;font-weight:bold">Stellar Global Supplies</div>
            <div style="color:#94A3B8;font-size:13px;margin-top:4px">Payment Follow-up Approval</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 16px">
            <div style="font-size:20px;font-weight:bold;color:#0A2547">
              Payment Follow-up — ${customer}
            </div>
            <div style="color:#64748B;font-size:14px;margin-top:6px">
              Total Payable: <strong>₹${total}</strong> · Links expire in <strong>1 hour</strong>.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px">
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:20px;font-size:14px;color:#334155">
              <p><strong>To:</strong> ${emailDraft.to || ''}</p>
              <p><strong>Subject:</strong> ${emailDraft.subject || ''}</p>
              <hr style="border:none;border-top:1px solid #E2E8F0;margin:12px 0"/>
              <div style="white-space:pre-wrap;font-size:13px">${bodyPreview}${bodyPreview.length === 600 ? '...' : ''}</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px">
            <table width="100%"><tr>
              <td width="48%" align="center">
                <a href="${approveUrl}"
                   style="display:block;background:#10B981;color:#fff;text-decoration:none;
                          font-size:16px;font-weight:bold;padding:14px 20px;border-radius:8px;text-align:center">
                  ✓ &nbsp; Approve & Send
                </a>
              </td>
              <td width="4%"></td>
              <td width="48%" align="center">
                <a href="${rejectUrl}"
                   style="display:block;background:#EF4444;color:#fff;text-decoration:none;
                          font-size:16px;font-weight:bold;padding:14px 20px;border-radius:8px;text-align:center">
                  ✕ &nbsp; Reject
                </a>
              </td>
            </tr></table>
            <div style="text-align:center;margin-top:16px;color:#94A3B8;font-size:12px">
              Links expire in 1 hour. Also manage at
              <a href="https://app.stellarglobalsupplies.com/approvals" style="color:#1565C0">the dashboard</a>.
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px 32px;text-align:center">
            <div style="color:#94A3B8;font-size:12px">Stellar Global Supplies · Pune, India</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`

  const accessToken = await getGmailToken(env)
  await sendViaGmail(accessToken, to, `[Approval] Payment Follow-up — ${customer}`, html, senderEmail)
  console.log(`[payment_approval_gate] notification sent to=${to}`)
}


// ═══════════════════════════════════════════════════════════════════════════
// HTML email template — mirrors _build_html_email in send_payment_email.py
// ═══════════════════════════════════════════════════════════════════════════

function buildHtmlEmail(subject, body, order) {
  const fmt      = n => `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
  const saleCost = parseFloat(order.sale_cost   || 0)
  const cgst     = parseFloat(order.cgst_total  || 0)
  const sgst     = parseFloat(order.sgst_total  || 0)
  const total    = saleCost + cgst + sgst

  const bodyHtml = body
    .replace(/\n\n/g, `</p><p style="margin:14px 0;color:#1e293b;line-height:1.7;">`)
    .replace(/\n/g, '<br>')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden">

  <div style="background:#0A2547;padding:24px 32px">
    <div style="display:inline-block;width:36px;height:36px;background:#F59E0B;border-radius:10px;
                text-align:center;line-height:36px;font-weight:700;color:#0A2547;font-size:18px;margin-right:12px">S</div>
    <div style="display:inline-block;vertical-align:middle">
      <div style="color:#fff;font-weight:700;font-size:16px">Stellar Global Supplies</div>
      <div style="color:#94a3b8;font-size:12px">Payment Follow-up</div>
    </div>
  </div>

  <div style="padding:32px">
    <p style="margin:14px 0;color:#1e293b;line-height:1.7">${bodyHtml}</p>

    <table style="width:100%;border-collapse:collapse;margin:24px 0;font-size:13px">
      <thead>
        <tr style="background:#f8fafc">
          <th style="text-align:left;padding:10px 12px;border:1px solid #e2e8f0;color:#64748b;font-weight:600">Description</th>
          <th style="text-align:right;padding:10px 12px;border:1px solid #e2e8f0;color:#64748b;font-weight:600">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e2e8f0;color:#1e293b">
            ${order.material || ''} (${order.product_type || ''}) × ${order.quantity || ''} ${order.unit || 'Pieces'}
          </td>
          <td style="text-align:right;padding:10px 12px;border:1px solid #e2e8f0;color:#1e293b">${fmt(saleCost)}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e2e8f0;color:#64748b">CGST</td>
          <td style="text-align:right;padding:10px 12px;border:1px solid #e2e8f0;color:#64748b">${fmt(cgst)}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e2e8f0;color:#64748b">SGST</td>
          <td style="text-align:right;padding:10px 12px;border:1px solid #e2e8f0;color:#64748b">${fmt(sgst)}</td>
        </tr>
        <tr style="background:#f0fdf4">
          <td style="padding:12px;border:1px solid #e2e8f0;font-weight:700;color:#0A2547">Total Payable</td>
          <td style="text-align:right;padding:12px;border:1px solid #e2e8f0;font-weight:700;color:#0A2547">${fmt(total)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
    <p style="margin:0;font-size:12px;color:#94a3b8">
      Stellar Global Supplies · stellarglobalsupplies.com<br>
      This is an automated payment reminder. Please ignore if payment has already been made.
    </p>
  </div>
</div>
</body></html>`
}