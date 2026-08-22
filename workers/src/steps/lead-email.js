/**
 * Lead Email Existing — Step Handlers
 * Ports: load_lead_for_email.py + draft_email.py + send_email.py
 *
 * Steps:
 *   lead_load_existing         → fetch lead from Supabase by ID
 *   lead_cf_draft_email        → CF Workers AI drafts personalised outreach email
 *   lead_send_email            → send via Gmail OAuth, update lead status
 *
 * Required secrets on stellar-job-runner:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   (no external AI credentials needed — uses CF Workers AI binding)
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   SENDER_EMAIL
 */

import { cfAiGenerateJson } from '../lib/cf-ai.js'
import { getClient }           from '../lib/supabase.js'
import { nowIso }              from '../lib/utils.js'
import { nextJob, insertApprovalGate } from '../job-runner.js'

// Helper to resolve Cloudflare secrets (handles both string and secret objects)
async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  if (typeof val === 'string') return val
  return String(val)
}

const SENDER_NAME    = 'Stellar Global Supplies Team'
const COMPANY_WEBSITE = 'https://stellarglobalsupplies.com'

const BEDROCK_SYSTEM = `You are a professional B2B sales copywriter for Stellar Global Supplies.
Write concise, personalized outreach emails that are warm but professional.
Never sound like a mass mailer. Reference the specific company and why we can help them.`


// ═══════════════════════════════════════════════════════════════════════════
// Step 1: Load Existing Lead
// Ports: load_lead_for_email.py
// ═══════════════════════════════════════════════════════════════════════════

