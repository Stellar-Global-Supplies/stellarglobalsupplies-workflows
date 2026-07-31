/**
 * Asset helpers — Supabase Storage
 * Secrets Store bindings require async .get() to resolve.
 */

const BUCKET = 'stellar-assets'

async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  if (typeof val === 'string') return val
  return String(val)
}

async function storageBase(env) {
  const url = await resolveSecret(env.SUPABASE_URL)
  return `${url.replace(/\/$/, '')}/storage/v1`
}

async function publicUrl(env, key) {
  const base = await storageBase(env)
  return `${base}/object/public/${BUCKET}/${key}`
}

async function authHeaders(env, contentType = null) {
  const key = await resolveSecret(env.SUPABASE_SERVICE_KEY)
  const h = { Authorization: `Bearer ${key}` }
  if (contentType) h['Content-Type'] = contentType
  return h
}

export async function uploadImage(env, imageBytes, key, contentType = 'image/png') {
  const base = await storageBase(env)
  const url  = `${base}/object/${BUCKET}/${key}`
  const res  = await fetch(url, {
    method:  'POST',
    headers: { ...(await authHeaders(env, contentType)), 'x-upsert': 'true' },
    body:    imageBytes,
  })
  if (!res.ok) throw new Error(`Storage upload failed ${res.status}: ${await res.text()}`)
  return publicUrl(env, key)
}

export async function uploadJson(env, data, key) {
  const base = await storageBase(env)
  const url  = `${base}/object/${BUCKET}/${key}`
  const res  = await fetch(url, {
    method:  'POST',
    headers: { ...(await authHeaders(env, 'application/json')), 'x-upsert': 'true' },
    body:    JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Storage JSON upload failed ${res.status}: ${await res.text()}`)
  return publicUrl(env, key)
}

export async function readJson(env, key) {
  const url = await publicUrl(env, key)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Storage read failed ${res.status}: ${key}`)
  return res.json()
}

export async function deleteAsset(env, key) {
  const base = await storageBase(env)
  const url  = `${base}/object/${BUCKET}/${key}`
  const res  = await fetch(url, { method: 'DELETE', headers: await authHeaders(env) })
  if (!res.ok) throw new Error(`Storage delete failed ${res.status}: ${await res.text()}`)
}

export function imageExtAndType(bytes) {
  const head = new Uint8Array(bytes.slice(0, 10))
  const str  = String.fromCharCode(...head).trimStart()
  if (str.startsWith('<svg') || str.startsWith('<SVG')) return { ext: '.svg', contentType: 'image/svg+xml' }
  return { ext: '.png', contentType: 'image/png' }
}

export async function getPublicUrl(env, key) {
  return publicUrl(env, key)
}