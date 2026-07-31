/**
 * Blog Post Workflow — Step Handlers
 * Ports: generate_blog.py + create_github_pr.py
 *
 * Steps:
 *   blog_generate_outline    → Bedrock generates structured outline JSON
 *   blog_generate_content    → Bedrock generates full markdown from outline
 *   blog_image_submit        → HF Gradio FLUX (same pattern as social)
 *   blog_image_poll          → poll FLUX result, upload to R2
 *   blog_create_github_pr    → GitHub API: create branch, commit MDX, open PR
 *
 * Required secrets on stellar-job-runner:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   BEDROCK_ACCESS_KEY_ID, BEDROCK_SECRET_ACCESS_KEY, BEDROCK_REGION
 *   GITHUB_TOKEN
 *   WEBSITE_REPO_OWNER, WEBSITE_REPO_NAME, WEBSITE_BASE_BRANCH
 */

import { bedrockGenerateJson, bedrockGenerateText } from '../lib/bedrock.js'
import { getClient }                                from '../lib/supabase.js'
import { uploadImage, imageExtAndType }             from '../lib/assets.js'
import { nowIso, slugify }                          from '../lib/utils.js'
import { nextJob, insertApprovalGate }              from '../job-runner.js'

const FLUX_BASE   = 'https://black-forest-labs-flux-1-schnell.hf.space'
const MAX_RETRIES = 8

const SYSTEM = `You are a professional content writer for Stellar Global Supplies, a global B2B supplier.
Write informative, SEO-optimized blog posts that provide genuine value to procurement professionals,
supply chain managers, and business owners. Use clear headings, practical advice, and professional tone.`


// ═══════════════════════════════════════════════════════════════════════════
// Step 1: Generate Blog Outline
// ═══════════════════════════════════════════════════════════════════════════

