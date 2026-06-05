import { generateObject } from 'ai'
import { z } from 'zod'
import type { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { createGroq } from '@ai-sdk/groq'
import type { createMistral } from '@ai-sdk/mistral'
import { recordAiUsage } from './usage'

export const PhotoAnalysisSchema = z.object({
  mood: z.string().describe('Overall mood: warm, cool, moody, vivid, fade, noir, golden, or neutral'),
  subjects: z.array(z.string()).describe('List of subjects visible in the photo'),
  suggestedFilter: z.enum(['original', 'warm', 'cool', 'moody', 'vivid', 'fade', 'noir', 'golden']),
  score: z.number().min(0).max(100).describe('Visual quality / engagement score'),
  confidence: z.number().min(0).max(1),
  description: z.string().describe('One sentence describing what is in the photo'),
})

export type PhotoAnalysis = z.infer<typeof PhotoAnalysisSchema>

const SYSTEM_PROMPT = `You are a visual content analyst for a craft brewery's Instagram account.
Analyse the photo and return structured data. Be concise and accurate.
For suggestedFilter, choose based on the mood:
- warm: golden-hour light, amber beer, cozy interiors
- cool: outdoor shots, blue tones, refreshing lagers
- moody: dark bars, low light, intimate scenes
- vivid: bright colorful food/beer shots, events
- fade: vintage feel, lifestyle, casual
- noir: black & white worthy, dramatic contrast
- golden: sunset, golden ales, warm amber hues
- original: already well-lit professional shots`

export interface AnalyzePhotoProviders {
  google: ReturnType<typeof createGoogleGenerativeAI>
  groq: ReturnType<typeof createGroq>
  mistral: ReturnType<typeof createMistral>
}

export async function analyzePhoto(
  imageUrl: string,
  providers: AnalyzePhotoProviders,
): Promise<PhotoAnalysis> {
  const { google, groq, mistral } = providers
  const imageContent = [
    { type: 'image' as const, image: new URL(imageUrl) },
    {
      type: 'text' as const,
      text: 'Analyse this brewery photo. Return the mood, subjects, best Instagram filter, visual quality score (0-100), confidence, and a one-sentence description.',
    },
  ]

  const errors: Record<string, string> = {}

  try {
    const res = await generateObject({
      model: google('gemini-2.5-flash'),
      schema: PhotoAnalysisSchema,
      messages: [{ role: 'user', content: imageContent }],
      system: SYSTEM_PROMPT,
    })
    await recordAiUsage(res, { feature: 'photo-analysis', provider: 'google', model: 'gemini-2.5-flash' })
    return res.object
  } catch (err) {
    errors.gemini = (err as Error).message
    console.warn('[analyzePhoto] Gemini failed, trying Groq:', errors.gemini)
  }

  try {
    const res = await generateObject({
      model: groq('meta-llama/llama-4-scout-17b-16e-instruct'),
      schema: PhotoAnalysisSchema,
      messages: [{ role: 'user', content: imageContent }],
      system: SYSTEM_PROMPT,
    })
    await recordAiUsage(res, { feature: 'photo-analysis', provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' })
    return res.object
  } catch (err) {
    errors.groq = (err as Error).message
    console.warn('[analyzePhoto] Groq failed, trying Mistral:', errors.groq)
  }

  try {
    const res = await generateObject({
      model: mistral('pixtral-12b-2409'),
      schema: PhotoAnalysisSchema,
      messages: [{ role: 'user', content: imageContent }],
      system: SYSTEM_PROMPT,
    })
    await recordAiUsage(res, { feature: 'photo-analysis', provider: 'mistral', model: 'pixtral-12b-2409' })
    return res.object
  } catch (err) {
    errors.mistral = (err as Error).message
    console.error('[analyzePhoto] All three vision providers failed.', errors)
    throw new Error(`AI vision analysis unavailable: ${JSON.stringify(errors)}`)
  }
}

// Concurrency-limited batch analysis. Gemini free tier is ~15 RPM so we cap at 3.
export async function analyzePhotos(
  imageUrls: string[],
  providers: AnalyzePhotoProviders,
  concurrency = 3,
): Promise<Array<{ imageUrl: string; analysis: PhotoAnalysis } | { imageUrl: string; error: string }>> {
  const results: Array<{ imageUrl: string; analysis: PhotoAnalysis } | { imageUrl: string; error: string }> = []
  for (let i = 0; i < imageUrls.length; i += concurrency) {
    const chunk = imageUrls.slice(i, i + concurrency)
    const chunkResults = await Promise.allSettled(
      chunk.map(async (imageUrl) => ({ imageUrl, analysis: await analyzePhoto(imageUrl, providers) })),
    )
    chunkResults.forEach((r, j) => {
      if (r.status === 'fulfilled') results.push(r.value)
      else results.push({ imageUrl: chunk[j], error: (r.reason as Error).message })
    })
  }
  return results
}
