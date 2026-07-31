/**
 * Lead Generation — Step Handlers
 * Ports: generate_leads.py + check_duplicate.py + save_lead.py
 *        + draft_email.py + send_email.py + schedule_followup.py
 *
 * Steps (per Migration.md Phase 4f):
 *   lead_tavily_find_company    → Tavily search for real companies (1 credit)
 *   lead_groq_extract_company   → Groq extracts structured company JSON
 *   lead_check_duplicate        → query Supabase leads, skip if domain exists
 *   lead_tavily_find_contact    → Tavily search LinkedIn + company (1 credit)
 *   lead_tavily_scrape_website  → Tavily scrape contact page (1 credit)
 *   lead_groq_extract_email     → Groq extracts email with fallback chain
 *   lead_save                   → insert lead row into Supabase
 *   lead_bedrock_draft_email    → Bedrock writes personalised B2B outreach
 *   lead_send_email             → send + schedule followup job
 *
 * Required secrets on stellar-job-runner:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   BEDROCK_ACCESS_KEY_ID, BEDROCK_SECRET_ACCESS_KEY, BEDROCK_REGION
 *   GROQ_API_KEY
 *   TAVILY_API_KEY
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   SENDER_EMAIL
 */

import { bedrockGenerateJson } from '../lib/bedrock.js'
import { getClient }           from '../lib/supabase.js'
import { nowIso }              from '../lib/utils.js'
import { nextJob, insertApprovalGate } from '../job-runner.js'

const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions'
const TAVILY_BASE = 'https://api.tavily.com'

const COMPANY_NAME = 'Stellar Global Supplies'
const COMPANY_DESC = 'Stellar Global Supplies is a global B2B supplier of industrial, commercial, and office supplies. Bulk procurement, competitive pricing, reliable logistics, and dedicated account management for businesses worldwide.'


// ═══════════════════════════════════════════════════════════════════════════
// Helper: Call Groq API
// ═══════════════════════════════════════════════════════════════════════════

async function groqJson(env, prompt, system, maxTokens = 600) {
  const res = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:    'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system || 'You are a helpful assistant. Return valid JSON.' },
        { role: 'user',   content: prompt },
      ],
      temperature: 0.3,
      max_tokens:  maxTokens,
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Groq API error ${res.status}: ${t}`)
  }
  const data = await res.json()
  return JSON.parse(data.choices[0].message.content)
}

async function groqText(env, prompt, system, maxTokens = 300) {
  const res = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:    'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system || 'You are a helpful assistant.' },
        { role: 'user',   content: prompt },
      ],
      temperature: 0.3,
      max_tokens:  maxTokens,
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Groq API error ${res.status}: ${t}`)
  }
  const data = await res.json()
  return data.choices[0].message.content
}


// ═══════════════════════════════════════════════════════════════════════════
// Helper: Call Tavily API
// ═══════════════════════════════════════════════════════════════════════════

async function tavilySearch(env, query, searchDepth = 'basic') {
  const res = await fetch(`${TAVILY_BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key:     env.TAVILY_API_KEY,
      query,
      search_depth: searchDepth,
      max_results: 5,
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Tavily API error ${res.status}: ${t}`)
  }
  return res.json()
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 1: Tavily — Find Real Companies
// Ports: generate_leads.py _ai_generate_company (Tavily replaces Nova for search)
// ═══════════════════════════════════════════════════════════════════════════

