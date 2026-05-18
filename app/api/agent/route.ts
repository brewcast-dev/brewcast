import {
  streamText,
  tool,
  convertToModelMessages,
  wrapLanguageModel,
  stepCountIs,
  generateText,
  generateObject,
  type LanguageModelMiddleware,
  type UIMessage,
} from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig, type ResolvedConfig } from '@/lib/get-user-config'
import type { Brewery } from '@/types/database'
import { analyzePhoto, analyzePhotos, type PhotoAnalysis } from '@/lib/ai/photo-analysis'
import { generatePhotoCaption, generateCarouselCaption, DEFAULT_BRAND_CONTEXT } from '@/lib/ai/captions'
import { publishPost as publishPostToMeta } from '@/lib/publish'
import { refreshMetaAnalytics, getAnalyticsSummary } from '@/lib/analytics'
import ffmpegPath from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

// ─── 429 / rate-limit detection ──────────────────────────────────────────────

function is429(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  const e = error as Record<string, unknown>
  if (e.statusCode === 429 || e.status === 429) return true
  const msg = typeof e.message === 'string' ? e.message : ''
  if (/429|rate.?limit|quota.?exceed|resource.?exhausted/i.test(msg)) return true
  return e.cause != null && is429(e.cause)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tryFallbacksStream(params: any, fallbacks: any[]): Promise<any> {
  const cleanParams = { ...params, providerMetadata: undefined }
  for (const model of fallbacks) {
    try {
      return await model.doStream(cleanParams)
    } catch (err) {
      if (is429(err)) {
        console.warn(`[BrewCast] ${model.modelId} rate-limited — trying next fallback`)
        continue
      }
      console.error(`[BrewCast] ${model.modelId} doStream error:`, err)
      throw err
    }
  }
  throw new Error('[BrewCast] All fallback models rate-limited (Groq + Mistral)')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tryFallbacksGenerate(params: any, fallbacks: any[]): Promise<any> {
  const cleanParams = { ...params, providerMetadata: undefined }
  for (const model of fallbacks) {
    try {
      return await model.doGenerate(cleanParams)
    } catch (err) {
      if (is429(err)) {
        console.warn(`[BrewCast] ${model.modelId} rate-limited — trying next fallback`)
        continue
      }
      console.error(`[BrewCast] ${model.modelId} doGenerate error:`, err)
      throw err
    }
  }
  throw new Error('[BrewCast] All fallback models rate-limited (Groq + Mistral)')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createFallbackMiddleware(fallbacks: any[]): LanguageModelMiddleware {
  // Gemini free-tier 429s often say "retry in ~50ms" — a single short backoff
  // beats falling all the way through to a less-capable model.
  const retryOnce = async <T>(fn: () => PromiseLike<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (!is429(err)) throw err
      console.log('[BrewCast] Gemini 429 — retrying in 1500ms before fallback')
      await new Promise((r) => setTimeout(r, 1500))
      return await fn()
    }
  }

  return {
    specificationVersion: 'v3',
    wrapStream: async ({ doStream, params }) => {
      try {
        return await retryOnce(doStream)
      } catch (err) {
        if (!is429(err)) throw err
        console.log('[BrewCast] Gemini 429 after retry — trying fallback chain: Groq 70b → Mistral')
        return tryFallbacksStream(params, fallbacks)
      }
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await retryOnce(doGenerate)
      } catch (err) {
        if (!is429(err)) throw err
        console.log('[BrewCast] Gemini 429 on generate after retry — trying fallback chain: Groq 70b → Mistral')
        return tryFallbacksGenerate(params, fallbacks)
      }
    },
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const sessionClient = createSessionClient()
  const { data: { user } } = await sessionClient.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const rawConfig = await getUserConfig(user.id)
  const config = resolveConfig(rawConfig)

  // Per-user AI providers
  const googleProvider = createGoogleGenerativeAI({ apiKey: config.googleApiKey })
  const groqProvider = createGroq({ apiKey: config.groqApiKey })
  const mistralProvider = createMistral({ apiKey: config.mistralApiKey })

  // Fallbacks — only models reliable for structured tool calling. 8b is
  // deliberately excluded; it emits tool calls as XML-ish text instead of
  // real function calls, which breaks every workflow.
  const fallbackModels = [
    groqProvider('llama-3.3-70b-versatile'),
    mistralProvider('mistral-small-latest'),
  ]

  const body = (await req.json()) as { messages: UIMessage[] }

  // ── Sliding window over message history ──────────────────────────────────
  // Cap what we send to the model regardless of localStorage history size.
  // Keep the very first user message (initial goal) plus the last KEEP_RECENT
  // messages. Bigger conversations would otherwise blow through every
  // provider's free-tier TPM ceiling.
  const KEEP_RECENT = 20
  let trimmedMessages: UIMessage[] = body.messages
  if (body.messages.length > KEEP_RECENT + 1) {
    const firstUserIdx = body.messages.findIndex((m) => m.role === 'user')
    const head = firstUserIdx >= 0 ? [body.messages[firstUserIdx]] : []
    const tail = body.messages.slice(-KEEP_RECENT)
    // Avoid duplicating the head if it's already in the tail
    trimmedMessages = head[0] && tail.includes(head[0]) ? tail : [...head, ...tail]
    console.log(`[agent] trimmed history ${body.messages.length} → ${trimmedMessages.length}`)
  }

  const supabase = createAdminClient()
  const { data: brewery } = await supabase
    .from('brewery')
    .select('*')
    .single() as { data: Brewery | null }

  const breweryName = config.breweryName !== 'your brewery' ? config.breweryName : (brewery?.name ?? 'your brewery')
  const igHandle = brewery?.ig_handle ?? ''
  const tone = brewery?.tone_of_voice ?? 'friendly and knowledgeable about craft beer'

  const systemPrompt = [
    `You are BrewCast, a professional social media manager for ${breweryName}.`,
    `Your tone is: ${tone}.`,
    'You help the brewery owner create and publish content for Instagram and Facebook.',
    'You have full access to every workflow in the webapp — browsing brewery photos, vision analysis, caption generation, carousel bundling, draft saving, queuing, publishing, and analytics.',
    '',
    'BEHAVIOUR — be decisive, not interrogative:',
    '- Make sensible defaults and act. Do not ask the user permission to perform routine steps like analysing photos, generating captions, or saving drafts.',
    '- Ask AT MOST ONE clarifying question per request, and only when the answer materially changes what you do.',
    '- The one question that IS necessary: when a request involves multiple photos and the user has not specified, ask: "Carousel (one post with all images) or separate posts (one per image)?" Then proceed without further questions.',
    '- Default platform: Instagram only, unless the user mentions Facebook or "both".',
    '- Default destination: save as draft (do not auto-queue or auto-publish). Only queue or publish when the user explicitly asks.',
    '- For "pick N best photos" requests: call list_brewery_photos, then analyze_brewery_photos on the whole set, then pick the top N by score yourself — do not ask the user to choose.',
    '- ALWAYS confirm with a one-line "publish this now? yes/no" before calling publish_post or publish_upload_draft_now.',
    '',
    'WORKFLOWS — common patterns:',
    '- list_brewery_photos returns photos PRE-SCORED, SORTED by score (best first). It returns ONLY name/url/score/analyzed — NOT the full analysis. The caption tools fetch stored analyses themselves; you do not need to pass analysis data around.',
    '- generate_photo_captions and generate_carousel_caption both take JUST `photo_urls` (an array of URLs from list_brewery_photos). They look up stored analyses by URL from the brewery_photos registry, falling back to inline vision only if a photo isn\'t scored yet.',
    '- DO NOT call analyze_brewery_photos before captioning — that\'s redundant. Only call it when the user explicitly asks to (re-)analyze or to inspect scores for unscored photos.',
    '- "Pick best N posts" / "make N posts from my photos" (no "carousel" word): list_brewery_photos(limit=N) → generate_photo_captions(photo_urls=[...]) → save_upload_drafts with N entries, each carousel=false and one image_url.',
    '- "Make a carousel from my photos" / "best N as a carousel" / ANY mention of "carousel": list_brewery_photos(limit=N) → generate_carousel_caption(photo_urls=[...]) → save_upload_drafts with EXACTLY ONE entry: carousel=true, image_urls=[ALL N URLs], image_url=first URL.',
    '- "Publish the carousel I just made": list_upload_drafts → publish_upload_draft_now with the matching draft id.',
    '- "Show me the archive" / "what got published recently": list_brewery_photos(view="archive"). Photos there auto-delete 30 days after publication.',
    '',
    'ATTACHED PHOTOS — when the user attaches photos via the + button:',
    '- The message starts with a block like: [Attached photos — work with these URLs (do NOT call list_brewery_photos): <url1> <url2> ...]',
    '- These URLs ARE the photos to operate on. Use them directly with generate_photo_captions / generate_carousel_caption / save_upload_drafts.',
    '- DO NOT call list_brewery_photos when this marker is present — the user has already chosen the photos. Calling it anyway wastes a step and may pick different photos.',
    '- If the photos have not been scored yet, the caption tools will fall back to inline vision automatically — you do not need to call analyze_brewery_photos first.',
    '- Count rule for carousel vs separate: if the user attached N photos and used the word "carousel", make ONE carousel with all N. Otherwise default to N separate drafts unless they say "one post" or "combine".',
    '',
    'CAROUSEL RULES — read carefully, the user\'s last complaint was about this:',
    '- If the user mentions "carousel" ANYWHERE in the request, you are in CAROUSEL MODE. Period.',
    '- In carousel mode: ONE call to generate_carousel_caption (NOT generate_photo_captions). ONE call to save_upload_drafts. ONE entry in the drafts array. ONE publish.',
    '- DO NOT create individual per-photo drafts as well as a carousel. DO NOT call save_upload_drafts twice in carousel mode. The result on Instagram is duplicate posts.',
    '- "Write captions" (plural) + "carousel" in the SAME request means ONE caption framing the whole set. Plural is just English — the carousel still gets ONE caption.',
    '- WRONG: save_upload_drafts({drafts: [{image_url:A,carousel:false}, {image_url:B,carousel:false}]}) when user asked for a carousel.',
    '- RIGHT: save_upload_drafts({drafts: [{image_url:A, image_urls:[A,B], carousel:true}]}).',
    '',
    'PUBLISH RULES — be precise about what gets published:',
    '- "Publish instantly" / "publish now" applies ONLY to what you just created in THIS turn. Never publish older drafts that happen to exist.',
    '- Call publish_upload_draft_now EXACTLY ONCE per draft you intend to publish. Never retry it without checking list_upload_drafts first — duplicate calls create duplicate posts on Instagram.',
    '- If a tool error suggests retrying, call list_upload_drafts first to confirm the draft\'s current status before retrying publish.',
    '',
    'CONTEXT HYGIENE — keep tool inputs small:',
    '- Always pass URLs/IDs between tools, never full analysis objects. Tools fetch what they need from the DB.',
    '- When picking N photos, set limit=N on list_brewery_photos so you don\'t pull more rows than needed.',
    '',
    'CRITICAL ID RULES — read carefully:',
    '- `post_id` is the UUID from the `posts` table. `draft_id` is the UUID from the `drafts` table. They are different tables.',
    '- `meta_post_id` is the long numeric Instagram/Facebook ID — NEVER pass it as either post_id or draft_id.',
    '- Before publish_post, call list_posts to get the correct UUID. Before publish_upload_draft_now, call list_upload_drafts.',
    '- Never guess or reuse IDs from earlier in the conversation if the user did something in between that could have changed state.',
    '',
    'After saving drafts, share the link: /drafts (the list) or /drafts/[id] for a specific one.',
  ].join('\n')

  const modelMessages = await convertToModelMessages(trimmedMessages)

  const model = wrapLanguageModel({
    model: googleProvider('gemini-2.5-flash'),
    middleware: createFallbackMiddleware(fallbackModels),
  })

  // Per-user AI providers passed to the photo/caption libs (separate instances
  // from `googleProvider` so that lib code stays decoupled from the chat model).
  const aiProviders = {
    google: googleProvider,
    groq: groqProvider,
    mistral: mistralProvider,
  }

  const brandContext = config.brandContext ?? DEFAULT_BRAND_CONTEXT

  const result = streamText({
    model,
    system: systemPrompt,
    messages: modelMessages,
    stopWhen: stepCountIs(30),
    tools: buildTools({
      supabase,
      brewery,
      breweryName,
      igHandle,
      tone,
      config,
      googleProvider,
      userId: user.id,
      aiProviders,
      brandContext,
    }),
  })

  return result.toUIMessageStreamResponse()
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof createAdminClient>

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function uploadToStorage(
  supabase: SupabaseClient,
  data: Buffer | Uint8Array,
  storagePath: string,
  contentType: string,
): Promise<string> {
  const { error } = await supabase.storage
    .from('media')
    .upload(storagePath, data, { contentType, upsert: true })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)
  return supabase.storage.from('media').getPublicUrl(storagePath).data.publicUrl
}

async function callHFModel(
  model: string,
  body: Record<string, unknown>,
  maxWaitSeconds = 90,
): Promise<Buffer> {
  const token = process.env.HUGGING_FACE_TOKEN
  if (!token) throw new Error('HUGGING_FACE_TOKEN not set')
  let waited = 0
  while (waited < maxWaitSeconds) {
    const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return Buffer.from(await res.arrayBuffer())
    if (res.status === 503) {
      const json = (await res.json().catch(() => ({}))) as { estimated_time?: number }
      const wait = Math.min(json.estimated_time ?? 20, 30)
      await new Promise(r => setTimeout(r, wait * 1000))
      waited += wait
      continue
    }
    throw new Error(`HF API ${res.status}: ${await res.text()}`)
  }
  throw new Error('HF model timed out loading')
}

function ffmpegRun(cmd: ReturnType<typeof ffmpeg>): Promise<void> {
  return new Promise((resolve, reject) => {
    cmd.on('end', () => resolve()).on('error', reject).run()
  })
}

/**
 * For each URL: try the brewery_photos registry first (cheap DB lookup);
 * if no stored analysis, run vision inline. Keeps caption tool inputs small
 * (just URLs) while reusing precomputed analyses where possible.
 */
async function resolveAnalysesForUrls(
  supabase: SupabaseClient,
  urls: string[],
  providers: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    groq: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mistral: any
  },
  userId: string,
): Promise<Array<{ url: string; analysis: PhotoAnalysis } | { url: string; error: string }>> {
  const { data } = await supabase
    .from('brewery_photos')
    .select('url, mood, subjects, suggested_filter, score, confidence, description, analyzed_at')
    .eq('user_id', userId)
    .in('url', urls)

  const byUrl = new Map<string, {
    mood: string | null
    subjects: string[] | null
    suggested_filter: string | null
    score: number | null
    confidence: number | null
    description: string | null
    analyzed_at: string | null
  }>()
  for (const row of ((data ?? []) as Array<{ url: string } & Record<string, unknown>>)) {
    byUrl.set(row.url, row as never)
  }

  return Promise.all(urls.map(async (url) => {
    const stored = byUrl.get(url)
    if (stored && stored.analyzed_at && stored.mood) {
      return {
        url,
        analysis: {
          mood: stored.mood,
          subjects: stored.subjects ?? [],
          suggestedFilter: (stored.suggested_filter ?? 'original') as PhotoAnalysis['suggestedFilter'],
          score: stored.score ?? 50,
          confidence: stored.confidence ?? 0.5,
          description: stored.description ?? '',
        },
      }
    }
    try {
      const analysis = await analyzePhoto(url, providers)
      return { url, analysis }
    } catch (err) {
      return { url, error: (err as Error).message }
    }
  }))
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

function buildTools(ctx: {
  supabase: SupabaseClient
  brewery: Brewery | null
  breweryName: string
  igHandle: string
  tone: string
  config: ResolvedConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  googleProvider: any
  userId: string
  aiProviders: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    groq: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mistral: any
  }
  brandContext: string
}) {
  const { supabase, config, googleProvider, userId, aiProviders, brandContext } = ctx

  return {
    // ── 1. get_brewery_profile ──────────────────────────────────────────────
    get_brewery_profile: tool({
      description: 'Read brewery profile from DB (name, tone, ig_handle).',
      inputSchema: z.object({}),
      execute: async () => {
        const { data, error } = await supabase.from('brewery').select('*').single()
        if (error) return { error: error.message }
        return data as Brewery
      },
    }),

    // ── 2. request_media_upload ─────────────────────────────────────────────
    request_media_upload: tool({
      description: 'Signed Supabase upload URL for jpg/png/webp/mp4. Returns upload_url + public_url.',
      inputSchema: z.object({
        filename: z.string().describe('Original filename, e.g. beer-photo.jpg'),
        content_type: z
          .string()
          .describe('MIME type: image/jpeg | image/png | image/webp | video/mp4'),
      }),
      execute: async ({ filename, content_type }) => {
        const storagePath = `media/${Date.now()}-${filename}`
        const { data, error } = await supabase.storage
          .from('media')
          .createSignedUploadUrl(storagePath)
        if (error) return { error: error.message }
        const { data: urlData } = supabase.storage.from('media').getPublicUrl(storagePath)
        return {
          upload_url: (data as { signedUrl: string }).signedUrl,
          path: storagePath,
          public_url: urlData.publicUrl,
          content_type,
        }
      },
    }),

    // ── 3. generate_image ───────────────────────────────────────────────────
    generate_image: tool({
      description: 'Generate image via Pixazo FLUX Schnell. square=1080² (posts), portrait=1080×1920 (reels/stories).',
      inputSchema: z.object({
        prompt: z.string().describe('Detailed image generation prompt'),
        style: z
          .string()
          .describe('Visual style, e.g. "cinematic craft brewery", "warm flat illustration"'),
        aspect: z
          .enum(['square', 'portrait'])
          .default('square')
          .describe('square = 1080×1080 for posts; portrait = 1080×1920 for reels/stories'),
      }),
      execute: async ({ prompt, style, aspect }) => {
        const apiKey = process.env.PIXAZO_API_KEY
        if (!apiKey) return { error: 'PIXAZO_API_KEY not configured' }

        const width = 1080
        const height = aspect === 'portrait' ? 1920 : 1080

        const res = await fetch('https://gateway.pixazo.ai/flux-1-schnell/v1/getData', {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': apiKey,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
          },
          body: JSON.stringify({ prompt: `${prompt}, ${style}`, num_steps: 4, width, height }),
        })
        if (!res.ok) return { error: `Pixazo error ${res.status}: ${await res.text()}` }

        const json = await res.json() as { output?: string }
        const imageUrl = json.output
        if (!imageUrl) return { error: 'Pixazo returned no output URL' }

        const imageBuffer = await fetchBuffer(imageUrl)
        const storagePath = `media/${Date.now()}-generated.jpg`
        const publicUrl = await uploadToStorage(supabase, imageBuffer, storagePath, 'image/jpeg')
        return { public_url: publicUrl, width, height }
      },
    }),

    // ── 4. write_caption ────────────────────────────────────────────────────
    write_caption: tool({
      description: 'Write a brand-voice caption. IG: long+hashtags. FB: short, 1-3 tags.',
      inputSchema: z.object({
        content_type: z.enum(['post', 'reel', 'story']),
        platform: z.enum(['instagram', 'facebook', 'both']),
        context: z
          .string()
          .describe('What the post is about: beer name, event, mood, key message, etc.'),
      }),
      execute: async ({ content_type, platform, context }) => {
        const platformGuide =
          platform === 'instagram'
            ? 'Instagram (max 2200 chars, up to 30 hashtags, emojis welcome)'
            : platform === 'facebook'
              ? 'Facebook (shorter, conversational, 1-3 hashtags)'
              : 'dual: one Instagram caption (max 2200 chars, up to 30 hashtags) and one Facebook caption (shorter, 1-3 hashtags)'

        const { text } = await generateText({
          model: googleProvider('gemini-2.5-flash'),
          system: `You write social media captions for ${ctx.breweryName}. Tone: ${ctx.tone}. IG handle: @${ctx.igHandle}.`,
          prompt: `Write a ${platformGuide} caption for this ${content_type}:\n${context}`,
        })

        return { caption: text }
      },
    }),

    // ── 5. generate_voiceover ───────────────────────────────────────────────
    generate_voiceover: tool({
      description: 'TTS voiceover via Kokoro-82M (HF). Returns audio_url + duration.',
      inputSchema: z.object({
        script: z.string().max(2000).describe('Voiceover script (keep under 500 words for best results)'),
      }),
      execute: async ({ script }) => {
        try {
          const audioBuffer = await callHFModel('hexgrad/Kokoro-82M', {
            inputs: script,
            parameters: { voice: 'af_bella', speed: 1.0 },
          })
          const storagePath = `media/${Date.now()}-voiceover.wav`
          const audioUrl = await uploadToStorage(supabase, audioBuffer, storagePath, 'audio/wav')
          const durationSeconds = Math.ceil(script.split(' ').length / 2.5)
          return { audio_url: audioUrl, duration_seconds: durationSeconds }
        } catch (err) {
          return { error: (err as Error).message }
        }
      },
    }),

    // ── 6. generate_background_music ───────────────────────────────────────
    generate_background_music: tool({
      description: 'Background music via MusicGen Small (HF). Returns audio_url.',
      inputSchema: z.object({
        mood: z
          .string()
          .describe('Music mood/style, e.g. "upbeat craft brewery ambient", "relaxing acoustic pub"'),
        duration_seconds: z
          .number()
          .min(5)
          .max(120)
          .describe('Desired track length in seconds'),
      }),
      execute: async ({ mood, duration_seconds }) => {
        try {
          const maxNewTokens = Math.min(Math.floor(duration_seconds * 50), 1500)
          const audioBuffer = await callHFModel('facebook/musicgen-small', {
            inputs: `${mood}, no vocals, instrumental background music`,
            parameters: { max_new_tokens: maxNewTokens },
          })
          const storagePath = `media/${Date.now()}-music.wav`
          const audioUrl = await uploadToStorage(supabase, audioBuffer, storagePath, 'audio/wav')
          return { audio_url: audioUrl }
        } catch (err) {
          return { error: (err as Error).message }
        }
      },
    }),

    // ── 7. compose_reel ─────────────────────────────────────────────────────
    compose_reel: tool({
      description: 'Render a 9:16 reel MP4 from images+clips+VO+music via FFmpeg (~30s).',
      inputSchema: z.object({
        image_urls: z.array(z.string()).describe('Public URLs of images (each shown for 3s with Ken Burns zoom)'),
        video_clip_urls: z
          .array(z.string())
          .default([])
          .describe('Public URLs of video clips (play at native speed)'),
        voiceover_url: z.string().describe('Public URL of the voiceover audio'),
        music_url: z.string().describe('Public URL of the background music (mixed at 20% volume)'),
        caption_overlay: z
          .string()
          .max(120)
          .describe('Short text overlay shown at bottom of reel'),
        duration_seconds: z
          .number()
          .min(5)
          .max(60)
          .describe('Target reel duration in seconds'),
      }),
      execute: async ({
        image_urls,
        video_clip_urls,
        voiceover_url,
        music_url,
        caption_overlay,
        duration_seconds,
      }) => {
        if (!ffmpegPath) return { error: 'ffmpeg-static binary not found' }
        ffmpeg.setFfmpegPath(ffmpegPath)

        const tmpDir = path.join(os.tmpdir(), `brewcast-${crypto.randomUUID()}`)
        fs.mkdirSync(tmpDir, { recursive: true })

        try {
          const segments: string[] = []

          // 1. Title card (1.5s) — amber brand background
          const titlePath = path.join(tmpDir, 'title.mp4')
          await ffmpegRun(
            ffmpeg()
              .input('color=c=#B45309:s=1080x1920:d=1.5:r=30')
              .inputOption('-f lavfi')
              .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-t 1.5'])
              .output(titlePath),
          )
          segments.push(titlePath)

          // 2. Images with Ken Burns slow zoom-in (3s each, 90 frames at 30fps)
          for (let i = 0; i < image_urls.length; i++) {
            const imgBuf = await fetchBuffer(image_urls[i])
            const imgPath = path.join(tmpDir, `img${i}.jpg`)
            fs.writeFileSync(imgPath, imgBuf)

            const segPath = path.join(tmpDir, `seg_img${i}.mp4`)
            await ffmpegRun(
              ffmpeg()
                .input(imgPath)
                .inputOptions(['-loop 1'])
                .duration(3)
                .videoFilters([
                  'scale=1080:1920:force_original_aspect_ratio=increase',
                  'crop=1080:1920',
                  "zoompan=z='min(zoom+0.0056,1.5)':d=90:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920",
                  'fps=30',
                ])
                .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-an'])
                .output(segPath),
            )
            segments.push(segPath)
          }

          // 3. Video clips — scaled/padded to 1080×1920
          for (let i = 0; i < video_clip_urls.length; i++) {
            const clipBuf = await fetchBuffer(video_clip_urls[i])
            const clipPath = path.join(tmpDir, `clip${i}.mp4`)
            fs.writeFileSync(clipPath, clipBuf)

            const segPath = path.join(tmpDir, `seg_clip${i}.mp4`)
            await ffmpegRun(
              ffmpeg()
                .input(clipPath)
                .videoFilters([
                  'scale=1080:1920:force_original_aspect_ratio=decrease',
                  'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
                ])
                .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-an'])
                .output(segPath),
            )
            segments.push(segPath)
          }

          // 4. Outro (1.5s) — zinc dark background
          const outroPath = path.join(tmpDir, 'outro.mp4')
          await ffmpegRun(
            ffmpeg()
              .input('color=c=#18181B:s=1080x1920:d=1.5:r=30')
              .inputOption('-f lavfi')
              .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-t 1.5'])
              .output(outroPath),
          )
          segments.push(outroPath)

          // 5. Concat segments
          const concatListPath = path.join(tmpDir, 'concat.txt')
          fs.writeFileSync(concatListPath, segments.map(s => `file '${s}'`).join('\n'))

          const rawPath = path.join(tmpDir, 'raw.mp4')
          await ffmpegRun(
            ffmpeg()
              .input(concatListPath)
              .inputOptions(['-f concat', '-safe 0'])
              .outputOptions(['-c copy'])
              .output(rawPath),
          )

          // 6. Caption overlay
          const captionPath = path.join(tmpDir, 'captioned.mp4')
          const escaped = caption_overlay
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "'")
            .replace(/:/g, '\\:')
          await ffmpegRun(
            ffmpeg()
              .input(rawPath)
              .videoFilters([
                'drawbox=x=0:y=h*0.65:w=iw:h=h*0.35:color=black@0.55:t=fill',
                `drawtext=text='${escaped}':fontcolor=white:fontsize=36:x=(w-tw)/2:y=h*0.72:line_spacing=8`,
              ])
              .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-an'])
              .output(captionPath),
          )

          // 7. Mix audio
          const finalPath = path.join(tmpDir, 'final.mp4')
          const hasVO = !!voiceover_url
          const hasMusic = !!music_url

          if (hasVO || hasMusic) {
            const audioCmd = ffmpeg().input(captionPath)
            if (hasVO) {
              const voBuf = await fetchBuffer(voiceover_url)
              const voPath = path.join(tmpDir, 'vo.wav')
              fs.writeFileSync(voPath, voBuf)
              audioCmd.input(voPath)
            }
            if (hasMusic) {
              const musicBuf = await fetchBuffer(music_url)
              const musicLocalPath = path.join(tmpDir, 'music.wav')
              fs.writeFileSync(musicLocalPath, musicBuf)
              audioCmd.input(musicLocalPath)
            }

            if (hasVO && hasMusic) {
              audioCmd
                .complexFilter('[1:a]volume=1.0[vo];[2:a]volume=0.2[bg];[vo][bg]amix=inputs=2:duration=first[aout]')
                .outputOptions(['-map 0:v', '-map [aout]', '-c:v copy', '-c:a aac', '-shortest'])
            } else if (hasVO) {
              audioCmd.outputOptions(['-map 0:v', '-map 1:a', '-c:v copy', '-c:a aac', '-shortest'])
            } else {
              audioCmd
                .complexFilter('[1:a]volume=0.2[aout]')
                .outputOptions(['-map 0:v', '-map [aout]', '-c:v copy', '-c:a aac', '-shortest'])
            }

            audioCmd.output(finalPath)
            await ffmpegRun(audioCmd)
          } else {
            fs.copyFileSync(captionPath, finalPath)
          }

          // 8. Extract thumbnail at 1s
          const thumbPath = path.join(tmpDir, 'thumbnail.jpg')
          await ffmpegRun(
            ffmpeg()
              .input(finalPath)
              .outputOptions(['-vframes 1', '-ss 1'])
              .output(thumbPath),
          )

          // 9. Upload both to Supabase Storage
          const ts = Date.now()
          const [videoUrl, thumbnailUrl] = await Promise.all([
            uploadToStorage(supabase, fs.readFileSync(finalPath), `media/${ts}-reel.mp4`, 'video/mp4'),
            uploadToStorage(supabase, fs.readFileSync(thumbPath), `media/${ts}-thumb.jpg`, 'image/jpeg'),
          ])

          return { video_url: videoUrl, thumbnail_url: thumbnailUrl, duration_seconds }
        } catch (err) {
          return { error: (err as Error).message }
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true })
        }
      },
    }),

    // ── 8. save_draft ───────────────────────────────────────────────────────
    save_draft: tool({
      description: 'Save a post to the `posts` table. Returns draft_id + review_url.',
      inputSchema: z.object({
        content_type: z.enum(['post', 'reel', 'story']),
        platform: z.enum(['instagram', 'facebook', 'both']),
        caption: z.string().describe('The full caption text'),
        media_urls: z
          .array(z.string())
          .default([])
          .describe('Public CDN URLs of image/video assets'),
        audio_url: z
          .string()
          .default('')
          .describe('Public URL of the voiceover audio (if any)'),
        video_url: z
          .string()
          .default('')
          .describe('Public URL of the composed reel MP4 (if any)'),
        thumbnail_url: z
          .string()
          .default('')
          .describe('Public URL of the thumbnail image (if any)'),
        scheduled_at: z
          .string()
          .optional()
          .describe('ISO 8601 datetime to auto-publish (omit to publish manually)'),
      }),
      execute: async ({
        content_type,
        platform,
        caption,
        media_urls,
        audio_url,
        video_url,
        thumbnail_url,
        scheduled_at,
      }) => {
        const { data, error } = await supabase
          .from('posts')
          .insert({
            status: scheduled_at ? 'queued' : 'draft',
            user_id: userId,
            content_type,
            platform,
            caption,
            media_urls: media_urls.length > 0 ? media_urls : null,
            audio_url: audio_url || null,
            video_url: video_url || null,
            thumbnail_url: thumbnail_url || null,
            scheduled_at: scheduled_at ?? null,
          })
          .select('id')
          .single()

        if (error) return { error: error.message }

        const draftId = (data as { id: string }).id
        return {
          draft_id: draftId,
          review_url: `/drafts/${draftId}`,
          message: `Draft saved! Review it here: /drafts/${draftId}`,
        }
      },
    }),

    // ── 8b. list_posts ──────────────────────────────────────────────────────
    list_posts: tool({
      description: 'List `posts` rows. Call before publish_post to get UUIDs. Filter by status.',
      inputSchema: z.object({
        status: z
          .enum(['draft', 'approved', 'queued', 'published', 'failed'])
          .optional()
          .describe('Filter by post status. Omit to list all posts.'),
        limit: z.number().int().min(1).max(50).default(20).optional(),
      }),
      execute: async ({ status, limit }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: any = supabase
          .from('posts')
          .select('id, status, platform, content_type, caption, scheduled_at, created_at, meta_post_id')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(limit ?? 20)
        if (status) query = query.eq('status', status)
        const { data, error } = await query
        if (error) return { error: error.message }
        const rows = (data ?? []) as Array<{
          id: string
          status: string
          platform: string
          content_type: string
          caption: string | null
          scheduled_at: string | null
          created_at: string
          meta_post_id: string | null
        }>
        return {
          count: rows.length,
          posts: rows.map((r) => ({
            id: r.id,
            status: r.status,
            platform: r.platform,
            content_type: r.content_type,
            caption_preview: r.caption ? r.caption.slice(0, 100) + (r.caption.length > 100 ? '…' : '') : null,
            scheduled_at: r.scheduled_at,
            already_published_meta_id: r.meta_post_id,
          })),
        }
      },
    }),

    // ── 8c. process_queue_now ───────────────────────────────────────────────
    process_queue_now: tool({
      description: 'Trigger the queue processor — publishes any queued post past its scheduled_at.',
      inputSchema: z.object({}),
      execute: async () => {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
        const secret = process.env.QUEUE_SECRET
        if (!secret) return { error: 'QUEUE_SECRET not set in environment — cannot trigger queue processor' }
        try {
          const res = await fetch(`${appUrl}/api/queue/process`, {
            headers: { Authorization: `Bearer ${secret}` },
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok) return { error: `Queue processor returned ${res.status}`, body: json }
          return { ok: true, result: json }
        } catch (err) {
          return { error: (err as Error).message }
        }
      },
    }),

    // ── 9. publish_post ─────────────────────────────────────────────────────
    publish_post: tool({
      description: 'Publish a `posts` row to Meta. post_id MUST be local UUID from list_posts (not meta_post_id). Confirm with user first.',
      inputSchema: z.object({
        post_id: z
          .string()
          .uuid()
          .describe(
            'The local Supabase UUID for the post (NOT the Meta/Instagram ID). Get this from list_posts.',
          ),
      }),
      execute: async ({ post_id }) => {
        const igUserId = config.metaIgUserId
        const accessToken = config.metaAccessToken
        if (!igUserId || !accessToken) return { error: 'Meta credentials not configured for this account' }

        const { data: post, error } = await supabase
          .from('posts')
          .select('*')
          .eq('id', post_id)
          .eq('user_id', userId)
          .single()

        if (error || !post) return { error: error?.message ?? 'Post not found' }

        const GRAPH_BASE = 'https://graph.instagram.com/v21.0'

        async function graphPost(
          endpoint: string,
          params: Record<string, string>,
        ): Promise<Record<string, unknown>> {
          const body = new URLSearchParams({ ...params, access_token: accessToken })
          const res = await fetch(`${GRAPH_BASE}${endpoint}`, { method: 'POST', body })
          const json = await res.json()
          if (!res.ok) throw new Error(`Meta API: ${JSON.stringify(json)}`)
          return json as Record<string, unknown>
        }

        async function pollContainer(containerId: string): Promise<void> {
          for (let i = 0; i < 24; i++) {
            const res = await fetch(
              `${GRAPH_BASE}/${containerId}?fields=status_code&access_token=${accessToken}`,
            )
            const json = (await res.json()) as { status_code?: string }
            if (json.status_code === 'FINISHED') return
            if (json.status_code === 'ERROR') throw new Error('Media container error')
            await new Promise(r => setTimeout(r, 5000))
          }
          throw new Error('Media container timed out')
        }

        try {
          const metaPostIds: string[] = []

          if (post.platform === 'instagram' || post.platform === 'both') {
            if (post.content_type === 'reel' && post.video_url) {
              const container = await graphPost(`/${igUserId}/media`, {
                media_type: 'REELS',
                video_url: post.video_url,
                caption: post.caption ?? '',
                share_to_feed: 'true',
                thumb_offset: '2000',
              })
              await pollContainer(container.id as string)
              const pub = await graphPost(`/${igUserId}/media_publish`, {
                creation_id: container.id as string,
              })
              metaPostIds.push(pub.id as string)
            } else if (post.content_type === 'story') {
              const mediaUrl = post.video_url || (post.media_urls as string[] | null)?.[0]
              if (mediaUrl) {
                const container = await graphPost(`/${igUserId}/media`, {
                  media_type: 'STORIES',
                  ...(post.video_url
                    ? { video_url: post.video_url }
                    : { image_url: mediaUrl }),
                })
                if (post.video_url) await pollContainer(container.id as string)
                const pub = await graphPost(`/${igUserId}/media_publish`, {
                  creation_id: container.id as string,
                })
                metaPostIds.push(pub.id as string)
              }
            } else {
              const imageUrl = (post.media_urls as string[] | null)?.[0] ?? post.thumbnail_url ?? ''
              if (imageUrl) {
                const container = await graphPost(`/${igUserId}/media`, {
                  image_url: imageUrl,
                  caption: post.caption ?? '',
                })
                const pub = await graphPost(`/${igUserId}/media_publish`, {
                  creation_id: container.id as string,
                })
                metaPostIds.push(pub.id as string)
              }
            }
          }

          const fbPageId = config.metaFbPageId
          if (fbPageId && (post.platform === 'facebook' || post.platform === 'both')) {
            if (post.content_type === 'reel' && post.video_url) {
              const video = await graphPost(`/${fbPageId}/videos`, {
                file_url: post.video_url,
                description: post.caption ?? '',
              })
              metaPostIds.push(video.id as string)
            } else {
              const imageUrl = (post.media_urls as string[] | null)?.[0] ?? ''
              if (imageUrl) {
                const photo = await graphPost(`/${fbPageId}/photos`, {
                  url: imageUrl,
                  message: post.caption ?? '',
                })
                metaPostIds.push(photo.id as string)
              }
            }
          }

          await supabase
            .from('posts')
            .update({
              status: 'published',
              published_at: new Date().toISOString(),
              meta_post_id: metaPostIds[0] ?? null,
            })
            .eq('id', post_id)
            .eq('user_id', userId)

          return {
            success: true,
            platform: post.platform,
            meta_post_id: metaPostIds[0] ?? null,
            meta_post_ids: metaPostIds,
          }
        } catch (err) {
          await supabase.from('posts').update({ status: 'failed' }).eq('id', post_id).eq('user_id', userId)
          return { error: (err as Error).message }
        }
      },
    }),

    // ── 10. suggest_ad_targeting ────────────────────────────────────────────
    suggest_ad_targeting: tool({
      description: 'Generate + save Meta ad targeting JSON for a post.',
      inputSchema: z.object({
        post_id: z.string().uuid().describe('The post ID to generate ad targeting for'),
      }),
      execute: async ({ post_id }) => {
        const { data: post, error } = await supabase
          .from('posts')
          .select('caption, content_type')
          .eq('id', post_id)
          .eq('user_id', userId)
          .single()

        if (error || !post) return { error: error?.message ?? 'Post not found' }

        const { object: targeting } = await generateObject({
          model: googleProvider('gemini-2.5-flash'),
          schema: z.object({
            age_range: z.object({
              min: z.number().min(18).max(65),
              max: z.number().min(18).max(65),
            }),
            interests: z
              .array(z.string())
              .describe('Facebook/Instagram interest targeting categories'),
            location_radius_km: z
              .number()
              .describe('Geographic radius around the brewery (km)'),
            daily_budget_usd: z.number().describe('Recommended daily ad spend in USD'),
            objective: z
              .enum(['BRAND_AWARENESS', 'REACH', 'ENGAGEMENT', 'VIDEO_VIEWS'])
              .describe('Meta campaign objective'),
          }),
          prompt: [
            `Generate Meta ad targeting for a local craft brewery.`,
            `Post type: ${post.content_type}`,
            `Caption: ${post.caption}`,
          ].join('\n'),
        })

        await supabase
          .from('posts')
          .update({ ad_targeting: targeting })
          .eq('id', post_id)
          .eq('user_id', userId)

        return targeting
      },
    }),

    // ── 11. fetch_analytics ─────────────────────────────────────────────────
    fetch_analytics: tool({
      description: 'Pull Meta Insights for the last N days, store in DB, return summary.',
      inputSchema: z.object({
        days: z
          .number()
          .min(1)
          .max(90)
          .default(30)
          .describe('Number of past days to fetch analytics for'),
      }),
      execute: async ({ days }) => {
        const igUserId = config.metaIgUserId
        const accessToken = config.metaAccessToken
        if (!igUserId || !accessToken) return { error: 'Meta credentials not configured for this account' }

        try {
          const refresh = await refreshMetaAnalytics(supabase, { igUserId, accessToken }, days, userId)
          const summary = await getAnalyticsSummary(supabase, days, userId)
          return {
            days_fetched: days,
            posts_analyzed: refresh.posts_captured,
            insights_failed: refresh.failed,
            total_reach: summary.total_reach,
            avg_engagement_rate: summary.avg_engagement_rate,
            top_post_id: summary.top_post_id,
          }
        } catch (err) {
          return { error: (err as Error).message }
        }
      },
    }),

    // ── 12. list_brewery_photos ─────────────────────────────────────────────
    list_brewery_photos: tool({
      description: 'List brewery photos sorted by score desc (best first). Returns name/url/score/analyzed. view="archive" for published ones. Take first N for "best N" — don\'t re-analyze.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(50).optional(),
        view: z.enum(['available', 'archive']).default('available').optional(),
      }),
      execute: async ({ limit, view }) => {
        const cap = limit ?? 50
        const viewFilter = view ?? 'available'

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: any = supabase
          .from('brewery_photos')
          .select('name, url, score, mood, subjects, suggested_filter, confidence, description, analyzed_at, published_at, created_at')
          .eq('user_id', userId)
          .order('score', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(cap)
        query = viewFilter === 'archive'
          ? query.not('published_at', 'is', null)
          : query.is('published_at', null)

        const { data, error } = await query
        if (error) return { error: error.message }

        const rows = (data ?? []) as Array<{
          name: string
          url: string
          score: number | null
          mood: string | null
          subjects: string[] | null
          suggested_filter: string | null
          confidence: number | null
          description: string | null
          analyzed_at: string | null
          published_at: string | null
          created_at: string
        }>

        return {
          view: viewFilter,
          count: rows.length,
          analyzed_count: rows.filter((r) => r.analyzed_at !== null).length,
          // Slim payload: only the fields the AI needs to pick photos.
          // The caption tools look up the full analysis from the DB by URL.
          photos: rows.map((r) => ({
            name: r.name,
            url: r.url,
            score: r.score,
            analyzed: r.analyzed_at !== null,
          })),
        }
      },
    }),

    // ── 13. analyze_brewery_photos ──────────────────────────────────────────
    analyze_brewery_photos: tool({
      description: 'Vision-analyze photos and persist to registry. Only use for analyzed=false rows or explicit re-analysis. Caption tools fetch analyses themselves — no need to call this first.',
      inputSchema: z.object({
        image_urls: z.array(z.string()).min(1).max(20).describe('Public photo URLs from list_brewery_photos'),
      }),
      execute: async ({ image_urls }) => {
        const results = await analyzePhotos(image_urls, aiProviders, 3)
        // Persist successful analyses so subsequent caption calls hit the cache.
        await Promise.all(results.map(async (r) => {
          if (!('analysis' in r)) return
          const a = r.analysis
          await supabase
            .from('brewery_photos')
            .update({
              mood: a.mood,
              subjects: a.subjects,
              suggested_filter: a.suggestedFilter,
              score: Math.round(a.score),
              confidence: a.confidence,
              description: a.description,
              analyzed_at: new Date().toISOString(),
              analysis_error: null,
            })
            .eq('user_id', userId)
            .eq('url', r.imageUrl)
        }))
        // Slim response: just score + mood + filter. Full analysis is in the
        // DB; caption tools will fetch it when needed without bloating context.
        return {
          count: results.length,
          results: results.map((r) => 'analysis' in r
            ? {
                imageUrl: r.imageUrl,
                score: Math.round(r.analysis.score),
                mood: r.analysis.mood,
                suggestedFilter: r.analysis.suggestedFilter,
              }
            : { imageUrl: r.imageUrl, error: r.error }),
        }
      },
    }),

    // ── 14. generate_photo_captions ─────────────────────────────────────────
    generate_photo_captions: tool({
      description: 'Generate per-photo IG captions for each URL. Looks up stored analysis. For non-carousel posts.',
      inputSchema: z.object({
        photo_urls: z.array(z.string()).min(1).max(20).describe('Public photo URLs'),
        brewery_concepts: z.array(z.string()).optional().describe('Optional extra context (beer names, events)'),
      }),
      execute: async ({ photo_urls, brewery_concepts }) => {
        const analyses = await resolveAnalysesForUrls(supabase, photo_urls, aiProviders, userId)
        const results = await Promise.all(
          analyses.map(async (item, i) => {
            if ('error' in item) return { index: i, photo_url: item.url, error: item.error }
            try {
              const cap = await generatePhotoCaption(item.analysis, aiProviders, brandContext, brewery_concepts)
              return { index: i, photo_url: item.url, caption: cap.caption, hashtags: cap.hashtags }
            } catch (err) {
              return { index: i, photo_url: item.url, error: (err as Error).message }
            }
          }),
        )
        return { count: results.length, captions: results }
      },
    }),

    // ── 15. generate_carousel_caption ───────────────────────────────────────
    generate_carousel_caption: tool({
      description: 'Generate ONE IG caption for a 2-10 photo carousel. Pass URLs; analyses fetched internally.',
      inputSchema: z.object({
        photo_urls: z.array(z.string()).min(2).max(10),
        brewery_concepts: z.array(z.string()).optional(),
      }),
      execute: async ({ photo_urls, brewery_concepts }) => {
        try {
          const resolved = await resolveAnalysesForUrls(supabase, photo_urls, aiProviders, userId)
          const ok = resolved.filter((r): r is { url: string; analysis: PhotoAnalysis } => 'analysis' in r)
          if (ok.length < 2) {
            return { error: `Need at least 2 analyzed photos; only ${ok.length} succeeded.` }
          }
          const result = await generateCarouselCaption(
            ok.map((r) => r.analysis),
            aiProviders,
            brandContext,
            brewery_concepts,
          )
          return result
        } catch (err) {
          return { error: (err as Error).message }
        }
      },
    }),

    // ── 16. save_upload_drafts ──────────────────────────────────────────────
    save_upload_drafts: tool({
      description: 'Insert into `drafts` table. CAROUSEL: ONE entry with carousel=true + image_urls[2-10]. SEPARATE: multiple entries each with one image_url. Returns draft_ids.',
      inputSchema: z.object({
        drafts: z.array(z.object({
          image_url: z.string().describe('Primary/thumbnail image URL (first image for carousels)'),
          caption: z.string(),
          hashtags: z.array(z.string()).default([]),
          platforms: z.array(z.enum(['instagram', 'facebook'])).default(['instagram']),
          filter_applied: z.string().default('original'),
          edited_image_url: z.string().optional(),
          carousel: z.boolean().default(false),
          image_urls: z.array(z.string()).default([]).describe('All image URLs when carousel=true (2-10)'),
          edited_image_urls: z.array(z.string()).default([]),
          scheduled_at: z.string().optional().describe('ISO 8601; omit for draft state'),
        })).min(1).max(10),
      }),
      execute: async ({ drafts }) => {
        // Guardrail: detect "carousel + per-photo individuals with same images"
        // pattern. The model has been known to mix modes, producing duplicate
        // Instagram posts. Reject the call so the model has to retry cleanly.
        const carouselUrls = new Set<string>()
        for (const d of drafts) {
          if (d.carousel) for (const u of d.image_urls) carouselUrls.add(u)
        }
        if (carouselUrls.size > 0) {
          const offending = drafts.filter((d) => !d.carousel && carouselUrls.has(d.image_url))
          if (offending.length > 0) {
            return {
              error: 'Mixed mode rejected: you cannot save a carousel AND individual drafts containing the same images in one call — that would create duplicate Instagram posts. In carousel mode, pass EXACTLY ONE entry with carousel=true and ALL image URLs in image_urls.',
              hint: 'If the user said "carousel", drop the individual entries and keep just the carousel entry.',
            }
          }
          // Also reject if 2+ carousel entries — should always be exactly one.
          const carouselCount = drafts.filter((d) => d.carousel).length
          if (carouselCount > 1) {
            return {
              error: `Got ${carouselCount} carousel entries in one call. Each save_upload_drafts call should contain AT MOST one carousel entry.`,
            }
          }
        }

        const rows = drafts.map((d) => ({
          brewery_id: 'district6',
          user_id: userId,
          image_url: d.image_url,
          edited_image_url: d.edited_image_url ?? null,
          filter_applied: d.filter_applied,
          caption: d.caption,
          hashtags: d.hashtags,
          platforms: d.platforms,
          status: d.scheduled_at ? 'queued' : 'draft',
          scheduled_at: d.scheduled_at ?? null,
          carousel: d.carousel,
          image_urls: d.image_urls,
          edited_image_urls: d.edited_image_urls,
        }))

        const { data, error } = await supabase.from('drafts').insert(rows).select('id, carousel')
        if (error) return { error: error.message }

        const items = (data ?? []) as Array<{ id: string; carousel: boolean }>
        return {
          count: items.length,
          drafts: items.map((r) => ({
            draft_id: r.id,
            carousel: r.carousel,
            review_url: `/drafts/${r.id}`,
          })),
          listing_url: '/drafts',
        }
      },
    }),

    // ── 17. list_upload_drafts ──────────────────────────────────────────────
    list_upload_drafts: tool({
      description: 'List `drafts` rows (upload flow). Returns id, carousel, image_count, caption_preview, status.',
      inputSchema: z.object({
        status: z.enum(['draft', 'approved', 'queued', 'published', 'failed']).optional(),
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(20).optional(),
      }),
      execute: async ({ status, include_archived, limit }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: any = supabase
          .from('drafts')
          .select('id, caption, carousel, image_url, image_urls, platforms, status, scheduled_at, archived_at, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(limit ?? 20)
        if (status) query = query.eq('status', status)
        if (!include_archived) query = query.is('archived_at', null)
        const { data, error } = await query
        if (error) return { error: error.message }
        const rows = (data ?? []) as Array<{
          id: string
          caption: string | null
          carousel: boolean
          image_url: string
          image_urls: string[] | null
          platforms: string[] | null
          status: string
          scheduled_at: string | null
          archived_at: string | null
          created_at: string
        }>
        return {
          count: rows.length,
          drafts: rows.map((r) => ({
            id: r.id,
            carousel: r.carousel,
            image_count: r.carousel ? (r.image_urls?.length ?? 0) : 1,
            thumbnail_url: r.image_url,
            caption_preview: r.caption ? r.caption.slice(0, 100) + (r.caption.length > 100 ? '…' : '') : null,
            platforms: r.platforms,
            status: r.status,
            scheduled_at: r.scheduled_at,
            review_url: `/drafts/${r.id}`,
          })),
        }
      },
    }),

    // ── 18. queue_upload_draft ──────────────────────────────────────────────
    queue_upload_draft: tool({
      description: 'Schedule a `drafts` row → posts row + publish queue. Carousel-aware. Use list_upload_drafts for draft_id.',
      inputSchema: z.object({
        draft_id: z.string().uuid(),
        scheduled_at: z.string().describe('ISO 8601 datetime'),
      }),
      execute: async ({ draft_id, scheduled_at }) => {
        const { data: draftData, error: fetchErr } = await supabase
          .from('drafts').select('*').eq('id', draft_id).eq('user_id', userId).single()
        if (fetchErr || !draftData) return { error: fetchErr?.message ?? 'Draft not found' }
        const draft = draftData as {
          image_url: string
          edited_image_url: string | null
          caption: string
          hashtags: string[]
          platforms: string[]
          carousel: boolean
          image_urls: string[]
          edited_image_urls: string[]
        }

        const isCarousel = draft.carousel && draft.image_urls?.length >= 2
        const mediaUrls = isCarousel
          ? (draft.edited_image_urls?.length === draft.image_urls.length ? draft.edited_image_urls : draft.image_urls)
          : [(draft.edited_image_url ?? draft.image_url)]

        const ig = draft.platforms?.includes('instagram')
        const fb = draft.platforms?.includes('facebook')
        const platform = ig && fb ? 'both' : fb ? 'facebook' : 'instagram'

        const captionWithTags = draft.hashtags?.length
          ? `${draft.caption}\n\n${draft.hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ')}`
          : draft.caption

        const { data: postData, error: insertErr } = await supabase
          .from('posts').insert({
            status: 'queued',
            user_id: userId,
            platform,
            content_type: isCarousel ? 'carousel' : 'post',
            caption: captionWithTags,
            media_urls: mediaUrls,
            thumbnail_url: mediaUrls[0],
            scheduled_at,
          }).select('id').single()
        if (insertErr || !postData) return { error: insertErr?.message ?? 'Failed to create post' }

        await supabase
          .from('drafts')
          .update({ status: 'queued', scheduled_at, archived_at: new Date().toISOString() })
          .eq('id', draft_id)
          .eq('user_id', userId)

        return {
          ok: true,
          post_id: (postData as { id: string }).id,
          scheduled_at,
          message: `Queued for ${scheduled_at}. The scheduler will publish it automatically.`,
        }
      },
    }),

    // ── 19. publish_upload_draft_now ────────────────────────────────────────
    publish_upload_draft_now: tool({
      description: 'Publish a `drafts` row to Meta NOW. Carousel-aware. CONFIRM with user first — goes live. Idempotent: refuses to re-publish an already-published or archived draft.',
      inputSchema: z.object({
        draft_id: z.string().uuid(),
      }),
      execute: async ({ draft_id }) => {
        const { data: draftData, error: fetchErr } = await supabase
          .from('drafts').select('*').eq('id', draft_id).eq('user_id', userId).single()
        if (fetchErr || !draftData) return { error: fetchErr?.message ?? 'Draft not found' }
        const draft = draftData as {
          image_url: string
          edited_image_url: string | null
          caption: string
          hashtags: string[]
          platforms: string[]
          carousel: boolean
          image_urls: string[]
          edited_image_urls: string[]
          status: string
          archived_at: string | null
        }

        // Idempotency: refuse double-publish. If the draft was already
        // published (or queued/archived from a prior publish attempt), bail
        // out instead of creating another posts row + another live IG post.
        if (draft.status === 'published' || draft.status === 'queued' || draft.archived_at) {
          return {
            error: 'Draft has already been published or queued. Refusing to publish again to avoid duplicate posts on Instagram.',
            draft_id,
            current_status: draft.status,
            archived_at: draft.archived_at,
          }
        }

        const isCarousel = draft.carousel && draft.image_urls?.length >= 2
        const mediaUrls = isCarousel
          ? (draft.edited_image_urls?.length === draft.image_urls.length ? draft.edited_image_urls : draft.image_urls)
          : [(draft.edited_image_url ?? draft.image_url)]

        const ig = draft.platforms?.includes('instagram')
        const fb = draft.platforms?.includes('facebook')
        const platform = ig && fb ? 'both' : fb ? 'facebook' : 'instagram'

        const captionWithTags = draft.hashtags?.length
          ? `${draft.caption}\n\n${draft.hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ')}`
          : draft.caption

        const { data: postData, error: insertErr } = await supabase
          .from('posts').insert({
            status: 'queued',
            user_id: userId,
            platform,
            content_type: isCarousel ? 'carousel' : 'post',
            caption: captionWithTags,
            media_urls: mediaUrls,
            thumbnail_url: mediaUrls[0],
            scheduled_at: new Date().toISOString(),
          }).select('id').single()
        if (insertErr || !postData) return { error: insertErr?.message ?? 'Failed to create post' }

        const newPostId = (postData as { id: string }).id

        await supabase
          .from('drafts')
          .update({ status: 'published', archived_at: new Date().toISOString() })
          .eq('id', draft_id)
          .eq('user_id', userId)

        try {
          const credentials = {
            igUserId: config.metaIgUserId,
            accessToken: config.metaAccessToken,
            fbPageId: config.metaFbPageId,
          }
          const result = await publishPostToMeta(supabase, newPostId, { allowAnyStatus: true, credentials })
          return {
            ok: true,
            post_id: newPostId,
            meta_post_ids: result.metaPostIds,
            review_url: `/drafts/${newPostId}`,
          }
        } catch (err) {
          return { error: (err as Error).message, post_id: newPostId }
        }
      },
    }),

    // ── 20. archive_upload_draft ────────────────────────────────────────────
    archive_upload_draft: tool({
      description: 'Soft-delete a `drafts` row (archived_at=now). 30-day window before hard delete.',
      inputSchema: z.object({
        draft_id: z.string().uuid(),
      }),
      execute: async ({ draft_id }) => {
        const { error } = await supabase
          .from('drafts')
          .update({ archived_at: new Date().toISOString() })
          .eq('id', draft_id)
          .eq('user_id', userId)
        if (error) return { error: error.message }
        return { ok: true, message: 'Draft archived. It will be hard-deleted after 30 days unless restored.' }
      },
    }),
  } as const
}
