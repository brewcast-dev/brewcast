import { NextResponse } from 'next/server'
import { createSessionClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { editPhotoHeavily, generateDesignedPost } from '@/lib/ai/nano-banana'
import { claidImageEdit } from '@/lib/ai/claid-edit'
import { recordAiUsage } from '@/lib/ai/usage'

// A/B compare the photo editors side-by-side. Takes a source image URL,
// runs it through each enabled provider in parallel, and returns the
// resulting URLs so you can eyeball quality differences.
//
// POST /api/debug/compare-editors { imageUrl, mood?: string }
//
// Response shape:
//   {
//     original: string,
//     mood: string,
//     results: {
//       nano_banana: { url?, error?, ms },
//       claid:       { url?, error?, ms },
//     }
//   }

interface RequestBody {
  imageUrl: string
  mood?: string         // Override the stored vision-detected mood
  headline?: string     // Headline for the generative-design lane (optional)
}

interface ProviderResult {
  url?: string
  error?: string
  ms: number
  // Dimensions of input vs output — useful as proof the provider actually
  // ran (e.g. Claid's smart_enhance upscales).
  inputSize?: string
  outputSize?: string
  // The exact prompt sent to the model (generative lane only).
  prompt?: string
}

async function runNanoBanana(
  imageBuffer: Buffer,
  mood: string,
  brandContext: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providers: { google: any; groq: any; mistral: any },
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<ProviderResult> {
  const t0 = Date.now()
  try {
    const out = await editPhotoHeavily({ imageBuffer, mood, brandContext, providers })
    if (!out) return { error: 'Nano Banana returned no image', ms: Date.now() - t0 }
    const filename = `compare_nano_${userId}_${Date.now()}.jpg`
    const storagePath = `compare/${filename}`
    const { error: upErr } = await supabase.storage
      .from('edited-posts')
      .upload(storagePath, out, { contentType: 'image/jpeg', upsert: true })
    if (upErr) return { error: `upload: ${upErr.message}`, ms: Date.now() - t0 }
    const { data } = supabase.storage.from('edited-posts').getPublicUrl(storagePath)
    return { url: data.publicUrl, ms: Date.now() - t0 }
  } catch (err) {
    return { error: (err as Error).message, ms: Date.now() - t0 }
  }
}

// The actual test: ask Gemini 2.5 Flash Image to design a FINISHED post
// (composition + legible text + the real logo), not just grade the photo.
async function runGenerativeDesign(
  imageBuffer: Buffer,
  mood: string,
  brandContext: string,
  headline: string | null,
  logoBuffer: Buffer | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providers: { google: any; groq: any; mistral: any },
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<ProviderResult> {
  const t0 = Date.now()
  try {
    const out = await generateDesignedPost({ imageBuffer, mood, brandContext, headline, logoBuffer, providers })
    // Meter the image-generation spend even on the debug lane.
    if (out.usage) {
      await recordAiUsage(
        { usage: out.usage, response: { modelId: out.model } },
        { feature: 'generative-design-compare', provider: 'google', model: out.model, userId },
      )
    }
    if (!out.image) return { error: 'Generative design returned no image', ms: Date.now() - t0, prompt: out.prompt }
    const filename = `compare_gendesign_${userId}_${Date.now()}.jpg`
    const storagePath = `compare/${filename}`
    const { error: upErr } = await supabase.storage
      .from('edited-posts')
      .upload(storagePath, out.image, { contentType: 'image/jpeg', upsert: true })
    if (upErr) return { error: `upload: ${upErr.message}`, ms: Date.now() - t0, prompt: out.prompt }
    const { data } = supabase.storage.from('edited-posts').getPublicUrl(storagePath)
    return { url: data.publicUrl, ms: Date.now() - t0, prompt: out.prompt }
  } catch (err) {
    return { error: (err as Error).message, ms: Date.now() - t0 }
  }
}

async function runClaid(imageUrl: string, mood: string): Promise<ProviderResult> {
  const t0 = Date.now()
  try {
    const out = await claidImageEdit({ imageUrl, mood })
    if (!out) return { error: 'CLAID_API_KEY not set', ms: Date.now() - t0 }
    return {
      url: out.url,
      ms: Date.now() - t0,
      inputSize: out.inputWidth && out.inputHeight ? `${out.inputWidth}×${out.inputHeight}` : undefined,
      outputSize: out.width && out.height ? `${out.width}×${out.height}` : undefined,
    }
  } catch (err) {
    return { error: (err as Error).message, ms: Date.now() - t0 }
  }
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

  const supabase = createAdminClient()
  const config = resolveConfig(await getUserConfig(user.id))
  const providers = {
    google: createGoogleGenerativeAI({ apiKey: config.googleApiKey }),
    groq: createGroq({ apiKey: config.groqApiKey }),
    mistral: createMistral({ apiKey: config.mistralApiKey }),
  }

  // Mood: caller override > registry > default
  let mood = body.mood ?? null
  if (!mood) {
    const { data: stored } = await supabase
      .from('brewery_photos')
      .select('mood')
      .eq('user_id', user.id)
      .eq('url', body.imageUrl)
      .maybeSingle()
    mood = (stored as { mood: string | null } | null)?.mood ?? null
  }
  const moodResolved = mood ?? 'vibrant'

  // Fetch source bytes once for Nano Banana
  let imageBuffer: Buffer
  try {
    const r = await fetch(body.imageUrl)
    if (!r.ok) throw new Error(`source fetch ${r.status}`)
    imageBuffer = Buffer.from(await r.arrayBuffer())
  } catch (err) {
    return NextResponse.json(
      { error: `Couldn't fetch source image: ${(err as Error).message}` },
      { status: 502 },
    )
  }

  // Fetch the user's real logo (if any) so the generative lane composites the
  // actual mark instead of inventing one.
  let logoBuffer: Buffer | null = null
  if (config.logoUrl) {
    try {
      const lr = await fetch(config.logoUrl)
      if (lr.ok) logoBuffer = Buffer.from(await lr.arrayBuffer())
    } catch { /* no logo — generative lane runs without one */ }
  }

  // Run all three editors in parallel: grade-only (Nano Banana), Claid enhance,
  // and the full generative design (the test).
  const [nanoBanana, claid, generativeDesign] = await Promise.all([
    runNanoBanana(imageBuffer, moodResolved, config.brandContext ?? '', providers, supabase, user.id),
    runClaid(body.imageUrl, moodResolved),
    runGenerativeDesign(imageBuffer, moodResolved, config.brandContext ?? '', body.headline ?? null, logoBuffer, providers, supabase, user.id),
  ])

  return NextResponse.json({
    original: body.imageUrl,
    mood: moodResolved,
    results: {
      nano_banana: nanoBanana,
      claid,
      generative_design: generativeDesign,
    },
  })
}
