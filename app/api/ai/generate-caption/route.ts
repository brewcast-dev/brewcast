import { NextResponse } from 'next/server'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'
import type { PhotoAnalysis } from '@/lib/ai/photo-analysis'
import { generatePhotoCaption, DEFAULT_BRAND_CONTEXT } from '@/lib/ai/captions'

// Re-exported so existing imports in the /upload page keep working.
export type { CaptionResult } from '@/lib/ai/captions'

export async function POST(req: Request) {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rawConfig = await getUserConfig(user.id)
  const config = resolveConfig(rawConfig)

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

  const providers = {
    google: createGoogleGenerativeAI({ apiKey: config.googleApiKey }),
    groq: createGroq({ apiKey: config.groqApiKey }),
    mistral: createMistral({ apiKey: config.mistralApiKey }),
  }

  const brandContext = config.brandContext ?? DEFAULT_BRAND_CONTEXT

  try {
    const result = await generatePhotoCaption(analysis, providers, brandContext, breweryConcepts)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 503 },
    )
  }
}
