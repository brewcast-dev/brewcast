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
import { composeDesignedImage, type DesignIntensity, type DesignTemplate, type ComparisonRow } from '@/lib/image-design'
import { prepareImageForDesign } from '@/lib/creative-director'
import { aiDesignImage } from '@/lib/ai/nano-banana'
import sharp from 'sharp'
import fs from 'fs'
import path from 'path'

interface RequestBody {
  imageUrl: string
  intensity?: DesignIntensity     // Legacy. Mapped to template if template not given.
  template?: DesignTemplate       // Override the creative director's pick
  aspect?: '4:5' | '1:1'          // Default 4:5
  handle?: string
  // Manual overrides — when present, skip AI headline generation.
  headline?: string
  subhead?: string
  kicker?: string                 // Amber pill above headline (e.g. "TAP TAKEOVER")
  badge?: string                  // Legacy alias for kicker
  comparisons?: ComparisonRow[]   // Used when template === 'comparison'
  // Set to false to skip the Nano Banana grading pass (default: true)
  grading?: boolean
  // Set to false to skip the full AI design pass and use only the templated
  // compositor. Default: true (AI design runs first; falls back on failure).
  aiDesign?: boolean
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

  // Per-user AI providers (used by both headline-gen and the creative director)
  const config = resolveConfig(await getUserConfig(user.id))
  const providers = {
    google: createGoogleGenerativeAI({ apiKey: config.googleApiKey }),
    groq: createGroq({ apiKey: config.groqApiKey }),
    mistral: createMistral({ apiKey: config.mistralApiKey }),
  }
  const brandContext = config.brandContext ?? DEFAULT_BRAND_CONTEXT

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

  // 3. Creative director: trim borders, smart crop, vision analysis.
  // Skip grading here — if we're doing the full AI design pass below, that
  // step handles color grading too (one Nano Banana call, not two).
  const aiDesignEnabled = body.aiDesign !== false
  let preparedBuffer: Buffer
  let designDecisions = null as Awaited<ReturnType<typeof prepareImageForDesign>>['decisions'] | null
  try {
    const prepared = await prepareImageForDesign({
      imageBuffer,
      imageUrl: body.imageUrl,
      providers,
      brandContext,
      // Grading is folded into aiDesignImage when AI design is on
      enableGrading: aiDesignEnabled ? false : (body.grading !== false),
    })
    preparedBuffer = prepared.buffer
    designDecisions = prepared.decisions
    if (!body.intensity && prepared.decisions.suggested_intensity) {
      headline.intensity = prepared.decisions.suggested_intensity
    }
  } catch (err) {
    console.warn('[design] creative director failed, using raw buffer:', (err as Error).message)
    preparedBuffer = imageBuffer
  }

  const logoBuffer = readLogoFromDisk()
  // Template: caller override > creative director > intensity fallback
  const template: DesignTemplate | undefined =
    body.template ?? designDecisions?.suggested_template ?? undefined
  // Kicker: caller override > vision suggestion > legacy badge field
  const kicker = body.kicker ?? designDecisions?.kicker ?? body.badge ?? headline.badge

  // 4. Try the FULL AI design pass first — Nano Banana renders headline,
  // kicker, graphics, and color grading directly into the photo. This is
  // the path that actually produces designs matching the reference posts.
  // Falls back to the templated compositor on failure.
  let designedBuffer: Buffer | null = null
  let designPath: 'ai' | 'template' = 'template'
  if (aiDesignEnabled) {
    try {
      const aiResult = await aiDesignImage({
        imageBuffer: preparedBuffer,
        headline: headline.headline,
        subhead: headline.subhead ?? null,
        kicker: kicker ?? null,
        handle: body.handle ?? null,
        mood: designDecisions?.mood ?? null,
        brandContext,
        template: template === 'comparison' ? 'bold-top' : (template ?? 'bold-top'),
        providers,
      })
      if (aiResult) {
        // Re-fit to the requested aspect (model can drift on dimensions),
        // then overlay the real brewery logo on top for brand consistency.
        const aspect = body.aspect ?? '4:5'
        const W = aspect === '1:1' ? 1080 : 1080
        const H = aspect === '1:1' ? 1080 : 1350
        const fitted = await sharp(aiResult)
          .resize(W, H, { fit: 'cover', position: 'attention' })
          .toBuffer()
        if (logoBuffer) {
          // Use composeDesignedImage with empty text to get the consistent
          // logo placement + processing (white-inversion of black-on-white).
          designedBuffer = await composeDesignedImage({
            imageBuffer: fitted,
            headline: '',                 // headline already baked into the photo
            subhead: undefined,
            handle: undefined,            // handle also baked in by the model
            template,
            intensity: headline.intensity,
            aspect,
            logoBuffer,
            // No decoratives or kicker — those are in the AI image now.
            decorative: 'none',
            headlineColor: null,
          })
        } else {
          designedBuffer = fitted
        }
        designPath = 'ai'
      } else {
        console.warn('[design] aiDesignImage returned null — falling back to templated compositor')
      }
    } catch (err) {
      console.warn('[design] aiDesignImage failed, falling back to templated compositor:', (err as Error).message)
    }
  }

  // 5. Fallback: templated compositor (gradient + text-to-path + logo)
  try {
    if (!designedBuffer) {
      designedBuffer = await composeDesignedImage({
        imageBuffer: preparedBuffer,
        headline: headline.headline,
        subhead: headline.subhead,
        handle: body.handle,
        kicker: kicker ?? undefined,
        template,
        intensity: headline.intensity,
        aspect: body.aspect ?? '4:5',
        comparisons: body.comparisons,
        logoBuffer: logoBuffer ?? undefined,
        decorative: designDecisions?.suggested_decorative,
        headlineColor: designDecisions?.headline_color ?? null,
      })
    }
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
    kicker: kicker ?? null,
    intensity: headline.intensity,
    template: template ?? null,
    design_path: designPath,
  })
}
