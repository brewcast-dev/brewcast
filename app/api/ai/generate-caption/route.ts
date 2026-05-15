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
  caption: z.string().describe('Instagram caption, 1-3 sentences, with emojis'),
  hashtags: z.array(z.string()).min(5).max(8).describe('5-8 hashtags without # prefix'),
})

export type CaptionResult = z.infer<typeof CaptionSchema>

// Default brand context used when the user hasn't configured their own
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

function buildPrompt(analysis: PhotoAnalysis, breweryConcepts?: string[]): string {
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

  const prompt = buildPrompt(analysis, breweryConcepts)
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
    console.warn('[generate-caption] Gemini failed, trying Groq:', errors.gemini)
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
    console.warn('[generate-caption] Groq failed, trying Mistral:', errors.groq)
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
    console.error('[generate-caption] All three caption providers failed.')
    console.error('  Gemini: ', errors.gemini)
    console.error('  Groq:   ', errors.groq)
    console.error('  Mistral:', errors.mistral)
    return NextResponse.json(
      { error: 'Caption generation unavailable — all providers failed', ...errors },
      { status: 503 },
    )
  }
}
