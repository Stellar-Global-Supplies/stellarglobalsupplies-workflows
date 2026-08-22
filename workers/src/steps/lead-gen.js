/**
 * Lead Generation — Optimised Pipeline
 *
 * Input: location only (city, state, or country)
 * Goal: find companies in that location who are BUYERS of Stellar's products
 *
 * Stellar Global Supplies products:
 *   MILD STEEL:       MS Angles, MS Flats, MS Round Pipes, MS Sheet, MS Square Tubes,
 *                     MS Channels, MS Chequered Plate, MS Galvanised Sheets
 *   STAINLESS STEEL:  SS Sheets, SS Plates, SS Round Bars, SS Round Pipes, SS Channels
 *   LOCKING/FASTENING: MS NYLOCK Nuts, Internal Circlips (DIN 472), External Circlips (DIN 471),
 *                      Nordlock Washers, Hex Bolts, Allen Bolts, Lock Nuts, Washers, Dowel Pins
 *
 * Buyer industries (who uses our products):
 *   Manufacturers, fabricators, construction companies, auto ancillaries,
 *   engineering workshops, EPC contractors, infrastructure companies,
 *   plant & machinery makers, pharmaceutical plant builders,
 *   food processing equipment makers, HVAC companies, furniture manufacturers
 *
 * Steps (STANDARD pipeline — input: location):
 *   lead_select_product_and_industry  → CF AI picks best product + industry match for location
 *   lead_tavily_find_buyers           → Tavily finds real companies buying that product
 *   lead_cf_extract_company           → CF AI extracts structured company data
 *   lead_check_duplicate              → skip if already in DB
 *   lead_tavily_find_contact          → Tavily finds procurement/purchase decision maker
 *   lead_tavily_scrape_website        → Tavily scrapes website for email/phone
 *   lead_cf_extract_email             → CF AI extracts best email with fallback chain
 *   lead_save                         → save to Supabase
 *   lead_gen_draft_email              → CF AI drafts product-specific outreach
 *   lead_gen_approval_gate            → email notification + dashboard approval
 *   lead_gen_send_email               → send approved email via Gmail
 *
 * Steps (PROMO pipeline — input: product_name only, e.g. "MS Nylock Nuts"):
 *   lead_promo_init                   → hardcoded ICP + rotates MIDC hub, builds search context
 *   lead_promo_tavily_find_buyers     → Tavily finds companies in MIDC hub matching ICP
 *   lead_promo_extract_company        → CF AI extracts structured company data (bulk/recurring framing)
 *   → rejoins standard pipeline at lead_check_duplicate onward
 *
 * Required secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *   TAVILY_API_KEY,
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
 *   SENDER_EMAIL, REVIEWER_EMAIL, API_BASE_URL
 * (AI inference uses CF Workers AI binding — no Bedrock/Groq keys needed)
 */

import { cfAiGenerateJson, cfAiExtractJson } from '../lib/cf-ai.js'
import { getClient }                         from '../lib/supabase.js'
import { nowIso }                            from '../lib/utils.js'
import { nextJob, insertApprovalGate }       from '../job-runner.js'

async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  return String(val)
}

const TAVILY_BASE = 'https://api.tavily.com'

// ── Stellar product catalogue ─────────────────────────────────────────────────

const STELLAR_PRODUCTS = {
  'MS Angles & Channels': {
    buyers: ['structural fabricators', 'construction companies', 'EPC contractors', 'building material dealers'],
    search_terms: ['steel structure fabrication', 'construction material procurement', 'structural steel buyer'],
    product_pitch: 'MS Angles (various sizes) and MS Channels for structural applications — competitive bulk pricing from Pune',
  },
  'MS Pipes & Tubes': {
    buyers: ['plumbing contractors', 'HVAC companies', 'process piping fabricators', 'furniture manufacturers'],
    search_terms: ['MS pipe procurement', 'steel tube buyer', 'pipe fittings contractor'],
    product_pitch: 'MS Round Pipes and MS Square Tubes — seamless supply for fluid and structural applications',
  },
  'MS Sheet & Plate': {
    buyers: ['sheet metal fabricators', 'press shop manufacturers', 'auto ancillaries', 'engineering workshops'],
    search_terms: ['MS sheet metal fabrication', 'press shop mild steel buyer', 'auto parts manufacturer'],
    product_pitch: 'MS Sheets, Chequered Plates, and Galvanised Sheets — quality verified, bulk orders welcome',
  },
  'Stainless Steel Products': {
    buyers: ['food processing equipment makers', 'pharma plant builders', 'chemical plant fabricators', 'hotel & hospitality equipment makers'],
    search_terms: ['stainless steel fabrication buyer', 'SS equipment manufacturer', 'food grade steel procurement'],
    product_pitch: 'SS 304/316/202 Sheets, Round Bars, and Pipes — food grade, pharma grade, corrosion resistant',
  },
  'Industrial Fasteners': {
    buyers: ['OEM manufacturers', 'machine builders', 'automotive assembly', 'heavy engineering companies'],
    search_terms: ['industrial fastener buyer OEM', 'nut bolt procurement manufacturer', 'assembly line fastener supplier'],
    product_pitch: 'NYLOCK Nuts, Circlips (DIN 471/472), Nordlock Washers, Hex & Allen Bolts — Grade 8.8 and above',
  },
}

const SKIP_DOMAINS = new Set([
  'linkedin.com','indeed.com','glassdoor.com','naukri.com','justdial.com',
  'wikipedia.org','facebook.com','twitter.com','instagram.com','youtube.com',
  'indiamart.com','tradeindia.com','exportersindia.com','alibaba.com',
  'amazon.in','flipkart.com','google.com','bing.com','yahoo.com',
])


// ── Tavily helpers ────────────────────────────────────────────────────────────

