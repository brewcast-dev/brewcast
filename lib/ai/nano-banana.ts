import type { createGoogleGenerativeAI } from '@ai-sdk/google'

// Nano Banana = Google Gemini 2.5 Flash Image (preview). Takes an image +
// prompt, returns an edited image inline. We use it for a subtle pass that
// enhances lighting, color balance, and clarity WITHOUT changing the subject
// or adding fake content.
//
// The AI SDK's image-generation surface doesn't yet expose image-to-image
// for Gemini, so we call the REST endpoint directly with the API key we
// already have on the google provider instance.

// GA model ID. The previous '-preview' name was deprecated and now 404s
// (see https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image).
const MODEL = 'gemini-2.5-flash-image'
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

// ─── Heavy photo edit (NO text rendering — that's done by code) ─────────────
// Gemini 2.5 Flash Image is great at photo editing but unreliable at
// rendering legible text. So we split the job: this function does AGGRESSIVE
// photo editing (cinematic grade, contrast, vignette, sharpening); the
// caller layers text + graphics on top via lib/image-design.ts.

export interface AiEditOptions {
  imageBuffer: Buffer
  mood?: string | null                // from vision: "cozy" | "vibrant" | etc.
  brandContext?: string | null
  providers: Providers
  explicitApiKey?: string
}

// Legacy alias — design route still calls aiDesignImage; keep the import
// working by re-exporting under both names.
export interface AiDesignOptions extends AiEditOptions {
  headline?: string
  subhead?: string | null
  kicker?: string | null
  handle?: string | null
  template?: 'bold-top' | 'serif-center' | 'caps-bottom-arrow'
}

function editPhotoPrompt(mood: string, brandContext?: string | null): string {
  // Pick a look based on the vision-detected mood. Each look pushes a
  // distinct, recognisably "designed" feel — not subtle grading.
  const look = (() => {
    const m = mood.toLowerCase()
    if (m.includes('cozy') || m.includes('warm') || m.includes('golden')) {
      return `WARM EDITORIAL look — push the highlights toward warm amber/honey, deepen shadows to near-black, lift the midtones with a soft golden glow. Add a subtle vignette darkening the corners ~30%. Mood: dimly-lit pub at golden hour.`
    }
    if (m.includes('moody') || m.includes('dark') || m.includes('noir') || m.includes('gritty')) {
      return `MOODY CINEMATIC look — heavy contrast, crush the blacks, desaturate the midtones, leave only highlights popping. Strong vignette (~45%). Slight teal-and-orange split toning. Mood: late-night session, dramatic.`
    }
    if (m.includes('vibrant') || m.includes('festive') || m.includes('playful') || m.includes('lively')) {
      return `VIBRANT EVENT look — push saturation hard, lift highlights, add a faint warm light leak from the upper-right corner. Sharpen the subject crisply. Mood: peak-hour celebration.`
    }
    if (m.includes('clean') || m.includes('minimal') || m.includes('premium')) {
      return `CLEAN EDITORIAL look — balanced exposure, slightly desaturated, neutral highlights, gentle shadow lift. Very subtle vignette. Mood: high-end magazine feature.`
    }
    return `RICH EDITORIAL look — deepen shadows, push contrast, gently boost saturation, sharpen the focal point. Add a subtle vignette darkening the corners ~25%.`
  })()

  return `You are a master photo editor finishing a raw photograph for ${brandContext ?? 'a craft brewery'}'s premium Instagram feed. Apply DRAMATIC editorial color grading — not subtle correction. The output must look noticeably more polished than the input.

${look}

ALWAYS APPLY:
- Deepen shadows (clip lightly into pure black at the deepest points)
- Add a soft vignette darkening the corners
- Sharpen the focal subject so it pops against the background
- Balance any obvious color cast in the lighting
- Light film grain / texture (very subtle — don't make it look noisy)

ABSOLUTE RULES:
- Same aspect ratio as input. Do NOT re-crop or re-frame.
- Same subjects, same composition, same scene elements. Do NOT add or remove people, glasses, food, furniture, or background details.
- Do NOT add text, logos, watermarks, captions, badges, frames, or any graphic overlays. These are composited afterwards by separate code.
- Do NOT make it surreal or over-stylized. Editorial, not Instagram-filter.

Output a single edited image.`
}

/**
 * Heavily edit a photo: cinematic color grading, contrast, vignette,
 * sharpening. NO text or graphic overlays — those are added by code
 * afterwards. Returns null if the model declines / doesn't return image
 * bytes (caller falls back to the original/ungraded buffer).
 *
 * Throws on transport errors (4xx/5xx).
 */
export async function editPhotoHeavily(opts: AiEditOptions): Promise<Buffer | null> {
  const apiKey = opts.explicitApiKey ?? getGoogleApiKey(opts.providers)
  if (!apiKey) {
    throw new Error('No Google API key available for AI photo edit')
  }
  const mood = opts.mood ?? 'vibrant'
  return callNanoBanana(editPhotoPrompt(mood, opts.brandContext), opts.imageBuffer, apiKey)
}

/**
 * Back-compat alias. Old callers that called aiDesignImage (which used to
 * also render text+graphics) now just get the heavy photo edit. Text and
 * graphics happen in lib/image-design.ts afterwards.
 */
export async function aiDesignImage(opts: AiDesignOptions): Promise<Buffer | null> {
  return editPhotoHeavily({
    imageBuffer: opts.imageBuffer,
    mood: opts.mood,
    brandContext: opts.brandContext,
    providers: opts.providers,
    explicitApiKey: opts.explicitApiKey,
  })
}
