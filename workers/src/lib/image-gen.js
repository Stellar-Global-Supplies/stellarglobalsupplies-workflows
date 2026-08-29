/**
 * Cloudflare Workers AI — FLUX Image Generation
 *
 * API: env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt, seed })
 * Returns: { image: "<base64 string>" }
 *
 * wrangler.toml binding required:
 *   [ai]
 *   binding = "AI"
 *
 * Free tier: ~10,000 Neurons/day ≈ 20-33 images/day free
 */

import { uploadImage, imageExtAndType } from './assets.js'

const MODEL = '@cf/black-forest-labs/flux-1-schnell'

/**
 * Generate an image using Workers AI FLUX.
 * Returns raw image bytes as Uint8Array.
 */
export async function generateImage(env, prompt, opts = {}) {
  if (!env.AI) throw new Error('Missing Workers AI binding — add [ai] binding = "AI" to wrangler.toml')

  console.log(`[image-gen] calling Workers AI FLUX schnell`)

  const response = await env.AI.run(MODEL, {
    prompt,
    seed: Math.floor(Math.random() * 1000000),
  })

  // Workers AI FLUX always returns { image: "<base64 jpeg string>" }
  if (!response?.image) throw new Error(`FLUX returned no image. Response: ${JSON.stringify(response)}`)

  const binary = atob(response.image)
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Generate image and upload to Supabase Storage.
 * Non-fatal by design (a missing image should never block the post from
 * reaching approval) — but unlike before, the failure reason is always
 * returned to the caller instead of being swallowed, so it can be logged
 * against the post and shown to whoever is reviewing it.
 *
 * Returns { url, key } on success, or { url: null, key: null, error } on
 * failure. Never throws.
 */
export async function generateAndUploadImage(env, prompt, storageKey, opts = {}) {
  let bytes
  try {
    bytes = await generateImage(env, prompt, opts)
  } catch (e) {
    // Distinguish "Workers AI itself failed" from "upload failed" — these
    // have very different fixes (AI binding/quota vs Supabase bucket/creds).
    const msg = `Workers AI FLUX call failed: ${e.message}`
    console.error(`[image-gen] ${msg}`, e.stack || e)
    return { url: null, key: null, error: msg }
  }

  try {
    // Workers AI FLUX returns JPEG
    const key       = storageKey.endsWith('.jpg') ? storageKey : storageKey + '.jpg'
    const publicUrl = await uploadImage(env, bytes, key, 'image/jpeg')
    console.log(`[image-gen] uploaded to ${key}`)
    return { url: publicUrl, key }
  } catch (e) {
    const msg = `Supabase Storage upload failed: ${e.message}`
    console.error(`[image-gen] ${msg}`, e.stack || e)
    return { url: null, key: null, error: msg }
  }
}