async function tavilySearch(env, query, depth = 'basic', maxResults = 5) {
  const apiKey = await resolveSecret(env.TAVILY_API_KEY)
  if (!apiKey) throw new Error('Missing secret: TAVILY_API_KEY')

  const res = await fetch(`${TAVILY_BASE}/search`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ api_key: apiKey, query, search_depth: depth, max_results: maxResults }),
  })
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`)
  return res.json()
}

function cleanDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') }
  catch { return '' }
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 1: Select Best Product + Industry for Location
// Uses Groq to decide which product category and buyer industry
// is most relevant for the given location — no user input needed for this
// ═══════════════════════════════════════════════════════════════════════════

export async function leadSelectProductAndIndustry(ctx) {
  const { payload, env } = ctx
  const location = (payload.location || 'Pune, Maharashtra, India').trim()

  // Rotate through product categories — use a simple hash of the run ID
  // so different runs target different products even for the same location
  const productKeys  = Object.keys(STELLAR_PRODUCTS)
  const runId        = ctx.workflow_run_id || crypto.randomUUID()
  const idx          = parseInt(runId.replace(/-/g, '').slice(0, 4), 16) % productKeys.length
  const selectedProduct = productKeys[idx]
  const productData     = STELLAR_PRODUCTS[selectedProduct]

  const prompt = `You are a B2B sales intelligence expert for Stellar Global Supplies, based in Pune, India.
Stellar sells these products: ${selectedProduct} — ${productData.product_pitch}

Location to target: ${location}

Based on the location, select the most relevant buyer type from this list:
${productData.buyers.map((b, i) => `${i+1}. ${b}`).join('\n')}

Also suggest the best search term to find these companies on the web.

