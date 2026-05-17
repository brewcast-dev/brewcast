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
import { analyzePhotos, type PhotoAnalysis, PhotoAnalysisSchema } from '@/lib/ai/photo-analysis'
import { generatePhotoCaption, generateCarouselCaption, DEFAULT_BRAND_CONTEXT } from '@/lib/ai/captions'
import { publishPost as publishPostToMeta } from '@/lib/publish'
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
  return {
    specificationVersion: 'v3',
    wrapStream: async ({ doStream, params }) => {
      try {
        return await doStream()
      } catch (err) {
        if (!is429(err)) throw err
        console.log('[BrewCast] Gemini 429 — trying fallback chain: Groq → Mistral')
        return tryFallbacksStream(params, fallbacks)
      }
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate()
      } catch (err) {
        if (!is429(err)) throw err
        console.log('[BrewCast] Gemini 429 on generate — trying fallback chain: Groq → Mistral')
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

  const fallbackModels = [
    groqProvider('llama-3.3-70b-versatile'),
    mistralProvider('mistral-small-latest'),
  ]

  const body = (await req.json()) as { messages: UIMessage[] }

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
    '- "Generate N posts from my photos": list_brewery_photos → analyze_brewery_photos → pick top N → generate_photo_captions → save_upload_drafts (carousel: false). Share the /drafts link.',
    '- "Make a carousel from my photos" (or N>=2 selected): list_brewery_photos → analyze_brewery_photos on the chosen photos → generate_carousel_caption → save_upload_drafts (carousel: true, single entry containing all image_urls).',
    '- "Publish the carousel I just made": list_upload_drafts → publish_upload_draft_now with the matching draft id.',
    '',
    'CRITICAL ID RULES — read carefully:',
    '- `post_id` is the UUID from the `posts` table. `draft_id` is the UUID from the `drafts` table. They are different tables.',
    '- `meta_post_id` is the long numeric Instagram/Facebook ID — NEVER pass it as either post_id or draft_id.',
    '- Before publish_post, call list_posts to get the correct UUID. Before publish_upload_draft_now, call list_upload_drafts.',
    '- Never guess or reuse IDs from earlier in the conversation if the user did something in between that could have changed state.',
    '',
    'After saving drafts, share the link: /drafts (the list) or /drafts/[id] for a specific one.',
  ].join('\n')

  const modelMessages = await convertToModelMessages(body.messages)

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
      description:
        'Read the brewery profile from the database. Call this at the start of each conversation to personalise your responses.',
      inputSchema: z.object({}),
      execute: async () => {
        const { data, error } = await supabase.from('brewery').select('*').single()
        if (error) return { error: error.message }
        return data as Brewery
      },
    }),

    // ── 2. request_media_upload ─────────────────────────────────────────────
    request_media_upload: tool({
      description:
        'Get a signed Supabase Storage upload URL so the client can PUT a media file directly. ' +
        'Accepts: jpg/png/webp (images) and mp4 (video, max 60s). Returns upload URL + public CDN URL.',
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
      description:
        'Generate an image using Pixazo (FLUX Schnell, free tier). ' +
        'Use square (1080×1080) for posts, portrait (1080×1920) for reels/stories.',
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
      description:
        'Write an on-brand social media caption using the brewery tone of voice. ' +
        'Instagram: max 2200 chars, up to 30 hashtags, emojis encouraged. ' +
        'Facebook: shorter, more conversational, 1-3 hashtags only.',
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
      description:
        'Generate a voiceover audio file from a script using Kokoro-82M via Hugging Face. ' +
        'Returns a public URL to the WAV file and estimated duration.',
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
      description:
        'Generate background music using MusicGen Small via Hugging Face. ' +
        'Returns a public URL to the audio file.',
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
      description:
        'Compose a 9:16 Instagram Reel (1080×1920 MP4) from images, video clips, voiceover, ' +
        'and background music using FFmpeg. Takes ~30 seconds to render.',
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
      description:
        'Save the post as a draft in the database. Returns the draft ID and review URL. ' +
        'Always tell the user: "Your draft is ready — review it here: /drafts/[id]"',
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
      description:
        'List posts from the Supabase posts table. Use this BEFORE publish_post to get the correct UUIDs. ' +
        'Returns the local UUID id (for publish_post), status, platform, caption preview, and scheduled_at. ' +
        'Filter by status (e.g. "queued", "draft", "approved", "published") or leave empty for all.',
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
      description:
        'Manually trigger the queue processor to publish any posts that are queued and past their scheduled_at time. ' +
        'Use this when the user wants to "publish all queued posts now" — it is the safest way to bulk-publish ' +
        'because it uses the same code path as the automated scheduler.',
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
      description:
        'Publish an approved draft to Instagram and/or Facebook via the Meta Graph API. ' +
        'IMPORTANT: post_id MUST be the local Supabase UUID (e.g. f47ac10b-58cc-4372-a567-0e02b2c3d479), ' +
        'NOT the Instagram/Facebook media ID (which is a long number like 18078147443553005). ' +
        'Always call list_posts first to get the correct UUIDs. ' +
        'Always confirm with the user before calling this tool.',
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

          return {
            success: true,
            platform: post.platform,
            meta_post_id: metaPostIds[0] ?? null,
            meta_post_ids: metaPostIds,
          }
        } catch (err) {
          await supabase.from('posts').update({ status: 'failed' }).eq('id', post_id)
          return { error: (err as Error).message }
        }
      },
    }),

    // ── 10. suggest_ad_targeting ────────────────────────────────────────────
    suggest_ad_targeting: tool({
      description:
        'Generate Meta ad targeting recommendations for a post. ' +
        'Saves targeting config to the database and returns structured JSON for display.',
      inputSchema: z.object({
        post_id: z.string().uuid().describe('The post ID to generate ad targeting for'),
      }),
      execute: async ({ post_id }) => {
        const { data: post, error } = await supabase
          .from('posts')
          .select('caption, content_type')
          .eq('id', post_id)
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

        return targeting
      },
    }),

    // ── 11. fetch_analytics ─────────────────────────────────────────────────
    fetch_analytics: tool({
      description:
        'Fetch the latest engagement metrics from Meta Insights API and store them in the database. ' +
        'Returns a summary of reach, engagement rate, and the top-performing post.',
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

        const GRAPH_BASE = 'https://graph.facebook.com/v19.0'
        const since = Math.floor(Date.now() / 1000) - days * 86400

        try {
          const mediaRes = await fetch(
            `${GRAPH_BASE}/${igUserId}/media?fields=id,timestamp,media_type&limit=50&since=${since}&access_token=${accessToken}`,
          )
          if (!mediaRes.ok) throw new Error(`Media list error ${mediaRes.status}`)

          const mediaData = (await mediaRes.json()) as {
            data: Array<{ id: string; timestamp: string; media_type: string }>
          }
          const mediaItems = mediaData.data ?? []

          let totalReach = 0
          let totalEngagements = 0
          let topPost: { id: string; reach: number } | null = null

          for (const media of mediaItems) {
            const insightsRes = await fetch(
              `${GRAPH_BASE}/${media.id}/insights?metric=reach,impressions,like_count,comments_count,shares,saved,plays&access_token=${accessToken}`,
            )
            if (!insightsRes.ok) continue

            const insightsData = (await insightsRes.json()) as {
              data: Array<{ name: string; values: Array<{ value: number }> }>
            }
            const m: Record<string, number> = {}
            for (const metric of insightsData.data ?? []) {
              m[metric.name] = metric.values?.[0]?.value ?? 0
            }

            const reach = m.reach ?? 0
            const likes = m.like_count ?? 0
            const comments = m.comments_count ?? 0
            const shares = m.shares ?? 0
            const saves = m.saved ?? 0
            const plays = m.plays ?? 0
            const impressions = m.impressions ?? 0

            totalReach += reach
            totalEngagements += likes + comments + shares + saves

            const { data: dbPost } = await supabase
              .from('posts')
              .select('id')
              .eq('meta_post_id', media.id)
              .maybeSingle()

            if (dbPost) {
              await supabase.from('analytics').insert({
                post_id: (dbPost as { id: string }).id,
                captured_at: new Date().toISOString(),
                reach,
                impressions,
                likes,
                comments,
                shares,
                saves,
                plays,
              })

              if (!topPost || reach > topPost.reach) {
                topPost = { id: (dbPost as { id: string }).id, reach }
              }
            }
          }

          const avgEngagementRate =
            totalReach > 0
              ? Math.round((totalEngagements / totalReach) * 1000) / 10
              : 0

          return {
            days_fetched: days,
            posts_analyzed: mediaItems.length,
            total_reach: totalReach,
            avg_engagement_rate: avgEngagementRate,
            top_post_id: topPost?.id ?? null,
          }
        } catch (err) {
          return { error: (err as Error).message }
        }
      },
    }),

    // ── 12. list_brewery_photos ─────────────────────────────────────────────
    list_brewery_photos: tool({
      description:
        'List the brewery photo library (Supabase `brewery-photos` bucket, with local fallback). ' +
        'Returns name + public URL for each photo. Use this as the first step of any photo-based workflow.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(50).optional(),
      }),
      execute: async ({ limit }) => {
        const cap = limit ?? 50
        const photos: Array<{ name: string; url: string; source: 'supabase' | 'local' }> = []

        try {
          const { data, error } = await supabase.storage
            .from('brewery-photos')
            .list('', { limit: cap, sortBy: { column: 'created_at', order: 'desc' } })
          if (!error && data) {
            for (const file of data) {
              if (!file.name.match(/\.(jpg|jpeg|png|webp|gif)$/i)) continue
              const { data: urlData } = supabase.storage.from('brewery-photos').getPublicUrl(file.name)
              photos.push({ name: file.name, url: urlData.publicUrl, source: 'supabase' })
            }
          }
        } catch (err) {
          console.warn('[list_brewery_photos] Supabase failed, trying local:', err)
        }

        if (photos.length === 0) {
          const localDir = process.env.BREWERY_PHOTOS_DIR ?? path.join(process.cwd(), 'public', 'brewery-photos')
          if (fs.existsSync(localDir)) {
            for (const file of fs.readdirSync(localDir).slice(0, cap)) {
              if (!file.match(/\.(jpg|jpeg|png|webp|gif)$/i)) continue
              photos.push({ name: file, url: `/brewery-photos/${file}`, source: 'local' })
            }
          }
        }

        return { count: photos.length, photos }
      },
    }),

    // ── 13. analyze_brewery_photos ──────────────────────────────────────────
    analyze_brewery_photos: tool({
      description:
        'Run vision analysis on one or more brewery photos (Gemini → Groq → Mistral fallback). ' +
        'Returns mood, subjects, suggested filter, visual quality score (0-100), and a one-line description for each photo. ' +
        'Use the scores to pick the best N photos when the user asks for a count.',
      inputSchema: z.object({
        image_urls: z.array(z.string()).min(1).max(20).describe('Public photo URLs from list_brewery_photos'),
      }),
      execute: async ({ image_urls }) => {
        const results = await analyzePhotos(image_urls, aiProviders, 3)
        return {
          count: results.length,
          results: results.map((r) => 'analysis' in r
            ? { imageUrl: r.imageUrl, ...r.analysis }
            : { imageUrl: r.imageUrl, error: r.error }),
        }
      },
    }),

    // ── 14. generate_photo_captions ─────────────────────────────────────────
    generate_photo_captions: tool({
      description:
        'Generate a per-photo Instagram caption + hashtags for each PhotoAnalysis. ' +
        'Use for non-carousel posts. For a single carousel, use generate_carousel_caption instead.',
      inputSchema: z.object({
        analyses: z.array(PhotoAnalysisSchema).min(1).max(20),
        brewery_concepts: z.array(z.string()).optional().describe('Optional extra context (beer names, events, etc.)'),
      }),
      execute: async ({ analyses, brewery_concepts }) => {
        const results = await Promise.all(
          analyses.map(async (analysis: PhotoAnalysis, i: number) => {
            try {
              const cap = await generatePhotoCaption(analysis, aiProviders, brandContext, brewery_concepts)
              return { index: i, caption: cap.caption, hashtags: cap.hashtags }
            } catch (err) {
              return { index: i, error: (err as Error).message }
            }
          }),
        )
        return { count: results.length, captions: results }
      },
    }),

    // ── 15. generate_carousel_caption ───────────────────────────────────────
    generate_carousel_caption: tool({
      description:
        'Generate a single Instagram carousel caption that ties together a set of 2-10 photos. ' +
        'Frames the whole sequence as a story / swipe-through, not a per-image description.',
      inputSchema: z.object({
        analyses: z.array(PhotoAnalysisSchema).min(2).max(10),
        brewery_concepts: z.array(z.string()).optional(),
      }),
      execute: async ({ analyses, brewery_concepts }) => {
        try {
          const result = await generateCarouselCaption(analyses, aiProviders, brandContext, brewery_concepts)
          return result
        } catch (err) {
          return { error: (err as Error).message }
        }
      },
    }),

    // ── 16. save_upload_drafts ──────────────────────────────────────────────
    save_upload_drafts: tool({
      description:
        'Save one or more drafts to the `drafts` table (the table backing the /upload + /drafts pages). ' +
        'Each draft becomes one row. For a CAROUSEL, pass ONE draft with carousel=true and image_urls containing 2-10 URLs. ' +
        'For separate posts, pass MULTIPLE drafts each with carousel=false (or omitted) and a single image_url. ' +
        'Returns the new draft IDs.',
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
      description:
        'List rows from the `drafts` table (the upload-flow drafts, separate from `posts`). ' +
        'Returns draft id, carousel flag, image count, caption preview, status, scheduled_at.',
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
      description:
        'Schedule an upload-flow draft to publish at a specific time. Converts the draft into a post row, sets ' +
        'content_type to "carousel" if the draft is a carousel, and adds it to the publish queue. ' +
        'Use list_upload_drafts first to get the draft_id.',
      inputSchema: z.object({
        draft_id: z.string().uuid(),
        scheduled_at: z.string().describe('ISO 8601 datetime'),
      }),
      execute: async ({ draft_id, scheduled_at }) => {
        const { data: draftData, error: fetchErr } = await supabase
          .from('drafts').select('*').eq('id', draft_id).single()
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
      description:
        'Publish an upload-flow draft to Meta immediately (Instagram, plus Facebook if the draft has it). ' +
        'Converts the draft into a post row, handles carousel vs single image, and publishes via the Meta Graph API. ' +
        'CONFIRM with the user before calling this — it goes live on the brewery\'s real Instagram account.',
      inputSchema: z.object({
        draft_id: z.string().uuid(),
      }),
      execute: async ({ draft_id }) => {
        const { data: draftData, error: fetchErr } = await supabase
          .from('drafts').select('*').eq('id', draft_id).single()
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
            scheduled_at: new Date().toISOString(),
          }).select('id').single()
        if (insertErr || !postData) return { error: insertErr?.message ?? 'Failed to create post' }

        const newPostId = (postData as { id: string }).id

        await supabase
          .from('drafts')
          .update({ status: 'published', archived_at: new Date().toISOString() })
          .eq('id', draft_id)

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
      description:
        'Soft-delete an upload-flow draft (sets archived_at = now). Reversible via restore_upload_draft within 30 days.',
      inputSchema: z.object({
        draft_id: z.string().uuid(),
      }),
      execute: async ({ draft_id }) => {
        const { error } = await supabase
          .from('drafts')
          .update({ archived_at: new Date().toISOString() })
          .eq('id', draft_id)
        if (error) return { error: error.message }
        return { ok: true, message: 'Draft archived. It will be hard-deleted after 30 days unless restored.' }
      },
    }),
  } as const
}
