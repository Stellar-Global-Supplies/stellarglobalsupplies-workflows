/**
 * Social Post Workflows — Step Handlers
 * Ports: get_orders.py + generate_post.py + post_to_platforms.py
 *
 * Handles both social-product and social-tech workflows.
 * Steps:
 *   social_get_orders            → fetch order from Supabase
 *   social_bedrock_generate_post → Bedrock Nova Pro generates content + image prompt
 *   social_image_submit          → submit image to HF Gradio FLUX, save event_id
 *   social_image_poll            → poll FLUX result, upload to Supabase Storage
 *   social_post_to_platforms     → post to FB/IG, email LinkedIn content
 *
 * Required secrets on stellar-job-runner:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   BEDROCK_ACCESS_KEY_ID, BEDROCK_SECRET_ACCESS_KEY, BEDROCK_REGION
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   SENDER_EMAIL
 *   LINKEDIN_NOTIFY_EMAILS   (comma-separated list)
 *   FB_PAGE_ID
 *   FB_ACCESS_TOKEN
 *   IG_ACCOUNT_ID
 *   IG_ACCESS_TOKEN
 */

import { bedrockGenerateJson, bedrockGenerateText } from '../lib/bedrock.js'
import { getClient }                                from '../lib/supabase.js'
import { uploadImage, imageExtAndType }             from '../lib/assets.js'
import { generateAndUploadImage }                   from '../lib/image-gen.js'
import { nowIso }                                   from '../lib/utils.js'
import { nextJob, insertApprovalGate }              from '../job-runner.js'

const FLUX_BASE    = 'https://black-forest-labs-flux-1-schnell.hf.space'

// ─── SYSTEM PROMPT (exact copy from generate_post.py) ────────────────────────

const SYSTEM = `You are a senior B2B marketing copywriter for Stellar Global Supplies — a trusted B2B industrial and commercial supplies company based in Pune, India. We supply Stainless Steel (SS), Mild Steel (MS), Fasteners (bolts, nuts, washers, circlips, anchor fasteners), Pipes, Fittings, and Commercial/Hospitality supplies to manufacturers, contractors, plant managers, hospitality businesses, and procurement teams across India and globally.

Our strengths: ISI/BIS certified products, strict quality checks, competitive bulk pricing, pan-India delivery, 500+ SKUs, dedicated B2B account management, and now a fully digital order management system.

Your writing goal is always the same regardless of post type: make the reader want to contact Stellar Global Supplies for their supply requirements.

═══ PRODUCT POST MODE ═══

Write like a confident sales advertisement — not a product description. Create desire, show value, drive action.

LinkedIn structure (1500-2000 chars minimum, EXACT format):

LINE 1: A powerful hook. State the buyer's pain point, a striking fact about the product category, or a bold business claim. Make a procurement manager stop scrolling. No fluff.

PARAGRAPH 1 — THE PROBLEM (3-4 sentences): Paint the real business cost of getting this product wrong. Be specific to the industries that use this product. Make the reader feel the problem.

PARAGRAPH 2 — OUR PRODUCT (3-4 sentences): Introduce the specific product with confidence. Mention grades, standards (ISI/BIS/IS:1367 etc), sizes, and why quality matters.

PARAGRAPH 3 — WHO BUYS THIS AND WHY (3-4 sentences): Name specific industries and use cases. Mention measurable benefits.

PARAGRAPH 4 — WHY STELLAR (2-3 sentences): Our specific differentiators for this product.

CTA: One sharp, specific line.

HASHTAGS: 8-10 hashtags.

Rules: No em-dashes. No bullet points. Plain paragraphs. Confident, direct, expert tone.

═══ TECH POST MODE ═══

Write to prove Stellar is a modern, reliable B2B supply partner — not to show off technology.

LinkedIn structure (1500-2000 chars minimum, EXACT format):

LINE 1: A hook about a business outcome the buyer cares about.

PARAGRAPH 1 — THE BUYER'S PROBLEM (3-4 sentences): Describe the real frustration of B2B procurement.

PARAGRAPH 2 — WHAT WE BUILT AND HOW IT HELPS THEM (3-4 sentences): Explain the specific technology feature from the buyer's benefit perspective.

PARAGRAPH 3 — WHAT THIS MEANS FOR YOUR BUSINESS (3-4 sentences): Concrete business outcomes for the buyer.

PARAGRAPH 4 — STELLAR AS YOUR SUPPLY PARTNER (2-3 sentences): Bridge firmly to the core business.

CTA: Drive supply enquiries, not tech interest.

HASHTAGS: Mix of tech AND supply/industry tags.

Rules: No em-dashes. No bullet points. Plain paragraphs.`

