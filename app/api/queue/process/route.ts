import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { getBoss, PUBLISH_QUEUE, type PublishJobData } from '@/lib/queue'
import type { Post } from '@/types/database'

// Allow up to 60 s — reels need polling for Meta transcoding
export const maxDuration = 60

const GRAPH_BASE = 'https://graph.instagram.com/v21.0'

export async function GET(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  console.log('[debug] token starts with:', process.env.META_ACCESS_TOKEN?.slice(0, 20))
  const auth = req.headers.get('authorization')
  if (!auth || auth !== `Bearer ${process.env.QUEUE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const results = { processed: 0, failed: 0 }

  // ── 1. pg-boss path ───────────────────────────────────────────────────────
  // Fetch all jobs that have reached their startAfter time (up to 100 at once).
  try {
    const boss = await getBoss()
    const jobs = await boss.fetch<PublishJobData>(PUBLISH_QUEUE, { batchSize: 100 })
    for (const job of jobs) {
      try {
        await publishPost(supabase, job.data.post_id)
        await boss.complete(PUBLISH_QUEUE, job.id)
        results.processed++
      } catch (err) {
        await boss.fail(PUBLISH_QUEUE, job.id, { error: (err as Error).message })
        results.failed++
      }
    }
  } catch (bossErr) {
    // pg-boss unavailable (e.g. SUPABASE_DB_URL not set) — fall through
    console.error('[queue] pg-boss unavailable:', (bossErr as Error).message)
  }

  // ── 2. Supabase fallback ──────────────────────────────────────────────────
  // Catches posts that were queued before pg-boss was wired up, or when
  // enqueuePublish silently failed. publishPost uses an .eq('status','queued')
  // guard so posts already published by path 1 are skipped automatically.
  const { data: duePosts } = await supabase
    .from('posts')
    .select('id')
    .eq('status', 'queued')
    .lte('scheduled_at', new Date().toISOString())

  for (const { id } of duePosts ?? []) {
    try {
      await publishPost(supabase, id)
      results.processed++
    } catch (err) {
      // publishPost already set status = 'failed' in the DB
      console.error(`[queue] failed to publish post ${id}:`, (err as Error).message)
      results.failed++
    }
  }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    processed: results.processed,
    failed: results.failed,
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof createAdminClient>

async function graphPost(
  endpoint: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ...params, access_token: process.env.META_ACCESS_TOKEN! })
  const res = await fetch(`${GRAPH_BASE}${endpoint}`, { method: 'POST', body })
  const json = await res.json()
  console.error(`[Meta API] ${endpoint}`, res.status, JSON.stringify(json))
  if (!res.ok) throw new Error(`Meta API: ${JSON.stringify(json)}`)
  return json as Record<string, unknown>
}

async function pollContainer(containerId: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    const res = await fetch(
      `${GRAPH_BASE}/${containerId}?fields=status_code&access_token=${process.env.META_ACCESS_TOKEN}`,
    )
    const json = (await res.json()) as { status_code?: string }
    if (json.status_code === 'FINISHED') return
    if (json.status_code === 'ERROR') throw new Error('Media container transcoding failed')
    await new Promise(r => setTimeout(r, 5_000))
  }
  throw new Error('Media container timed out (2 min)')
}

async function publishPost(supabase: SupabaseClient, postId: string): Promise<void> {
  const igUserId = process.env.META_IG_USER_ID
  const accessToken = process.env.META_ACCESS_TOKEN
  if (!igUserId || !accessToken) throw new Error('Meta credentials not configured')

  // Atomic claim: only proceed if the post is still queued.
  // This prevents double-publishing when both the pg-boss path and the
  // Supabase fallback run in the same cycle.
  const { data: post } = await supabase
    .from('posts')
    .select('*')
    .eq('id', postId)
    .eq('status', 'queued')
    .maybeSingle()

  if (!post) return // already published, failed, or not found

  const p = post as Post
  const metaPostIds: string[] = []

  try {
    // ── Instagram ───────────────────────────────────────────────────────────
    if (p.platform === 'instagram' || p.platform === 'both') {
      if (p.content_type === 'reel' && p.video_url) {
        const container = await graphPost(`/${igUserId}/media`, {
          media_type: 'REELS',
          video_url: p.video_url,
          caption: p.caption ?? '',
          share_to_feed: 'true',
          thumb_offset: '2000',
        })
        await pollContainer(container.id as string)
        const pub = await graphPost(`/${igUserId}/media_publish`, {
          creation_id: container.id as string,
        })
        metaPostIds.push(pub.id as string)
      } else if (p.content_type === 'story') {
        const mediaUrl = p.video_url ?? (p.media_urls as string[] | null)?.[0]
        if (mediaUrl) {
          const container = await graphPost(`/${igUserId}/media`, {
            media_type: 'STORIES',
            ...(p.video_url ? { video_url: p.video_url } : { image_url: mediaUrl }),
          })
          if (p.video_url) await pollContainer(container.id as string)
          const pub = await graphPost(`/${igUserId}/media_publish`, {
            creation_id: container.id as string,
          })
          metaPostIds.push(pub.id as string)
        }
      } else {
        const imageUrl = (p.media_urls as string[] | null)?.[0] ?? p.thumbnail_url ?? ''
        if (imageUrl) {
          const container = await graphPost(`/${igUserId}/media`, {
            image_url: imageUrl,
            caption: p.caption ?? '',
          })
          await new Promise(r => setTimeout(r, 3000))
          const pub = await graphPost(`/${igUserId}/media_publish`, {
            creation_id: container.id as string,
          })
          metaPostIds.push(pub.id as string)
        }
      }
    }

    // ── Facebook (only if META_FB_PAGE_ID is set) ───────────────────────────
    const fbPageId = process.env.META_FB_PAGE_ID
    if (fbPageId && (p.platform === 'facebook' || p.platform === 'both')) {
      if (p.content_type === 'reel' && p.video_url) {
        const video = await graphPost(`/${fbPageId}/videos`, {
          file_url: p.video_url,
          description: p.caption ?? '',
        })
        metaPostIds.push(video.id as string)
      } else {
        const imageUrl = (p.media_urls as string[] | null)?.[0] ?? ''
        if (imageUrl) {
          const photo = await graphPost(`/${fbPageId}/photos`, {
            url: imageUrl,
            message: p.caption ?? '',
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
      .eq('id', postId)
  } catch (err) {
    await supabase.from('posts').update({ status: 'failed' }).eq('id', postId)
    throw err
  }
}