export async function leadTavilyFindCompany(ctx) {
  const { payload, env } = ctx
  const industry = payload.target_industry || 'manufacturing'
  const country  = payload.target_country  || 'India'
  const extra    = payload.additional_context || ''

  // Use Tavily to find real companies
  const query = `B2B companies in ${industry} industry in ${country} ${extra ? `(${extra})` : ''}`
  const searchResult = await tavilySearch(env, query)

  const companies = (searchResult.results || []).slice(0, 3).map(r => ({
    company_name: r.title?.replace(/ - .*$/, '').trim() || 'Unknown Company',
    website:      r.url || '',
    description:  r.content?.slice(0, 200) || '',
  }))

  if (!companies.length) {
    throw new Error('Tavily returned no companies')
  }

  console.log(`[lead_tavily_find_company] found ${companies.length} companies`)

  await nextJob(ctx, 'lead_groq_extract_company', {
    companies,
    target_industry: industry,
    target_country:  country,
    additional_context: extra,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Groq — Extract Structured Company Data
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGroqExtractCompany(ctx) {
  const { payload, env } = ctx
  const companies = payload.companies || []
  const industry  = payload.target_industry || 'manufacturing'
  const country   = payload.target_country  || 'India'

  if (!companies.length) throw new Error('No companies to extract')

  const company = companies[0]  // Take the first one

  const prompt = `You are a B2B sales intelligence AI for ${COMPANY_NAME}.
${COMPANY_DESC}

Extract structured data from this company:
- Name: ${company.company_name}
- Website: ${company.website}
- Description: ${company.description}

Return a JSON object with these fields:
{
  "company_name": "${company.company_name}",
  "website": "${company.website || 'https://example.com'}",
  "industry": "${industry}",
  "address": "realistic address in ${country}",
  "description": "${company.description || `A company in the ${industry} industry in ${country}`}"
}`

  const extracted = await groqJson(env, prompt, 'You extract structured company data. Return valid JSON.', 500)
  console.log(`[lead_groq_extract_company] extracted company=${extracted.company_name}`)

  await nextJob(ctx, 'lead_check_duplicate', {
    lead: extracted,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 3: Check Duplicate
// Ports: check_duplicate.py
// ═══════════════════════════════════════════════════════════════════════════

export async function leadCheckDuplicate(ctx) {
  const { payload, env } = ctx
  const lead = payload.lead || {}
  const email        = (lead.email || '').toLowerCase().trim()
  const companyName  = (lead.company_name || '').toLowerCase().trim()

  const sb = getClient(env)

  // Check by email
  let isDuplicate = false
  let existingId  = null

  if (email) {
    const byEmail = await sb.select('leads', `email=eq.${encodeURIComponent(email)}&select=id,email,status&limit=1`)
    if (byEmail.length) {
      isDuplicate = true
      existingId  = byEmail[0].id
    }
  }

  // Check by company name
  if (!isDuplicate && companyName) {
    const byName = await sb.select('leads', `company_name=ilike.${encodeURIComponent(`%${companyName}%`)}&select=id,company_name,status&limit=1`)
    if (byName.length) {
      isDuplicate = true
      existingId  = byName[0].id
    }
  }

  if (isDuplicate) {
    console.log(`[lead_check_duplicate] duplicate found — existingId=${existingId}, skipping`)
    
    // Update workflow_run to indicate duplicate was found
    if (ctx.workflow_run_id) {
      await ctx.d1.update('workflow_runs', {
        status: 'succeeded',
        output: { 
          duplicate_found: true, 
          existing_id: existingId, 
          message: 'Duplicate lead skipped' 
        },
      }, { id: ctx.workflow_run_id })
    }
    
    return  // Chain ends — no more jobs
  }

  console.log(`[lead_check_duplicate] no duplicate found — continuing`)
  await nextJob(ctx, 'lead_tavily_find_contact', { lead })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 4: Tavily — Find Contact
// ═══════════════════════════════════════════════════════════════════════════

export async function leadTavilyFindContact(ctx) {
  const { payload, env } = ctx
  const lead = payload.lead || {}

  const query = `${lead.company_name} ${lead.industry || ''} procurement manager contact email LinkedIn`
  const searchResult = await tavilySearch(env, query)

  const contacts = (searchResult.results || []).slice(0, 3).map(r => ({
    title:       r.title || '',
    content:     r.content || '',
    url:         r.url || '',
  }))

  console.log(`[lead_tavily_find_contact] found ${contacts.length} potential contacts`)

  await nextJob(ctx, 'lead_tavily_scrape_website', {
    lead,
    contacts,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 5: Tavily — Scrape Website
// ═══════════════════════════════════════════════════════════════════════════

export async function leadTavilyScrapeWebsite(ctx) {
  const { payload, env } = ctx
  const lead     = payload.lead || {}
  const contacts = payload.contacts || []

  // Try to scrape the company website for contact info
  let scrapedContent = ''
  if (lead.website) {
    try {
      const searchResult = await tavilySearch(env, `${lead.website} contact email phone`, 'advanced')
      scrapedContent = (searchResult.results || []).map(r => r.content || '').join('\n').slice(0, 2000)
    } catch (e) {
      console.warn(`[lead_tavily_scrape_website] scrape failed: ${e.message}`)
    }
  }

  console.log(`[lead_tavily_scrape_website] scraped ${scrapedContent.length} chars`)

  await nextJob(ctx, 'lead_groq_extract_email', {
    lead,
    contacts,
    scrapedContent,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 6: Groq — Extract Email with Fallback Chain
// Ports: generate_leads.py _ai_generate_free_email
// Email fallback chain (from Migration.md):
//   Found email on website?          → use it
//   Other emails found at domain?    → guess firstname@domain.com
//   Domain known, no emails?         → procurement@domain.com
//   Nothing found?                   → mark needs_review, skip send
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGroqExtractEmail(ctx) {
  const { payload, env } = ctx
  const lead           = payload.lead || {}
  const contacts       = payload.contacts || []
  const scrapedContent = payload.scrapedContent || ''

  const prompt = `Extract or generate a contact email for this company:

Company: ${lead.company_name}
Website: ${lead.website || 'N/A'}
Industry: ${lead.industry || 'N/A'}

Search results (contacts):
${contacts.map(c => `- ${c.title}: ${c.content.slice(0, 200)}`).join('\n')}

Scraped website content:
${scrapedContent.slice(0, 1000)}

Email fallback chain (use first that works):
1. If an email is found in the content above, use it
2. If other emails at the same domain are found, guess firstname@domain.com
3. If domain is known but no emails, use procurement@domain.com
4. If nothing found, set needs_review: true

Return JSON:
{
  "email": "found or generated email",
  "contact_name": "First Last or empty string",
  "phone": "phone number or empty string",
  "needs_review": false,
  "source": "found_on_website | guessed | fallback | needs_review"
}`

  const result = await groqJson(env, prompt, 'You extract contact information. Return valid JSON.', 500)

  const email = (result.email || '').toLowerCase().trim()
  
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const isValidEmail = emailRegex.test(email)
  
  if (!isValidEmail) {
    console.warn(`[lead_groq_extract_email] invalid email format: ${email}`)
  }
  
  const needsReview = !isValidEmail || result.needs_review || !email

  const enrichedLead = {
    ...lead,
    email:        email || '',
    contact_name: result.contact_name || lead.contact_name || '',
    phone:        result.phone || lead.phone || '',
    source:       result.source || 'ai_generated',
    needs_review: needsReview,
  }

  console.log(`[lead_groq_extract_email] email=${email || 'NONE'} source=${result.source} needs_review=${needsReview}`)

  if (needsReview) {
    // Save lead with needs_review status — no email will be sent
    await nextJob(ctx, 'lead_save', { lead: enrichedLead, skipEmail: true })
  } else {
    await nextJob(ctx, 'lead_save', { lead: enrichedLead, skipEmail: false })
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 7: Save Lead
// Ports: save_lead.py
// ═══════════════════════════════════════════════════════════════════════════

export async function leadSave(ctx) {
  const { payload, env } = ctx
  const lead      = payload.lead || {}
  const skipEmail = payload.skipEmail || false

  const sb = getClient(env)

  const row = {
    company_name:    lead.company_name || '',
    website:         lead.website || '',
    email:           (lead.email || '').toLowerCase().trim(),
    phone:           lead.phone || '',
    industry:        lead.industry || '',
    address:         lead.address || '',
    contact_name:    lead.contact_name || '',
    description:     lead.description || '',
    status:          skipEmail ? 'needs_review' : 'pending',
    source:          lead.source || 'ai_generated',
    workflow_run_id: ctx.workflow_run_id || null,
  }

  const saved = await sb.insert('leads', row)
  console.log(`[lead_save] saved leadId=${saved.id} status=${row.status}`)

  if (skipEmail) {
    console.log(`[lead_save] lead needs review — no email will be sent`)
    return  // Chain ends
  }

  await nextJob(ctx, 'lead_gen_draft_email', {
    lead:   { ...lead, id: saved.id },
    leadId: saved.id,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 8: Bedrock — Draft Outreach Email
// Ports: draft_email.py
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGenBedrockDraftEmail(ctx) {
  const { payload, env } = ctx
  const lead   = payload.lead || {}
  const leadId = payload.leadId || lead.id

  if (!lead.company_name) throw new Error('Missing lead data')

  const prompt = `Draft a B2B outreach email from Stellar Global Supplies Team to ${lead.contact_name || 'the team'} at ${lead.company_name}.

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
- Website: https://stellarglobalsupplies.com

Return JSON with exactly these fields:
{
  "subject": "email subject line",
  "body": "full email body with proper greeting, value proposition, CTA, and signature from Stellar Global Supplies Team"
}`

  const draft = await bedrockGenerateJson(env, prompt,
    'You are a professional B2B sales copywriter. Write concise, personalized outreach emails.', 1500)

  console.log(`[lead_gen_bedrock_draft_email] drafted for lead=${leadId}`)

  await nextJob(ctx, 'lead_gen_approval_gate', {
    lead,
    leadId,
    emailDraft: draft,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 9: Approval Gate
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGenApprovalGate(ctx) {
  const { payload, env, d1, workflow_run_id, workflow_type, job } = ctx
  const lead       = payload.lead       || {}
  const emailDraft = payload.emailDraft || {}
  const leadId     = payload.leadId     || lead.id

  if (!emailDraft.subject) throw new Error('Missing emailDraft in payload')

  const approvalId = crypto.randomUUID()
  const emailToken = crypto.randomUUID().replace(/-/g, '')
  const now        = nowIso()
  const apiBase    = (env.API_BASE_URL || '').replace(/\/$/, '')

  const previewHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <h2 style="color:#0A2547">New Lead — ${lead.company_name || ''}</h2>
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:20px">
        <p><strong>Company:</strong> ${lead.company_name || ''}</p>
        <p><strong>Contact:</strong> ${lead.contact_name || ''}</p>
        <p><strong>Email:</strong> ${lead.email || ''}</p>
        <p><strong>Phone:</strong> ${lead.phone || ''}</p>
        <p><strong>Industry:</strong> ${lead.industry || ''}</p>
        <p><strong>Website:</strong> ${lead.website || ''}</p>
        <p><strong>Source:</strong> ${lead.source || ''}</p>
        <hr style="border:none;border-top:1px solid #E2E8F0"/>
        <p><strong>Email Subject:</strong> ${emailDraft.subject || ''}</p>
        <div style="white-space:pre-wrap;font-size:13px">${(emailDraft.body || '').slice(0, 400)}...</div>
      </div>
    </div>`

  await d1.insert('approval_queue', {
    id:              approvalId,
    workflow_type:   'lead_approval',
    workflow_run_id,
    reference_id:    leadId || null,
    task_token:      `lead-gen-${crypto.randomUUID()}`,
    payload:         { lead, leadId, emailDraft, approvalGate: 'save', _nextStep: 'lead_gen_send_email' },
    preview_html:    previewHtml,
    status:          'pending',
    email_token:     emailToken,
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    created_at:      now,
  })

  console.log(`[lead_gen_approval_gate] approval_id=${approvalId} lead=${leadId}`)

  await d1.update('job_queue', { status: 'waiting_for_approval' }, { id: job.id })
  if (workflow_run_id) {
    await d1.update('workflow_runs', { status: 'awaiting_approval' }, { id: workflow_run_id })
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 10: Send Email
// Ports: send_email.py + schedule_followup.py
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGenSendEmail(ctx) {
  const { payload, env } = ctx
  const lead       = payload.lead       || {}
  const emailDraft = payload.emailDraft || {}
  const leadId     = payload.leadId     || lead.id
  const senderEmail = env.SENDER_EMAIL  || 'sales@stellarglobalsupplies.com'

  const to      = lead.email || ''
  const subject = emailDraft.subject || 'Outreach'
  const body    = emailDraft.body    || ''

  if (!to) throw new Error('No recipient email address for lead')
  if (!leadId) throw new Error('Missing leadId')

  // Send via Gmail
  const accessToken = await getGmailToken(env)
  const html        = buildPlainEmailHtml(subject, body)
  const result      = await sendViaGmail(accessToken, to, subject, html, senderEmail)
  console.log(`[lead_gen_send_email] sent to=${to} leadId=${leadId} gmailId=${result.id}`)

  // Update lead status
  const sb = getClient(env)
  try {
    await sb.update('leads', {
      status:     'emailed',
      updated_at: nowIso(),
    }, `id=eq.${leadId}`)
  } catch (e) {
    console.warn(`[lead_gen_send_email] lead status update failed: ${e.message}`)
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Gmail helpers
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