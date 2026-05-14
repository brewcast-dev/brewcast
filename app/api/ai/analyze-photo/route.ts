import { NextResponse } from 'next/server'
import { generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { groq } from '@ai-sdk/groq'
import { z } from 'zod'

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

async function analyzeWithGemini(imageUrl: string): Promise<PhotoAnalysis> {
  const { object } = await generateObject({
    model: google('gemini-2.5-flash'),
    schema: AnalysisSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: new URL(imageUrl) },
          {
            type: 'text',
            text: 'Analyse this brewery photo. Return the mood, subjects, best Instagram filter, visual quality score (0-100), confidence, and a one-sentence description.',
          },
        ],
      },
    ],
    system: SYSTEM_PROMPT,
  })
  return object
}

async function analyzeWithGroq(imageUrl: string): Promise<PhotoAnalysis> {
  // Llama 4 Scout — current Groq vision model (Llama 3.2 vision was decommissioned mid-2025)
  const { object } = await generateObject({
    model: groq('meta-llama/llama-4-scout-17b-16e-instruct'),
    schema: AnalysisSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: new URL(imageUrl) },
          {
            type: 'text',
            text: 'Analyse this brewery photo. Return the mood, subjects, best Instagram filter, visual quality score (0-100), confidence, and a one-sentence description.',
          },
        ],
      },
    ],
    system: SYSTEM_PROMPT,
  })
  return object
}

export async function POST(req: Request) {
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

  let geminiError: unknown = null
  try {
    const analysis = await analyzeWithGemini(imageUrl)
    return NextResponse.json(analysis)
  } catch (err) {
    geminiError = err
    console.warn('[analyze-photo] Gemini failed, trying Groq:', (err as Error).message)
  }

  try {
    const analysis = await analyzeWithGroq(imageUrl)
    return NextResponse.json(analysis)
  } catch (groqErr) {
    console.error('[analyze-photo] Both providers failed.')
    console.error('  Gemini:', (geminiError as Error)?.message ?? geminiError)
    console.error('  Groq:  ', (groqErr as Error).message)
    return NextResponse.json(
      {
        error: 'AI vision analysis unavailable',
        gemini: (geminiError as Error)?.message ?? String(geminiError),
        groq: (groqErr as Error).message,
      },
      { status: 503 },
    )
  }
}
