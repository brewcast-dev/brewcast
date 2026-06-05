// Claid.ai image enhancement — non-generative photo polish (HDR, color
// correction, sharpening, denoise). Unlike Nano Banana or Stable Diffusion,
// Claid doesn't redraw pixels; it applies deterministic adjustments tuned
// by AI. Better fit for "make this brewery photo look pro" than generative
// img2img.
//
// Sign-up: https://app.claid.ai/ — trial gives ~100 free credits.
// Set CLAID_API_KEY in .env.local once issued.
//
// Docs: https://docs.claid.ai/image-editing-api/api-reference

const ENDPOINT = 'https://api.claid.ai/v1/image/edit'

interface ClaidResponse {
  data?: {
    input?: { width?: number; height?: number; format?: string }
    output?: {
      tmp_url?: string
      width?: number
      height?: number
      format?: string
    }
  }
  error_message?: string
  errors?: Array<{ message?: string }>
}

export interface ClaidEditOptions {
  // Public URL to the source image. Claid pulls it directly — we don't
  // upload bytes. Must be reachable from the public internet (Supabase
  // public URLs work).
  imageUrl: string
  mood?: string | null
  apiKey?: string
}

interface MoodPreset {
  exposure: number      // -100..100
  saturation: number    // -100..100
  contrast: number      // -100..100
  sharpness: number     // 0..100
  hdr: number           // 0..100
}

// Claid recommends HDR ~100, sat ~25, contrast ~20, sharp ~45 for product /
// venue photography. We push slightly past those defaults per mood so the
// result is visibly different from the input — subtle settings looked
// identical to the source in early tests.
function moodToPreset(mood: string | null | undefined): MoodPreset {
  const m = (mood ?? '').toLowerCase()
  if (m.includes('cozy') || m.includes('warm') || m.includes('golden')) {
    return { exposure: 10, saturation: 35, contrast: 28, sharpness: 50, hdr: 85 }
  }
  if (m.includes('moody') || m.includes('dark') || m.includes('noir') || m.includes('gritty')) {
    return { exposure: -5, saturation: -10, contrast: 55, sharpness: 60, hdr: 40 }
  }
  if (m.includes('vibrant') || m.includes('festive') || m.includes('lively') || m.includes('playful')) {
    return { exposure: 8, saturation: 50, contrast: 30, sharpness: 50, hdr: 100 }
  }
  if (m.includes('clean') || m.includes('minimal') || m.includes('premium')) {
    return { exposure: 5, saturation: 15, contrast: 22, sharpness: 40, hdr: 60 }
  }
  return { exposure: 8, saturation: 30, contrast: 25, sharpness: 45, hdr: 80 }
}

/**
 * Enhance the image via Claid's edit endpoint. Returns the URL of the
 * processed image (Claid's tmp_url, valid ~24h) or null if credentials
 * aren't set.
 *
 * Throws on transport errors so the caller can fall back to another editor.
 */
export async function claidImageEdit(opts: ClaidEditOptions): Promise<{
  url: string
  width?: number
  height?: number
  inputWidth?: number
  inputHeight?: number
} | null> {
  const apiKey = opts.apiKey ?? process.env.CLAID_API_KEY
  if (!apiKey) return null

  const preset = moodToPreset(opts.mood)

  const body = {
    input: opts.imageUrl,
    operations: {
      restorations: {
        // "strong" — aggressive JPEG-artifact removal. Brewery photos are
        // often re-saves of phone JPEGs, so this gives the most headroom for
        // subsequent adjustments.
        decompress: 'strong',
        // smart_enhance = Claid's AI upscaler. It both upscales and recovers
        // detail, which is the single biggest "looks more pro" lever in the
        // API. Without this, the result was visually identical to the input.
        upscale: 'smart_enhance',
        polish: true,
      },
      adjustments: {
        hdr: { intensity: preset.hdr, stitching: true },
        exposure: preset.exposure,
        saturation: preset.saturation,
        contrast: preset.contrast,
        sharpness: preset.sharpness,
      },
    },
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    let msg = text.slice(0, 400)
    try {
      const parsed = JSON.parse(text) as ClaidResponse
      msg = parsed.error_message ?? parsed.errors?.[0]?.message ?? msg
    } catch { /* keep raw */ }
    throw new Error(`Claid ${res.status}: ${msg}`)
  }

  const json = (await res.json()) as ClaidResponse
  const out = json.data?.output
  const inp = json.data?.input
  if (!out?.tmp_url) return null
  return {
    url: out.tmp_url,
    width: out.width,
    height: out.height,
    inputWidth: inp?.width,
    inputHeight: inp?.height,
  }
}
