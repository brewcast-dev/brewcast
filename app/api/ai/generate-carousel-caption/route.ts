import { NextResponse } from 'next/server'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'
import type { PhotoAnalysis } from '@/lib/ai/photo-analysis'
import { generateCarouselCaption, DEFAULT_BRAND_CONTEXT } from '@/lib/ai/captions'

export type { CarouselCaptionResult } from '@/lib/ai/captions'

export async function POST(req: Request) {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rawConfig = await getUserConfig(user.id)
  const config = resolveConfig(rawConfig)

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

  const providers = {
    google: createGoogleGenerativeAI({ apiKey: config.googleApiKey }),
    groq: createGroq({ apiKey: config.groqApiKey }),
    mistral: createMistral({ apiKey: config.mistralApiKey }),
  }

  const brandContext = config.brandContext ?? DEFAULT_BRAND_CONTEXT

  try {
    const result = await generateCarouselCaption(analyses, providers, brandContext, breweryConcepts)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 503 },
    )
  }
}
