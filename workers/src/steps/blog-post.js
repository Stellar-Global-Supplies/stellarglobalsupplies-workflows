/**
 * Blog Post Workflow — Optimised
 *
 * Input: optional product_name (if blank, auto-picks next unwritten product from Stellar catalogue)
 *
 * Blog structure (fixed):
 *   1. Introduction — what the product is and why it matters in Indian industry
 *   2. Why This Product — common problems it solves, industry pain points
 *   3. Use Cases — real applications across industries (construction, pharma, auto, etc.)
 *   4. Why Stellar Global Supplies — promote Stellar with specs, certifications, pricing, delivery
 *   5. Conclusion + CTA — call +91 9637655556 or visit stellarglobalsupplies.com
 *
 * SEO rules:
 *   - Product name in title (first 60 chars)
 *   - Product name + "Pune" / "India" / "supplier" in meta description
 *   - Product name used naturally throughout, especially in H2 headings
 *   - Internal link to stellarglobalsupplies.com and /promotional-products where relevant
 *
 * Auto-rotation: picks the next product not yet written about.
 * Dedup: checks blog_posts table by product keyword before generating.
 *
 * All 20 products from stellarglobalsupplies.com:
 * MS: Angles, Flats, Round Pipes, Sheet, Square Tubes, Channels, Chequered Plate, Galvanised Sheets
 * SS: Sheets, Plates, Round Bars, Round Pipes, Channels, Circles
 * L&F: MS NYLOCK Nuts, Internal Circlips DIN 472, External Circlips DIN 471,
 *       Nordlock Washers, Hex Bolts, Allen Bolts, Lock Nuts, Washers, Dowel Pins
 */

import { bedrockGenerateJson, bedrockGenerateText } from '../lib/bedrock.js'
import { getClient }                                from '../lib/supabase.js'
import { uploadImage, imageExtAndType }             from '../lib/assets.js'
import { generateAndUploadImage }                   from '../lib/image-gen.js'
import { nowIso, slugify }                          from '../lib/utils.js'
import { nextJob, insertApprovalGate }              from '../job-runner.js'

async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  return String(val)
}

// Image generation via Cloudflare Workers AI — synchronous, no polling

// ── Complete Stellar product catalogue ───────────────────────────────────────

