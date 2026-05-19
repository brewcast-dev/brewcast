import { generateObject } from 'ai'
import { z } from 'zod'
import type { PhotoAnalysis } from './photo-analysis'
import type { CaptionProviders } from './captions'

// Wider bounds than ideal so generative models don't fail validation on
// borderline outputs — we trim/sanitize after parsing. The strict-enum
// intensity field used to be required, but Gemini's structured output
// would occasionally return values like "medium" or omit it entirely.
const HeadlineSchema = z.object({
  headline: z.string().min(2).max(80).describe('1-6 word punchy phrase for the image overlay'),
  subhead: z.string().max(120).optional().describe('Optional 3-10 word supporting line'),
  badge: z.string().max(40).optional().describe('Optional 1-3 word badge text (e.g. "Tap Takeover", "New Brew")'),
  intensity: z.string().optional().describe('One of: subtle, bold, heavy. How aggressively the design should dominate.'),
})

type RawHeadline = z.infer<typeof HeadlineSchema>
export interface HeadlineResult {
  headline: string
  subhead?: string
  badge?: string
  intensity: 'subtle' | 'bold' | 'heavy'
}

function coerceIntensity(raw: string | undefined): 'subtle' | 'bold' | 'heavy' {
  const v = (raw ?? '').toLowerCase().trim()
  if (v === 'subtle') return 'subtle'
  if (v === 'heavy' || v === 'high' || v === 'strong') return 'heavy'
  return 'bold' // default — matches "bold" / "medium" / "" / unknown
}

function sanitize(r: RawHeadline): HeadlineResult {
  // Trim trailing punctuation, collapse whitespace. Headline shouldn't end
  // with "!" or "." per the brand voice — strip aggressively.
  const trim = (s: string) => s.replace(/\s+/g, ' ').replace(/[.!?\s]+$/g, '').trim()
  return {
    headline: trim(r.headline).slice(0, 60),
    subhead: r.subhead ? trim(r.subhead).slice(0, 80) || undefined : undefined,
    badge: r.badge ? trim(r.badge).slice(0, 24) || undefined : undefined,
    intensity: coerceIntensity(r.intensity),
  }
}

/**
 * Suggest a short on-image headline plus optional subhead, badge, and a
 * recommended intensity level. Separate from the long-form caption — this
 * is what gets BAKED INTO the image, so it has to be very short and bold.
 */
export async function generateImageHeadline(
  analysis: PhotoAnalysis,
  providers: CaptionProviders,
  brandContext: string,
): Promise<HeadlineResult> {
  const prompt = [
    'You write short, punchy phrases to overlay on social-media photos for a craft brewery.',
    '',
    'BRAND CONTEXT:',
    brandContext.trim(),
    '',
    'PHOTO ANALYSIS:',
    `- Mood: ${analysis.mood}`,
    `- Subjects: ${analysis.subjects.join(', ')}`,
    `- Description: ${analysis.description}`,
    '',
    'TASK:',
    '- headline: 1-6 words. The biggest, boldest line burned into the image. Must read at thumbnail size. Active voice, no fluff. Examples: "Tap In Today", "Fresh From The Tank", "Pint Night Friday", "New Brew Drop", "Cold One Calls".',
    '- subhead (optional, omit if it weakens the headline): 3-10 words. Supports the headline. Example: "House lager, on draft now".',
    '- badge (optional): a 1-3 word pill label for the corner — only when the photo represents a SPECIFIC OCCASION or RELEASE. Examples: "New Brew", "Tap Takeover", "Limited Run", "Live Tonight". Skip for generic atmosphere/product shots.',
    '- intensity:',
    '   * "subtle" — magazine-cover style, photo dominates. Use for atmospheric/lifestyle shots where the photo carries the message.',
    '   * "bold" — half the frame is design. Use for product launches, beer close-ups, anything that needs CTA energy.',
    '   * "heavy" — big poster style. Use ONLY for events, takeovers, big announcements with a clear date/time energy.',
    '',
    'AVOID:',
    '- Generic corporate phrases ("Discover our finest...")',
    '- Hashtags (those go in the long caption)',
    '- Emojis (typography only)',
    '- Mentioning the brewery name (that\'s in the watermark)',
    '- Punctuation beyond commas; no exclamation marks unless absolutely necessary',
  ].join('\n')

  // Gemini first; same fallback chain as the caption pipeline.
  const tryModel = async (model: ReturnType<typeof providers.google>) =>
    generateObject({ model, schema: HeadlineSchema, prompt })

  try {
    const result = await tryModel(providers.google('gemini-2.5-flash'))
    return sanitize(result.object)
  } catch (geminiErr) {
    console.warn('[headline] Gemini failed, trying Groq:', (geminiErr as Error).message)
    try {
      const result = await tryModel(providers.groq('llama-3.3-70b-versatile') as unknown as ReturnType<typeof providers.google>)
      return sanitize(result.object)
    } catch (groqErr) {
      console.warn('[headline] Groq failed, trying Mistral:', (groqErr as Error).message)
      const result = await tryModel(providers.mistral('mistral-small-latest') as unknown as ReturnType<typeof providers.google>)
      return sanitize(result.object)
    }
  }
}
