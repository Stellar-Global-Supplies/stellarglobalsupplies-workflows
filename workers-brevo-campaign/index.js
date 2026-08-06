/**
 * brevo-campaign — Cloudflare Worker
 *
 * Builds a branded Stellar Global Supplies HTML email from campaign parameters,
 * creates an email campaign in Brevo, and sends it immediately (or schedules it).
 *
 * Trigger:
 *   POST /run  — called via Cloudflare Service Binding from the job runner
 *               Body: JSON with campaign parameters (see PAYLOAD FIELDS below)
 *
 * PAYLOAD FIELDS
 * ─────────────────────────────────────────────────────────────────────────────
 * Required:
 *   productTitle     {string}   e.g. "MS Nylock Nuts"
 *   productSubtitle  {string}   e.g. "DIN 982 Standard"
 *   productImageUrl  {string}   hero image URL
 *   productDesc      {string}   body paragraph
 *   campaignSubject  {string}   email subject line
 *   listIds          {number[]} Brevo list IDs to send to (at least one)
 *
 * Optional:
 *   campaignName     {string}   internal Brevo campaign name (auto-generated if omitted)
 *   heroEyebrow      {string}   default "Featured Product"
 *   ctaUrl           {string}   default https://www.stellarglobalsupplies.com/contact
 *   senderName       {string}   default "Stellar Global Supplies"
 *   availableSizes   {Array<{size,pitch}>}  renders sizes table
 *   features         {Array<{icon,title,desc}>}  up to 4 feature bullets
 *   scheduledAt      {string|null}  ISO 8601 UTC; null/omitted = send immediately
 *
 * Required secrets (Cloudflare Secrets Store):
 *   BREVO_API_KEY        — Brevo v3 API key
 *   BREVO_SENDER_EMAIL   — verified Brevo sender address
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BREVO_API  = 'https://api.brevo.com/v3'
const LOGO_URL   = 'https://hwljdlgoysqaujzcnpeu.supabase.co/storage/v1/object/public/stellar-assets/Stellar%20Global%20Supplies%20Final%20Logo%20and%20Stationery%20(1)%20(1).jpg'
const DEFAULT_CTA = 'https://www.stellarglobalsupplies.com/contact'
const DEFAULT_SENDER = 'stellarglobalsupplies@gmail.com'

const DEFAULT_FEATURES = [
  { icon: '🔩', title: 'Vibration-Resistant',  desc: 'Nylon insert prevents loosening under load and vibration' },
  { icon: '🏭', title: 'Industrial Grade',      desc: 'Built for automotive, engineering & heavy-duty applications' },
  { icon: '✅', title: 'Standard Compliant',    desc: 'Manufactured to strict international quality standards' },
  { icon: '📦', title: 'Multiple Sizes',        desc: 'Ready to ship in all standard metric thread sizes' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  return String(val)
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function makeLogger(label) {
  const p = `[${label}]`
  return {
    info:  m => console.log( `${new Date().toISOString()}  INFO   ${p}  ${m}`),
    warn:  m => console.warn(`${new Date().toISOString()}  WARN   ${p}  ${m}`),
    error: m => console.error(`${new Date().toISOString()}  ERROR  ${p}  ${m}`),
  }
}

async function brevoRequest(apiKey, method, path, body = null) {
  const res = await fetch(`${BREVO_API}${path}`, {
    method,
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok && res.status !== 204) {
    throw new Error(`Brevo ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 400)}`)
  }
  return data
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML Template
// ─────────────────────────────────────────────────────────────────────────────

function buildHtml({ productTitle, productSubtitle, productImageUrl, productDesc,
  heroEyebrow = 'Featured Product', ctaUrl = DEFAULT_CTA,
  features = DEFAULT_FEATURES, availableSizes = [] }) {

  const featureRows = features.slice(0, 4).map(f => `
          <tr>
            <td width="28" valign="top" style="padding:7px 0;font-size:17px;line-height:1.5;">${f.icon || '🔹'}</td>
            <td style="padding:7px 0 7px 8px;font-size:14px;color:#2a3e2f;line-height:1.5;">
              <strong>${escHtml(f.title)}</strong>${f.desc ? ' — ' + escHtml(f.desc) : ''}
            </td>
          </tr>`).join('')

  const sizesSection = availableSizes.length ? `
    <tr><td><hr style="border:none;border-top:1px solid #d4e0d8;margin:0 36px;"></td></tr>
    <tr>
      <td style="padding:22px 36px 30px;">
        <p style="color:#2f4f43;font-size:11px;font-weight:bold;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 14px;border-left:3px solid #d6ae4d;padding-left:10px;">Available Sizes</p>
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1.5px solid #b8d0c0;">
          <thead><tr>
            <th align="left"  style="background:#2f4f43;color:#fff;font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding:12px 16px;">Size</th>
            <th align="right" style="background:#2f4f43;color:#fff;font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding:12px 16px;">Thread Pitch</th>
          </tr></thead>
          <tbody>${availableSizes.map((s, i) => `
            <tr style="background:${i % 2 === 0 ? '#ffffff' : '#f2f7f4'};">
              <td style="padding:12px 16px;font-size:14px;color:#2a3e2f;border-bottom:1px solid #dde8e1;"><span style="color:#2f4f43;font-weight:bold;margin-right:6px;">✔</span>${escHtml(s.size)}</td>
              <td style="padding:12px 16px;font-size:14px;color:#2a3e2f;border-bottom:1px solid #dde8e1;text-align:right;"><span style="display:inline-block;background:#d6ae4d;color:#2f4f43;font-size:12px;font-weight:bold;padding:3px 12px;border-radius:20px;">${escHtml(s.pitch)}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </td>
    </tr>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${escHtml(productTitle)} – Stellar Global Supplies</title>
  <style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
    img{-ms-interpolation-mode:bicubic;border:0;outline:0}
    *{box-sizing:border-box}
    body{margin:0;padding:0;background-color:#e8ede9;font-family:Arial,Helvetica,sans-serif}
    @media only screen and (max-width:600px){
      .wrapper{padding:0!important}
      .container{border-radius:0!important;box-shadow:none!important}
      .header{padding:22px 16px 18px!important}
      .header img{max-width:220px!important}
      .intro{padding:22px 16px 16px!important}
      .product-title{font-size:22px!important}
      .features-pad{padding:18px 16px 20px!important}
      .sizes-wrap{padding:4px 16px 24px!important}
      .cta-wrap{padding:8px 16px 28px!important}
      .cta-btn{display:block!important;width:100%!important;padding:18px 10px!important;text-align:center!important}
      .footer{padding:28px 16px 22px!important}
      .fc{display:block!important;width:100%!important;padding:6px 0!important}
    }
  </style>
</head>
<body>
<div style="width:100%;background-color:#e8ede9;padding:28px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center">
  <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0"
    style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 6px 32px rgba(10,82,33,0.13);">

    <!-- HEADER -->
    <tr>
      <td class="header" style="background-color:#2f4f43;text-align:center;padding:30px 24px 22px;">
        <img src="${LOGO_URL}" alt="Stellar Global Supplies" width="290"
          style="max-width:290px;width:100%;height:auto;display:block;margin:0 auto;">
        <p style="color:#d6ae4d;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:12px 0 0;font-weight:bold;">
          Premium Industrial Fasteners &amp; Engineering Supplies
        </p>
      </td>
    </tr>

    <!-- GOLD BAR -->
    <tr><td style="height:5px;font-size:0;line-height:0;background:linear-gradient(90deg,#2f4f43 0%,#d6ae4d 40%,#f0cc6e 60%,#d6ae4d 80%,#2f4f43 100%);">&nbsp;</td></tr>

    <!-- HERO IMAGE -->
    <tr>
      <td style="background:#f0f4f1;line-height:0;font-size:0;">
        <img src="${escAttr(productImageUrl)}" alt="${escAttr(productTitle)}" width="600"
          style="width:100%;max-width:600px;height:auto;display:block;">
      </td>
    </tr>

    <!-- INTRO -->
    <tr>
      <td class="intro" style="padding:30px 36px 20px;">
        <span style="display:inline-block;background:#2f4f43;color:#d6ae4d;font-size:10px;font-weight:bold;letter-spacing:2.5px;text-transform:uppercase;padding:5px 13px;border-radius:3px;margin-bottom:14px;">
          ${escHtml(heroEyebrow)}
        </span>
        <h1 class="product-title" style="color:#2f4f43;font-size:26px;font-weight:bold;margin:0 0 5px;line-height:1.2;">${escHtml(productTitle)}</h1>
        <p style="color:#d6ae4d;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px;">${escHtml(productSubtitle)}</p>
        <p style="color:#3a4a3e;font-size:15px;line-height:1.8;margin:0;">${escHtml(productDesc)}</p>
      </td>
    </tr>

    <tr><td><hr style="border:none;border-top:1px solid #d4e0d8;margin:0 36px;"></td></tr>

    <!-- FEATURES -->
    <tr>
      <td class="features-pad" style="padding:22px 36px 24px;">
        <p style="color:#2f4f43;font-size:11px;font-weight:bold;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 14px;border-left:3px solid #d6ae4d;padding-left:10px;">
          Why Choose Our ${escHtml(productTitle)}
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
          ${featureRows}
        </table>
      </td>
    </tr>

    ${sizesSection}

    <!-- CTA -->
    <tr>
      <td class="cta-wrap" style="padding:8px 36px 36px;text-align:center;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
          href="${escAttr(ctaUrl)}" style="height:52px;v-text-anchor:middle;width:260px;"
          arcsize="12%" stroke="f" fillcolor="#d6ae4d">
          <w:anchorlock/>
          <center style="color:#2f4f43;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;">REQUEST A QUOTE</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-->
        <a href="${escAttr(ctaUrl)}" class="cta-btn"
          style="display:inline-block;background:#d6ae4d;color:#2f4f43;font-size:14px;font-weight:bold;text-decoration:none;padding:16px 44px;border-radius:6px;letter-spacing:1.5px;text-transform:uppercase;border:2px solid #b8922e;">
          Request a Quote
        </a>
        <!--<![endif]-->
        <p style="margin:13px 0 0;font-size:11px;color:#7a9a80;letter-spacing:0.8px;">
          Fast Response &nbsp;·&nbsp; Bulk Pricing Available &nbsp;·&nbsp; Worldwide Shipping
        </p>
      </td>
    </tr>

    <!-- GOLD BAR -->
    <tr><td style="height:5px;font-size:0;line-height:0;background:linear-gradient(90deg,#2f4f43 0%,#d6ae4d 40%,#f0cc6e 60%,#d6ae4d 80%,#2f4f43 100%);">&nbsp;</td></tr>

    <!-- FOOTER -->
    <tr>
      <td class="footer" style="background-color:#1e3328;padding:36px 36px 28px;">
        <p style="text-align:center;color:#fff;font-size:20px;font-weight:bold;margin:0 0 4px;">Stellar Global Supplies</p>
        <p style="text-align:center;color:#d6ae4d;font-size:10px;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 24px;">
          Global Performance &nbsp;•&nbsp; Trusted Supplies &nbsp;•&nbsp; Stellar Solutions
        </p>
        <hr style="border:none;border-top:1px solid #2d4e38;margin:0 0 24px;">

        <!-- Social icons -->
        <div style="text-align:center;margin:0 0 24px;">
          ${[
            ['https://www.stellarglobalsupplies.com/', 'Website', `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#d6ae4d" stroke-width="1.8"/><ellipse cx="12" cy="12" rx="4" ry="10" stroke="#d6ae4d" stroke-width="1.8"/><path d="M2 12h20" stroke="#d6ae4d" stroke-width="1.8"/></svg>`],
            ['mailto:stellarglobalsupplies@gmail.com', 'Email', `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="16" rx="2" stroke="#d6ae4d" stroke-width="1.8"/><path d="M2 7l10 7 10-7" stroke="#d6ae4d" stroke-width="1.8" stroke-linejoin="round"/></svg>`],
            ['https://api.whatsapp.com/message/QWNLYNBUH5Y3H1?autoload=1&app_absent=0', 'WhatsApp', `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.477 2 2 6.418 2 11.85c0 1.888.528 3.653 1.444 5.158L2 22l5.13-1.42A10.09 10.09 0 0 0 12 21.7c5.523 0 10-4.418 10-9.85S17.523 2 12 2z" stroke="#d6ae4d" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 9.5s.5-1 1.5-1 1.5 1 2 2-.5 2-1 2.5 2 3 3.5 3.5 1.5-1 1.5-1" stroke="#d6ae4d" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`],
            ['https://www.instagram.com/stellarglobalsupplies/', 'Instagram', `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="5" stroke="#d6ae4d" stroke-width="1.8"/><circle cx="12" cy="12" r="5" stroke="#d6ae4d" stroke-width="1.8"/><circle cx="17.5" cy="6.5" r="1" fill="#d6ae4d"/></svg>`],
          ].map(([href, title, svg]) =>
            `<a href="${escAttr(href)}" style="display:inline-block;margin:0 8px;text-decoration:none;" title="${escAttr(title)}">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;background:rgba(214,174,77,0.12);border:1.5px solid rgba(214,174,77,0.35);border-radius:50%;">${svg}</span>
            </a>`
          ).join('')}
        </div>

        <!-- Contact grid -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
          <tr>
            <td class="fc" width="50%" style="padding:8px 12px;vertical-align:top;font-size:13px;color:#a8c4b0;line-height:1.5;">
              <span style="display:block;color:#6a9278;font-size:9px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;margin-bottom:3px;">Website</span>
              <a href="https://www.stellarglobalsupplies.com/" style="color:#d6ae4d;text-decoration:none;font-weight:600;">www.stellarglobalsupplies.com</a>
            </td>
            <td class="fc" width="50%" style="padding:8px 12px;vertical-align:top;font-size:13px;color:#a8c4b0;line-height:1.5;">
              <span style="display:block;color:#6a9278;font-size:9px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;margin-bottom:3px;">Email</span>
              <a href="mailto:stellarglobalsupplies@gmail.com" style="color:#d6ae4d;text-decoration:none;font-weight:600;">stellarglobalsupplies@gmail.com</a>
            </td>
          </tr>
          <tr>
            <td class="fc" width="50%" style="padding:8px 12px;vertical-align:top;font-size:13px;color:#a8c4b0;line-height:1.5;">
              <span style="display:block;color:#6a9278;font-size:9px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;margin-bottom:3px;">WhatsApp</span>
              <a href="https://api.whatsapp.com/message/QWNLYNBUH5Y3H1?autoload=1&app_absent=0" style="color:#d6ae4d;text-decoration:none;font-weight:600;">Chat with us</a>
            </td>
            <td class="fc" width="50%" style="padding:8px 12px;vertical-align:top;font-size:13px;color:#a8c4b0;line-height:1.5;">
              <span style="display:block;color:#6a9278;font-size:9px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;margin-bottom:3px;">Instagram</span>
              <a href="https://www.instagram.com/stellarglobalsupplies/" style="color:#d6ae4d;text-decoration:none;font-weight:600;">@stellarglobalsupplies</a>
            </td>
          </tr>
        </table>

        <p style="text-align:center;color:#3d6645;font-size:11px;margin:20px 0 0;">
          © 2025 Stellar Global Supplies. All rights reserved.
        </p>
      </td>
    </tr>

  </table>
</td></tr>
</table>
</div>
</body>
</html>`
}

// ─────────────────────────────────────────────────────────────────────────────
// Main campaign orchestrator
// ─────────────────────────────────────────────────────────────────────────────

async function runCampaign(params, env) {
  const log = makeLogger('brevo-campaign')

  const required = ['productTitle', 'productSubtitle', 'productImageUrl', 'productDesc', 'campaignSubject', 'listIds']
  for (const f of required) {
    if (!params[f] || (Array.isArray(params[f]) && !params[f].length))
      throw new Error(`Missing required field: ${f}`)
  }
  if (!Array.isArray(params.listIds) || !params.listIds.length)
    throw new Error('listIds must be a non-empty array of Brevo list IDs')

  const apiKey      = await resolveSecret(env.BREVO_API_KEY)
  const senderEmail = (await resolveSecret(env.BREVO_SENDER_EMAIL)) || DEFAULT_SENDER
  if (!apiKey) throw new Error('BREVO_API_KEY secret is not configured')

  // Build HTML
  const html = buildHtml({
    productTitle:    params.productTitle,
    productSubtitle: params.productSubtitle,
    productImageUrl: params.productImageUrl,
    productDesc:     params.productDesc,
    heroEyebrow:     params.heroEyebrow    || 'Featured Product',
    ctaUrl:          params.ctaUrl         || DEFAULT_CTA,
    features:        params.features       || DEFAULT_FEATURES,
    availableSizes:  params.availableSizes || [],
  })

  log.info(`HTML built for "${params.productTitle}" (${html.length} chars)`)

  const campaignName = params.campaignName
    || `${params.productTitle} — ${new Date().toISOString().slice(0, 10)}`
  const senderName   = params.senderName || 'Stellar Global Supplies'

  // Create Brevo campaign
  const createBody = {
    name:        campaignName,
    subject:     params.campaignSubject,
    sender:      { name: senderName, email: senderEmail },
    type:        'classic',
    htmlContent: html,
    recipients:  { listIds: params.listIds.map(Number) },
  }
  if (params.scheduledAt) createBody.scheduledAt = params.scheduledAt

  log.info(`Creating campaign "${campaignName}" → lists ${JSON.stringify(params.listIds)}`)
  const created = await brevoRequest(apiKey, 'POST', '/emailCampaigns', createBody)
  const campaignId = created.id
  if (!campaignId) throw new Error(`Brevo returned no campaign ID: ${JSON.stringify(created)}`)

  log.info(`Campaign created id=${campaignId}`)

  // Send now or schedule
  let sentAt = null
  if (!params.scheduledAt) {
    await brevoRequest(apiKey, 'POST', `/emailCampaigns/${campaignId}/sendNow`, {})
    sentAt = new Date().toISOString()
    log.info(`Campaign ${campaignId} sent immediately`)
  } else {
    log.info(`Campaign ${campaignId} scheduled for ${params.scheduledAt}`)
  }

  return {
    ok:           true,
    campaignId,
    campaignName,
    listIds:      params.listIds,
    scheduledAt:  params.scheduledAt || null,
    sentAt,
    productTitle: params.productTitle,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker export
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url)

    if (pathname !== '/run') {
      return new Response(
        'brevo-campaign worker\nPOST /run with campaign JSON payload to send a campaign.',
        { status: 200 }
      )
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST /run required' }), {
        status: 405, headers: { 'Content-Type': 'application/json' },
      })
    }

    let params
    try {
      params = await request.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Run async — respond immediately so job-runner doesn't time out on slow Brevo calls
    ctx.waitUntil(runCampaign(params, env).catch(e =>
      console.error(`[brevo-campaign] fatal: ${e.message}`)
    ))

    return new Response(
      JSON.stringify({ ok: true, message: 'Campaign job started', product: params.productTitle }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  },
}