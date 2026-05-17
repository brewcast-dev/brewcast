import { NextResponse } from 'next/server'
import { generateObject } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { z } from 'zod'
import type { PhotoAnalysis } from '../analyze-photo/route'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'

const CaptionSchema = z.object({
  caption: z.string().describe('Instagram carousel caption, 2-4 sentences, with emojis'),
  hashtags: z.array(z.string()).min(5).max(8).describe('5-8 hashtags without # prefix'),
})

export type CarouselCaptionResult = z.infer<typeof CaptionSchema>

const DEFAULT_BRAND_CONTEXT = `
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

function buildPrompt(analyses: PhotoAnalysis[], breweryConcepts?: string[]): string {
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

export async function POST(req: Request) {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rawConfig = await getUserConfig(user.id)
  const config = resolveConfig(rawConfig)

  const google = createGoogleGenerativeAI({ apiKey: config.googleApiKey })
  const groq = createGroq({ apiKey: config.groqApiKey })
  const mistral = createMistral({ apiKey: config.mistralApiKey })

  const brandContext = config.brandContext ?? DEFAULT_BRAND_CONTEXT

  let body: { analyses: PhotoAnalysis[]; breweryConcepts?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { analyses, breweryConcepts } = body
  if (!Array.isArray(analyses) || analyses.length < 2) {
    return NextResponse.json({ error: 'analyses must be an array of at least 2 PhotoAnalysis objects' }, { status: 400 })
  }

  const prompt = buildPrompt(analyses, breweryConcepts)
  const errors: Record<string, string> = {}

  try {
    const { object } = await generateObject({
      model: google('gemini-2.5-flash'),
      schema: CaptionSchema,
      system: brandContext,
      prompt,
    })
    return NextResponse.json(object)
  } catch (err) {
    errors.gemini = (err as Error).message
    console.warn('[generate-carousel-caption] Gemini failed, trying Groq:', errors.gemini)
  }

  try {
    const { object } = await generateObject({
      model: groq('llama-3.3-70b-versatile'),
      schema: CaptionSchema,
      system: brandContext,
      prompt,
    })
    return NextResponse.json(object)
  } catch (err) {
    errors.groq = (err as Error).message
    console.warn('[generate-carousel-caption] Groq failed, trying Mistral:', errors.groq)
  }

  try {
    const { object } = await generateObject({
      model: mistral('mistral-small-latest'),
      schema: CaptionSchema,
      system: brandContext,
      prompt,
    })
    return NextResponse.json(object)
  } catch (err) {
    errors.mistral = (err as Error).message
    console.error('[generate-carousel-caption] All three providers failed.')
    return NextResponse.json(
      { error: 'Carousel caption generation unavailable — all providers failed', ...errors },
      { status: 503 },
    )
  }
}
