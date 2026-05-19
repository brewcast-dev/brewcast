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

// ─── Shared transport ───────────────────────────────────────────────────────

async function callNanoBanana(
  prompt: string,
  imageBuffer: Buffer,
  apiKey: string,
): Promise<Buffer | null> {
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageBuffer.toString('base64'),
          },
        },
      ],
    }],
    generationConfig: { responseModalities: ['IMAGE'] },
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

  return callNanoBanana(GRADING_PROMPT(mood), imageBuffer, apiKey)
}

// ─── Full AI design: photo → finished social post ──────────────────────────
// Hands the entire design problem to Gemini 2.5 Flash Image: color-grade
// the photo, render headline + kicker text directly into the image, place
// graphic flourishes. The result is a fully-designed post that just needs
// our brand logo overlaid for consistency.
//
// This is the "creative director" approach the templated overlay was a
// poor substitute for.

export interface AiDesignOptions {
  imageBuffer: Buffer
  headline: string
  subhead?: string | null
  kicker?: string | null              // e.g. "TAP TAKEOVER"
  handle?: string | null              // e.g. "@district6bangalore"
  mood?: string | null                // from vision: "cozy" | "vibrant" | etc.
  brandContext?: string | null
  template?: 'bold-top' | 'serif-center' | 'caps-bottom-arrow'
  providers: Providers
  explicitApiKey?: string
}

function aiDesignPrompt(opts: AiDesignOptions): string {
  const mood = opts.mood ?? 'vibrant'
  const layoutGuide = (() => {
    switch (opts.template) {
      case 'serif-center':
        return `LAYOUT — editorial / centered:
- The headline goes in the VERTICAL CENTER of the image, in BOLD ITALIC SERIF typeface (think DM Serif Display Italic or Playfair Display Italic), white with a soft dark drop shadow.
- The headline reads across 2–3 lines, centered horizontally.
${opts.kicker ? `- ABOVE the headline, add a small AMBER (#f5b740) rounded pill with the text "${opts.kicker}" in white uppercase sans-serif inside.` : ''}
- Keep the brewery scene visible behind the headline. A subtle dark vignette across the middle band gives the text contrast.`
      case 'caps-bottom-arrow':
        return `LAYOUT — call-to-action / bottom:
- The headline goes at the BOTTOM-CENTER of the image, in ALL CAPS BOLD CONDENSED SANS-SERIF (think Anton or Bebas Neue), white with a soft dark drop shadow.
- The headline spans 1–2 lines, centered.
- BELOW the headline, draw a small hand-drawn-style downward double-arrow in white (two simple parallel arrows pointing down).
- A dark gradient at the bottom 35% of the image (transparent at top, dark at bottom) gives the text contrast.`
      case 'bold-top':
      default:
        return `LAYOUT — bold / top:
- The headline goes at the TOP-LEFT of the image, in BOLD CONDENSED SANS-SERIF (think Anton or Oswald Black), white with a soft dark drop shadow.
- The headline reads across 1–3 lines, left-aligned, taking up roughly 60% of the width.
${opts.kicker ? `- ABOVE the headline, add a small AMBER (#f5b740) rounded pill with the text "${opts.kicker}" in white uppercase sans-serif inside.` : ''}
${opts.subhead ? `- BELOW the headline, in a thinner white sans-serif, add this supporting line: "${opts.subhead}"` : ''}
- A soft dark gradient at the top 30% of the image (dark at top, transparent at bottom) gives the text contrast.`
    }
  })()

  return `You are a senior graphic designer creating a polished Instagram post for ${opts.brandContext ?? 'a craft brewery'}. Edit this RAW photo into a FINISHED social media graphic.

ASPECT: keep the input's 4:5 portrait aspect (1080×1350). Do NOT re-frame or crop the subject.

PHOTO ENHANCEMENTS:
- Professional color grading appropriate for a "${mood}" mood. Punch up the vibrancy in highlights, deepen shadows, balance any color cast, and gently sharpen the focal point.
- The edit should look editorial — not over-processed. No surreal filters.
- Keep ALL existing subjects, composition, and scene elements EXACTLY as they are. Do not add or remove people, food, drinks, furniture, or details.

${layoutGuide}

HEADLINE TEXT (must appear in the rendered image, spelled exactly as given):
"${opts.headline}"

GRAPHIC FLOURISHES:
- One or two subtle decorative elements that fit the brewery theme: hop sprigs in a corner, foam bubbles near beer glasses, a fine dashed line under the headline, a thin vintage-style frame, or a small starburst. Keep them tasteful and minimal — the photo and the headline are the heroes.
- Do NOT add a logo or watermark. We composite the real brewery logo afterward.

${opts.handle ? `HANDLE: in the BOTTOM-RIGHT corner, in small white sans-serif, render "${opts.handle}" with 60% opacity.` : ''}

OUTPUT a single finished image, ready to post.`
}

/**
 * Generate a fully-designed social post using Nano Banana. The model
 * color-grades the photo, renders the headline+kicker+graphics inline,
 * and returns a finished image. Returns null if the model declines or
 * doesn't return image bytes (caller falls back to the templated
 * compositor).
 *
 * Throws on transport errors (4xx/5xx).
 */
export async function aiDesignImage(opts: AiDesignOptions): Promise<Buffer | null> {
  const apiKey = opts.explicitApiKey ?? getGoogleApiKey(opts.providers)
  if (!apiKey) {
    throw new Error('No Google API key available for AI design')
  }
  return callNanoBanana(aiDesignPrompt(opts), opts.imageBuffer, apiKey)
}
