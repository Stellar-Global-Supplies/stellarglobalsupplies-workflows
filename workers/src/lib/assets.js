/**
 * Asset helpers — Supabase Storage (replaces R2)
 *
 * Supabase Storage is a free S3-compatible store.
 * Bucket: "stellar-assets" (set to public in Supabase dashboard)
 *
 * Required secrets:
 *   SUPABASE_URL          e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  service role key (same one used for DB)
 *
 * Public URL pattern (no secret needed — it's just the Supabase URL + path):
 *   https://xxxx.supabase.co/storage/v1/object/public/stellar-assets/{key}
 */

const BUCKET = 'stellar-assets'

function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return val.get()
  if (typeof val === 'string') return val
  return String(val)
}



function storageBase(env) {
  return `${resolveSecret(env.SUPABASE_URL).replace(/\/$/, '')}/storage/v1`
}

function publicUrl(env, key) {
  return `${storageBase(env)}/object/public/${BUCKET}/${key}`
}

function authHeaders(env, contentType = null) {
  const h = {
    Authorization: `Bearer ${resolveSecret(env.SUPABASE_SERVICE_KEY)}`,
  }
  if (contentType) h['Content-Type'] = contentType
  return h
}

/**
 * Upload an image (Uint8Array or ArrayBuffer) to Supabase Storage.
 * Returns the public URL.
 */
export async function uploadImage(env, imageBytes, key, contentType = 'image/png') {
  const url = `${storageBase(env)}/object/${BUCKET}/${key}`

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      ...authHeaders(env, contentType),
      'x-upsert': 'true',   // overwrite if exists
    },
    body: imageBytes,
  })

  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Supabase Storage upload failed ${res.status}: ${t}`)
  }

  return publicUrl(env, key)
}

/**
 * Upload a JSON object to Supabase Storage.
 * Returns the public URL.
 */
export async function uploadJson(env, data, key) {
  const body = JSON.stringify(data)
  const url  = `${storageBase(env)}/object/${BUCKET}/${key}`

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      ...authHeaders(env, 'application/json'),
      'x-upsert': 'true',
    },
    body,
  })

  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Supabase Storage JSON upload failed ${res.status}: ${t}`)
  }

  return publicUrl(env, key)
}

/**
 * Read a JSON file from Supabase Storage.
 * Uses the public URL — no auth needed if bucket is public.
 */
export async function readJson(env, key) {
  const url = publicUrl(env, key)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Supabase Storage read failed ${res.status}: ${key}`)
  return res.json()
}

/**
 * Delete a file from Supabase Storage.
 */
export async function deleteAsset(env, key) {
  const url = `${storageBase(env)}/object/${BUCKET}/${key}`
  const res = await fetch(url, {
    method:  'DELETE',
    headers: authHeaders(env),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Supabase Storage delete failed ${res.status}: ${t}`)
  }
}

/**
 * Detect image type from bytes — mirrors image_ext_and_type() in utils.py
 */
export function imageExtAndType(bytes) {
  const head = new Uint8Array(bytes.slice(0, 10))
  const str  = String.fromCharCode(...head).trimStart()
  if (str.startsWith('<svg') || str.startsWith('<SVG'))
    return { ext: '.svg', contentType: 'image/svg+xml' }
  return { ext: '.png', contentType: 'image/png' }
}

/**
 * Build a public URL without uploading — useful when you already
 * know the key and just need the URL (e.g. after a poll step confirms ready)
 */
export function getPublicUrl(env, key) {
  return publicUrl(env, key)
}