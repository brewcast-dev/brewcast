import { createAdminClient } from './supabase'
import type { Post } from '@/types/database'

const GRAPH_BASE = 'https://graph.instagram.com/v21.0'

type SupabaseClient = ReturnType<typeof createAdminClient>

export interface PublishCredentials {
  igUserId: string
  accessToken: string
  fbPageId?: string | null
}

function makeGraphPost(accessToken: string) {
  return async function graphPost(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({ ...params, access_token: accessToken })
    const res = await fetch(`${GRAPH_BASE}${endpoint}`, { method: 'POST', body })
    const json = await res.json()
    console.error(`[Meta API] ${endpoint}`, res.status, JSON.stringify(json))
    if (!res.ok) throw new Error(`Meta API: ${JSON.stringify(json)}`)
    return json as Record<string, unknown>
  }
}

async function pollContainer(containerId: string, accessToken: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    const res = await fetch(
      `${GRAPH_BASE}/${containerId}?fields=status_code&access_token=${accessToken}`,
    )
    const json = (await res.json()) as { status_code?: string }
    if (json.status_code === 'FINISHED') return
    if (json.status_code === 'ERROR') throw new Error('Media container transcoding failed')
    await new Promise((r) => setTimeout(r, 5_000))
  }
  throw new Error('Media container timed out (2 min)')
}

export interface PublishOptions {
  /**
   * If true, publish regardless of current status (used by manual "Publish Now").
   * If false (default), only publish if status is currently 'queued' — used by
   * the cron processor for atomic claim semantics.
   */
  allowAnyStatus?: boolean
  /**
   * Per-user Meta credentials. Falls back to env vars if not provided
   * (used by the background cron processor which has no user session).
   */
  credentials?: PublishCredentials
}

export async function publishPost(
  supabase: SupabaseClient,
  postId: string,
  options: PublishOptions = {},
): Promise<{ metaPostIds: string[] }> {
  const igUserId = options.credentials?.igUserId ?? process.env.META_IG_USER_ID
  const accessToken = options.credentials?.accessToken ?? process.env.META_ACCESS_TOKEN
  if (!igUserId || !accessToken) throw new Error('Meta credentials not configured')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase
    .from('posts')
    .select('*')
    .eq('id', postId)
    .is('archived_at', null) // never publish archived rows
  if (!options.allowAnyStatus) {
    // Atomic claim: only proceed if the post is still queued.
    // Prevents double-publish when pg-boss + Supabase fallback run together.
    query = query.eq('status', 'queued')
  } else {
    // Manual publish: anything that isn't already published is fair game.
    query = query.neq('status', 'published')
  }

  const { data: post } = await query.maybeSingle()
  if (!post) {
    if (options.allowAnyStatus) throw new Error('Post not found, archived, or already published')
    return { metaPostIds: [] } // already published, failed, archived, or not found
  }

  const p = post as Post
  const metaPostIds: string[] = []
  const graphPost = makeGraphPost(accessToken)

  try {
    // ── Instagram ────────────────────────────────────────────────────────────
    if (p.platform === 'instagram' || p.platform === 'both') {
      if (p.content_type === 'reel' && p.video_url) {
        const container = await graphPost(`/${igUserId}/media`, {
          media_type: 'REELS',
          video_url: p.video_url,
          caption: p.caption ?? '',
          share_to_feed: 'true',
          thumb_offset: '2000',
        })
        await pollContainer(container.id as string, accessToken)
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
          if (p.video_url) await pollContainer(container.id as string, accessToken)
          const pub = await graphPost(`/${igUserId}/media_publish`, {
            creation_id: container.id as string,
          })
          metaPostIds.push(pub.id as string)
        }
      } else if (p.content_type === 'carousel') {
        const mediaUrls = (p.media_urls as string[] | null) ?? []
        if (mediaUrls.length >= 2) {
          // Create each child container and wait for it to finish processing.
          // Without polling, Meta silently drops children that aren't FINISHED
          // when the parent carousel container is created, so only the first
          // (already-processed) image ends up in the published carousel.
          const children: string[] = []
          for (const imageUrl of mediaUrls) {
            const child = await graphPost(`/${igUserId}/media`, {
              image_url: imageUrl,
              is_carousel_item: 'true',
            })
            await pollContainer(child.id as string, accessToken)
            children.push(child.id as string)
          }
          const container = await graphPost(`/${igUserId}/media`, {
            media_type: 'CAROUSEL',
            children: children.join(','),
            caption: p.caption ?? '',
          })
          await pollContainer(container.id as string, accessToken)
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
          await new Promise((r) => setTimeout(r, 3000))
          const pub = await graphPost(`/${igUserId}/media_publish`, {
            creation_id: container.id as string,
          })
          metaPostIds.push(pub.id as string)
        }
      }
    }

    // ── Facebook ─────────────────────────────────────────────────────────────
    const fbPageId = options.credentials?.fbPageId ?? process.env.META_FB_PAGE_ID
    if (fbPageId && (p.platform === 'facebook' || p.platform === 'both')) {
      if (p.content_type === 'reel' && p.video_url) {
        const video = await graphPost(`/${fbPageId}/videos`, {
          file_url: p.video_url,
          description: p.caption ?? '',
        })
        metaPostIds.push(video.id as string)
      } else {
        // For carousels publish the first image to Facebook (carousel is IG-only)
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

    return { metaPostIds }
  } catch (err) {
    await supabase.from('posts').update({ status: 'failed' }).eq('id', postId)
    throw err
  }
}
