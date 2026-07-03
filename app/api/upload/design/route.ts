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
import { runDesignDirector } from '@/lib/design-director/pipeline'
import { editPhotoHeavily, generateDesignedPost } from '@/lib/ai/nano-banana'
import { recordAiUsage } from '@/lib/ai/usage'
import { cloudflareImageEdit, moodToCloudflarePrompt } from '@/lib/ai/cloudflare-edit'
import { getFontStatus } from '@/lib/text-to-path'
import sharp from 'sharp'

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
  // The AI Design Director pipeline (photo -> AI design plan -> deterministic
  // render -> vision QA) is now the DEFAULT. Set to false to force the legacy
  // templated compositor instead.
  designDirector?: boolean
  // Within the Design Director path: set false to skip the vision QA + regen.
  qa?: boolean
  // Generative design (Gemini 2.5 Flash Image designs the whole post end-to-end)
  // is the DEFAULT path. Set false to skip it and use the deterministic Design
  // Director instead. On failure it falls through to the Design Director too.
  generative?: boolean
}

// Last-resort headline so the design pipeline never dies just because all
// the AI providers refused. Picks a short phrase from the photo's mood and
// dominant subjects. Generic but on-brand; better than a blank overlay.
function heuristicHeadline(
  analysis: { mood: string; subjects: string[]; description: string },
  intensity: DesignIntensity,
): HeadlineResult {
  const mood = (analysis.mood ?? '').toLowerCase()
  const subj = (analysis.subjects ?? []).join(' ').toLowerCase()

  let headline = 'Crafted On Site'
  if (mood.includes('cozy') || mood.includes('warm') || mood.includes('golden')) {
    headline = 'Settle In Slow'
  } else if (mood.includes('moody') || mood.includes('dark') || mood.includes('noir')) {
    headline = 'Late Night Pour'
  } else if (mood.includes('vibrant') || mood.includes('festive') || mood.includes('lively')) {
    headline = 'Pour It Up'
  } else if (subj.includes('beer') || subj.includes('glass') || subj.includes('pint') || subj.includes('tap')) {
    headline = 'Fresh On Tap'
  } else if (subj.includes('food') || subj.includes('plate') || subj.includes('burger')) {
    headline = 'Pair It Up'
  } else if (subj.includes('crowd') || subj.includes('people') || subj.includes('bar')) {
    headline = 'Pull Up A Stool'
  }
  return { headline, intensity }
}

