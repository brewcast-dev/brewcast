import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { analyzePhoto } from '@/lib/ai/photo-analysis'
import { generateImageHeadline, type HeadlineResult } from '@/lib/ai/headline'
import { DEFAULT_BRAND_CONTEXT } from '@/lib/ai/captions'
import { composeDesignedImage, type DesignIntensity } from '@/lib/image-design'
import fs from 'fs'
import path from 'path'

interface RequestBody {
  imageUrl: string
  intensity?: DesignIntensity
  handle?: string
  // Manual overrides — when present, skip AI headline generation.
  headline?: string
  subhead?: string
  badge?: string
}

// Read optional brewery logo. Returns null if not present.
function readLogoFromDisk(): Buffer | null {
  const candidates = [
    path.join(process.cwd(), 'public', 'brand', 'logo.png'),
    path.join(process.cwd(), 'public', 'brand', 'logo.jpg'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p)
      } catch {
        return null
      }
    }
  }
  return null
}

export async function POST(req: Request) {
  const session = createSessionClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.imageUrl) {
    return NextResponse.json({ error: 'imageUrl required' }, { status: 400 })
  }
  const intensity: DesignIntensity = body.intensity ?? 'bold'
  const supabase = createAdminClient()

  // 1. Fetch the source image bytes
  let imageBuffer: Buffer
  try {
    const res = await fetch(body.imageUrl)
    if (!res.ok) throw new Error(`source fetch ${res.status}`)
    imageBuffer = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    return NextResponse.json(
      { error: `Couldn't fetch source image: ${(err as Error).message}` },
      { status: 502 },
    )
  }

  // 2. Resolve headline. If the caller passed one, use it as-is. Otherwise
  // look up the photo's stored analysis (or run vision inline) and ask the
  // AI for a punchy phrase.
  let headline: HeadlineResult
  if (body.headline) {
    headline = {
      headline: body.headline,
      subhead: body.subhead,
      badge: body.badge,
      intensity,
    }
  } else {
    const config = resolveConfig(await getUserConfig(user.id))
    const providers = {
      google: createGoogleGenerativeAI({ apiKey: config.googleApiKey }),
      groq: createGroq({ apiKey: config.groqApiKey }),
      mistral: createMistral({ apiKey: config.mistralApiKey }),
    }
    const brandContext = config.brandContext ?? DEFAULT_BRAND_CONTEXT

    // Try the registry first; vision-analyze inline only if nothing stored.
    const { data: stored } = await supabase
      .from('brewery_photos')
      .select('mood, subjects, suggested_filter, score, confidence, description')
      .eq('user_id', user.id)
      .eq('url', body.imageUrl)
      .maybeSingle()

    let analysis
    if (stored && (stored as { description: string | null }).description) {
      const s = stored as {
        mood: string | null
        subjects: string[] | null
        suggested_filter: string | null
        score: number | null
        confidence: number | null
        description: string | null
      }
      analysis = {
        mood: s.mood ?? 'casual',
        subjects: s.subjects ?? [],
        suggestedFilter: (s.suggested_filter ?? 'original') as 'original',
        score: s.score ?? 50,
        confidence: s.confidence ?? 0.5,
        description: s.description ?? '',
      }
    } else {
      try {
        analysis = await analyzePhoto(body.imageUrl, providers)
      } catch (err) {
        return NextResponse.json(
          { error: `Photo analysis failed: ${(err as Error).message}` },
          { status: 500 },
        )
      }
    }

    try {
      headline = await generateImageHeadline(analysis, providers, brandContext)
    } catch (err) {
      return NextResponse.json(
        { error: `Headline generation failed: ${(err as Error).message}` },
        { status: 500 },
      )
    }
    // Caller-supplied intensity overrides the AI's recommendation.
    if (body.intensity) headline.intensity = body.intensity
  }

  // 3. Composite
  const logoBuffer = readLogoFromDisk()
  let designedBuffer: Buffer
  try {
    designedBuffer = await composeDesignedImage({
      imageBuffer,
      headline: headline.headline,
      subhead: headline.subhead,
      handle: body.handle,
      badge: headline.badge,
      intensity: headline.intensity,
      logoBuffer: logoBuffer ?? undefined,
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Composite failed: ${(err as Error).message}` },
      { status: 500 },
    )
  }

  // 4. Upload to edited-posts bucket (same bucket used by the filter pipeline)
  const filename = `designed_${user.id}_${Date.now()}.jpg`
  const storagePath = `edited-posts/${filename}`
  const { error: upErr } = await supabase.storage
    .from('edited-posts')
    .upload(storagePath, designedBuffer, { contentType: 'image/jpeg', upsert: true })
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 })
  }
  const { data: urlData } = supabase.storage.from('edited-posts').getPublicUrl(storagePath)

  return NextResponse.json({
    url: urlData.publicUrl,
    headline: headline.headline,
    subhead: headline.subhead ?? null,
    badge: headline.badge ?? null,
    intensity: headline.intensity,
  })
}