const STELLAR_PRODUCTS = [
  // Mild Steel
  {
    name:       'MS Angles',
    category:   'Mild Steel',
    url_path:   '/products/ms-angles',
    keywords:   ['MS angles', 'mild steel angles', 'structural steel angles', 'angle iron'],
    industries: ['construction', 'steel fabrication', 'EPC contractors', 'infrastructure'],
    specs:      'Available in various sizes from 20×20mm to 150×150mm, IS 2062 Grade',
  },
  {
    name:       'MS Flats',
    category:   'Mild Steel',
    url_path:   '/products/ms-flats',
    keywords:   ['MS flats', 'mild steel flat bars', 'flat bar steel'],
    industries: ['fabrication', 'engineering workshops', 'auto ancillaries', 'gates & grills'],
    specs:      'Precision-rolled flat bars, multiple widths and thicknesses, IS 2062 Grade',
  },
  {
    name:       'MS Round Pipes',
    category:   'Mild Steel',
    url_path:   '/products/ms-round-pipes',
    keywords:   ['MS round pipes', 'mild steel pipes', 'ERW pipes', 'MS circular pipes'],
    industries: ['plumbing contractors', 'HVAC', 'structural applications', 'furniture manufacturing'],
    specs:      'ERW (Electric Resistance Welded), IS 1239 compliant, various diameters',
  },
  {
    name:       'MS Sheet',
    category:   'Mild Steel',
    url_path:   '/products/ms-sheet',
    keywords:   ['MS sheet', 'mild steel sheet', 'hot rolled sheet', 'CR sheet'],
    industries: ['press shops', 'auto body shops', 'enclosure manufacturing', 'general fabrication'],
    specs:      'Hot-rolled and cold-rolled, IS 2062, multiple gauges from 1.6mm to 12mm',
  },
  {
    name:       'MS Square Tubes',
    category:   'Mild Steel',
    url_path:   '/products/ms-square-tubes',
    keywords:   ['MS square tubes', 'mild steel square tubes', 'hollow square sections', 'box sections'],
    industries: ['furniture manufacturers', 'construction scaffolding', 'material handling equipment'],
    specs:      'Hollow square sections, IS 4923, various sizes from 12×12mm to 100×100mm',
  },
  {
    name:       'MS Channels',
    category:   'Mild Steel',
    url_path:   '/products/ms-channels',
    keywords:   ['MS channels', 'mild steel channels', 'C channels', 'steel channels'],
    industries: ['structural fabrication', 'civil construction', 'purlins', 'support structures'],
    specs:      'C-section channels, IS 2062, ISMC 75 to ISMC 300 series',
  },
  {
    name:       'MS Chequered Plate',
    category:   'Mild Steel',
    url_path:   '/products/ms-chequered-plate',
    keywords:   ['MS chequered plate', 'chequered plate', 'anti-slip plate', 'diamond plate'],
    industries: ['flooring for factories', 'ramps', 'stair treads', 'vehicle loading platforms'],
    specs:      'IS 3502 compliant, raised pattern for anti-slip, 2.5mm to 8mm thickness',
  },
  {
    name:       'MS Galvanised Sheets',
    category:   'Mild Steel',
    url_path:   '/products/ms-galvanised-sheets',
    keywords:   ['MS galvanised sheets', 'galvanised steel', 'zinc coated sheets', 'GI sheets'],
    industries: ['roofing contractors', 'agricultural equipment', 'outdoor structures', 'ducting'],
    specs:      'Hot-dip galvanised, IS 277, zinc coating 120–275 gsm, various gauges',
  },
  // Stainless Steel
  {
    name:       'SS Sheets',
    category:   'Stainless Steel',
    url_path:   '/products/ss-sheets',
    keywords:   ['SS sheets', 'stainless steel sheets', 'SS 304 sheets', 'SS 316 sheets'],
    industries: ['food processing equipment', 'pharma plant fabrication', 'kitchen equipment', 'chemical tanks'],
    specs:      'Grades 304, 316, 202 — 2B, No. 4, mirror finish — IS 6911 compliant',
  },
  {
    name:       'SS Plates',
    category:   'Stainless Steel',
    url_path:   '/products/ss-plates',
    keywords:   ['SS plates', 'stainless steel plates', 'SS 304 plates', 'thick SS plates'],
    industries: ['pressure vessels', 'heat exchangers', 'heavy fabrication', 'defence equipment'],
    specs:      'Grades 304 / 316 / 316L, 6mm to 100mm thickness, ASTM A240 compliant',
  },
  {
    name:       'SS Round Bars',
    category:   'Stainless Steel',
    url_path:   '/products/ss-round-bars',
    keywords:   ['SS round bars', 'stainless steel round bars', 'SS 304 bars', 'bright bars'],
    industries: ['shaft manufacture', 'CNC machining', 'fastener manufacturing', 'marine hardware'],
    specs:      'Grades 304, 316, 202, bright and black finish, 6mm to 150mm diameter',
  },
  {
    name:       'SS Round Pipes',
    category:   'Stainless Steel',
    url_path:   '/products/ss-round-pipes',
    keywords:   ['SS round pipes', 'stainless steel pipes', 'SS 304 pipes', 'food grade pipes'],
    industries: ['dairy equipment', 'food processing lines', 'pharma piping', 'water treatment'],
    specs:      'Grades 304 / 316, seamless and welded, IS 6911, sanitary and industrial finish',
  },
  {
    name:       'SS Channels',
    category:   'Stainless Steel',
    url_path:   '/products/ss-channels',
    keywords:   ['SS channels', 'stainless steel channels', 'SS C channels', 'SS structural'],
    industries: ['food plant structures', 'clean room fabrication', 'marine structures', 'hospital equipment'],
    specs:      'Grade 304 / 316, various ISMC sizes, mirror and 2B finish available',
  },
  // Locking & Fastening
  {
    name:       'MS NYLOCK Nuts',
    category:   'Fasteners',
    url_path:   '/promotional-products',
    keywords:   ['NYLOCK nuts', 'nylon insert lock nuts', 'MS NYLOCK', 'vibration proof nuts'],
    industries: ['automotive assembly', 'heavy machinery', 'construction equipment', 'agriculture equipment'],
    specs:      'Grade 982, M5 to M30, nylon insert for vibration resistance, IS 1367 compliant',
    promotional: true,
  },
  {
    name:       'Internal Circlips DIN 472',
    category:   'Fasteners',
    url_path:   '/promotional-products',
    keywords:   ['internal circlips', 'DIN 472 circlips', 'bore circlips', 'retaining rings internal'],
    industries: ['bearing assemblies', 'gearbox manufacture', 'hydraulic cylinders', 'electric motors'],
    specs:      'DIN 472 standard, spring steel, phosphate and stainless finish, B8 to B100 range',
    promotional: true,
  },
  {
    name:       'External Circlips DIN 471',
    category:   'Fasteners',
    url_path:   '/promotional-products',
    keywords:   ['external circlips', 'DIN 471 circlips', 'shaft circlips', 'retaining rings external'],
    industries: ['shaft assembly', 'pump manufacture', 'motor production', 'power transmission'],
    specs:      'DIN 471 standard, spring steel, reliable shaft retention, A6 to A100 range',
    promotional: true,
  },
  {
    name:       'Nordlock Washers',
    category:   'Fasteners',
    url_path:   '/promotional-products',
    keywords:   ['Nordlock washers', 'wedge locking washers', 'bolt locking washers', 'anti-loosening washers'],
    industries: ['rail equipment', 'heavy engineering', 'wind energy structures', 'bridge construction'],
    specs:      'Wedge-locking technology, M6 to M24, standard grade, eliminates bolt loosening',
    promotional: true,
  },
  {
    name:       'Hex Bolts',
    category:   'Fasteners',
    url_path:   '/products/hex-bolts',
    keywords:   ['hex bolts', 'hexagonal bolts', 'structural bolts', 'Grade 8.8 bolts'],
    industries: ['structural steel connections', 'machinery assembly', 'civil construction', 'general engineering'],
    specs:      'Grade 4.6, 8.8, 10.9 — M6 to M48, IS 1367 compliant, full and partial thread',
  },
  {
    name:       'Allen Bolts',
    category:   'Fasteners',
    url_path:   '/products/allen-bolts',
    keywords:   ['allen bolts', 'socket head cap screws', 'hex socket bolts', 'allen key bolts'],
    industries: ['precision machinery', 'CNC equipment', 'automotive jigs', 'electronics enclosures'],
    specs:      'Grade 10.9, M4 to M24, DIN 912, bright zinc and black oxide finish',
  },
  {
    name:       'Dowel Pins',
    category:   'Fasteners',
    url_path:   '/products/dowel-pins',
    keywords:   ['dowel pins', 'precision dowel pins', 'alignment pins', 'locating pins'],
    industries: ['precision tooling', 'die & mould industry', 'jig and fixture making', 'injection moulding'],
    specs:      'DIN 6325, hardened steel, ground finish, m6 tolerance, 3mm to 25mm diameter',
  },
]

