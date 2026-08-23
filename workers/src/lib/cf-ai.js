/**
 * CF Workers AI client — drop-in replacement for bedrock.js + groqJson().
 *
 * Uses the env.AI binding (Workers AI) — already declared in wrangler.toml.
 * No external HTTP calls, no AWS credentials, no API keys needed.
 *
 * Models chosen by use-case:
 *   @cf/meta/llama-3.1-70b-instruct
 *     → fast structured JSON tasks: extraction, classification, short drafts
 *     → full-precision (not fp8-quantized) — 2026-08-23: switched off the
 *       fp8-fast quantized 3.3 variant, which was unreliable on multi-step
 *       conditional prompts (e.g. the email-extraction fallback chain),
 *       causing empty email/phone fields on otherwise-successful scrapes.
 *
 *   @cf/meta/llama-4-scout-17b-16e-instruct
 *     → long-form generation: blog content (up to 4 000 tokens output),
 *       social posts (1 500+ chars), detailed email drafts
 *     → Llama 4 Scout's 10 M-token context + large output window suits these tasks
 */

// ── Model selection ───────────────────────────────────────────────────────────

/** Fast model — structured JSON extraction / short outputs (≤ 1 200 tokens) */
const MODEL_FAST = '@cf/meta/llama-3.1-70b-instruct'

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

  let text = result?.response ?? result?.result?.response

  // Workers AI can return an already-parsed object/array when
  // response_format: json_object is set (varies by model version).
  // Normalize everything down to a string so downstream parsing is uniform.
  if (text != null && typeof text !== 'string') {
    text = JSON.stringify(text)
  }

  if (!text) throw new Error(`CF Workers AI (${model}) returned empty response`)
  return text
}

// ── JSON helpers (mirrors bedrock.js API exactly) ────────────────────────────

/**
 * Generate and parse a JSON response — replaces bedrockGenerateJson().
 * Applies the same multi-stage fallback JSON extraction logic.
 */
export async function cfAiGenerateJson(env, prompt, system = '', maxTokens = 2000) {
  const raw = await cfAiInvoke(env, prompt, system, maxTokens, true)

  // Defensive: cfAiInvoke should always return a string, but guard anyway
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)

  // 0. Models sometimes ignore json_object mode and wrap the JSON in a
  //    conversational preamble + markdown fence, e.g.
  //    "Here is the email:\n```json\n{...}\n```"
  //    If a fenced block exists ANYWHERE in the text, prefer its contents
  //    over the raw text (the old regex only stripped a fence at the very
  //    start/end, which misses this preamble case entirely).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  let clean = (fenced ? fenced[1] : text)
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()

  // 1. Direct parse
  try { return JSON.parse(clean) } catch {}

  // 2. Repair common non-JSON artifacts: models frequently emit *literal*
  //    newlines/tabs inside string values (e.g. an email body written as
  //    real line breaks) instead of escaping them as \n — that's invalid
  //    JSON and JSON.parse rejects it outright. Escape raw control chars
  //    that fall inside quoted strings, then retry.
  const repaired = repairJsonControlChars(clean)
  try { return JSON.parse(repaired) } catch {}

  // 3. Extract first complete JSON object or array, then repair + parse
  const objMatch = repaired.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (objMatch) {
    try { return JSON.parse(objMatch[1]) } catch {}
  }

  // 4. Last resort — brace scan
  const firstBrace = repaired.indexOf('{')
  const lastBrace  = repaired.lastIndexOf('}')
  const firstBrack = repaired.indexOf('[')
  const lastBrack  = repaired.lastIndexOf(']')

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(repaired.slice(firstBrace, lastBrace + 1)) } catch {}
  }
  if (firstBrack !== -1 && lastBrack > firstBrack) {
    try { return JSON.parse(repaired.slice(firstBrack, lastBrack + 1)) } catch {}
  }

  throw new Error(`Invalid JSON from CF Workers AI: ${text.slice(0, 300)}...`)
}

/**
 * Escape raw control characters (newline, carriage return, tab) that occur
 * INSIDE quoted JSON string values. Walks the text tracking quote/escape
 * state so it doesn't touch whitespace used for JSON formatting outside
 * strings (which is harmless either way, but this keeps the diff minimal).
 */
function repairJsonControlChars(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') { out += ch; escaped = true; continue }
      if (ch === '"')  { out += ch; inString = false; continue }
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      if (ch === '\t') { out += '\\t'; continue }
      out += ch
    } else {
      if (ch === '"') inString = true
      out += ch
    }
  }
  return out
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

/**
 * Generate JSON constrained to an exact schema, using Workers AI's
 * `response_format: { type: 'json_schema' }` mode (stricter than json_object —
 * required fields are enforced server-side; the model can't silently omit them).
 *
 * Falls back to the regular cfAiExtractJson() (json_object mode + regex/brace
 * parsing) if schema mode isn't supported for the model or errors out, so this
 * is safe to introduce without risking a hard failure on calls that used to work.
 *
 * @param {object} env
 * @param {string} prompt
 * @param {string} system
 * @param {object} schema     - JSON Schema object with "properties"/"required"
 * @param {number} maxTokens
 */
export async function cfAiExtractJsonStrict(env, prompt, system, schema, maxTokens = 800) {
  if (!env.AI) throw new Error('CF Workers AI binding (AI) not found in env')

  const tokens = Math.min(maxTokens, 2000)
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  try {
    const result = await env.AI.run(MODEL_FAST, {
      messages,
      max_tokens: tokens,
      temperature: 0.2,
      response_format: { type: 'json_schema', json_schema: schema },
    })

    let text = result?.response ?? result?.result?.response
    if (text != null && typeof text !== 'string') return text // already parsed object
    if (!text) throw new Error('empty response in schema mode')

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const clean  = (fenced ? fenced[1] : text)
      .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()

    try { return JSON.parse(clean) } catch {}
    return JSON.parse(repairJsonControlChars(clean))
  } catch (e) {
    console.warn(`[cfAiExtractJsonStrict] schema mode failed (${e.message}), falling back to json_object mode`)
    return cfAiExtractJson(env, prompt, system, maxTokens)
  }
}