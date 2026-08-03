/**
 * Cloudflare Workers AI — FLUX Image Generation
 *
 * Uses env.AI binding (Workers AI) to generate images directly.
 * No external API calls, no HF Gradio, no event polling.
 * Synchronous — generates and returns image bytes in one call.
 *
 * Models available:
 *   @cf/black-forest-labs/flux-1-schnell    — fast, plain JSON input, free tier
 *   @cf/black-forest-labs/flux-2-klein-4b   — faster + higher quality, multipart
 *   @cf/black-forest-labs/flux-2-klein-9b   — best quality, multipart
 *
 * We use flux-1-schnell as default (simple JSON, free, fast).
 * Falls back gracefully if AI binding not available.
 *
 * Free tier: 10,000 Neurons/day. One 512×512 image ≈ 100–400 Neurons.
 * So ~25–100 images/day free.
 *
 * wrangler.toml binding required:
 *   [ai]
 *   binding = "AI"
 */

const MODEL_SCHNELL = '@cf/black-forest-labs/flux-1-schnell'
const MODEL_KLEIN4B = '@cf/black-forest-labs/flux-2-klein-4b'

/**
 * Generate an image using Cloudflare Workers AI FLUX.
 *
 * @param {object} env           - Worker env (must have env.AI binding)
 * @param {string} prompt        - Image prompt
 * @param {object} opts          - Options
 * @param {number} opts.width    - Width in px (default 1024 for social, 1200 for blog)
 * @param {number} opts.height   - Height in px (default 1024)
 * @param {string} opts.model    - Model to use (default: flux-1-schnell)
 * @returns {ArrayBuffer}        - Raw image bytes (PNG)
 */
export async function generateImage(env, prompt, opts = {}) {
  const {
    width  = 1024,
    height = 1024,
    model  = MODEL_SCHNELL,
  } = opts

  if (!env.AI) {
    throw new Error('Missing Workers AI binding: add [ai] binding = "AI" to wrangler.toml')
  }

  console.log(`[image-gen] generating ${width}x${height} with ${model.split('/').pop()}`)

  if (model === MODEL_SCHNELL) {
    // flux-1-schnell uses plain JSON input — simplest API
    const result = await env.AI.run(model, {
      prompt,
      num_steps: 4,   // schnell is optimised for 4 steps
      width,
      height,
    })

    // Workers AI returns image as ReadableStream or ArrayBuffer
    if (result instanceof ReadableStream) {
      const reader = result.getReader()
      const chunks = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const total  = chunks.reduce((s, c) => s + c.length, 0)
      const buffer = new Uint8Array(total)
      let offset   = 0
      for (const chunk of chunks) {
        buffer.set(chunk, offset)
        offset += chunk.length
      }
      return buffer.buffer
    }

    // Some versions return ArrayBuffer directly
    if (result instanceof ArrayBuffer) return result

    // Response object
    if (result?.image) {
      // base64 string
      const b64    = result.image
      const binary = atob(b64)
      const bytes  = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    }

    throw new Error(`Unexpected FLUX response shape: ${typeof result}`)

  } else {
    // flux-2-klein-4b / 9b uses multipart form data
    const form = new FormData()
    form.append('prompt', prompt)
    form.append('num_steps', '4')
    form.append('width',  String(width))
    form.append('height', String(height))

    const formResponse   = new Response(form)
    const formStream     = formResponse.body
    const formContentType = formResponse.headers.get('content-type')

    const result = await env.AI.run(model, {
      multipart: {
        body:        formStream,
        contentType: formContentType,
      },
    })

    if (result instanceof ReadableStream) {
      const reader = result.getReader()
      const chunks = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const total  = chunks.reduce((s, c) => s + c.length, 0)
      const buffer = new Uint8Array(total)
      let offset   = 0
      for (const chunk of chunks) {
        buffer.set(chunk, offset)
        offset += chunk.length
      }
      return buffer.buffer
    }

    if (result instanceof ArrayBuffer) return result
    throw new Error(`Unexpected FLUX multipart response: ${typeof result}`)
  }
}

/**
 * Generate image and upload to Supabase Storage in one call.
 * Returns public URL or null on failure (non-fatal for workflow).
 */
export async function generateAndUploadImage(env, prompt, storageKey, opts = {}) {
  const { uploadImage, imageExtAndType } = await import('./assets.js')

  try {
    const imgBytes   = await generateImage(env, prompt, opts)
    const { ext, contentType } = imageExtAndType(imgBytes)
    const key        = storageKey.endsWith(ext) ? storageKey : storageKey + ext
    const publicUrl  = await uploadImage(env, imgBytes, key, contentType)
    console.log(`[image-gen] uploaded to ${key}`)
    return { url: publicUrl, key }
  } catch (e) {
    console.warn(`[image-gen] failed (non-fatal): ${e.message}`)
    return null
  }
}