const COMPANY_CONTEXT = `Stellar Global Supplies — key facts:
- Based in Pune, India
- Core products: Stainless Steel (SS 304, 316, 202), Mild Steel (MS), Fasteners (bolts, nuts, washers, circlips, anchor fasteners), Pipes & Fittings, Commercial/Hospitality supplies
- Certifications: ISI/BIS certified, IS:1367 compliant fasteners
- Customers: manufacturers, plant managers, contractors, construction companies, hospitality/hotel chains, procurement teams
- Strengths: 500+ SKUs, pan-India delivery, bulk pricing, 2-hour response time, dedicated B2B account management
- Website: stellarglobalsupplies.com`


// ═══════════════════════════════════════════════════════════════════════════
// Step 1: Get Orders
// Mirrors: get_orders.py
// ═══════════════════════════════════════════════════════════════════════════

export async function socialGetOrders(ctx) {
  const { payload, env } = ctx
  const sb       = getClient(env)
  const postType = payload.type || payload.post_type || 'product'

  // Fetch the most recent DELIVERED order — no manual input needed
  // Select only product columns — never expose customer, qty, or price
  let order = null

  // Try delivered orders first
  const deliveredRows = await sb.select('orders',
    'select=id,material,product_type,status,delivery_timeline&status=eq.Delivered&order=created_at.desc&limit=10'
  )

  // Pick one that hasn't been posted about yet
  for (const row of deliveredRows) {
    const existing = await sb.select('social_posts',
      `order_id=eq.${encodeURIComponent(row.id)}&type=eq.product&limit=1`
    )
    if (!existing.length) { order = row; break }
  }

  // Fallback: any recent order if all delivered ones already have posts
  if (!order) {
    const recentRows = await sb.select('orders',
      'select=id,material,product_type,status,delivery_timeline&order=created_at.desc&limit=20'
    )
    for (const row of recentRows) {
      const existing = await sb.select('social_posts',
        `order_id=eq.${encodeURIComponent(row.id)}&type=eq.product&limit=1`
      )
      if (!existing.length) { order = row; break }
    }
  }

  if (!order) {
    // All orders already have posts — mark as stopped
    console.log('[social_get_orders] all orders already have posts — nothing to post')
    if (ctx.workflow_run_id) {
      await ctx.d1.update('workflow_runs', {
        status:       'stopped',
        completed_at: nowIso(),
        output:       { skipped: true, reason: 'All recent orders already have social posts' },
      }, { id: ctx.workflow_run_id })
    }
    return
  }

  // ── Build sanitised order context ─────────────────────────
  // ONLY expose: product name, product type, delivery status
  // NEVER expose: customer name, quantity, price, GST, payment status
  const productName     = (order.material      || '').trim()
  const productCategory = (order.product_type  || '').trim()
  const deliveryStatus  = (order.status        || 'Delivered').trim()
  const deliveredOn     = order.delivery_timeline
    ? new Date(order.delivery_timeline).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
    : null

  const sanitisedOrder = {
    id:              order.id,
    product_name:    productName,
    product_category: productCategory,
    delivery_status: deliveryStatus,
    delivered_on:    deliveredOn,
  }

  console.log(`[social_get_orders] selected order=${order.id} product="${productName}" category="${productCategory}"`)

  await nextJob(ctx, 'social_bedrock_generate_post', {
    order:     sanitisedOrder,
    orderId:   String(order.id || ''),
    post_type: postType,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Generate Post with Bedrock
// Mirrors: generate_post.py handler()
// ═══════════════════════════════════════════════════════════════════════════

export async function socialBedrockGeneratePost(ctx) {
  const { payload, env } = ctx
  const sb         = getClient(env)
  const postType   = payload.post_type || payload.type || 'product'
  const order      = payload.order || {}
  const repoName   = payload.repo_name || ''
  const prompt     = payload.prompt || ''
  const contextText= payload.contextText || ''
  const workflowRunId = payload.workflowRunId

  // Dedup guard (secondary — primary dedup now happens in socialGetOrders)
  if (postType === 'product' && payload.orderId) {
    const existing = await sb.select('social_posts',
      `order_id=eq.${encodeURIComponent(payload.orderId)}&type=eq.product&limit=1`
    )
    if (existing.length) {
      console.log(`[social_bedrock_generate_post] duplicate product post — skipping`)
      if (ctx.workflow_run_id) {
        await ctx.d1.update('workflow_runs', {
          status:       'stopped',
          completed_at: nowIso(),
          output:       { skipped: true, reason: 'Post already exists for this order' },
        }, { id: ctx.workflow_run_id })
      }
      return
    }
  }

  // Dedup check for tech posts
  if (postType === 'tech' && repoName) {
    const existing = await sb.select('social_posts',
      `repo_name=eq.${encodeURIComponent(repoName)}&type=eq.tech&limit=1`
    )
    if (existing.length) {
      console.log(`[social_bedrock_generate_post] duplicate tech post — skipping`)
      return // marks current job done, chain ends
    }
  }

  // ── Generate text content ────────────────────────────────
  let genPrompt
  if (postType === 'product') {
    const deliveryNote = order.delivered_on
      ? `Successfully delivered ${order.delivered_on}`
      : 'Recently delivered'
    genPrompt = `Write a B2B marketing social media campaign for Stellar Global Supplies showcasing a recently delivered product.
${COMPANY_CONTEXT}

PRODUCT TO SHOWCASE:
- Product Name: ${order.product_name || ''}
- Product Category: ${order.product_category || ''}
- Delivery Note: ${deliveryNote}

STRICT CONTENT RULES — follow exactly:
1. NEVER mention customer name, buyer name, client name, or company name of the buyer
2. NEVER mention quantity, units, pieces, or order size
3. NEVER mention price, cost, amount, invoice value, or any rupee figure
4. NEVER say "we delivered X units to Y company"
5. DO mention: the product name, its industrial applications, quality standards, why buyers need it
6. DO use the delivery note only as social proof ("Another ${order.product_name} delivery completed")
7. The post is about the PRODUCT and STELLAR — not about any specific customer

${prompt ? `Additional instructions: ${prompt}` : ''}

Return JSON with these exact keys:
{
  "title": "attention-grabbing post title about the product (max 10 words, no customer mention)",
  "facebook": "Facebook ad copy — 280 chars max. Lead with buyer pain for this product. Sharp CTA. 3-4 hashtags. No customer/qty/price.",
  "instagram": "Instagram caption — 180 chars max. Product-focused, visual, punchy. 4-5 hashtags. No customer/qty/price.",
  "linkedin": "Full LinkedIn post in PRODUCT POST MODE. Hook, Problem, Product details with specs/grades, Who buys this and why, Why Stellar, CTA, Hashtags. Minimum 1500 characters. No em-dashes. No bullets. No customer name. No quantity. No price.",
  "hashtags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7"]
}`
  } else {
    genPrompt = `Write a B2B marketing social media campaign for Stellar Global Supplies that uses our technology platform to prove we are a reliable, modern supply partner.
${COMPANY_CONTEXT}
TECHNOLOGY DETAILS:
- Platform/Repository: ${repoName}
- Custom angle: ${prompt || 'Show how our technology makes us a better B2B supply partner'}
${contextText ? `\nContext:\n${contextText}` : ''}

Return JSON with these exact keys:
{
  "title": "post title (max 10 words) — focus on business outcome for the buyer",
  "facebook": "Facebook post — 280 chars max. Buyer benefit first. Supply CTA. 3-4 hashtags.",
  "instagram": "Instagram caption — 180 chars max. Business outcome first. 4-5 hashtags.",
  "linkedin": "Full LinkedIn post in TECH POST MODE. Minimum 1500 characters. No em-dashes. No bullets.",
  "hashtags": ["B2BSupplyChain", "OrderManagement", "StainlessSteel", "Fasteners", "IndustrialSupply", "StellarGlobalSupplies", "B2BIndia"]
}`
  }

  const contentData = await bedrockGenerateJson(env, genPrompt, SYSTEM, 3000)
  console.log(`[social_bedrock_generate_post] generated title=${contentData.title}`)

  const title   = contentData.title || ''
  const summary = contentData.facebook || (contentData.linkedin || '').slice(0, 300)

  // ── Build image prompt ────────────────────────────────────
  let imgPrompt
  if (postType === 'product') {
    const ipPrompt = `Write a FLUX image generation prompt (70-90 words) for a B2B marketing photograph that showcases this industrial product.
Product Name: ${order.product_name}
Product Category: ${order.product_category}

Rules:
- Show the product in a real industrial/commercial setting (factory floor, construction site, workshop, warehouse)
- Natural industrial lighting, DSLR editorial style, photorealistic
- Sharp focus on product, slightly blurred industrial background
- NO people, NO text, NO logos, NO price tags
- Convey quality, strength, and professional grade
Output ONLY the prompt text — no explanation, no quotes, no preamble`

    try {
      imgPrompt = (await bedrockGenerateText(env, ipPrompt, '', 180)).trim().replace(/^"|"$/g, '')
    } catch (e) {
      imgPrompt = `Realistic DSLR commercial photography of ${order.product_name} in a professional industrial setting, natural lighting, sharp focus, photorealistic editorial`
    }
  } else {
    const ipPrompt = `Write a FLUX image generation prompt (70-90 words) for an editorial photograph showing modern B2B supply chain technology in action.
Post title: ${title}
Platform/system: ${repoName}
Business context: Stellar Global Supplies — B2B supplier of stainless steel, mild steel, fasteners in India

Show a laptop in a professional office displaying a supply chain dashboard with order status for SS/MS products.
Rules: realistic DSLR, natural office lighting, navy and gold UI on screen, shallow depth of field, professional Indian business context.
Output ONLY the prompt — no explanation, no quotes`

    try {
      imgPrompt = (await bedrockGenerateText(env, ipPrompt, '', 180)).trim().replace(/^"|"$/g, '')
    } catch (e) {
      imgPrompt = `Realistic DSLR photo of a procurement professional reviewing a B2B supply chain dashboard, navy and gold UI, natural lighting, industrial supply catalogue on desk, shallow depth of field, photorealistic`
    }
  }

  // ── Save social_post row (status: pending_approval) ───────
  const today     = new Date()
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - today.getDay())
  const weekStartIso = weekStart.toISOString().slice(0, 10)

  const socialWorkflowId = payload.socialWorkflowId || payload.social_workflow_id || workflowRunId || null
  const primaryPlatform  = postType === 'tech' ? 'linkedin' : 'facebook'
  const caption = contentData[primaryPlatform] || contentData.instagram || contentData.facebook || title || ''

  let hashtags = contentData.hashtags || []
  if (typeof hashtags === 'string') hashtags = hashtags.split(/\s+/).filter(Boolean)
  hashtags = hashtags.map(h => String(h).replace(/^#/, ''))

  const row = {
    social_workflow_id: socialWorkflowId,
    platform:           primaryPlatform,
    caption:            caption.slice(0, 2000),
    raw_caption:        caption.slice(0, 2000),
    hashtags,
    status:             'pending_approval',
    orders_included:    [],
    week_start:         weekStartIso,
    type:               postType,
    title:              title || null,
    content:            (contentData.facebook || '').slice(0, 500) || null,
    platforms:          payload.platforms || { facebook: true, instagram: true, linkedin: true },
    order_id:           postType === 'product' && payload.orderId ? payload.orderId : null,
    repo_name:          postType === 'tech' && repoName ? repoName : null,
    prompt:             prompt || null,
    workflow_run_id:    workflowRunId || null,
  }

  const saved = await sb.insert('social_posts', row)
  console.log(`[social_bedrock_generate_post] saved postId=${saved.id}`)

  await nextJob(ctx, 'social_image_submit', {
    postId:       saved.id,
    post:         { ...saved, title, content: contentData.facebook || '' },
    contentData,
    imgPrompt,
    post_type:    postType,
    imageRetries: 0,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 3: Submit Image to HF Gradio FLUX
// Mirrors: _flux_gradio() step 1 (submit)
// ═══════════════════════════════════════════════════════════════════════════

export async function socialImageSubmit(ctx) {
  const { payload, env } = ctx
  const imgPrompt = payload.imgPrompt || ''
  const postId    = payload.postId

  if (!imgPrompt) {
    console.log('[social_image_submit] no image prompt — skipping to approval')
    await insertApprovalGate(ctx, 'social_post_to_platforms', buildApprovalPreview(payload))
    return
  }

  console.log(`[social_image_submit] generating image via Workers AI FLUX postId=${postId}`)

  // Workers AI FLUX — synchronous, no polling needed
  const storageKey = `social-posts/${payload.post_type || 'product'}/${crypto.randomUUID()}`
  const image      = await generateAndUploadImage(env, imgPrompt, storageKey, {
    width:  1024,
    height: 1024,
  })

  // Update social_posts row with image url if generated
  if (image?.url && postId) {
    try {
      const sb = getClient(env)
      await sb.update('social_posts', {
        image_url:    image.url,
        image_s3_key: image.key,
      }, `id=eq.${postId}`)
    } catch (e) {
      console.warn(`[social_image_submit] post update failed (non-fatal): ${e.message}`)
    }
  }

  const updatedPayload = image?.url
    ? { ...payload, post: { ...(payload.post || {}), image_url: image.url } }
    : payload

  await insertApprovalGate(ctx, 'social_post_to_platforms', buildApprovalPreview(updatedPayload))
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 4: Poll FLUX Result
// Mirrors: _flux_gradio() step 2 (SSE poll)
// Re-inserts itself if not ready yet — Worker dies fast each time
// ═══════════════════════════════════════════════════════════════════════════

export async function socialImagePoll(ctx) {
  const { payload, env } = ctx
  const eventId     = payload.imageEventId
  const retries     = payload.imageRetries || 0
  const postId      = payload.postId

  if (!eventId) {
    await insertApprovalGate(ctx, 'social_post_to_platforms', buildApprovalPreview(payload))
    return
  }

  const maxRetries = parseInt(env?.IMAGE_POLL_MAX_RETRIES) || 8
  if (retries >= maxRetries) {
    console.warn(`[social_image_poll] max retries reached for postId=${postId} — proceeding without image`)
    await insertApprovalGate(ctx, 'social_post_to_platforms', buildApprovalPreview(payload))
    return
  }

  try {
    // Read SSE stream with a short timeout — Worker has 30s CPU budget
    const streamUrl = `${FLUX_BASE}/gradio_api/call/infer/${eventId}`
    const res = await fetch(streamUrl, {
      headers: { Accept: 'text/event-stream' },
      signal:  AbortSignal.timeout(20_000),
    })

    if (!res.ok) throw new Error(`FLUX poll failed ${res.status}`)

    const text   = await res.text()
    const lines  = text.split('\n')

    let imageUrl = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.startsWith('event: complete')) {
        // Next data: line has the result
        const dataLine = lines.slice(i + 1).find(l => l.startsWith('data:'))
        if (dataLine) {
          try {
            const parsed = JSON.parse(dataLine.replace(/^data:\s*/, ''))
            const imgInfo = Array.isArray(parsed) ? parsed[0] : parsed
            imageUrl = imgInfo?.url || imgInfo?.path || (typeof imgInfo === 'string' ? imgInfo : null)
          } catch { /* ignore parse error */ }
        }
        break
      }
      if (line.startsWith('event: error')) {
        throw new Error(`FLUX stream error: ${lines[i + 1] || ''}`)
      }
    }

    if (!imageUrl) {
      // Still processing — re-queue self for next cron tick
      console.log(`[social_image_poll] still processing retry=${retries + 1} postId=${postId}`)
      await nextJob(ctx, 'social_image_poll', {
        ...payload,
        imageRetries: retries + 1,
      })
      return
    }

    // ── Image ready — download and upload to Supabase Storage ──
    console.log(`[social_image_poll] image ready url=${imageUrl.slice(0, 60)}`)
    const imgRes   = await fetch(imageUrl)
    if (!imgRes.ok) throw new Error(`Failed to download image ${imgRes.status}`)
    const imgBytes = await imgRes.arrayBuffer()

    const { ext, contentType } = imageExtAndType(imgBytes)
    const key      = `social-posts/${payload.post_type || 'product'}/${crypto.randomUUID()}${ext}`
    const publicUrl = await uploadImage(env, imgBytes, key, contentType)

    // Update social_posts row with image url
    const sb = getClient(env)
    await sb.update('social_posts', {
      image_url:     publicUrl,
      image_s3_key:  key,
    }, `id=eq.${postId}`)

    console.log(`[social_image_poll] image uploaded key=${key} postId=${postId}`)

    const updatedPayload = {
      ...payload,
      post: { ...payload.post, image_url: publicUrl },
    }

    await insertApprovalGate(ctx, 'social_post_to_platforms', buildApprovalPreview(updatedPayload))

  } catch (e) {
    const maxRetries = parseInt(env?.IMAGE_POLL_MAX_RETRIES) || 8
    if (retries < maxRetries) {
      console.warn(`[social_image_poll] poll error (${e.message}) retry=${retries + 1}`)
      await nextJob(ctx, 'social_image_poll', {
        ...payload,
        imageRetries: retries + 1,
      })
    } else {
      console.warn(`[social_image_poll] giving up after ${maxRetries} retries — proceeding without image`)
      await insertApprovalGate(ctx, 'social_post_to_platforms', buildApprovalPreview(payload))
    }
  }
}

function buildApprovalPreview(payload) {
  const post      = payload.post || {}
  const content   = payload.contentData || {}
  const postType  = payload.post_type || 'product'
  const imageHtml = post.image_url
    ? `<img src="${post.image_url}" style="max-width:100%;border-radius:8px;margin:12px 0"/>`
    : '<p style="color:#94a3b8;font-size:12px">Image generating or unavailable</p>'

  const preview = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <h2 style="color:#0A2547">${postType === 'tech' ? 'Tech' : 'Product'} Social Post</h2>
      <p><strong>Title:</strong> ${post.title || ''}</p>
      ${imageHtml}
      <div style="margin:16px 0">
        <p><strong>LinkedIn Preview (first 500 chars):</strong></p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;white-space:pre-wrap;font-size:13px">
          ${(content.linkedin || '').slice(0, 500)}...
        </div>
      </div>
      <div style="margin:12px 0">
        <p><strong>Facebook:</strong></p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font-size:13px">
          ${content.facebook || ''}
        </div>
      </div>
      <div style="margin:12px 0">
        <p><strong>Instagram:</strong></p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font-size:13px">
          ${content.instagram || ''}
        </div>
      </div>
    </div>`

  return {
    referenceId: payload.postId,
    previewHtml: preview,
    _nextStep:   'social_post_to_platforms',
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 5: Post to Platforms
// Mirrors: post_to_platforms.py handler()
// Triggered by api-router on approval
// ═══════════════════════════════════════════════════════════════════════════

export async function socialPostToPlatforms(ctx) {
  const { payload, env } = ctx
  const sb      = getClient(env)
  let   post    = payload.post || {}
  const postId  = payload.postId || post.id
  const content = payload.contentData || {}

  if (!postId) throw new Error('Missing postId in payload')

  // Reload post from Supabase to get latest image_url
  const rows = await sb.select('social_posts', `id=eq.${postId}&limit=1`)
  if (rows.length) post = { ...post, ...rows[0] }

  const platforms = post.platforms || payload.platforms || { facebook: true, instagram: true, linkedin: true }
  const imageUrl  = post.image_url || ''
  const title     = post.title || content.title || 'Stellar Global Supplies Post'
  const results   = {}

  // ── Resolve secrets ────────────────────────────────────────
  const resolveSecret = async (val) => {
    if (!val) return undefined
    if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
    return String(val)
  }

  // ── Facebook ───────────────────────────────────────────────
  if (platforms.facebook) {
    try {
      const fbPageId = await resolveSecret(env.FB_PAGE_ID)
      const fbToken  = await resolveSecret(env.FB_ACCESS_TOKEN)
      const message  = content.facebook || post.content || ''

      if (!fbPageId || !fbToken) {
        results.facebook = { success: false, error: 'FB credentials not configured' }
      } else {
        results.facebook = await postFacebook(fbPageId, fbToken, message, imageUrl)
      }
    } catch (e) {
      results.facebook = { success: false, error: e.message }
    }
    console.log(`[social_post] Facebook: success=${results.facebook?.success}`)
  }

  // ── Instagram ──────────────────────────────────────────────
  if (platforms.instagram) {
    try {
      const igId    = await resolveSecret(env.IG_ACCOUNT_ID)
      const igToken = await resolveSecret(env.IG_ACCESS_TOKEN)
      const caption = content.instagram || post.content || ''

      if (!igId || !igToken) {
        results.instagram = { success: false, error: 'IG credentials not configured' }
      } else if (!imageUrl) {
        results.instagram = { success: false, error: 'Instagram requires an image' }
      } else {
        results.instagram = await postInstagram(igId, igToken, caption, imageUrl)
      }
    } catch (e) {
      results.instagram = { success: false, error: e.message }
    }
    console.log(`[social_post] Instagram: success=${results.instagram?.success}`)
  }

  // ── LinkedIn (email notification) ─────────────────────────
  if (platforms.linkedin) {
    try {
      const linkedinContent = content.linkedin || post.caption || ''
      const notifyEmails    = (await resolveSecret(env.LINKEDIN_NOTIFY_EMAILS) || '').split(',').map(e => e.trim()).filter(Boolean)
      results.linkedin = await sendLinkedinEmail(env, { post, linkedinContent, imageUrl, title, notifyEmails })
    } catch (e) {
      results.linkedin = { success: false, error: e.message }
    }
    console.log(`[social_post] LinkedIn: success=${results.linkedin?.success}`)
  }

  // ── Update status ──────────────────────────────────────────
  const successCount = Object.values(results).filter(r => r?.success).length
  const totalCount   = Object.keys(results).length
  const status = totalCount === 0 ? 'published'
    : successCount === totalCount ? 'published'
    : successCount > 0 ? 'partial'
    : 'publish_failed'

  await sb.update('social_posts', {
    status,
    post_results: results,
    posted_at:    nowIso(),
  }, `id=eq.${postId}`)

  console.log(`[social_post] done postId=${postId} status=${status}`)
}


// ═══════════════════════════════════════════════════════════════════════════
// Platform helpers
// ═══════════════════════════════════════════════════════════════════════════

async function postFacebook(pageId, token, message, imageUrl) {
  let url, body

  if (imageUrl) {
    url  = `https://graph.facebook.com/v18.0/${pageId}/photos`
    body = new URLSearchParams({ url: imageUrl, caption: message, access_token: token })
  } else {
    url  = `https://graph.facebook.com/v18.0/${pageId}/feed`
    body = new URLSearchParams({ message, access_token: token })
  }

  const res = await fetch(url, { method: 'POST', body })
  if (!res.ok) {
    const err = await res.text()
    return { success: false, error: err }
  }
  return { success: true, result: await res.json() }
}

async function postInstagram(igAccountId, token, caption, imageUrl) {
  const base = 'https://graph.facebook.com/v18.0'

  // Step 1: Create media container
  const createRes = await fetch(`${base}/${igAccountId}/media`, {
    method: 'POST',
    body:   new URLSearchParams({ image_url: imageUrl, caption, access_token: token }),
  })
  if (!createRes.ok) return { success: false, error: await createRes.text() }
  const container   = await createRes.json()
  const containerId = container.id
  if (!containerId) return { success: false, error: 'No container ID' }

  // Step 2: Wait for container to be ready, then publish.
  // Instagram needs time to process the media container — publishing
  // immediately can fail with "Media ID is not available" / error 9007.
  const maxAttempts = 6
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check container status (polls the media object)
    const statusRes = await fetch(`${base}/${containerId}?fields=status_code&access_token=${token}`)
    if (statusRes.ok) {
      const status = await statusRes.json()
      // status_code "FINISHED" or "PUBLISHED" means we can publish
      if (status.status_code === 'FINISHED' || status.status_code === 'PUBLISHED') {
        const publishRes = await fetch(`${base}/${igAccountId}/media_publish`, {
          method: 'POST',
          body:   new URLSearchParams({ creation_id: containerId, access_token: token }),
        })
        if (publishRes.ok) return { success: true, result: await publishRes.json() }
        // If publish failed but not due to "not ready", return the error
        const errText = await publishRes.text()
        if (!errText.includes('9007') && !errText.includes('Media ID')) {
          return { success: false, error: errText }
        }
        // Otherwise fall through to retry
      }
    }

    if (attempt < maxAttempts) {
      // Wait 5 seconds between attempts (Worker CPU doesn't count sleep)
      await new Promise(r => setTimeout(r, 5000))
    }
  }

  // Final attempt without checking status
  const finalRes = await fetch(`${base}/${igAccountId}/media_publish`, {
    method: 'POST',
    body:   new URLSearchParams({ creation_id: containerId, access_token: token }),
  })
  if (finalRes.ok) return { success: true, result: await finalRes.json() }
  return { success: false, error: await finalRes.text() }
}

async function sendLinkedinEmail(env, { post, linkedinContent, imageUrl, title, notifyEmails }) {
  const resolveSecret = async (val) => {
    if (!val) return undefined
    if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
    return String(val)
  }

  if (!notifyEmails.length) {
    return { success: false, manual: true, error: 'LINKEDIN_NOTIFY_EMAILS not configured', content: linkedinContent }
  }

  const senderEmail = await resolveSecret(env.SENDER_EMAIL) || 'sales@stellarglobalsupplies.com'
  const imageBlock  = imageUrl
    ? `<div style="margin:24px 0;text-align:center"><img src="${imageUrl}" style="max-width:560px;width:100%;border-radius:10px;border:1px solid #e2e8f0"/><p style="font-size:12px;color:#94a3b8;margin-top:8px">Attach this image when posting on LinkedIn</p></div>`
    : ''

  const contentHtml = linkedinContent
    .replace(/\n\n/g, `</p><p style="margin:16px 0;color:#1e293b;line-height:1.8;">`)
    .replace(/\n/g, '<br>')

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif">
  <div style="max-width:620px;margin:32px auto;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden">
    <div style="background:#0A66C2;padding:28px 32px">
      <h1 style="margin:0;color:white;font-size:18px;font-weight:700">LinkedIn Post Ready</h1>
      <p style="margin:4px 0 0;color:#bfdbfe;font-size:13px">Stellar Global Supplies · Action Required</p>
    </div>
    <div style="padding:32px">
      <h2 style="margin:0 0 24px;font-size:20px;color:#0f172a">${title}</h2>
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:16px 20px;margin-bottom:28px">
        <p style="margin:0;font-size:14px;color:#1d4ed8;font-weight:600">How to post on LinkedIn</p>
        <ol style="margin:8px 0 0;padding-left:20px;font-size:13px;color:#1e40af;line-height:1.8">
          <li>Copy the post content below</li>
          <li>Go to linkedin.com/company/stellar-global-supplies</li>
          <li>Click Start a post</li>
          <li>Paste the content and attach the image below</li>
          <li>Click Post</li>
        </ol>
      </div>
      ${imageBlock}
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:24px;font-size:15px;line-height:1.8;color:#1e293b">
        <p style="margin:16px 0;color:#1e293b;line-height:1.8">${contentHtml}</p>
      </div>
    </div>
    <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
      <p style="margin:0;font-size:12px;color:#94a3b8">Stellar Global Supplies · Automated Workflow System</p>
    </div>
  </div>
</body></html>`

  try {
    const accessToken = await getGmailToken(env)
    const sentTo = []
    const errors = []

    for (const email of notifyEmails) {
      try {
        await sendViaGmail(accessToken, email, `[LinkedIn] Ready to Post: ${title}`, html, senderEmail)
        sentTo.push(email)
      } catch (e) {
        errors.push(`${email}: ${e.message}`)
      }
    }

    if (sentTo.length) return { success: true, manual: true, note: `Emailed to ${sentTo.join(', ')}`, sent_to: sentTo, errors, content: linkedinContent }
    return { success: false, manual: true, error: `All emails failed: ${errors}`, content: linkedinContent }
  } catch (e) {
    return { success: false, manual: true, error: `Gmail auth failed: ${e.message}`, content: linkedinContent }
  }
}

async function getGmailToken(env) {
  const resolveSecret = async (val) => {
    if (!val) return undefined
    if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
    return String(val)
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     await resolveSecret(env.GMAIL_CLIENT_ID),
      client_secret: await resolveSecret(env.GMAIL_CLIENT_SECRET),
      refresh_token: await resolveSecret(env.GMAIL_REFRESH_TOKEN),
      grant_type:    'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Gmail token refresh failed ${res.status}: ${await res.text()}`)
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
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ raw }),
  })
  if (!res.ok) throw new Error(`Gmail send failed ${res.status}: ${await res.text()}`)
  return res.json()
}