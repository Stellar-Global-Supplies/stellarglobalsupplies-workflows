/**
 * CF Workers AI client — drop-in replacement for bedrock.js + groqJson().
 *
 * Uses the env.AI binding (Workers AI) — already declared in wrangler.toml.
 * No external HTTP calls, no AWS credentials, no API keys needed.
 *
 * Models chosen by use-case:
 *   @cf/meta/llama-3.3-70b-instruct-fp8-fast
 *     → fast structured JSON tasks: extraction, classification, short drafts
 *     → same Llama 3.3 70B architecture as the Groq model being replaced
 *
 *   @cf/meta/llama-4-scout-17b-16e-instruct
 *     → long-form generation: blog content (up to 4 000 tokens output),
 *       social posts (1 500+ chars), detailed email drafts
 *     → Llama 4 Scout's 10 M-token context + large output window suits these tasks
 */

// ── Model selection ───────────────────────────────────────────────────────────

/** Fast model — structured JSON extraction / short outputs (≤ 1 200 tokens) */
const MODEL_FAST = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

/** Long-form model — creative / long outputs (> 1 200 tokens) */
const MODEL_LONG = '@cf/meta/llama-4-scout-17b-16e-instruct'

function pickModel(maxTokens) {
  return maxTokens > 1200 ? MODEL_LONG : MODEL_FAST
}

// ── Core invoke ───────────────────────────────────────────────────────────────

/**
 * Run a CF Workers AI inference call.
 * @param {object} env          - Worker env with AI binding
 * @param {string} prompt       - User message
 * @param {string} system       - System prompt (may be empty)
 * @param {number} maxTokens    - Max output tokens
 * @param {boolean} jsonMode    - Whether to request JSON output
 * @returns {Promise<string>}   - Raw text response
 */
async function cfAiInvoke(env, prompt, system, maxTokens, jsonMode = false) {
  if (!env.AI) throw new Error('CF Workers AI binding (AI) not found in env')

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  const params = {
    messages,
    max_tokens: maxTokens,
    temperature: 0.7,
  }

  // Request JSON mode when caller needs structured output
  if (jsonMode) {
    params.response_format = { type: 'json_object' }
    // Lower temperature for more deterministic JSON
    params.temperature = 0.2
  }

  const model  = pickModel(maxTokens)
  const result = await env.AI.run(model, params)

  const text = result?.response ?? result?.result?.response ?? ''
  if (!text) throw new Error(`CF Workers AI (${model}) returned empty response`)
  return text
}

// ── JSON helpers (mirrors bedrock.js API exactly) ────────────────────────────

/**
 * Generate and parse a JSON response — replaces bedrockGenerateJson().
 * Applies the same multi-stage fallback JSON extraction logic.
 */
export async function cfAiGenerateJson(env, prompt, system = '', maxTokens = 2000) {
  const text = await cfAiInvoke(env, prompt, system, maxTokens, true)

  // 1. Strip markdown code fences if present
  let clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()

  // 2. Direct parse
  try { return JSON.parse(clean) } catch {}

  // 3. Extract first complete JSON object or array
  const objMatch = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (objMatch) {
    try { return JSON.parse(objMatch[1]) } catch {}
  }

  // 4. Last resort — brace scan
  const firstBrace = clean.indexOf('{')
  const lastBrace  = clean.lastIndexOf('}')
  const firstBrack = clean.indexOf('[')
  const lastBrack  = clean.lastIndexOf(']')

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(clean.slice(firstBrace, lastBrace + 1)) } catch {}
  }
  if (firstBrack !== -1 && lastBrack > firstBrack) {
    try { return JSON.parse(clean.slice(firstBrack, lastBrack + 1)) } catch {}
  }

  throw new Error(`Invalid JSON from CF Workers AI: ${text.slice(0, 300)}...`)
}

/**
 * Generate plain text — replaces bedrockGenerateText().
 */
export async function cfAiGenerateText(env, prompt, system = '', maxTokens = 2000) {
  return cfAiInvoke(env, prompt, system, maxTokens, false)
}

/**
 * Generate structured JSON for fast extraction tasks (replaces groqJson()).
 * Identical to cfAiGenerateJson but always uses the fast model via low maxTokens.
 */
export async function cfAiExtractJson(env, prompt, system = '', maxTokens = 800) {
  // Cap to fast-model range so pickModel() always chooses MODEL_FAST
  const tokens = Math.min(maxTokens, 1200)
  return cfAiGenerateJson(env, prompt, system, tokens)
}