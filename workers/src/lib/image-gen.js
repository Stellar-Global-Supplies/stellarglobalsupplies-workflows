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
 * Returns { url, key } or null on any failure (non-fatal — workflow continues).
 */
export async function generateAndUploadImage(env, prompt, storageKey, opts = {}) {
  try {
    const bytes     = await generateImage(env, prompt, opts)
    // Workers AI FLUX returns JPEG
    const key       = storageKey.endsWith('.jpg') ? storageKey : storageKey + '.jpg'
    const publicUrl = await uploadImage(env, bytes, key, 'image/jpeg')
    console.log(`[image-gen] uploaded to ${key}`)
    return { url: publicUrl, key }
  } catch (e) {
    console.warn(`[image-gen] failed (non-fatal): ${e.message}`)
    return null
  }
}