// Cloudflare Workers AI img2img fallback — used when Google's Nano Banana
// is quota-blocked. Free tier gives 10,000 neurons/day (~50-200 calls).
// Sign-up: https://dash.cloudflare.com/sign-up/workers-ai
//
// Set two env vars in Vercel:
//   CLOUDFLARE_ACCOUNT_ID   — from dash.cloudflare.com (right sidebar)
//   CLOUDFLARE_API_TOKEN    — create at My Profile → API Tokens with the
//                             "Workers AI" template

const MODEL = '@cf/runwayml/stable-diffusion-v1-5-img2img'
const endpoint = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`

export interface CloudflareEditOptions {
  imageBuffer: Buffer
  // Free-text prompt describing the desired LOOK. The model uses this to
  // bias the denoising — color, mood, lighting language works best. Avoid
  // composition changes ("add a person", "remove the glass") at low
  // strength because img2img keeps most of the original pixels.
  prompt: string
  // 0..1. Lower preserves more of the original photo. ~0.3-0.45 is the
  // sweet spot for editorial color grading without redrawing subjects.
  strength?: number
  steps?: number
  accountId?: string
  apiToken?: string
}

/**
 * Run Cloudflare's stable-diffusion-v1-5-img2img on the buffer with a style
 * prompt. Returns the new PNG bytes, or null if credentials aren't set.
 * Throws on API errors so the caller can decide whether to fall back further.
 */
export async function cloudflareImageEdit(opts: CloudflareEditOptions): Promise<Buffer | null> {
  const accountId = opts.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = opts.apiToken ?? process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !apiToken) {
    // Not configured — caller should treat as "skip", not error.
    return null
  }

  const body = {
    prompt: opts.prompt,
    image_b64: opts.imageBuffer.toString('base64'),
    strength: opts.strength ?? 0.4,
    num_steps: opts.steps ?? 20,
  }

  const res = await fetch(endpoint(accountId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Cloudflare img2img ${res.status}: ${text.slice(0, 400)}`)
  }

  // Endpoint returns raw image/png bytes
  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// Mood-driven prompt — same shape as nano-banana so the design route can
// swap one for the other.
export function moodToCloudflarePrompt(mood: string | null | undefined): string {
  const m = (mood ?? '').toLowerCase()
  if (m.includes('cozy') || m.includes('warm') || m.includes('golden')) {
    return 'warm editorial color grade, golden hour, amber highlights, deep shadows, soft vignette, cinematic pub atmosphere, sharp focal point, film grain'
  }
  if (m.includes('moody') || m.includes('dark') || m.includes('noir') || m.includes('gritty')) {
    return 'moody cinematic color grade, crushed blacks, teal and orange split tone, heavy vignette, late night bar, dramatic lighting, sharp subject, fine film grain'
  }
  if (m.includes('vibrant') || m.includes('festive') || m.includes('lively')) {
    return 'vibrant editorial color grade, lifted highlights, warm light leak, punchy saturation, peak hour celebration, sharp subject, subtle grain'
  }
  if (m.includes('clean') || m.includes('minimal') || m.includes('premium')) {
    return 'clean editorial color grade, neutral highlights, soft shadow lift, subtle vignette, high-end magazine feature, balanced exposure, sharp subject'
  }
  return 'rich editorial color grade, deep shadows, boosted contrast, gentle saturation, subtle vignette, sharp focal point, fine film grain'
}