export async function leadLoadExisting(ctx) {
  const { payload, env } = ctx
  const leadId = payload.leadId || payload.lead_id
  if (!leadId) throw new Error('Missing leadId in payload')

  const sb = getClient(env)
  const rows = await sb.select('leads', `id=eq.${leadId}&limit=1`)
  if (!rows.length) throw new Error(`Lead not found: ${leadId}`)

  const lead = rows[0]
  console.log(`[lead_load_existing] loaded lead=${lead.id} company=${lead.company_name}`)

  await nextJob(ctx, 'lead_email_draft_email', {
    lead,
    leadId: lead.id,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Draft Email with CF Workers AI
// Ports: draft_email.py
// ═══════════════════════════════════════════════════════════════════════════

export async function leadCfDraftEmail(ctx) {
  const { payload, env } = ctx
  const lead = payload.lead || {}
  if (!lead.id || !lead.company_name) throw new Error('Missing lead data in payload')

  const prompt = `Draft a B2B outreach email from ${SENDER_NAME} to ${lead.contact_name || 'the team'} at ${lead.company_name}.

Lead details:
- Company: ${lead.company_name}
- Industry: ${lead.industry || 'unknown'}
- Website: ${lead.website || 'N/A'}
- Description: ${lead.description || ''}
- Location: ${lead.address || ''}

Our company (Stellar Global Supplies) offers:
- Industrial, commercial, and office supplies in bulk
- Competitive pricing with volume discounts
- Global logistics and reliable delivery
- Dedicated account manager
- Website: ${COMPANY_WEBSITE}

Return JSON with exactly these fields:
{
  "subject": "email subject line",
  "body": "full email body with proper greeting, value proposition, CTA, and signature from ${SENDER_NAME}"
}`

  const draft = await cfAiGenerateJson(env, prompt, BEDROCK_SYSTEM, 1500)
  console.log(`[lead_cf_draft_email] drafted for lead=${lead.id} company=${lead.company_name}`)

  await nextJob(ctx, 'lead_approval_gate', {
    lead,
    leadId: lead.id,
    emailDraft: draft,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 3: Approval Gate for Lead Email
// ═══════════════════════════════════════════════════════════════════════════

export async function leadApprovalGate(ctx) {
  const { payload, env, d1, workflow_run_id, workflow_type, job } = ctx
  const lead       = payload.lead       || {}
  const emailDraft = payload.emailDraft || {}
  const leadId     = payload.leadId     || lead.id

  if (!emailDraft.subject) throw new Error('Missing emailDraft in payload')

  const approvalId = crypto.randomUUID()
  const emailToken = crypto.randomUUID().replace(/-/g, '')
  const now        = nowIso()

  const previewHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <h2 style="color:#0A2547">Outreach Email — ${lead.company_name || ''}</h2>
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:20px">
        <p><strong>To:</strong> ${lead.email || ''}</p>
        <p><strong>Subject:</strong> ${emailDraft.subject || ''}</p>
        <hr style="border:none;border-top:1px solid #E2E8F0"/>
        <div style="white-space:pre-wrap;font-size:13px">${(emailDraft.body || '').slice(0, 600)}...</div>
      </div>
    </div>`

  await d1.insert('approval_queue', {
    id:              approvalId,
    workflow_type:   'lead_email',
    workflow_run_id,
    reference_id:    leadId || null,
    task_token:      `lead-email-${crypto.randomUUID()}`,
    payload:         { lead, leadId, emailDraft, approvalGate: 'save', _nextStep: 'lead_send_email' },
    preview_html:    previewHtml,
    status:          'pending',
    email_token:     emailToken,
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    created_at:      now,
  })

  console.log(`[lead_approval_gate] approval_id=${approvalId} lead=${leadId}`)

  // Send notification email to reviewer
  try {
    const reviewerEmail = await resolveSecret(env.REVIEWER_EMAIL)
    if (reviewerEmail) {
      await sendLeadApprovalNotification(env, {
        to:          reviewerEmail,
        approvalId,
        emailToken,
        approveUrl:  `${apiBase}/approvals/${approvalId}/email-action?token=${emailToken}&action=approve`,
        rejectUrl:   `${apiBase}/approvals/${approvalId}/email-action?token=${emailToken}&action=reject`,
        lead,
        emailDraft,
        senderEmail,
      })
    }
  } catch (e) {
    console.warn(`[lead_approval_gate] notification email failed: ${e.message}`)
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
// Ports: send_email.py
// Triggered by api-router on approval
// ═══════════════════════════════════════════════════════════════════════════

export async function leadSendEmail(ctx) {
  const { payload, env } = ctx
  const lead       = payload.lead       || {}
  const emailDraft = payload.emailDraft || {}
  const leadId     = payload.leadId     || lead.id
  const senderEmail = await resolveSecret(env.SENDER_EMAIL) || 'sales@stellarglobalsupplies.com'

  const to      = lead.email || ''
  const subject = emailDraft.subject || 'Outreach'
  const body    = emailDraft.body    || ''

  if (!to) throw new Error('No recipient email address for lead')
  if (!leadId) throw new Error('Missing leadId')

  // Send via Gmail
  const accessToken = await getGmailToken(env)
  const html        = buildPlainEmailHtml(subject, body)
  const result      = await sendViaGmail(accessToken, to, subject, html, senderEmail)
  console.log(`[lead_send_email] sent to=${to} leadId=${leadId} gmailId=${result.id}`)

  // Update lead status
  const sb = getClient(env)
  try {
    await sb.update('leads', {
      status:     'emailed',
      updated_at: nowIso(),
    }, `id=eq.${leadId}`)
  } catch (e) {
    console.warn(`[lead_send_email] lead status update failed: ${e.message}`)
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Gmail helpers
// ═══════════════════════════════════════════════════════════════════════════

async function getGmailToken(env) {
  const clientId     = await resolveSecret(env.GMAIL_CLIENT_ID)
  const clientSecret = await resolveSecret(env.GMAIL_CLIENT_SECRET)
  const refreshToken = await resolveSecret(env.GMAIL_REFRESH_TOKEN)
  
  if (!clientId) throw new Error('Missing secret: GMAIL_CLIENT_ID')
  if (!clientSecret) throw new Error('Missing secret: GMAIL_CLIENT_SECRET')
  if (!refreshToken) throw new Error('Missing secret: GMAIL_REFRESH_TOKEN')
  
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
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

async function sendLeadApprovalNotification(env, { to, approvalId, emailToken, approveUrl, rejectUrl, lead, emailDraft, senderEmail }) {
  const companyName = lead.company_name || ''
  const contactName = lead.contact_name || ''
  const bodyPreview = (emailDraft.body || '').slice(0, 600)

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
            <div style="color:#94A8B8;font-size:13px;margin-top:4px">Email Outreach Approval Required</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 16px">
            <div style="font-size:20px;font-weight:bold;color:#0A2547">
              Follow-up Email — ${companyName}
            </div>
            <div style="color:#64748B;font-size:14px;margin-top:6px">
              Contact: <strong>${contactName}</strong> · Email: <strong>${lead.email || ''}</strong>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px">
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:20px;font-size:14px;color:#334155">
              <p><strong>Company:</strong> ${companyName}</p>
              <p><strong>Industry:</strong> ${lead.industry || ''}</p>
              <p><strong>Website:</strong> ${lead.website || ''}</p>
              <hr style="border:none;border-top:1px solid #E2E8F0;margin:12px 0"/>
              <p><strong>Email Subject:</strong> ${emailDraft.subject || ''}</p>
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
            <div style="text-align:center;margin-top:16px;color:#94A8B8;font-size:12px">
              Links expire in 1 hour. Also manage at
              <a href="https://app.stellarglobalsupplies.com/approvals" style="color:#1565C0">the dashboard</a>.
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px 32px;text-align:center">
            <div style="color:#94A8B8;font-size:12px">Stellar Global Supplies · Pune, India</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`

  const accessToken = await getGmailToken(env)
  await sendViaGmail(accessToken, to, `[Approval] Email Outreach — ${companyName}`, html, senderEmail)
  console.log(`[lead_approval_gate] notification sent to=${to}`)
}

function buildPlainEmailHtml(subject, body) {
  const bodyHtml = body
    .replace(/\n\n/g, `</p><p style="margin:14px 0;color:#1e293b;line-height:1.7;">`)
    .replace(/\n/g, '<br>')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden">
  <div style="background:#0A2547;padding:24px 32px">
    <div style="color:#fff;font-weight:700;font-size:16px">Stellar Global Supplies</div>
  </div>
  <div style="padding:32px">
    <p style="margin:14px 0;color:#1e293b;line-height:1.7">${bodyHtml}</p>
  </div>
  <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
    <p style="margin:0;font-size:12px;color:#94a3b8">Stellar Global Supplies · stellarglobalsupplies.com</p>
  </div>
</div>
</body></html>`
}