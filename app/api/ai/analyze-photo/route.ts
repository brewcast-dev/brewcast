import { NextResponse } from 'next/server'
import { generateObject } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { z } from 'zod'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'

const AnalysisSchema = z.object({
  mood: z.string().describe('Overall mood: warm, cool, moody, vivid, fade, noir, golden, or neutral'),
  subjects: z.array(z.string()).describe('List of subjects visible in the photo'),
  suggestedFilter: z.enum(['original', 'warm', 'cool', 'moody', 'vivid', 'fade', 'noir', 'golden']),
  score: z.number().min(0).max(100).describe('Visual quality / engagement score'),
  confidence: z.number().min(0).max(1),
  description: z.string().describe('One sentence describing what is in the photo'),
})

export type PhotoAnalysis = z.infer<typeof AnalysisSchema>

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

export async function POST(req: Request) {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rawConfig = await getUserConfig(user.id)
  const config = resolveConfig(rawConfig)

  const google = createGoogleGenerativeAI({ apiKey: config.googleApiKey })
  const groq = createGroq({ apiKey: config.groqApiKey })
  const mistral = createMistral({ apiKey: config.mistralApiKey })

  let body: { imageUrl: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { imageUrl } = body
  if (!imageUrl) {
    return NextResponse.json({ error: 'imageUrl is required' }, { status: 400 })
  }

  const imageContent = [
    { type: 'image' as const, image: new URL(imageUrl) },
    {
      type: 'text' as const,
      text: 'Analyse this brewery photo. Return the mood, subjects, best Instagram filter, visual quality score (0-100), confidence, and a one-sentence description.',
    },
  ]

  const errors: Record<string, string> = {}

  try {
    const { object } = await generateObject({
      model: google('gemini-2.5-flash'),
      schema: AnalysisSchema,
      messages: [{ role: 'user', content: imageContent }],
      system: SYSTEM_PROMPT,
    })
    return NextResponse.json(object)
  } catch (err) {
    errors.gemini = (err as Error).message
    console.warn('[analyze-photo] Gemini failed, trying Groq:', errors.gemini)
  }

  try {
    const { object } = await generateObject({
      model: groq('meta-llama/llama-4-scout-17b-16e-instruct'),
      schema: AnalysisSchema,
      messages: [{ role: 'user', content: imageContent }],
      system: SYSTEM_PROMPT,
    })
    return NextResponse.json(object)
  } catch (err) {
    errors.groq = (err as Error).message
    console.warn('[analyze-photo] Groq failed, trying Mistral:', errors.groq)
  }

  try {
    const { object } = await generateObject({
      model: mistral('pixtral-12b-2409'),
      schema: AnalysisSchema,
      messages: [{ role: 'user', content: imageContent }],
      system: SYSTEM_PROMPT,
    })
    return NextResponse.json(object)
  } catch (err) {
    errors.mistral = (err as Error).message
    console.error('[analyze-photo] All three vision providers failed.')
    console.error('  Gemini: ', errors.gemini)
    console.error('  Groq:   ', errors.groq)
    console.error('  Mistral:', errors.mistral)
    return NextResponse.json(
      { error: 'AI vision analysis unavailable — all providers failed', ...errors },
      { status: 503 },
    )
  }
}
