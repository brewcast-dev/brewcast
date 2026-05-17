import { NextResponse } from 'next/server'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'
import { analyzePhoto } from '@/lib/ai/photo-analysis'

// Re-exported so existing imports in the /upload page keep working.
export type { PhotoAnalysis } from '@/lib/ai/photo-analysis'

export async function POST(req: Request) {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rawConfig = await getUserConfig(user.id)
  const config = resolveConfig(rawConfig)

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

  const providers = {
    google: createGoogleGenerativeAI({ apiKey: config.googleApiKey }),
    groq: createGroq({ apiKey: config.groqApiKey }),
    mistral: createMistral({ apiKey: config.mistralApiKey }),
  }

  try {
    const result = await analyzePhoto(imageUrl, providers)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 503 },
    )
  }
}
