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
import { google } from '@ai-sdk/google'
import { groq } from '@ai-sdk/groq'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase'
import type { Brewery } from '@/types/database'
import ffmpegPath from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

// ─── Gemini → Groq fallback on 429 ──────────────────────────────────────────

const groqFallback = groq('llama-3.3-70b-versatile')

function is429(error: unknown): boolean {
  const e = error as { statusCode?: number; status?: number; message?: string }
  return (
    e?.statusCode === 429 ||
    e?.status === 429 ||
    (typeof e?.message === 'string' && e.message.includes('429'))
  )
}

const geminiGroqFallbackMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  wrapStream: async ({ doStream, params }) => {
    try {
      return await doStream()
    } catch (err) {
      if (is429(err)) {
        console.log('[BrewCast] Gemini 429 — retrying with Groq fallback')
        return await groqFallback.doStream(params)
      }
      throw err
    }
  },
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const body = (await req.json()) as { messages: UIMessage[] }

  const supabase = createAdminClient()
  const { data: brewery } = await supabase
    .from('brewery')
    .select('*')
    .single() as { data: Brewery | null }

  const breweryName = brewery?.name ?? 'your brewery'
  const igHandle = brewery?.ig_handle ?? ''
  const tone = brewery?.tone_of_voice ?? 'friendly and knowledgeable about craft beer'

  const systemPrompt = [
    `You are BrewCast, a professional social media manager for ${breweryName}.`,
    `Your tone is: ${tone}.`,
    'You help the brewery owner create and publish content for Instagram and Facebook.',
    'You ask one question at a time. You never overwhelm the user with multiple questions.',
    'You always confirm before publishing anything.',
    'You have access to the following tools — use them to get things done.',
    'After saving a draft, always share the review link: /drafts/[id]',
  ].join('\n')

  const modelMessages = await convertToModelMessages(body.messages)

  const model = wrapLanguageModel({
    model: google('gemini-2.5-flash'),
    middleware: geminiGroqFallbackMiddleware,
  })

  const result = streamText({
    model,
    system: systemPrompt,
    messages: modelMessages,
    stopWhen: stepCountIs(10),
    tools: buildTools({ supabase, brewery, breweryName, igHandle, tone }),
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

// Calls a Hugging Face Inference API model and retries if it's loading (503)
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
}) {
  const { supabase } = ctx

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

        const res = await fetch('https://api.pixazo.ai/v1/text-to-image', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: `${prompt}, ${style}`,
            width,
            height,
            model: 'flux-schnell',
            num_images: 1,
          }),
        })
        if (!res.ok) return { error: `Pixazo error ${res.status}: ${await res.text()}` }

        const json = await res.json() as {
          images?: Array<{ url?: string; b64_json?: string }>
          data?: Array<{ url?: string; b64_json?: string }>
          url?: string
        }

        const item = json.images?.[0] ?? json.data?.[0]
        let imageBuffer: Buffer | undefined

        if (item?.b64_json) {
          imageBuffer = Buffer.from(item.b64_json, 'base64')
        } else {
          const imageUrl = item?.url ?? json.url
          if (!imageUrl) return { error: 'Pixazo returned no image data' }
          imageBuffer = await fetchBuffer(imageUrl)
        }

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
          model: google('gemini-2.5-flash'),
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
          // MusicGen Small: ~50 tokens/s at 32kHz. Hard cap at 1500 tokens (~30s).
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

          // 6. Caption overlay — dark gradient bar at bottom 35% + white text
          const captionPath = path.join(tmpDir, 'captioned.mp4')
          // Escape single quotes and colons for the drawtext filter
          const escaped = caption_overlay
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "’")
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

          // 7. Mix audio: voiceover (full vol) + music (20%)
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

    // ── 9. publish_post ─────────────────────────────────────────────────────
    publish_post: tool({
      description:
        'Publish an approved draft to Instagram and/or Facebook via the Meta Graph API. ' +
        'Always confirm with the user before calling this tool.',
      inputSchema: z.object({
        post_id: z.string().uuid().describe('The draft post ID from the Supabase database'),
      }),
      execute: async ({ post_id }) => {
        const igUserId = process.env.META_IG_USER_ID
        const accessToken = process.env.META_ACCESS_TOKEN
        if (!igUserId || !accessToken) return { error: 'Meta credentials not configured' }

        const { data: post, error } = await supabase
          .from('posts')
          .select('*')
          .eq('id', post_id)
          .single()

        if (error || !post) return { error: error?.message ?? 'Post not found' }

        const GRAPH_BASE = 'https://graph.facebook.com/v19.0'

        async function graphPost(
          endpoint: string,
          params: Record<string, string>,
        ): Promise<Record<string, unknown>> {
          const body = new URLSearchParams({ ...params, access_token: accessToken! })
          const res = await fetch(`${GRAPH_BASE}${endpoint}`, { method: 'POST', body })
          const json = await res.json()
          if (!res.ok) throw new Error(`Meta API: ${JSON.stringify(json)}`)
          return json as Record<string, unknown>
        }

        // Poll until the IG media container finishes transcoding
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

          // ── Instagram ──────────────────────────────────────────────────
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

          // ── Facebook (optional — only if META_FB_PAGE_ID is set) ───────
          const fbPageId = process.env.META_FB_PAGE_ID
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
          model: google('gemini-2.5-flash'),
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
        const igUserId = process.env.META_IG_USER_ID
        const accessToken = process.env.META_ACCESS_TOKEN
        if (!igUserId || !accessToken) return { error: 'Meta credentials not configured' }

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

            // Find the matching post in our DB
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
  } as const
}
