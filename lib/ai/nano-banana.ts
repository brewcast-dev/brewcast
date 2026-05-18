import type { createGoogleGenerativeAI } from '@ai-sdk/google'

// Nano Banana = Google Gemini 2.5 Flash Image (preview). Takes an image +
// prompt, returns an edited image inline. We use it for a subtle pass that
// enhances lighting, color balance, and clarity WITHOUT changing the subject
// or adding fake content.
//
// The AI SDK's image-generation surface doesn't yet expose image-to-image
// for Gemini, so we call the REST endpoint directly with the API key we
// already have on the google provider instance.

const MODEL = 'gemini-2.5-flash-image-preview'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

interface GeminiImagePart {
  inlineData: { mimeType: string; data: string }
}
interface GeminiTextPart {
  text: string
}
interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<GeminiImagePart | GeminiTextPart>
    }
  }>
  error?: { message?: string; code?: number }
}

const GRADING_PROMPT = (mood: string) => `Lightly enhance this brewery photo for an Instagram post. Apply professional but SUBTLE color grading appropriate for a "${mood}" mood:
- Correct any color casts and balance the exposure
- Slightly punch up vibrancy in the highlights
- Deepen shadows for contrast — but keep midtones natural
- Sharpen the focal point gently

CRITICAL RULES:
- Do NOT change what the photo shows. Same subjects, same composition.
- Do NOT add objects, text, watermarks, or graphics.
- Do NOT change the camera angle or framing.
- Do NOT make it look surreal or over-processed. Keep it editorial, not Instagram-filter.
- Same aspect ratio as the input.

Output only the edited image.`

interface Providers {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  google: any
}

// Extract the API key from an @ai-sdk/google provider instance. The provider
// stores it on a closure, so we read it via the same env var the SDK reads.
function getGoogleApiKey(providers: Providers): string | null {
  // The SDK reads GOOGLE_GENERATIVE_AI_API_KEY at default; the per-user
  // provider in our agent passes apiKey explicitly. We can't always extract
  // that, so check both. The route handler should set this env when calling.
  const fromEnv = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY
  if (fromEnv) return fromEnv
  // Last-ditch — try the provider's stashed config
  try {
    type ProviderWithApiKey = ReturnType<typeof createGoogleGenerativeAI> & {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _options?: { apiKey?: string }
    }
    const p = providers.google as ProviderWithApiKey
    if (p._options?.apiKey) return p._options.apiKey
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Run a Nano Banana grading pass over the given image. Returns the graded
 * image bytes, or null if the model declined / returned no image (caller
 * should fall back to the ungraded buffer in that case).
 *
 * Throws on transport errors (4xx/5xx) so the caller can decide whether to
 * retry or skip.
 */
export async function gradeImage(
  imageBuffer: Buffer,
  providers: Providers,
  mood: string,
  explicitApiKey?: string,
): Promise<Buffer | null> {
  const apiKey = explicitApiKey ?? getGoogleApiKey(providers)
  if (!apiKey) {
    throw new Error('No Google API key available for Nano Banana grading')
  }

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: GRADING_PROMPT(mood) },
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageBuffer.toString('base64'),
          },
        },
      ],
    }],
    // Image-out generation config
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  }

  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    let msg = text.slice(0, 400)
    try {
      const parsed = JSON.parse(text) as GeminiResponse
      if (parsed.error?.message) msg = parsed.error.message
    } catch { /* keep raw */ }
    throw new Error(`Nano Banana ${res.status}: ${msg}`)
  }

  const json = (await res.json()) as GeminiResponse
  const parts = json.candidates?.[0]?.content?.parts ?? []
  for (const part of parts) {
    if ('inlineData' in part && part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, 'base64')
    }
  }
  // Model returned text only (likely refused) — caller will use the original
  return null
}