const SYSTEM = `You are an expert SEO content writer and B2B industrial copywriter for Stellar Global Supplies, Pune, India.

Company: Stellar Global Supplies
Website: https://stellarglobalsupplies.com
Products: Mild Steel (MS), Stainless Steel (SS), Industrial Fasteners
Phone: +91 9637655556
Address: Survey No-169, Talawade, Pune – 411062
Email: stellarglobalsupplies@gmail.com

Writing style: informative, professional, practical. Speak to procurement managers, plant engineers, and B2B buyers.
Tone: expert and confident — like an industry professional advising a peer.
Never: be salesy or use generic filler like "In today's fast-paced world" or "In conclusion, it's clear that".
Always: cite specific standards (IS codes, DIN, ASTM), grades, and real industry applications.`


// ═══════════════════════════════════════════════════════════════════════════
// Step 1: Generate Blog Outline
// Selects product (from input or auto-rotation) then generates SEO outline
// ═══════════════════════════════════════════════════════════════════════════

export async function blogGenerateOutline(ctx) {
  const { payload, env } = ctx
  const sb             = getClient(env)
  const inputProduct   = (payload.product_name || '').trim()

  let product

  if (inputProduct) {
    // Find best matching product from catalogue
    const needle = inputProduct.toLowerCase()
    product = STELLAR_PRODUCTS.find(p =>
      p.name.toLowerCase().includes(needle) ||
      p.keywords.some(k => k.toLowerCase().includes(needle)) ||
      needle.includes(p.name.toLowerCase().split(' ').slice(-1)[0])
    ) || {
      name:       inputProduct,
      category:   'Industrial Products',
      url_path:   '/',
      keywords:   [inputProduct, 'industrial supply', 'Pune', 'India'],
      industries: ['manufacturing', 'construction', 'engineering'],
      specs:      'Available from Stellar Global Supplies, Pune',
    }
  } else {
    // Auto-rotate — pick next product not yet blogged about
    const existingBlogs = await sb.select('blog_posts', 'select=title&status=neq.deleted&limit=100')
    const writtenTitles = (existingBlogs || []).map(b => (b.title || '').toLowerCase())

    product = STELLAR_PRODUCTS.find(p =>
      !writtenTitles.some(t =>
        t.includes(p.name.toLowerCase()) ||
        p.keywords.some(k => t.includes(k.toLowerCase()))
      )
    )

    if (!product) {
      // All products written — restart rotation from first
      console.log('[blog_generate_outline] all products covered — restarting rotation')
      product = STELLAR_PRODUCTS[0]
    }
  }

  console.log(`[blog_generate_outline] product="${product.name}" category="${product.category}"`)

  // Check dedup — don't write the same product twice unless explicitly requested
  if (!inputProduct) {
    const existing = await sb.select('blog_posts',
      `title=ilike.${encodeURIComponent(`%${product.name}%`)}&status=neq.deleted&limit=1`
    )
    if (existing.length) {
      // Pick the next unwritten one
      const writtenNames = new Set(
        (await sb.select('blog_posts', 'select=title&status=neq.deleted&limit=100'))
          .map(b => (b.title || '').toLowerCase())
      )
      const next = STELLAR_PRODUCTS.find(p =>
        !writtenNames.has(p.name.toLowerCase()) &&
        !writtenNames.some(t => t.includes(p.name.toLowerCase()))
      )
      if (next) product = next
    }
  }

  const productUrl = `https://stellarglobalsupplies.com${product.url_path}`
  const primaryKw  = product.keywords[0]

  const prompt = `Plan a comprehensive SEO blog post for Stellar Global Supplies about "${product.name}".

Product details:
- Name: ${product.name}
- Category: ${product.category}
- Specifications: ${product.specs}
- Target industries: ${product.industries.join(', ')}
- Primary keyword: ${primaryKw}
- All keywords: ${product.keywords.join(', ')}
- Product page URL: ${productUrl}

REQUIRED BLOG STRUCTURE (use exactly these 5 sections):
1. Introduction — What is ${product.name} and why does it matter in Indian industry?
2. Why ${product.name} — The problems it solves, what happens when you use poor quality, key buying criteria
3. Use Cases of ${product.name} — Real industry applications with specific examples
4. Why Source ${product.name} from Stellar Global Supplies — Our specs, certifications, pricing, delivery
5. Get Your ${product.name} Quote Today — CTA with phone, email, website

SEO rules for title:
- Must contain "${primaryKw}" in the first 60 characters
- Should include "Pune" or "India" or "Supplier" or "B2B"
- Example format: "${product.name} Supplier in Pune | B2B Industrial Supply"
- Or: "Buy ${product.name} in India — Specs, Grades & Pricing Guide"

Return JSON:
{
  "title": "SEO title with product name in first 60 chars",
  "excerpt": "Meta description under 155 chars — must include '${primaryKw}' and 'Stellar Global Supplies'",
  "section_headings": [
    "H2 for section 1",
    "H2 for section 2",
    "H2 for section 3",
    "H2 for section 4",
    "H2 for section 5"
  ],
  "tags": ["${primaryKw.toLowerCase()}", "${product.category.toLowerCase()}", "industrial supply", "pune", "b2b"],
  "primary_keyword": "${primaryKw}",
  "product_page_url": "${productUrl}"
}`

  const outline = await bedrockGenerateJson(env, prompt, SYSTEM, 1000)
  console.log(`[blog_generate_outline] title="${outline.title}"`)

  await nextJob(ctx, 'blog_generate_content', {
    product,
    outline,
    productUrl,
    primaryKw,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Generate Full Blog Content
// Writes the complete blog with the fixed 5-section structure
// ═══════════════════════════════════════════════════════════════════════════

export async function blogGenerateContent(ctx) {
  const { payload, env } = ctx
  const product    = payload.product    || {}
  const outline    = payload.outline    || {}
  const productUrl = payload.productUrl || 'https://stellarglobalsupplies.com'
  const primaryKw  = payload.primaryKw  || product.name

  const sections   = outline.section_headings || []
  const wordCount  = payload.word_count || 900

  const prompt = `Write a complete, SEO-optimised blog post for Stellar Global Supplies.

Title: ${outline.title}
Meta description: ${outline.excerpt}
Primary keyword: ${primaryKw}
All target keywords: ${(product.keywords || []).join(', ')}
Target word count: ${wordCount} words

Product information:
- Name: ${product.name}
- Category: ${product.category}
- Specifications: ${product.specs}
- Industries served: ${(product.industries || []).join(', ')}
- Product URL: ${productUrl}
- Promotional products page: https://stellarglobalsupplies.com/promotional-products

SECTION HEADINGS TO USE (exactly in this order):
${sections.map((h, i) => `${i + 1}. ## ${h}`).join('\n')}

CONTENT RULES:
1. Use the heading structure above — 5 ## headings, each with 2-4 paragraphs
2. Mention "${primaryKw}" naturally in every section — especially in the first sentence of sections 1 and 4
3. Section 3 (Use Cases): name at least 4 specific industries with a concrete use case each
4. Section 4 (Why Stellar): include these facts:
   - ISI/BIS certified products
   - 500+ industrial products under one roof
   - Competitive bulk pricing
   - Pan-India delivery
   - 2-hour quote turnaround
   - Phone: +91 9637655556
   - Address: Survey No-169, Talawade, Pune – 411062
   - Internal link to ${productUrl} using anchor text "${primaryKw}"
   ${product.promotional ? `- Internal link to https://stellarglobalsupplies.com/promotional-products for promotional pricing` : ''}
5. Section 5 (CTA): end with clear action steps — call +91 9637655556, email stellarglobalsupplies@gmail.com, visit stellarglobalsupplies.com
6. Include at least ONE internal link to ${productUrl} in markdown format
7. Keep sentences under 25 words for readability
8. No bullet points except in section 4 where listing features
9. Avoid: "In conclusion", "In today's world", "It's important to note", "It goes without saying"

Return JSON:
{
  "content": "complete markdown blog post — all 5 sections with ## headings, ~${wordCount} words",
  "word_count_estimate": 900
}`

  const result  = await bedrockGenerateJson(env, prompt, SYSTEM, 4000)
  const content = result.content || ''

  console.log(`[blog_generate_content] generated ~${result.word_count_estimate || '?'} words`)

  // Build image prompt
  const imgPrompt = await buildBlogImagePrompt(env, {
    title:    outline.title || product.name,
    product:  product.name,
    category: product.category,
    excerpt:  outline.excerpt || '',
  })

  await nextJob(ctx, 'blog_image_submit', {
    ...payload,
    blog: {
      title:   outline.title,
      excerpt: outline.excerpt,
      content,
      tags:    outline.tags || [],
      product_name: product.name,
    },
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
    await saveBlogAndGoToApproval(ctx, blog, null)
    return
  }

  console.log(`[blog_image_submit] generating featured image via Workers AI FLUX`)

  // Workers AI FLUX — synchronous, OG image ratio 1200x630 for blog featured image
  const storageKey = `blog-images/${crypto.randomUUID()}`
  const image      = await generateAndUploadImage(env, imgPrompt, storageKey, {
    width:  1024,   // Workers AI supports up to 1024 on schnell
    height: 576,    // ~16:9 ratio for blog OG image
  })

  await saveBlogAndGoToApproval(ctx, blog, image)
}


// blogImagePoll removed — Workers AI FLUX is synchronous
// blog_image_submit now generates + uploads in one step


// ═══════════════════════════════════════════════════════════════════════════
// Helper: Save blog to Supabase + create approval gate
// ═══════════════════════════════════════════════════════════════════════════

async function saveBlogAndGoToApproval(ctx, blog, image) {
  const { env } = ctx
  const sb   = getClient(env)
  const slug = slugify(blog.title || 'blog-post') + '-' + crypto.randomUUID().slice(0, 6)

  const row = {
    title:           blog.title   || '',
    slug,
    excerpt:         blog.excerpt || '',
    content:         (blog.content || '').slice(0, 500),   // preview
    image_url:       image?.url  || null,
    image_s3_key:    image?.key  || null,
    tags:            blog.tags   || [],
    status:          'draft',
    workflow_run_id: ctx.workflow_run_id || null,
  }

  // Try insert with all cols, fall back if columns missing
  let saved
  try {
    saved = await sb.insert('blog_posts', row)
  } catch {
    const minimal = { title: row.title, slug, excerpt: row.excerpt,
                      content: row.content, tags: row.tags, status: row.status }
    saved = await sb.insert('blog_posts', minimal)
  }
  console.log(`[blog] saved blogId=${saved.id}`)

  const contentPreview = (blog.content || '').slice(0, 800)
  const imageHtml      = image?.url
    ? `<img src="${image.url}" style="max-width:100%;border-radius:8px;margin:12px 0 20px"/>`
    : '<p style="color:#94a3b8;font-size:12px;font-style:italic">Featured image generating or unavailable</p>'

  const previewHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <h2 style="color:#0A2547;margin:0 0 6px">${blog.title || ''}</h2>
      <p style="color:#64748b;font-size:13px;font-style:italic;margin:0 0 16px">${blog.excerpt || ''}</p>
      ${imageHtml}
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px">
        ${(blog.tags || []).map(t => `<span style="background:#f1f5f9;border-radius:4px;padding:3px 8px;font-size:11px">${t}</span>`).join('')}
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;
                  font-size:13px;line-height:1.7;color:#334155;white-space:pre-wrap;max-height:300px;overflow:hidden">
        ${contentPreview}${contentPreview.length >= 800 ? '\n\n...' : ''}
      </div>
      <p style="color:#64748b;font-size:12px;margin-top:16px">
        Approve to create a GitHub PR. Reject to discard. You can also edit the content before approving.
      </p>
    </div>`

  // Store full content in payload for GitHub PR step
  ctx.payload.blogId = saved.id
  ctx.payload.blog   = {
    ...blog,
    id:            saved.id,
    slug,
    image_url:     image?.url || null,
    image_s3_key:  image?.key || null,
    full_content:  blog.content,
  }

  await insertApprovalGate(ctx, 'blog_create_github_pr', {
    referenceId: saved.id,
    title:       blog.title,
    blog:        ctx.payload.blog,
    previewHtml,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 5: Create GitHub PR
// ═══════════════════════════════════════════════════════════════════════════

export async function blogCreateGithubPr(ctx) {
  const { payload, env } = ctx
  const blog   = payload.blog   || {}
  const blogId = payload.blogId || blog.id
  if (!blogId) throw new Error('Missing blogId in payload')

  const sb = getClient(env)
  const rows = await sb.select('blog_posts', `id=eq.${blogId}&limit=1`)
  if (!rows.length) throw new Error(`Blog post not found: ${blogId}`)
  const saved = rows[0]

  // Use full_content from payload — DB only stores preview
  const fullContent = blog.full_content || saved.content || ''

  const token      = await resolveSecret(env.GITHUB_TOKEN)
  const repoOwner  = await resolveSecret(env.WEBSITE_REPO_OWNER)
  const repoName   = await resolveSecret(env.WEBSITE_REPO_NAME)
  const baseBranch = await resolveSecret(env.WEBSITE_BASE_BRANCH) || 'main'
  const blogDir    = await resolveSecret(env.WEBSITE_BLOG_DIR)    || 'content/blog'

  if (!token)     throw new Error('Missing: GITHUB_TOKEN')
  if (!repoOwner) throw new Error('Missing: WEBSITE_REPO_OWNER')
  if (!repoName)  throw new Error('Missing: WEBSITE_REPO_NAME')

  const gh = async (method, path, body) => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization:          `Bearer ${token}`,
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type':         'application/json',
        'User-Agent':           'StellarWorkflows/1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`)
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  }

  const refData   = await gh('GET', `/repos/${repoOwner}/${repoName}/git/refs/heads/${baseBranch}`)
  const baseSha   = refData.object.sha
  const today     = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const newBranch = `blog/${(saved.slug || blogId).slice(0, 40)}-${today}`

  await gh('POST', `/repos/${repoOwner}/${repoName}/git/refs`, {
    ref: `refs/heads/${newBranch}`,
    sha: baseSha,
  })

  const pubDate  = new Date().toISOString().slice(0, 10)
  const tagsYaml = (saved.tags || []).map(t => `  - "${t}"`).join('\n')

  const fileContent = `---
title: "${(saved.title || '').replace(/"/g, '\\"')}"
date: "${pubDate}"
excerpt: "${(saved.excerpt || '').replace(/"/g, '\\"')}"
image: "${saved.image_url || ''}"
author: "Stellar Global Supplies"
product: "${blog.product_name || ''}"
tags:
${tagsYaml}
seo:
  title: "${(saved.title || '').replace(/"/g, '\\"')}"
  description: "${(saved.excerpt || '').replace(/"/g, '\\"').slice(0, 155)}"
---

${fullContent}
`

  const filePath = `${blogDir}/${saved.slug || blogId}.md`
  await gh('PUT', `/repos/${repoOwner}/${repoName}/contents/${filePath}`, {
    message: `blog: ${saved.title}`,
    content: btoa(unescape(encodeURIComponent(fileContent))),
    branch:  newBranch,
  })

  const pr = await gh('POST', `/repos/${repoOwner}/${repoName}/pulls`, {
    title: `[Blog] ${saved.title}`,
    body:  `## New Blog Post\n\n**Title:** ${saved.title}\n**Product:** ${blog.product_name || ''}\n**Excerpt:** ${saved.excerpt || ''}\n**Tags:** ${(saved.tags || []).join(', ')}\n**Image:** ${saved.image_url || 'None'}\n\n---\n*Auto-generated by Stellar Workflows*`,
    head:  newBranch,
    base:  baseBranch,
  })

  console.log(`[blog_create_github_pr] PR #${pr.number}: ${pr.html_url}`)

  try {
    await sb.update('blog_posts', {
      status:    'pr_created',
      pr_url:    pr.html_url,
      pr_number: pr.number,
    }, `id=eq.${blogId}`)
  } catch {
    await sb.update('blog_posts', { status: 'pr_created' }, `id=eq.${blogId}`)
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Helper: Blog featured image prompt
// ═══════════════════════════════════════════════════════════════════════════

async function buildBlogImagePrompt(env, { title, product, category, excerpt }) {
  const instruction = `Write a FLUX image generation prompt (60-80 words) for a B2B blog post featured image.

Blog title: ${title}
Product: ${product}
Category: ${category}
Excerpt: ${excerpt.slice(0, 150)}

Rules:
- Show the physical product in a professional industrial setting (workshop, factory, construction site, warehouse)
- Natural lighting, DSLR editorial style, shallow depth of field
- Product should be the clear hero of the image
- Clean, professional, photorealistic — no text, no logos, no people
- For stainless steel: bright clean studio or food-grade environment
- For fasteners: precision close-up in machining or assembly context
- Include: "DSLR photo", "natural lighting", "photorealistic"
Output ONLY the prompt text — no preamble, no quotes`

  try {
    return (await bedrockGenerateText(env, instruction, '', 150))
      .trim().replace(/^"|"$/g, '')
  } catch {
    return `Realistic DSLR editorial photograph of ${product} in a professional industrial setting, natural lighting, sharp focus on product, photorealistic, no text`
  }
}