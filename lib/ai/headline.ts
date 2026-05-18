import { generateObject } from 'ai'
import { z } from 'zod'
import type { PhotoAnalysis } from './photo-analysis'
import type { CaptionProviders } from './captions'

const HeadlineSchema = z.object({
  headline: z.string().min(2).max(40).describe('1-6 word punchy phrase for the image overlay'),
  subhead: z.string().max(60).optional().describe('Optional 3-10 word supporting line'),
  badge: z.string().max(20).optional().describe('Optional 1-3 word badge text (e.g. "Tap Takeover", "New Brew")'),
  intensity: z.enum(['subtle', 'bold', 'heavy']).describe('How aggressively the design should dominate'),
})

export type HeadlineResult = z.infer<typeof HeadlineSchema>

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
    return result.object
  } catch (geminiErr) {
    console.warn('[headline] Gemini failed, trying Groq:', (geminiErr as Error).message)
    try {
      const result = await tryModel(providers.groq('llama-3.3-70b-versatile') as unknown as ReturnType<typeof providers.google>)
      return result.object
    } catch (groqErr) {
      console.warn('[headline] Groq failed, trying Mistral:', (groqErr as Error).message)
      const result = await tryModel(providers.mistral('mistral-small-latest') as unknown as ReturnType<typeof providers.google>)
      return result.object
    }
  }
}