Return JSON:
{
  "selected_product":    "${selectedProduct}",
  "selected_industry":   "chosen buyer type from the list",
  "search_term":         "3-6 word web search to find these companies in ${location}",
  "product_pitch":       "${productData.product_pitch}",
  "why_this_industry":   "one sentence explaining why this industry buys this product"
}`

  const result = await cfAiExtractJson(env, prompt,
    'You are a B2B sales intelligence expert. Return valid JSON only.', 400)

  console.log(`[lead_select] location=${location} product=${result.selected_product} industry=${result.selected_industry}`)

  await nextJob(ctx, 'lead_tavily_find_buyers', {
    location,
    selected_product:  result.selected_product  || selectedProduct,
    selected_industry: result.selected_industry || productData.buyers[0],
    search_term:       result.search_term       || productData.search_terms[0],
    product_pitch:     result.product_pitch     || productData.product_pitch,
    why_this_industry: result.why_this_industry || '',
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Tavily — Find Real Buyer Companies
// Targeted searches using product-specific buyer terms + location
// Uses 2 Tavily credits max
// ═══════════════════════════════════════════════════════════════════════════

export async function leadTavilyFindBuyers(ctx) {
  const { payload, env } = ctx
  const location  = payload.location        || 'India'
  const industry  = payload.selected_industry || 'manufacturing'
  const searchTerm = payload.search_term    || 'steel buyer manufacturer'
  const product   = payload.selected_product || 'MS Angles & Channels'

  // Two targeted queries — one company-focused, one buyer-intent-focused
  const queries = [
    `${industry} company ${location} official website procurement contact`,
    `${searchTerm} ${location} company buy supply requirement`,
  ]

  const allResults = []
  for (const query of queries) {
    try {
      const result = await tavilySearch(env, query, 'basic', 7)
      allResults.push(...(result.results || []))
    } catch (e) {
      console.warn(`[lead_tavily_find_buyers] query failed: ${e.message}`)
    }
  }

  // Deduplicate by domain, skip directories and irrelevant sites
  const seen      = new Set()
  const companies = []

  for (const r of allResults) {
    const domain = cleanDomain(r.url)
    if (!domain || seen.has(domain)) continue
    if ([...SKIP_DOMAINS].some(skip => domain.includes(skip))) continue
    seen.add(domain)
    companies.push({
      company_name: (r.title || domain)
        .replace(/ [-|·–—].*$/, '')
        .replace(/\s+(India|Pvt|Ltd|Private|Limited|Inc|Corp|LLP).*$/i, '')
        .trim()
        .slice(0, 80),
      website:      `https://${domain}`,
      description:  (r.content || '').slice(0, 400),
      domain,
    })
    if (companies.length >= 3) break  // Take top 3 unique companies
  }

  if (!companies.length) {
    throw new Error(`No buyer companies found in ${location} for ${product}`)
  }

  // Pick the most relevant company using Groq
  const pickPrompt = `Stellar Global Supplies sells ${product} to buyers in ${location}.

Here are companies found:
${companies.map((c, i) => `${i+1}. ${c.company_name} (${c.domain})\n   ${c.description.slice(0, 200)}`).join('\n\n')}

Pick the company MOST likely to be an actual buyer of ${product}.
Prefer companies that:
- Are manufacturers, fabricators, or contractors (not dealers/distributors)
- Have a real website (not a directory page)
- Are based in or near ${location}
- Show signs of using steel, pipes, fasteners, or structural materials

Return JSON:
{
  "selected_index": 0,
  "confidence":     "high | medium | low",
  "reason":         "one sentence why this company is a good prospect"
}`

  let selectedIdx = 0
  try {
    const pick = await cfAiExtractJson(env, pickPrompt, 'Pick the best B2B lead. Return JSON only.', 200)
    selectedIdx = Math.min(parseInt(pick.selected_index) || 0, companies.length - 1)
    console.log(`[lead_tavily_find_buyers] picked idx=${selectedIdx} confidence=${pick.confidence} reason=${pick.reason}`)
  } catch (e) {
    console.warn(`[lead_tavily_find_buyers] company selection failed, using first result: ${e.message}`)
  }

  const company = companies[selectedIdx]
  console.log(`[lead_tavily_find_buyers] selected=${company.company_name} domain=${company.domain}`)

  await nextJob(ctx, 'lead_cf_extract_company', {
    ...payload,
    company,
    companies,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// PROMO PIPELINE — Fastener/Locking Product Lead Generation
// Input: product_name only (e.g. "MS Nylock Nuts", "Nord-Lock Washers",
//        "Internal Circlips", "External Circlips")
//
// Fixed ICP (hardcoded, not user input):
//   Sectors:   Manufacturing, Automotive, Aerospace, Construction, Engineering
//   Size:      Medium to large enterprises
//   Geography: Maharashtra MIDC industrial hubs
//   Intent:    Regular/recurring bulk orders, long-term supply partnership fit
// ═══════════════════════════════════════════════════════════════════════════

const PROMO_PRODUCTS = {
  'MS Nylock Nuts': {
    aliases:  ['MS Nylock Nuts', 'Nylock Nuts', 'Nylon Insert Lock Nuts'],
    pitch:    'MS NYLOCK Nuts (Nylon Insert Lock Nuts) — vibration-resistant locking, Grade 8.8+, bulk stock',
    use_case: 'anti-vibration fastening in machinery assembly, chassis mounting, and structural joints',
  },
  'Nord-Lock Washers': {
    aliases:  ['Nord-Lock Washers', 'Nordlock Washers', 'Wedge Locking Washers'],
    pitch:    'Nord-Lock Washers — wedge-locking technology for high-vibration bolted joints, zero maintenance',
    use_case: 'critical bolted joints in heavy machinery, wind turbines, and automotive assembly lines subject to dynamic loads',
  },
  'Internal Circlips': {
    aliases:  ['Internal Circlips', 'Internal Circlips DIN 472', 'Retaining Rings Internal'],
    pitch:    'Internal Circlips (DIN 472) — precision retaining rings for bore applications, spring steel',
    use_case: 'shaft and bore retention in gearboxes, bearings, and precision-machined assemblies',
  },
  'External Circlips': {
    aliases:  ['External Circlips', 'External Circlips DIN 471', 'Retaining Rings External'],
    pitch:    'External Circlips (DIN 471) — precision retaining rings for shaft applications, spring steel',
    use_case: 'shaft retention in automotive transmissions, aerospace actuators, and rotating machinery',
  },
}

const PROMO_SECTORS = [
  { name: 'Automotive & Auto Ancillary',      terms: ['auto component manufacturer', 'automotive OEM supplier', 'auto ancillary unit'] },
  { name: 'Manufacturing & Engineering',      terms: ['precision engineering company', 'industrial machine manufacturer', 'heavy engineering works'] },
  { name: 'Aerospace & Defence',              terms: ['aerospace component manufacturer', 'defence equipment manufacturer'] },
  { name: 'Construction & Infrastructure',    terms: ['construction equipment manufacturer', 'infrastructure EPC contractor'] },
]

// Maharashtra MIDC industrial hubs — rotated per run for geographic spread
const MIDC_HUBS = [
  'Pune MIDC',
  'Chakan MIDC',
  'Bhosari MIDC',
  'Ranjangaon MIDC',
  'Talegaon MIDC',
  'Taloja MIDC',
  'Nashik MIDC (Satpur/Ambad)',
  'Aurangabad MIDC (Waluj/Shendra)',
  'Butibori MIDC, Nagpur',
  'Kolhapur MIDC (Shiroli/Gokul Shirgaon)',
]

function resolvePromoProduct(rawName = '') {
  const needle = rawName.trim().toLowerCase()
  for (const [canonical, data] of Object.entries(PROMO_PRODUCTS)) {
    if (canonical.toLowerCase() === needle) return { canonical, ...data }
    if (data.aliases.some(a => a.toLowerCase() === needle)) return { canonical, ...data }
  }
  // Fuzzy fallback — partial match on alias words
  for (const [canonical, data] of Object.entries(PROMO_PRODUCTS)) {
    if (data.aliases.some(a => needle.includes(a.toLowerCase()) || a.toLowerCase().includes(needle))) {
      return { canonical, ...data }
    }
  }
  return null
}


// ═══════════════════════════════════════════════════════════════════════════
// Promo Step 1: Init — Resolve Product, Fix ICP, Rotate MIDC Hub
// ═══════════════════════════════════════════════════════════════════════════

export async function leadPromoInit(ctx) {
  const { payload, env } = ctx
  const rawProductName = (payload.product_name || payload.productName || '').trim()

  if (!rawProductName) throw new Error('Missing required field: product_name')

  const product = resolvePromoProduct(rawProductName)
  if (!product) {
    throw new Error(
      `Unknown promo product: "${rawProductName}". Valid options: ${Object.keys(PROMO_PRODUCTS).join(', ')}`
    )
  }

  // Rotate MIDC hub and sector using workflow run id, same pattern as standard pipeline
  const runId   = ctx.workflow_run_id || crypto.randomUUID()
  const seed    = parseInt(runId.replace(/-/g, '').slice(0, 8), 16) || 0
  const hub     = MIDC_HUBS[seed % MIDC_HUBS.length]
  const sector  = PROMO_SECTORS[Math.floor(seed / MIDC_HUBS.length) % PROMO_SECTORS.length]

  console.log(`[lead_promo_init] product=${product.canonical} hub=${hub} sector=${sector.name}`)

  await nextJob(ctx, 'lead_promo_tavily_find_buyers', {
    ...payload,
    selected_product:   product.canonical,
    product_pitch:       product.pitch,
    product_use_case:    product.use_case,
    location:             `${hub}, Maharashtra, India`,
    midc_hub:             hub,
    selected_industry:    sector.name,
    sector_search_terms:  sector.terms,
    icp: {
      business_size: 'Medium to large enterprises with significant industrial product requirements',
      geography:     `Maharashtra MIDC — focus on ${hub} and nearby industrial clusters`,
      purchase_intent: 'Regular, recurring bulk orders with potential for long-term supply contracts',
      sectors:       PROMO_SECTORS.map(s => s.name),
    },
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Promo Step 2: Tavily — Find Buyer Companies in MIDC Hub
// Scoped tightly to sector + MIDC hub + bulk/recurring purchase signals
// ═══════════════════════════════════════════════════════════════════════════

export async function leadPromoTavilyFindBuyers(ctx) {
  const { payload, env } = ctx
  const hub          = payload.midc_hub          || 'Pune MIDC'
  const sectorName    = payload.selected_industry || 'Manufacturing & Engineering'
  const sectorTerms   = payload.sector_search_terms || ['industrial manufacturer']
  const product       = payload.selected_product   || 'Industrial Fasteners'
  const useCase        = payload.product_use_case   || ''

  // Targeted queries: sector + MIDC hub + bulk procurement intent
  const queries = [
    `${sectorTerms[0]} "${hub}" Maharashtra official website`,
    `${sectorTerms[1] || sectorTerms[0]} ${hub} bulk fastener procurement supplier`,
    `medium large manufacturer ${hub} ${sectorName} contact`,
  ]

  const allResults = []
  for (const query of queries) {
    try {
      const result = await tavilySearch(env, query, 'basic', 6)
      allResults.push(...(result.results || []))
    } catch (e) {
      console.warn(`[lead_promo_tavily_find_buyers] query failed: ${e.message}`)
    }
  }

  const seen      = new Set()
  const companies = []

  for (const r of allResults) {
    const domain = cleanDomain(r.url)
    if (!domain || seen.has(domain)) continue
    if ([...SKIP_DOMAINS].some(skip => domain.includes(skip))) continue
    seen.add(domain)
    companies.push({
      company_name: (r.title || domain)
        .replace(/ [-|·–—].*$/, '')
        .replace(/\s+(India|Pvt|Ltd|Private|Limited|Inc|Corp|LLP).*$/i, '')
        .trim()
        .slice(0, 80),
      website:      `https://${domain}`,
      description:  (r.content || '').slice(0, 400),
      domain,
    })
    if (companies.length >= 3) break
  }

  if (!companies.length) {
    throw new Error(`No buyer companies found in ${hub} for ${product}`)
  }

  // Pick the best-fit company using CF AI — emphasise bulk/recurring/medium-large fit
  const pickPrompt = `Stellar Global Supplies sells ${product} (${useCase}) to industrial buyers in Maharashtra's MIDC belt.

Target ICP:
- Medium to large enterprises (not small workshops or traders)
- Sectors: Manufacturing, Automotive, Aerospace, Construction, Engineering
- Located in or near ${hub}
- Likely to place regular, recurring BULK orders — not one-off purchases
- Good candidate for a long-term supply partnership

Companies found:
${companies.map((c, i) => `${i+1}. ${c.company_name} (${c.domain})\n   ${c.description.slice(0, 200)}`).join('\n\n')}

Pick the company that BEST fits the ICP above. Prefer companies that:
- Are manufacturers/OEMs/fabricators (not dealers, distributors, or staffing agencies)
- Show signs of scale (medium/large operation, not a tiny workshop)
- Would plausibly need ${product} in volume, recurring

Return JSON:
{
  "selected_index": 0,
  "confidence":     "high | medium | low",
  "reason":         "one sentence why this company fits the bulk/recurring ICP"
}`

  let selectedIdx = 0
  try {
    const pick = await cfAiExtractJson(env, pickPrompt,
      'Pick the best B2B lead matching a medium-to-large recurring-bulk-buyer ICP. Return JSON only.', 220)
    selectedIdx = Math.min(parseInt(pick.selected_index) || 0, companies.length - 1)
    console.log(`[lead_promo_tavily_find_buyers] picked idx=${selectedIdx} confidence=${pick.confidence} reason=${pick.reason}`)
  } catch (e) {
    console.warn(`[lead_promo_tavily_find_buyers] company selection failed, using first result: ${e.message}`)
  }

  const company = companies[selectedIdx]
  console.log(`[lead_promo_tavily_find_buyers] selected=${company.company_name} domain=${company.domain} hub=${hub}`)

  await nextJob(ctx, 'lead_promo_extract_company', {
    ...payload,
    company,
    companies,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Promo Step 3: CF AI — Extract Structured Company Data
// Same shape as standard leadCfExtractCompany but frames description/why_prospect
// around bulk/recurring purchase fit and MIDC context, then rejoins the
// standard pipeline at lead_check_duplicate.
// ═══════════════════════════════════════════════════════════════════════════

export async function leadPromoExtractCompany(ctx) {
  const { payload, env } = ctx
  const company  = payload.company || payload.companies?.[0] || {}
  const hub       = payload.midc_hub          || 'Maharashtra MIDC'
  const sector    = payload.selected_industry || ''
  const product   = payload.selected_product  || ''
  const useCase   = payload.product_use_case  || ''

  if (!company.company_name) throw new Error('No company data to extract')

  const prompt = `Extract structured B2B lead data for Stellar Global Supplies (industrial fastener supply company, Pune, India).

Company info found:
- Name: ${company.company_name}
- Website: ${company.website}
- Domain: ${company.domain}
- Description: ${company.description}
- MIDC hub context: ${hub}
- Sector context: ${sector}
- Target product: ${product} (${useCase})

Target ICP: medium to large enterprise, recurring bulk buyer, long-term supply partnership potential.

Extract and return JSON:
{
  "company_name":  "official full company name",
  "website":       "${company.website}",
  "domain":        "${company.domain}",
  "industry":      "${sector}",
  "country":       "India",
  "address":       "city/MIDC area and state if found in description, else '${hub}'",
  "description":   "2-3 sentence description of what this company does and its scale (medium/large)",
  "why_prospect":  "one line: why this is a good fit for recurring bulk orders of ${product}"
}`

  const extracted = await cfAiExtractJson(env, prompt,
    'Extract structured B2B lead data for a medium-to-large recurring-bulk-buyer ICP. Be accurate — only use what is in the source. Return JSON only.', 500)

  console.log(`[lead_promo_extract_company] company=${extracted.company_name} product=${product}`)

  // Rejoin the standard pipeline — same shape as leadCfExtractCompany's output
  await nextJob(ctx, 'lead_check_duplicate', {
    ...payload,
    lead: {
      ...extracted,
      source: 'tavily_search_promo',
    },
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 3: Groq — Extract Structured Company Data
// ═══════════════════════════════════════════════════════════════════════════

export async function leadCfExtractCompany(ctx) {
  const { payload, env } = ctx
  const company   = payload.company || payload.companies?.[0] || {}
  const location  = payload.location || 'India'
  const industry  = payload.selected_industry || ''

  if (!company.company_name) throw new Error('No company data to extract')

  const prompt = `Extract structured B2B lead data for Stellar Global Supplies (industrial supply company, Pune, India).

Company info found:
- Name: ${company.company_name}
- Website: ${company.website}
- Domain: ${company.domain}
- Description: ${company.description}
- Location context: ${location}
- Industry context: ${industry}

Extract and return JSON:
{
  "company_name":  "official full company name",
  "website":       "${company.website}",
  "domain":        "${company.domain}",
  "industry":      "${industry}",
  "country":       "India",
  "address":       "city and state if found in description, else '${location}'",
  "description":   "2-3 sentence description of what this company does and why they'd buy industrial steel/fasteners",
  "why_prospect":  "one line: specific product from Stellar they would need and why"
}`

  const extracted = await cfAiExtractJson(env, prompt,
    'Extract structured B2B lead data. Be accurate — only use what is in the source. Return JSON only.', 500)

  console.log(`[lead_cf_extract_company] company=${extracted.company_name}`)

  await nextJob(ctx, 'lead_check_duplicate', {
    ...payload,
    lead: {
      ...extracted,
      source: 'tavily_search',
    },
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 4: Check Duplicate
// Skip if company name or domain already in DB
// ═══════════════════════════════════════════════════════════════════════════

export async function leadCheckDuplicate(ctx) {
  const { payload, env } = ctx
  const lead        = payload.lead || {}
  const sb          = getClient(env)
  const companyName = (lead.company_name || '').toLowerCase().trim()
  const domain      = lead.domain || cleanDomain(lead.website || '')

  let isDuplicate = false
  let existingId  = null

  // Check by domain (most reliable)
  if (domain) {
    const byDomain = await sb.select('leads',
      `website=ilike.${encodeURIComponent(`%${domain}%`)}&select=id,company_name,status&limit=1`
    )
    if (byDomain.length) { isDuplicate = true; existingId = byDomain[0].id }
  }

  // Check by company name if no domain match
  if (!isDuplicate && companyName.length > 3) {
    const byName = await sb.select('leads',
      `company_name=ilike.${encodeURIComponent(`%${companyName}%`)}&select=id,company_name,status&limit=1`
    )
    if (byName.length) { isDuplicate = true; existingId = byName[0].id }
  }

  if (isDuplicate) {
    console.log(`[lead_check_duplicate] duplicate existingId=${existingId} — stopping`)
    if (ctx.workflow_run_id) {
      await ctx.d1.update('workflow_runs', {
        status:       'stopped',
        completed_at: nowIso(),
        output:       { duplicate_found: true, existing_id: existingId, message: 'Duplicate lead — skipped' },
      }, { id: ctx.workflow_run_id })
      await ctx.d1.update('job_queue', {
        status: 'done', completed_at: nowIso(), error_msg: 'Duplicate — skipped',
      }, { id: ctx.job.id })
    }
    return
  }

  console.log(`[lead_check_duplicate] no duplicate — continuing`)
  await nextJob(ctx, 'lead_tavily_find_contact', { ...payload })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 5: Tavily — Find Procurement Contact
// 1 Tavily credit — targeted at procurement/purchase decision maker
// ═══════════════════════════════════════════════════════════════════════════

export async function leadTavilyFindContact(ctx) {
  const { payload, env } = ctx
  const lead    = payload.lead    || {}
  const company = lead.company_name || ''
  const domain  = lead.domain || cleanDomain(lead.website || '')

  // Targeted: find procurement/purchase person at this specific company
  const query = `"${company}" procurement purchase manager director contact${domain ? ` site:${domain} OR site:linkedin.com` : ''}`

  let contacts = []
  try {
    const result = await tavilySearch(env, query, 'basic', 5)
    contacts = (result.results || []).slice(0, 5).map(r => ({
      title:   r.title   || '',
      content: r.content || '',
      url:     r.url     || '',
    }))
  } catch (e) {
    console.warn(`[lead_tavily_find_contact] search failed: ${e.message}`)
  }

  console.log(`[lead_tavily_find_contact] found ${contacts.length} contact results`)

  await nextJob(ctx, 'lead_tavily_scrape_website', { ...payload, contacts })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 6: Tavily — Scrape Company Website
// 1 Tavily credit — scrapes contact/about page for email/phone
// ═══════════════════════════════════════════════════════════════════════════

export async function leadTavilyScrapeWebsite(ctx) {
  const { payload, env } = ctx
  const lead     = payload.lead    || {}
  const contacts = payload.contacts || []

  let scrapedContent = ''
  if (lead.website) {
    try {
      const result = await tavilySearch(env,
        `${lead.website} contact email phone address`,
        'advanced', 3
      )
      scrapedContent = (result.results || [])
        .map(r => r.content || '')
        .join('\n')
        .slice(0, 3000)
    } catch (e) {
      console.warn(`[lead_tavily_scrape_website] scrape failed: ${e.message}`)
    }
  }

  console.log(`[lead_tavily_scrape_website] scraped ${scrapedContent.length} chars from ${lead.website}`)

  await nextJob(ctx, 'lead_cf_extract_email', { ...payload, scrapedContent })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 7: Groq — Extract Email + Contact
// Strict fallback chain — never invents Gmail/Yahoo addresses
// ═══════════════════════════════════════════════════════════════════════════

export async function leadCfExtractEmail(ctx) {
  const { payload, env } = ctx
  const lead           = payload.lead           || {}
  const contacts       = payload.contacts       || []
  const scrapedContent = payload.scrapedContent || ''

  // Pre-extract emails from scraped text using regex
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
  const domain     = lead.domain || cleanDomain(lead.website || '')

  const allText    = [scrapedContent, ...contacts.map(c => c.content)].join('\n')
  const foundEmails = [...new Set((allText.match(emailRegex) || [])
    .filter(e =>
      !e.includes('sentry') && !e.includes('example') &&
      !e.includes('noreply') && !e.includes('@gmail') &&
      !e.includes('@yahoo') && !e.includes('@hotmail') &&
      (domain ? e.endsWith(domain) || e.includes(domain.split('.')[0]) : true)
    )
  )].slice(0, 5)

  console.log(`[lead_cf_extract_email] regex found emails: ${foundEmails.join(', ') || 'none'}`)

  const prompt = `You are a B2B sales intelligence AI for Stellar Global Supplies.

Company: ${lead.company_name}
Website: ${lead.website}
Domain: ${domain}
Industry: ${lead.industry}

Emails already found by regex: ${foundEmails.join(', ') || 'none'}

Contact search results:
${contacts.slice(0, 4).map(c => `- ${c.title}\n  ${c.content.slice(0, 300)}`).join('\n\n')}

Scraped website content (first 1500 chars):
${scrapedContent.slice(0, 1500)}

TASK: Find the best procurement/purchase contact email and name.

STRICT EMAIL RULES — follow this chain in order:
1. FOUND: Use an email from the regex list above if it belongs to ${domain}
2. FOUND: Extract any email from the content that belongs to ${domain}
3. GUESSED: If a person's name is found, guess firstname@${domain || 'domain.com'}
4. FALLBACK: Use procurement@${domain || 'domain.com'} or purchase@${domain || 'domain.com'}
5. NEEDS_REVIEW: Only if domain is completely unknown

CRITICAL RULES:
- NEVER use @gmail.com, @yahoo.com, @hotmail.com, @outlook.com addresses
- NEVER invent a domain not present in the data above
- For contact_name: use actual names found, never invent one
- For phone: extract Indian format numbers (+91 or 0XX) only if clearly present

Return JSON:
{
  "email":        "best email following the chain above",
  "contact_name": "First Last if found, else empty string",
  "contact_role": "procurement manager | purchase manager | director | CEO | empty string",
  "phone":        "phone number if clearly found, else empty string",
  "needs_review": false,
  "source":       "found_on_website | found_in_search | guessed_from_name | fallback_procurement | needs_review",
  "confidence":   "high | medium | low"
}`

  const result = await cfAiExtractJson(env, prompt,
    'Extract B2B contact info. NEVER use Gmail/Yahoo/Hotmail. Return JSON only.', 500)

  const email      = (result.email || '').toLowerCase().trim()
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
                     !email.endsWith('@gmail.com') &&
                     !email.endsWith('@yahoo.com') &&
                     !email.endsWith('@hotmail.com') &&
                     !email.endsWith('@outlook.com')

  const needsReview = !emailValid || result.needs_review

  const enrichedLead = {
    ...lead,
    email:        emailValid ? email : '',
    contact_name: result.contact_name  || '',
    contact_role: result.contact_role  || '',
    phone:        result.phone         || '',
    source:       result.source        || 'tavily_search',
    confidence:   result.confidence    || 'low',
    needs_review: needsReview,
  }

  console.log(`[lead_cf_extract_email] email=${email || 'NONE'} source=${result.source} confidence=${result.confidence}`)

  await nextJob(ctx, 'lead_save', { ...payload, lead: enrichedLead, skipEmail: needsReview })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 8: Save Lead to Supabase
// ═══════════════════════════════════════════════════════════════════════════

export async function leadSave(ctx) {
  const { payload, env } = ctx
  const lead      = payload.lead      || {}
  const skipEmail = payload.skipEmail || false
  const sb        = getClient(env)

  const row = {
    company_name:    (lead.company_name || '').slice(0, 255),
    website:         (lead.website      || '').slice(0, 500),
    email:           (lead.email        || '').toLowerCase().trim(),
    phone:           (lead.phone        || '').slice(0, 50),
    industry:        (lead.industry     || '').slice(0, 100),
    address:         (lead.address      || '').slice(0, 255),
    contact_name:    (lead.contact_name || '').slice(0, 100),
    description:     (lead.description  || '').slice(0, 500),
    status:          skipEmail ? 'needs_review' : 'pending',
    source:          lead.source || 'tavily_search',
    // Store extra metadata in description if room
  }

  // Try inserting with all columns, fall back gracefully
  let saved
  try {
    saved = await sb.insert('leads', { ...row, workflow_run_id: ctx.workflow_run_id })
  } catch {
    saved = await sb.insert('leads', row)
  }

  console.log(`[lead_save] saved leadId=${saved.id} company=${lead.company_name} skipEmail=${skipEmail}`)

  if (skipEmail) {
    // Mark workflow succeeded — lead saved but no email (needs manual review)
    if (ctx.workflow_run_id) {
      await ctx.d1.update('workflow_runs', {
        status:       'succeeded',
        completed_at: nowIso(),
        output:       { lead_id: saved.id, needs_review: true, message: 'Lead saved — needs email review' },
      }, { id: ctx.workflow_run_id })
    }
    return
  }

  await nextJob(ctx, 'lead_gen_draft_email', {
    ...payload,
    lead:   { ...lead, id: saved.id },
    leadId: saved.id,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 9: Bedrock — Draft Product-Specific Outreach Email
// Highly personalised — references the specific product they'd buy
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGenCfDraftEmail(ctx) {
  const { payload, env } = ctx
  const lead            = payload.lead            || {}
  const leadId          = payload.leadId          || lead.id
  const selectedProduct = payload.selected_product || 'Industrial Steel Products'
  const productPitch    = payload.product_pitch    || ''
  const whyProspect     = lead.why_prospect        || `${lead.industry} companies use ${selectedProduct}`

  if (!lead.company_name) throw new Error('Missing lead data')

  const greeting = lead.contact_name
    ? `Dear ${lead.contact_name.split(' ')[0]}`
    : `Dear Procurement Team`

  const prompt = `Write a professional B2B cold outreach email from Stellar Global Supplies to ${lead.company_name}.

SENDER: Stellar Global Supplies, Pune, India
  - Products: ${selectedProduct}
  - Specifics: ${productPitch}
  - Website: https://stellarglobalsupplies.com
  - Phone: +91 9637655556
  - Address: Survey No-169, Talawade, Pune - 411062

RECIPIENT:
  - Company: ${lead.company_name}
  - Industry: ${lead.industry || 'manufacturing'}
  - Location: ${lead.address || lead.country || 'India'}
  - Contact: ${lead.contact_name || 'Procurement Team'}
  - Role: ${lead.contact_role || 'procurement decision maker'}
  - Why they'd buy from us: ${whyProspect}
  - Company description: ${lead.description || ''}

EMAIL REQUIREMENTS:
1. Opening: ${greeting}, — reference their industry and why we're reaching out
2. One specific pain point their industry faces in sourcing ${selectedProduct}
3. How Stellar solves it — reference specific product specs/grades if relevant
4. Our key differentiators: ISI/BIS certified, bulk pricing, pan-India delivery, 2-hour response time, 500+ SKUs
5. Simple CTA: call +91 9637655556 or email back to get a quote within 24 hours
6. Signature: Stellar Global Supplies Team | Pune | +91 9637655556 | stellarglobalsupplies.com
7. Keep it under 200 words — concise, professional, not salesy
8. No fluff like "I hope this email finds you well"

Return JSON:
{
  "subject": "compelling subject line referencing their industry and our product",
  "body":    "full email body — professional, specific, concise, under 200 words"
}`

  const SYSTEM = `You are a senior B2B sales copywriter for Stellar Global Supplies.
Write concise, personalised industrial supply outreach emails.
Reference specific products, grades, and applications relevant to the recipient's industry.
Be direct and professional. Never use "I hope this email finds you well."
Return valid JSON only.`

  const draft = await cfAiGenerateJson(env, prompt, SYSTEM, 1200)

  console.log(`[lead_gen_draft_email] drafted subject="${draft.subject}" for leadId=${leadId}`)

  await nextJob(ctx, 'lead_gen_approval_gate', {
    ...payload,
    lead,
    leadId,
    emailDraft: draft,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 10: Approval Gate
// Sends email to REVIEWER_EMAIL with Approve/Reject buttons
// Also creates approval_queue row for dashboard
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGenApprovalGate(ctx) {
  const { payload, env, d1, workflow_run_id, workflow_type, job } = ctx
  const lead       = payload.lead       || {}
  const emailDraft = payload.emailDraft || {}
  const leadId     = payload.leadId     || lead.id

  if (!emailDraft.subject) throw new Error('Missing emailDraft — cannot create approval')

  const senderEmail   = await resolveSecret(env.SENDER_EMAIL)   || 'sales@stellarglobalsupplies.com'
  const reviewerEmail = await resolveSecret(env.REVIEWER_EMAIL)
  const apiBase       = (await resolveSecret(env.API_BASE_URL) || '').replace(/\/$/, '')

  const approvalId = crypto.randomUUID()
  const emailToken = crypto.randomUUID().replace(/-/g, '')
  const now        = nowIso()
  const expiresAt  = new Date(Date.now() + 60 * 60 * 1000).toISOString()

  const approveUrl = `${apiBase}/approvals/${approvalId}/email-action?token=${emailToken}&action=approve`
  const rejectUrl  = `${apiBase}/approvals/${approvalId}/email-action?token=${emailToken}&action=reject`
  const dashUrl    = `https://workflow.stellarglobalsupplies.com/approvals`

  // Build preview HTML for dashboard modal
  const previewHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px;margin-bottom:16px">
        <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#16a34a;text-transform:uppercase">Lead Details</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
          ${[['Company', lead.company_name],['Industry', lead.industry],
             ['Website', lead.website],['Contact', lead.contact_name],
             ['Email', lead.email],['Phone', lead.phone],
             ['Location', lead.address],['Source', lead.source]
            ].filter(([,v]) => v).map(([k,v]) => `
            <div>
              <div style="font-size:11px;color:#94a3b8">${k}</div>
              <div style="font-size:13px;font-weight:500;color:#1e293b">${v}</div>
            </div>`).join('')}
        </div>
        ${lead.description ? `<p style="margin:12px 0 0;font-size:12px;color:#64748b;font-style:italic">${lead.description}</p>` : ''}
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px">
        <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase">Outreach Email Draft</p>
        <p style="margin:10px 0 4px"><strong>Subject:</strong> ${emailDraft.subject || ''}</p>
        <div style="white-space:pre-wrap;font-size:13px;color:#334155;margin-top:8px;line-height:1.6">
          ${(emailDraft.body || '').slice(0, 600)}${(emailDraft.body || '').length > 600 ? '...' : ''}
        </div>
      </div>
    </div>`

  // Insert into D1 approval_queue
  await d1.insert('approval_queue', {
    id:               approvalId,
    workflow_type:    'lead_generation',
    workflow_run_id,
    reference_id:     leadId || null,
    task_token:       `lead-gen-${workflow_run_id}`,
    payload:          {
      lead, leadId, emailDraft,
      selected_product:  payload.selected_product,
      product_pitch:     payload.product_pitch,
      approvalGate:      'save',
      _nextStep:         'lead_gen_send_email',
    },
    preview_html:     previewHtml,
    status:           'pending',
    email_token:      emailToken,
    token_expires_at: expiresAt,
    created_at:       now,
  })

  console.log(`[lead_gen_approval_gate] created approvalId=${approvalId} lead=${leadId}`)

  // Send email notification to reviewer
  if (reviewerEmail && apiBase) {
    try {
      await sendLeadApprovalEmail(env, {
        to: reviewerEmail, senderEmail,
        approvalId, approveUrl, rejectUrl, dashUrl,
        lead, emailDraft,
        product: payload.selected_product || 'Industrial Products',
      })
      console.log(`[lead_gen_approval_gate] notification sent to=${reviewerEmail}`)
    } catch (e) {
      console.warn(`[lead_gen_approval_gate] notification failed (non-fatal): ${e.message}`)
    }
  }

  // Pause job
  await d1.update('job_queue',    { status: 'waiting_for_approval' }, { id: job.id })
  await d1.update('workflow_runs',{ status: 'awaiting_approval'    }, { id: workflow_run_id })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 11: Send Approved Email via Gmail
// Triggered by api-router on approval
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGenSendEmail(ctx) {
  const { payload, env } = ctx
  const lead        = payload.lead       || {}
  const emailDraft  = payload.emailDraft || {}
  const leadId      = payload.leadId     || lead.id
  const senderEmail = await resolveSecret(env.SENDER_EMAIL) || 'sales@stellarglobalsupplies.com'

  const to      = (payload.email?.to || lead.email || '').trim()
  const subject = payload.email?.subject || emailDraft.subject || 'Industrial Supply Partnership'
  const body    = payload.email?.body    || emailDraft.body    || ''

  if (!to)     throw new Error('No recipient email for lead')
  if (!leadId) throw new Error('Missing leadId')
  if (!body)   throw new Error('Missing email body')

  const html        = buildEmailHtml(subject, body, senderEmail)
  const accessToken = await getGmailToken(env)
  const result      = await sendViaGmail(accessToken, to, subject, html, senderEmail)

  console.log(`[lead_gen_send_email] sent to=${to} leadId=${leadId} msgId=${result.id}`)

  const sb = getClient(env)
  try {
    await sb.update('leads', {
      status:     'emailed',
      updated_at: nowIso(),
    }, `id=eq.${leadId}`)
  } catch (e) {
    console.warn(`[lead_gen_send_email] status update failed (non-fatal): ${e.message}`)
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Gmail helpers
// ═══════════════════════════════════════════════════════════════════════════

async function getGmailToken(env) {
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    resolveSecret(env.GMAIL_CLIENT_ID),
    resolveSecret(env.GMAIL_CLIENT_SECRET),
    resolveSecret(env.GMAIL_REFRESH_TOKEN),
  ])
  if (!clientId)     throw new Error('Missing: GMAIL_CLIENT_ID')
  if (!clientSecret) throw new Error('Missing: GMAIL_CLIENT_SECRET')
  if (!refreshToken) throw new Error('Missing: GMAIL_REFRESH_TOKEN')

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
                                   refresh_token: refreshToken, grant_type: 'refresh_token' }),
  })
  if (!res.ok) throw new Error(`Gmail token ${res.status}: ${await res.text()}`)
  return (await res.json()).access_token
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
  if (!res.ok) throw new Error(`Gmail send ${res.status}: ${await res.text()}`)
  return res.json()
}

function buildEmailHtml(subject, body, sender) {
  const bodyHtml = body
    .replace(/\n\n/g, '</p><p style="margin:14px 0;color:#1e293b;line-height:1.7">')
    .replace(/\n/g, '<br>')
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden">
  <div style="background:#0A2547;padding:20px 28px;display:flex;align-items:center;gap:12px">
    <div style="width:36px;height:36px;background:#F59E0B;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#0A2547;font-size:16px">S</div>
    <div>
      <div style="color:#fff;font-weight:700;font-size:15px">Stellar Global Supplies</div>
      <div style="color:#94a3b8;font-size:11px">Industrial Supply Partner · Pune, India</div>
    </div>
  </div>
  <div style="padding:28px">
    <p style="margin:14px 0;color:#1e293b;line-height:1.7">${bodyHtml}</p>
  </div>
  <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 28px;text-align:center">
    <p style="margin:0;font-size:11px;color:#94a3b8">
      Stellar Global Supplies · Survey No-169, Talawade, Pune 411062 · stellarglobalsupplies.com
    </p>
  </div>
</div>
</body></html>`
}

async function sendLeadApprovalEmail(env, { to, senderEmail, approvalId, approveUrl, rejectUrl, dashUrl, lead, emailDraft, product }) {
  const bodyPreview = (emailDraft.body || '').slice(0, 500)
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 16px">
<tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0"
  style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr>
    <td style="background:#0A2547;padding:20px 28px">
      <div style="color:#F59E0B;font-size:18px;font-weight:bold">Stellar Global Supplies</div>
      <div style="color:#94A3B8;font-size:12px;margin-top:3px">New Lead — Approval Required</div>
    </td>
  </tr>
  <tr>
    <td style="padding:20px 28px 12px">
      <div style="font-size:17px;font-weight:bold;color:#0A2547">${lead.company_name || 'New Lead'}</div>
      <div style="color:#64748B;font-size:12px;margin-top:4px">
        Product targeted: <strong>${product}</strong>
      </div>
    </td>
  </tr>
  <tr>
    <td style="padding:0 28px 16px">
      <table width="100%" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:0" cellpadding="12" cellspacing="0">
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${[['Industry', lead.industry],['Website', lead.website],
               ['Contact', lead.contact_name],['Email', lead.email],
               ['Phone', lead.phone],['Location', lead.address]
              ].filter(([,v]) => v).map(([k,v]) => `
              <tr>
                <td style="font-size:12px;color:#64748b;padding:3px 8px 3px 0;width:80px">${k}</td>
                <td style="font-size:13px;color:#1e293b;font-weight:500;padding:3px 0">${v}</td>
              </tr>`).join('')}
          </table>
        </td></tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:0 28px 20px">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px">
        <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b">OUTREACH EMAIL DRAFT</p>
        <p style="margin:0 0 6px;font-size:13px"><strong>Subject:</strong> ${emailDraft.subject || ''}</p>
        <div style="white-space:pre-wrap;font-size:13px;color:#334155;line-height:1.6;margin-top:8px">
          ${bodyPreview}${bodyPreview.length >= 500 ? '...' : ''}
        </div>
      </div>
    </td>
  </tr>
  <tr>
    <td style="padding:0 28px 28px">
      <table width="100%"><tr>
        <td width="48%" align="center">
          <a href="${approveUrl}"
             style="display:block;background:#10B981;color:#fff;text-decoration:none;
                    font-size:14px;font-weight:bold;padding:12px 16px;border-radius:8px;text-align:center">
            ✓ &nbsp; Approve & Send Email
          </a>
        </td>
        <td width="4%"></td>
        <td width="48%" align="center">
          <a href="${rejectUrl}"
             style="display:block;background:#EF4444;color:#fff;text-decoration:none;
                    font-size:14px;font-weight:bold;padding:12px 16px;border-radius:8px;text-align:center">
            ✕ &nbsp; Reject Lead
          </a>
        </td>
      </tr></table>
      <div style="text-align:center;margin-top:14px;color:#94A3B8;font-size:11px">
        Links expire in 1 hour ·
        <a href="${dashUrl}" style="color:#1565C0">View in dashboard</a>
      </div>
    </td>
  </tr>
  <tr>
    <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:12px 28px;text-align:center">
      <div style="color:#94A3B8;font-size:11px">Stellar Global Supplies · Pune, India · stellarglobalsupplies.com</div>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body></html>`

  const accessToken = await getGmailToken(env)
  await sendViaGmail(accessToken, to, `[Lead Approval] ${lead.company_name || 'New Lead'} — ${product}`, html, senderEmail)
}