/**
 * Bedrock client for Cloudflare Workers.
 * Uses AWS Signature V4 — no SDK needed, pure fetch.
 * Secrets Store bindings require async .get() to resolve.
 */

const MODEL_ID = 'amazon.nova-pro-v1:0'

async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  if (typeof val === 'string') return val
  return String(val)
}

export async function bedrockGenerateJson(env, prompt, system = '', maxTokens = 2000) {
  const text = await bedrockInvoke(env, prompt, system, maxTokens)

  // 1. Strip markdown code fences if present
  let clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()

  // 2. Try direct parse first
  try {
    return JSON.parse(clean)
  } catch {}

  // 3. Extract first complete JSON object or array — handles trailing text
  const objMatch = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (objMatch) {
    try {
      return JSON.parse(objMatch[1])
    } catch {}
  }

  // 4. Last resort: find first '{' and last '}' (or first '[' and last ']')
  const firstBrace = clean.indexOf('{')
  const lastBrace  = clean.lastIndexOf('}')
  const firstBrack = clean.indexOf('[')
  const lastBrack  = clean.lastIndexOf(']')

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(clean.slice(firstBrace, lastBrace + 1))
    } catch {}
  }
  if (firstBrack !== -1 && lastBrack > firstBrack) {
    try {
      return JSON.parse(clean.slice(firstBrack, lastBrack + 1))
    } catch {}
  }

  throw new Error(`Invalid JSON from Bedrock: ${text.slice(0, 300)}...`)
}

export async function bedrockGenerateText(env, prompt, system = '', maxTokens = 2000) {
  return bedrockInvoke(env, prompt, system, maxTokens)
}

async function bedrockInvoke(env, prompt, system, maxTokens) {
  const region    = await resolveSecret(env.BEDROCK_REGION) || 'us-east-1'
  const accessKey = await resolveSecret(env.BEDROCK_ACCESS_KEY_ID)
  const secretKey = await resolveSecret(env.BEDROCK_SECRET_ACCESS_KEY)

  if (!accessKey) throw new Error('Missing secret: BEDROCK_ACCESS_KEY_ID')
  if (!secretKey) throw new Error('Missing secret: BEDROCK_SECRET_ACCESS_KEY')

  const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(MODEL_ID)}/invoke`

  const body = JSON.stringify({
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    ...(system ? { system: [{ text: system }] } : {}),
    inferenceConfig: { max_new_tokens: maxTokens, temperature: 0.7 },
  })

  const headers = await signRequest({
    method: 'POST', url: endpoint, body,
    service: 'bedrock', region, accessKeyId: accessKey, secretAccessKey: secretKey,
  })

  const res = await fetch(endpoint, { method: 'POST', headers, body })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Bedrock invoke failed ${res.status}: ${t}`)
  }

  const data   = await res.json()
  const output = data.output?.message?.content?.[0]?.text
  if (!output) throw new Error('Bedrock returned empty output')
  return output
}

// ── AWS Signature V4 ─────────────────────────────────────────────────────────

async function signRequest({ method, url, body, service, region, accessKeyId, secretAccessKey }) {
  const u        = new URL(url)
  const now      = new Date()
  const date     = isoDate(now)
  const datetime = isoDatetime(now)
  const bodyHash = await sha256Hex(body)

  const canonicalHeaders = [
    `content-type:application/json`,
    `host:${u.host}`,
    `x-amz-content-sha256:${bodyHash}`,
    `x-amz-date:${datetime}`,
  ].join('\n') + '\n'

  // AWS SigV4 requires double-encoding of the path in the canonical request.
  // u.pathname is single-encoded (e.g. /model/amazon.nova-pro-v1%3A0/invoke)
  // AWS expects double-encoded (e.g. /model/amazon.nova-pro-v1%253A0/invoke)
  // We re-encode each path segment to achieve the double-encoding.
  const canonicalUri = u.pathname.split('/').map(encodeURIComponent).join('/')

  const signedHeaders   = 'content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = [method, canonicalUri, u.search.slice(1), canonicalHeaders, signedHeaders, bodyHash].join('\n')
  const credentialScope  = `${date}/${region}/${service}/aws4_request`
  const stringToSign     = ['AWS4-HMAC-SHA256', datetime, credentialScope, await sha256Hex(canonicalRequest)].join('\n')
  const signingKey       = await getSigningKey(secretAccessKey, date, region, service)
  const signature        = await hmacHex(signingKey, stringToSign)

  return {
    'Content-Type':         'application/json',
    'X-Amz-Date':           datetime,
    'X-Amz-Content-Sha256': bodyHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

async function getSigningKey(secret, date, region, service) {
  const kDate    = await hmacRaw(`AWS4${secret}`, date)
  const kRegion  = await hmacRaw(kDate, region)
  const kService = await hmacRaw(kRegion, service)
  return hmacRaw(kService, 'aws4_request')
}

async function hmacRaw(key, data) {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : key
  const cryptoKey = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
}

async function hmacHex(key, data) {
  return toHex(await hmacRaw(key, data))
}

async function sha256Hex(data) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)))
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function isoDate(d)     { return d.toISOString().slice(0, 10).replace(/-/g, '') }
function isoDatetime(d) { return d.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z' }