export async function blogGenerateOutline(ctx) {
  const { payload, env } = ctx
  const topic       = payload.topic || 'Best practices in B2B procurement and supply chain management'
  const keywords    = payload.keywords || []
  const customPrompt = payload.custom_prompt || ''

  const prompt = `You are a blog content strategist for Stellar Global Supplies.

Topic: ${topic}
Target keywords: ${keywords.length ? keywords.join(', ') : 'supply chain, B2B procurement, industrial supplies'}
${customPrompt ? `Additional instructions: ${customPrompt}` : ''}

Return a JSON object with these exact keys:
{
  "title": "SEO-optimized blog post title",
  "excerpt": "2-3 sentence summary for meta description (under 160 chars)",
  "outline": ["Section 1 heading", "Section 2 heading", "Section 3 heading", "Section 4 heading", "Section 5 heading"],
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}`

  const outline = await bedrockGenerateJson(env, prompt, SYSTEM, 1500)
  console.log(`[blog_generate_outline] title=${outline.title}`)

  await nextJob(ctx, 'blog_generate_content', {
    blogOutline: outline,
    topic,
    keywords,
    customPrompt,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Generate Full Blog Content
// ═══════════════════════════════════════════════════════════════════════════

export async function blogGenerateContent(ctx) {
  const { payload, env } = ctx
  const outline    = payload.blogOutline || {}
  const topic      = payload.topic || ''
  const keywords   = payload.keywords || []
  const wordCount  = payload.word_count || 800

  const prompt = `Write a comprehensive blog post for Stellar Global Supplies website.

Topic: ${topic}
Title: ${outline.title || ''}
Excerpt: ${outline.excerpt || ''}
Outline sections:
${(outline.outline || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}
Target keywords: ${keywords.length ? keywords.join(', ') : 'supply chain, B2B procurement, industrial supplies'}
Target word count: ${wordCount} words

Return valid JSON with these exact keys:
{
  "content": "full markdown blog post content with ## headings, practical examples, conclusion",
  "content_preview": "first 500 chars of content for storage"
}`

  const blogData = await bedrockGenerateJson(env, prompt, SYSTEM, 3000)
  const content  = blogData.content || ''
  const preview  = content.slice(0, 500)

  console.log(`[blog_generate_content] generated ${content.length} chars`)

  // Build image prompt for featured image
  const imgPrompt = await buildBlogImagePrompt(env, {
    title:   outline.title || topic,
    topic,
    excerpt: outline.excerpt || '',
    tags:    outline.tags || [],
  })

  const blog = {
    title:        outline.title || topic,
    excerpt:      outline.excerpt || '',
    content:      content,
    contentPreview: preview,
    tags:         outline.tags || [],
    imagePrompt:  imgPrompt,
    topic,
    keywords,
  }

  await nextJob(ctx, 'blog_image_submit', {
    blog,
    blogId:       null,  // will be set after save
    imgPrompt,
    imageRetries: 0,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 3: Submit Image to HF Gradio FLUX
// ═══════════════════════════════════════════════════════════════════════════

export async function blogImageSubmit(ctx) {
  const { payload, env } = ctx
  const imgPrompt = payload.imgPrompt || ''
  const blog      = payload.blog || {}

  if (!imgPrompt) {
    console.log('[blog_image_submit] no image prompt — proceeding without image')
    await saveBlogAndGoToApproval(ctx, blog, null)
    return
  }

  try {
    const res = await fetch(`${FLUX_BASE}/gradio_api/call/infer`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        data: [imgPrompt, 0, true, 1024, 1024, 4],
      }),
    })

    if (!res.ok) throw new Error(`FLUX submit failed ${res.status}: ${await res.text()}`)

    const result  = await res.json()
    const eventId = result.event_id
    if (!eventId) throw new Error(`FLUX: no event_id in response: ${JSON.stringify(result)}`)

    console.log(`[blog_image_submit] queued eventId=${eventId}`)
    await nextJob(ctx, 'blog_image_poll', {
      ...payload,
      imageEventId: eventId,
      imageRetries: 0,
    })
  } catch (e) {
    console.warn(`[blog_image_submit] FLUX submit failed (${e.message}) — proceeding without image`)
    await saveBlogAndGoToApproval(ctx, blog, null)
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 4: Poll FLUX Result
// ═══════════════════════════════════════════════════════════════════════════

export async function blogImagePoll(ctx) {
  const { payload, env } = ctx
  const eventId   = payload.imageEventId
  const retries   = payload.imageRetries || 0
  const blog      = payload.blog || {}

  if (!eventId) {
    await saveBlogAndGoToApproval(ctx, blog, null)
    return
  }

  if (retries >= MAX_RETRIES) {
    console.warn(`[blog_image_poll] max retries reached — proceeding without image`)
    await saveBlogAndGoToApproval(ctx, blog, null)
    return
  }

  try {
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
      console.log(`[blog_image_poll] still processing retry=${retries + 1}`)
      await nextJob(ctx, 'blog_image_poll', {
        ...payload,
        imageRetries: retries + 1,
      })
      return
    }

    // Image ready — download and upload to R2
    console.log(`[blog_image_poll] image ready url=${imageUrl.slice(0, 60)}`)
    const imgRes = await fetch(imageUrl)
    if (!imgRes.ok) throw new Error(`Failed to download image ${imgRes.status}`)
    const imgBytes = await imgRes.arrayBuffer()

    const { ext, contentType } = imageExtAndType(imgBytes)
    const key      = `blog-images/${crypto.randomUUID()}${ext}`
    const publicUrl = await uploadImage(env, imgBytes, key, contentType)

    console.log(`[blog_image_poll] image uploaded key=${key}`)
    await saveBlogAndGoToApproval(ctx, blog, { url: publicUrl, key })

  } catch (e) {
    if (retries < MAX_RETRIES) {
      console.warn(`[blog_image_poll] poll error (${e.message}) retry=${retries + 1}`)
      await nextJob(ctx, 'blog_image_poll', {
        ...payload,
        imageRetries: retries + 1,
      })
    } else {
      console.warn(`[blog_image_poll] giving up after ${MAX_RETRIES} retries — proceeding without image`)
      await saveBlogAndGoToApproval(ctx, blog, null)
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Helper: Save blog to Supabase and go to approval gate
// ═══════════════════════════════════════════════════════════════════════════

async function saveBlogAndGoToApproval(ctx, blog, image) {
  const { env } = ctx
  const sb = getClient(env)

  const slug = slugify(blog.title || 'blog-post') + '-' + crypto.randomUUID().slice(0, 6)

  const row = {
    title:         blog.title || '',
    slug,
    excerpt:       blog.excerpt || '',
    content:       blog.contentPreview || blog.content?.slice(0, 500) || '',
    image_url:     image?.url || null,
    image_s3_key:  image?.key || null,
    tags:          blog.tags || [],
    status:        'draft',
    workflow_run_id: ctx.workflow_run_id || null,
  }

  const saved = await sb.insert('blog_posts', row)
  console.log(`[blog] saved blogId=${saved.id}`)

  const previewHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <h2 style="color:#0A2547">Blog Post — ${blog.title || ''}</h2>
      <p style="color:#64748B">${blog.excerpt || ''}</p>
      ${image?.url ? `<img src="${image.url}" style="max-width:100%;border-radius:8px;margin:12px 0"/>` : ''}
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;font-size:13px;white-space:pre-wrap">
        ${(blog.content || '').slice(0, 800)}...
      </div>
    </div>`

  await insertApprovalGate(ctx, 'blog_create_github_pr', {
    referenceId: saved.id,
    previewHtml,
  })

  // Update payload with blogId for the next step
  ctx.payload.blogId = saved.id
  ctx.payload.blog = { ...blog, id: saved.id, image_url: image?.url, image_s3_key: image?.key }
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 5: Create GitHub PR
// Ports: create_github_pr.py
// ═══════════════════════════════════════════════════════════════════════════

export async function blogCreateGithubPr(ctx) {
  const { payload, env } = ctx
  const blogId = payload.blogId || payload.blog?.id
  if (!blogId) throw new Error('Missing blogId in payload')

  // Reload full blog content from Supabase
  const sb = getClient(env)
  const rows = await sb.select('blog_posts', `id=eq.${blogId}&limit=1`)
  if (!rows.length) throw new Error(`Blog post not found: ${blogId}`)
  const blog = rows[0]

  const token      = env.GITHUB_TOKEN
  const repoOwner  = env.WEBSITE_REPO_OWNER || ''
  const repoName   = env.WEBSITE_REPO_NAME  || ''
  const baseBranch = env.WEBSITE_BASE_BRANCH || 'main'
  const blogDir    = env.WEBSITE_BLOG_DIR || 'content/blog'

  if (!repoOwner || !repoName) {
    throw new Error(`Missing GitHub config: WEBSITE_REPO_OWNER='${repoOwner}', WEBSITE_REPO_NAME='${repoName}'`)
  }

  const ghApi = 'https://api.github.com'
  const ghHeaders = {
    'Authorization':        `Bearer ${token}`,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
    'User-Agent':           'StellarWorkflows/1.0',
  }

  async function gh(method, path, body) {
    const res = await fetch(`${ghApi}${path}`, {
      method,
      headers: ghHeaders,
      body:    body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub ${method} ${path}: ${res.status} ${text}`)
    }
    return res.json()
  }

  try {
    // 1. Get base branch SHA
    const refData = await gh('GET', `/repos/${repoOwner}/${repoName}/git/refs/heads/${baseBranch}`)
    const baseSha = refData.object.sha

    // 2. Create new branch
    const today     = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const newBranch = `blog/${blog.slug?.slice(0, 40) || blogId}-${today}`
    await gh('POST', `/repos/${repoOwner}/${repoName}/git/refs`, {
      ref: `refs/heads/${newBranch}`,
      sha: baseSha,
    })

    // 3. Build MDX file content
    const pubDate  = new Date().toISOString().slice(0, 10)
    const tagsYaml = (blog.tags || ['general']).map(t => `  - ${t}`).join('\n')
    const fileContent = `---
title: "${blog.title || ''}"
date: "${pubDate}"
excerpt: "${blog.excerpt || ''}"
image: "${blog.image_url || ''}"
author: "Stellar Global Supplies"
tags:
${tagsYaml}
---

${blog.content || ''}
`

    // 4. Create file in new branch
    const filePath = `${blogDir}/${blog.slug || blogId}.md`
    const encoded  = btoa(unescape(encodeURIComponent(fileContent)))
    await gh('PUT', `/repos/${repoOwner}/${repoName}/contents/${filePath}`, {
      message: `feat: add blog post '${blog.title}'`,
      content: encoded,
      branch:  newBranch,
    })

    // 5. Open Pull Request
    const pr = await gh('POST', `/repos/${repoOwner}/${repoName}/pulls`, {
      title: `[Blog] ${blog.title}`,
      body:  `## New Blog Post\n\n**Title:** ${blog.title}\n\n**Excerpt:** ${blog.excerpt || ''}\n\n**Tags:** ${(blog.tags || []).join(', ')}\n\n**Featured Image:** ${blog.image_url || ''}\n\n---\n*Auto-generated by Stellar Workflows Platform*`,
      head:  newBranch,
      base:  baseBranch,
    })

    const prUrl    = pr.html_url
    const prNumber = pr.number

    // Update blog post status
    await sb.update('blog_posts', {
      status:    'pr_created',
      pr_url:    prUrl,
      pr_number: prNumber,
    }, `id=eq.${blogId}`)

    console.log(`[blog_create_github_pr] PR created: ${prUrl}`)
    
  } catch (e) {
    console.error(`[blog_create_github_pr] GitHub PR creation failed:`, e)
    
    // Update blog status to indicate PR creation failed
    await sb.update('blog_posts', {
      status: 'draft',
    }, `id=eq.${blogId}`)
    
    // Insert approval gate so user can manually retry
    await ctx.d1.insert('approval_queue', {
      id:              crypto.randomUUID(),
      workflow_type:   'blog',
      workflow_run_id: ctx.workflow_run_id,
      reference_id:    blogId,
      task_token:      `blog-retry-${crypto.randomUUID()}`,
      payload:         { 
        blogId, 
        blog,
        approvalGate: 'save', 
        _nextStep: 'blog_create_github_pr',
        error: e.message 
      },
      preview_html:    `<p>GitHub PR creation failed: ${e.message}</p><p>The blog post has been saved as a draft and can be retried.</p>`,
      status:          'pending',
      created_at:      new Date().toISOString(),
    })
    
    await ctx.d1.update('job_queue', { status: 'waiting_for_approval' }, { id: ctx.job.id })
    if (ctx.workflow_run_id) {
      await ctx.d1.update('workflow_runs', { status: 'awaiting_approval' }, { id: ctx.workflow_run_id })
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Helper: Build image prompt for blog featured image
// ═══════════════════════════════════════════════════════════════════════════

async function buildBlogImagePrompt(env, { title, topic, excerpt, tags }) {
  const techKeywords = ['software', 'platform', 'system', 'workflow', 'automation', 'tech', 'digital',
    'dashboard', 'api', 'app', 'saas', 'cloud', 'data', 'analytics', 'ai', 'erp', 'order management']
  const topicLower = (topic + ' ' + title).toLowerCase()
  const isTech = techKeywords.some(kw => topicLower.includes(kw))

  const styleRules = isTech ? `
- Describe a realistic editorial tech photograph: a laptop or monitor in a modern bright office
- Screen shows a relevant dashboard UI, workflow diagram, or analytics chart related to the blog topic
- Natural window light, wooden desk, shallow depth of field, sharp screen
- Navy and gold colour accents on the UI visible on screen
- Style: realistic DSLR editorial tech photography
- Never use: physical products, industrial setting, warehouse, machinery`
    : `
- Describe a realistic product or industry photograph relevant to the blog topic
- Simple clean background: grey studio sweep, wooden workbench, or professional office
- Natural even lighting, sharp product, slight background blur
- Muted natural tones, no HDR or oversaturation
- Style: realistic DSLR editorial photography
- Never use: cinematic, render, 3D, glowing, AI art style`

  const instruction = `Write a FLUX image generation prompt (60-80 words) for a featured blog post image.

Blog title: ${title}
Topic: ${topic}
Summary: ${(excerpt || '').slice(0, 200)}
Tags: ${(tags || []).slice(0, 5).join(', ')}

Style rules:${styleRules}

Additional rules:
- Be specific — describe exact visual elements, not generic descriptions
- Include: "DSLR photo", "natural lighting", "realistic", "photorealistic"
- Output ONLY the prompt — no explanation, no preamble, no quotes`

  try {
    const prompt = (await bedrockGenerateText(env, instruction, '', 150)).trim().replace(/^"|"$/g, '')
    return prompt
  } catch (e) {
    if (isTech) {
      return `Realistic DSLR photo of a laptop in a modern professional office showing a clean dashboard UI related to ${topic}, natural window light, sharp screen, shallow depth of field, realistic tech photography`
    }
    return `Realistic DSLR editorial photo representing ${topic} for a B2B industrial supply company, natural lighting, professional setting, photorealistic`
  }
}