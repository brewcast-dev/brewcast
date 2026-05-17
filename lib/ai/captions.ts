import { generateObject } from 'ai'
import { z } from 'zod'
import type { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { createGroq } from '@ai-sdk/groq'
import type { createMistral } from '@ai-sdk/mistral'
import type { PhotoAnalysis } from './photo-analysis'

const SingleCaptionSchema = z.object({
  caption: z.string().describe('Instagram caption, 1-3 sentences, with emojis'),
  hashtags: z.array(z.string()).min(5).max(8).describe('5-8 hashtags without # prefix'),
})

export type CaptionResult = z.infer<typeof SingleCaptionSchema>

const CarouselCaptionSchema = z.object({
  caption: z.string().describe('Instagram carousel caption, 2-4 sentences, with emojis'),
  hashtags: z.array(z.string()).min(5).max(8).describe('5-8 hashtags without # prefix'),
})

export type CarouselCaptionResult = z.infer<typeof CarouselCaptionSchema>

export const DEFAULT_BRAND_CONTEXT = `
District 6 Brewery is a craft brewery in Bangalore, India.
Brand voice: casual, warm, craft-forward, local Bangalore pride, community-first.
Tone: like a knowledgeable friend who loves beer, not a corporate account.
Always include at least one emoji. Keep it conversational and authentic.
Signature hashtag: #District6Bangalore. Always include it.
Other brand hashtags to rotate: #D6Brewing, #BangaloreBeer, #CraftBeerBangalore.
Niche hashtags: #CraftBeerIndia, #IndianCraftBeer, #MicrobreweryIndia.
Broad hashtags: #BeerLovers, #CraftBeer, #BreweryLife, #BeerPhotography.
Mix of brand + niche + broad hashtags. 5-8 total.
Never use generic marketing speak. Be genuine and local.
`

export interface CaptionProviders {
  google: ReturnType<typeof createGoogleGenerativeAI>
  groq: ReturnType<typeof createGroq>
  mistral: ReturnType<typeof createMistral>
}

function buildSinglePrompt(analysis: PhotoAnalysis, breweryConcepts?: string[]): string {
  const extra = breweryConcepts?.length
    ? `\nAdditional brewery context: ${breweryConcepts.join(', ')}`
    : ''
  return `Write an Instagram caption for this brewery photo.

Photo description: ${analysis.description}
Subjects visible: ${analysis.subjects.join(', ')}
Photo mood: ${analysis.mood}${extra}

Return a caption (1-3 sentences with emojis) and 5-8 hashtags (no # prefix).
The caption should feel authentic to the brewery. Keep it short and punchy.`
}

function buildCarouselPrompt(analyses: PhotoAnalysis[], breweryConcepts?: string[]): string {
  const extra = breweryConcepts?.length
    ? `\nAdditional brewery context: ${breweryConcepts.join(', ')}`
    : ''
  const photoList = analyses
    .map((a, i) => `Photo ${i + 1}: ${a.description}\n  Subjects: ${a.subjects.join(', ')}\n  Mood: ${a.mood}`)
    .join('\n\n')

  return `Write a single Instagram carousel caption that ties together this set of ${analyses.length} brewery photos.

${photoList}${extra}

The caption frames the whole sequence — it should feel like a small story, a thematic thread, or a "swipe through" moment, not a description of any one image. Reference what the set has in common (mood, beer style, vibe of the room, people) instead of listing each photo.

Return a single caption (2-4 sentences with emojis) and 5-8 hashtags (no # prefix). Keep it punchy and authentic to the brewery — never robotic. Do not include phrases like "Image 1" or "Photo 2".`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runWithFallback<T>(
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
  providers: CaptionProviders,
  label: string,
): Promise<T> {
  const { google, groq, mistral } = providers
  const errors: Record<string, string> = {}

  try {
    const { object } = await generateObject({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: google('gemini-2.5-flash') as any,
      schema,
      system,
      prompt,
    })
    return object as T
  } catch (err) {
    errors.gemini = (err as Error).message
    console.warn(`[${label}] Gemini failed, trying Groq:`, errors.gemini)
  }

  try {
    const { object } = await generateObject({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: groq('llama-3.3-70b-versatile') as any,
      schema,
      system,
      prompt,
    })
    return object as T
  } catch (err) {
    errors.groq = (err as Error).message
    console.warn(`[${label}] Groq failed, trying Mistral:`, errors.groq)
  }

  try {
    const { object } = await generateObject({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: mistral('mistral-small-latest') as any,
      schema,
      system,
      prompt,
    })
    return object as T
  } catch (err) {
    errors.mistral = (err as Error).message
    console.error(`[${label}] All three providers failed.`, errors)
    throw new Error(`Caption generation unavailable: ${JSON.stringify(errors)}`)
  }
}

export async function generatePhotoCaption(
  analysis: PhotoAnalysis,
  providers: CaptionProviders,
  brandContext: string = DEFAULT_BRAND_CONTEXT,
  breweryConcepts?: string[],
): Promise<CaptionResult> {
  return runWithFallback(
    SingleCaptionSchema,
    brandContext,
    buildSinglePrompt(analysis, breweryConcepts),
    providers,
    'generate-caption',
  )
}

export async function generateCarouselCaption(
  analyses: PhotoAnalysis[],
  providers: CaptionProviders,
  brandContext: string = DEFAULT_BRAND_CONTEXT,
  breweryConcepts?: string[],
): Promise<CarouselCaptionResult> {
  if (analyses.length < 2) {
    throw new Error('Carousel caption requires at least 2 photo analyses')
  }
  return runWithFallback(
    CarouselCaptionSchema,
    brandContext,
    buildCarouselPrompt(analyses, breweryConcepts),
    providers,
    'generate-carousel-caption',
  )
}
