import { NextResponse } from 'next/server'
import { generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { groq } from '@ai-sdk/groq'
import { z } from 'zod'
import type { PhotoAnalysis } from '../analyze-photo/route'

const CaptionSchema = z.object({
  caption: z.string().describe('Instagram caption, 1-3 sentences, with emojis'),
  hashtags: z.array(z.string()).min(5).max(8).describe('5-8 hashtags without # prefix'),
})

export type CaptionResult = z.infer<typeof CaptionSchema>

// District 6 brand context injected into every caption prompt
const DISTRICT6_BRAND_CONTEXT = `
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

function buildPrompt(analysis: PhotoAnalysis, breweryConcepts?: string[]): string {
  const extra = breweryConcepts?.length
    ? `\nAdditional brewery context: ${breweryConcepts.join(', ')}`
    : ''
  return `Write an Instagram caption for this brewery photo.

Photo description: ${analysis.description}
Subjects visible: ${analysis.subjects.join(', ')}
Photo mood: ${analysis.mood}${extra}

Return a caption (1-3 sentences with emojis) and 5-8 hashtags (no # prefix).
The caption should feel authentic to a Bangalore craft brewery. Keep it short and punchy.`
}

async function captionWithGemini(
  analysis: PhotoAnalysis,
  breweryConcepts?: string[],
): Promise<CaptionResult> {
  const { object } = await generateObject({
    model: google('gemini-2.5-flash'),
    schema: CaptionSchema,
    system: DISTRICT6_BRAND_CONTEXT,
    prompt: buildPrompt(analysis, breweryConcepts),
  })
  return object
}

async function captionWithGroq(
  analysis: PhotoAnalysis,
  breweryConcepts?: string[],
): Promise<CaptionResult> {
  const { object } = await generateObject({
    model: groq('llama-3.3-70b-versatile'),
    schema: CaptionSchema,
    system: DISTRICT6_BRAND_CONTEXT,
    prompt: buildPrompt(analysis, breweryConcepts),
  })
  return object
}

export async function POST(req: Request) {
  let body: { analysis: PhotoAnalysis; breweryConcepts?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { analysis, breweryConcepts } = body
  if (!analysis) {
    return NextResponse.json({ error: 'analysis is required' }, { status: 400 })
  }

  try {
    const result = await captionWithGemini(analysis, breweryConcepts)
    return NextResponse.json(result)
  } catch (geminiErr) {
    console.warn('[generate-caption] Gemini failed, trying Groq:', geminiErr)
    try {
      const result = await captionWithGroq(analysis, breweryConcepts)
      return NextResponse.json(result)
    } catch (groqErr) {
      console.error('[generate-caption] Both Gemini and Groq failed:', groqErr)
      return NextResponse.json({ error: 'Caption generation unavailable' }, { status: 503 })
    }
  }
}