// Resolve the brewery logo: the per-user logo uploaded in Settings
// (config.logoUrl). There is no shared/default logo — accounts without one get
// no logo stamped (the renderer handles a null logo gracefully).
async function loadUserLogo(logoUrl: string | null): Promise<Buffer | null> {
  if (!logoUrl) return null
  try {
    const res = await fetch(logoUrl)
    if (res.ok) return Buffer.from(await res.arrayBuffer())
    console.warn(`[design] logo fetch ${res.status} for ${logoUrl}`)
  } catch (err) {
    console.warn('[design] logo fetch failed:', (err as Error).message)
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

  // Per-client keys are required (no operator-key fallback). Fail fast with an
  // actionable message rather than a cryptic provider auth error mid-pipeline.
  if (!config.googleApiKey) {
    return NextResponse.json(
      { error: 'No Google Gemini API key configured for this account. Add yours in Settings.' },
      { status: 400 },
    )
  }

  // ── Generative design path (DEFAULT; opt out with generative:false) ───────
  // Gemini 2.5 Flash Image designs the entire post — composition, legible text,
  // and the brewery's real logo composited in. On any failure (model declines,
  // transport error) it falls THROUGH to the deterministic Design Director
  // below, which itself falls through to the legacy compositor, so a request
  // never errors out.
  if (body.generative !== false) {
    try {
      const logoBuffer = await loadUserLogo(config.logoUrl)
      // Best-effort mood hint from the photo registry (the model also sees the
      // photo directly, so this is enrichment, not a hard dependency).
      const { data: stored } = await supabase
        .from('brewery_photos')
        .select('mood')
        .eq('user_id', user.id)
        .eq('url', body.imageUrl)
        .maybeSingle()
      const mood = (stored as { mood: string | null } | null)?.mood ?? null

      const gen = await generateDesignedPost({
        imageBuffer,
        headline: body.headline ?? null,
        mood,
        brandContext,
        logoBuffer,
        providers,
        explicitApiKey: config.googleApiKey,
      })

      // Meter the image-generation spend (this path is billed per image).
      if (gen.usage) {
        await recordAiUsage(
          { usage: gen.usage, response: { modelId: gen.model } },
          { feature: 'generative-design', provider: 'google', model: gen.model, userId: user.id },
        )
      }

      if (!gen.image) {
        // Model declined / returned no image — fall through to the Design Director.
        console.warn('[design] generative returned no image, falling through to Design Director')
      } else {
        // Re-encode and bound size without cropping (preserve the model's
        // composition — a cover-crop would slice off the text/logo it placed).
        const buffer = await sharp(gen.image)
          .resize(1440, 1800, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 92 })
          .toBuffer()

        const filename = `designed_${user.id}_${Date.now()}.jpg`
        const storagePath = `edited-posts/${filename}`
        const { error: upErr } = await supabase.storage
          .from('edited-posts')
          .upload(storagePath, buffer, { contentType: 'image/jpeg', upsert: true })
        if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
        const { data: urlData } = supabase.storage.from('edited-posts').getPublicUrl(storagePath)

        return NextResponse.json({
          url: urlData.publicUrl,
          pipeline: 'generative',
          model: gen.model,
          headline: body.headline ?? null,
          // The exact prompt sent to the model — always surfaced per request.
          design_prompt: gen.prompt,
        })
      }
    } catch (err) {
      console.warn('[design] generative path failed, falling through to Design Director:', (err as Error).message)
    }
  }

  // ── AI Design Director path (fallback; also the path when generative:false) ──
  // New pipeline: photo → AI design plan → deterministic render → vision QA.
  // Internally falls back to a heuristic plan if the director fails, and on a
  // hard failure here it falls through to the legacy templated path below, so
  // a request never errors out.
  if (body.designDirector !== false) {
    const logoBuffer = await loadUserLogo(config.logoUrl)
    // Optional vision hints from the photo registry (the director also sees
    // the photo directly, so these are best-effort enrichment).
    let hints: { mood?: string | null; subjects?: string[] | null; description?: string | null } | undefined
    const { data: stored } = await supabase
      .from('brewery_photos')
      .select('mood, subjects, description')
      .eq('user_id', user.id)
      .eq('url', body.imageUrl)
      .maybeSingle()
    if (stored) hints = stored as typeof hints

    try {
      const result = await runDesignDirector({
        imageUrl: body.imageUrl,
        providers: { google: providers.google },
        logo: logoBuffer,
        brandContext,
        hints,
        enhance: body.grading !== false, // reuse the grading flag for the Claid pre-step
        qa: body.qa !== false,
        userId: user.id,
      })

      const filename = `designed_${user.id}_${Date.now()}.jpg`
      const storagePath = `edited-posts/${filename}`
      const { error: upErr } = await supabase.storage
        .from('edited-posts')
        .upload(storagePath, result.buffer, { contentType: 'image/jpeg', upsert: true })
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
      const { data: urlData } = supabase.storage.from('edited-posts').getPublicUrl(storagePath)

      return NextResponse.json({
        url: urlData.publicUrl,
        pipeline: 'design-director',
        archetype: result.plan.archetype,
        headline: result.plan.textBlocks.map((b) => b.text).join(' / ') || null,
        plan: result.plan,
        qa: result.qa,
        regenerated: result.regenerated,
        used_fallback: result.usedFallback,
        enhanced: !!result.enhancedUrl,
        notes: result.notes,
      })
    } catch (err) {
      // Hard failure (rare — the pipeline degrades internally at each stage).
      // Fall through to the legacy templated compositor below rather than
      // failing the request.
      console.warn('[design] Design Director failed, falling back to legacy pipeline:', (err as Error).message)
    }
  }

  // 2. Resolve headline. If the caller passed one, use it as-is. Otherwise
  // look up the photo's stored analysis (or run vision inline) and ask the
  // AI for a punchy phrase.
  let headline: HeadlineResult
  let headlineFallback: string | null = null
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
      // Never block the design on headline gen — providers throttle, schemas
      // mis-validate. Derive a plausible phrase from the vision analysis so
      // the design pipeline always produces something usable.
      headlineFallback = (err as Error).message
      console.warn('[design] headline gen failed, falling back to heuristic:', headlineFallback)
      headline = heuristicHeadline(analysis, intensity)
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

  const logoBuffer = await loadUserLogo(config.logoUrl)
  // Template: caller override > creative director > intensity fallback
  const template: DesignTemplate | undefined =
    body.template ?? designDecisions?.suggested_template ?? undefined
  // Kicker: caller override > vision suggestion > legacy badge field
  const kicker = body.kicker ?? designDecisions?.kicker ?? body.badge ?? headline.badge

  // 4. Heavy photo edit. Try Nano Banana first (Gemini 2.5 Flash Image —
  // best quality but paid), then fall back to Cloudflare Workers AI's
  // SD-1.5 img2img (free tier, 10k neurons/day). NO text rendering here —
  // image-gen models are unreliable at legible text. Text + graphics get
  // composited by code in step 5.
  let editedPhoto = preparedBuffer
  let aiEditApplied = false
  let aiEditError: string | null = null
  let aiEditProvider: 'nano-banana' | 'cloudflare' | null = null
  const refitToAspect = async (buf: Buffer): Promise<Buffer> => {
    const a = body.aspect ?? '4:5'
    const W = 1440
    const H = a === '1:1' ? 1440 : 1800
    return sharp(buf).resize(W, H, { fit: 'cover', position: 'attention' }).toBuffer()
  }
  if (aiDesignEnabled) {
    // Try Nano Banana first
    try {
      const aiResult = await editPhotoHeavily({
        imageBuffer: preparedBuffer,
        mood: designDecisions?.mood ?? null,
        brandContext,
        providers,
      })
      if (aiResult) {
        editedPhoto = await refitToAspect(aiResult)
        aiEditApplied = true
        aiEditProvider = 'nano-banana'
      } else {
        aiEditError = 'Nano Banana returned no image'
        console.warn('[design] Nano Banana returned null')
      }
    } catch (err) {
      aiEditError = `nano-banana: ${(err as Error).message}`
      console.warn('[design] Nano Banana failed:', (err as Error).message)
    }

    // Cloudflare fallback when Nano Banana didn't apply (quota, refusal, etc.)
    if (!aiEditApplied) {
      try {
        const cfResult = await cloudflareImageEdit({
          imageBuffer: preparedBuffer,
          prompt: moodToCloudflarePrompt(designDecisions?.mood ?? null),
          strength: 0.4,
        })
        if (cfResult) {
          editedPhoto = await refitToAspect(cfResult)
          aiEditApplied = true
          aiEditProvider = 'cloudflare'
          aiEditError = null
        } else if (!aiEditError) {
          aiEditError = 'Cloudflare credentials not configured'
        }
      } catch (err) {
        const cfMsg = `cloudflare: ${(err as Error).message}`
        aiEditError = aiEditError ? `${aiEditError} | ${cfMsg}` : cfMsg
        console.warn('[design] Cloudflare img2img failed:', (err as Error).message)
      }
    }
  }

  // 5. Templated compositor — always runs. Overlays headline, kicker,
  // decoratives, handle, and the brewery logo onto whatever photo the
  // previous step produced (edited or original).
  let designedBuffer: Buffer
  try {
    designedBuffer = await composeDesignedImage({
      imageBuffer: editedPhoto,
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

  // Diagnostic block — surfaces whether fonts loaded so we can see
  // immediately why text might not be rendering.
  const fontStatus = getFontStatus()
  const fontsLoaded = fontStatus.display.loaded && fontStatus.serif.loaded && fontStatus.body.loaded

  return NextResponse.json({
    url: urlData.publicUrl,
    headline: headline.headline,
    subhead: headline.subhead ?? null,
    badge: headline.badge ?? null,
    kicker: kicker ?? null,
    intensity: headline.intensity,
    template: template ?? null,
    ai_edit_applied: aiEditApplied,
    ai_edit_provider: aiEditProvider,
    ai_edit_error: aiEditError,
    fonts_loaded: fontsLoaded,
    fonts_detail: fontsLoaded ? undefined : fontStatus,
    headline_fallback: headlineFallback,
  })
}
