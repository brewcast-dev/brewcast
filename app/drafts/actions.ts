'use server'

import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'
import { revalidatePath } from 'next/cache'
import { enqueuePublish } from '@/lib/queue'
import { publishPost as publishPostToMeta } from '@/lib/publish'

async function getCurrentUser() {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  return user
}

async function getMetaCredentials() {
  const user = await getCurrentUser()
  const rawConfig = await getUserConfig(user.id)
  const config = resolveConfig(rawConfig)
  return {
    igUserId: config.metaIgUserId,
    accessToken: config.metaAccessToken,
    fbPageId: config.metaFbPageId,
  }
}

export async function approvePost(id: string) {
  const supabase = createAdminClient()
  const { error } = await supabase.from('posts').update({ status: 'approved' }).eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
}

export async function queuePost(id: string, scheduledAt: string) {
  const supabase = createAdminClient()
  const dt = scheduledAt || new Date().toISOString()
  const { error } = await supabase
    .from('posts')
    .update({ status: 'queued', scheduled_at: dt })
    .eq('id', id)
  if (error) throw new Error(error.message)

  // Non-fatal: if SUPABASE_DB_URL is missing the Supabase fallback in the
  // process route will still pick up the post via a direct status query.
  await enqueuePublish(id, dt).catch((e: unknown) =>
    console.warn('[queue] enqueuePublish failed — falling back to Supabase query:', (e as Error).message),
  )

  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
}

/**
 * Soft-delete: sets archived_at = now(). The row is hidden from normal views
 * and will be hard-deleted by the queue cron after 30 days. Use restorePost()
 * to undo within that window or purgePost() to delete immediately.
 */
export async function archivePost(id: string) {
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('posts')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
}

export async function restorePost(id: string) {
  const supabase = createAdminClient()
  const { error } = await supabase.from('posts').update({ archived_at: null }).eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
}

/** Hard-delete — bypasses the archive. Only callable from the archive tab. */
export async function purgePost(id: string) {
  const supabase = createAdminClient()
  const { error } = await supabase.from('posts').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/drafts')
}

export async function publishPostNow(id: string) {
  const supabase = createAdminClient()
  const credentials = await getMetaCredentials()
  await publishPostToMeta(supabase, id, { allowAnyStatus: true, credentials })
  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
}

// ── Actions for /upload-sourced drafts (separate `drafts` table) ─────────────

interface UploadDraftRow {
  id: string
  image_url: string
  edited_image_url: string | null
  caption: string
  hashtags: string[]
  platforms: string[]
  status: string
  scheduled_at: string | null
  carousel: boolean
  image_urls: string[]
  edited_image_urls: string[]
}

function platformsToColumn(platforms: string[]): 'instagram' | 'facebook' | 'both' {
  const ig = platforms.includes('instagram')
  const fb = platforms.includes('facebook')
  if (ig && fb) return 'both'
  if (fb) return 'facebook'
  return 'instagram'
}

function captionWithHashtags(caption: string, hashtags: string[]): string {
  if (!hashtags?.length) return caption
  const tagLine = hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')
  return `${caption}\n\n${tagLine}`
}

export async function approveUploadDraft(id: string) {
  const supabase = createAdminClient()
  const { error } = await supabase.from('drafts').update({ status: 'approved' }).eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
}

export async function queueUploadDraft(id: string, scheduledAt: string) {
  const supabase = createAdminClient()
  const user = await getCurrentUser()

  // 1. Fetch the draft
  const { data: draftData, error: fetchErr } = await supabase
    .from('drafts')
    .select('*')
    .eq('id', id)
    .single()
  if (fetchErr || !draftData) throw new Error(fetchErr?.message ?? 'Draft not found')
  const draft = draftData as UploadDraftRow

  const dt = scheduledAt || new Date().toISOString()
  const isCarousel = draft.carousel && draft.image_urls?.length >= 2
  const mediaUrls = isCarousel
    ? (draft.edited_image_urls?.length === draft.image_urls.length
        ? draft.edited_image_urls
        : draft.image_urls)
    : [(draft.edited_image_url ?? draft.image_url)]

  // 2. Insert into posts so the existing publish pipeline can pick it up
  const { data: postData, error: insertErr } = await supabase
    .from('posts')
    .insert({
      status: 'queued',
      user_id: user.id,
      platform: platformsToColumn(draft.platforms ?? ['instagram']),
      content_type: isCarousel ? 'carousel' : 'post',
      caption: captionWithHashtags(draft.caption, draft.hashtags ?? []),
      media_urls: mediaUrls,
      thumbnail_url: mediaUrls[0],
      scheduled_at: dt,
    })
    .select('id')
    .single()
  if (insertErr || !postData) throw new Error(insertErr?.message ?? 'Failed to create post')

  const newPostId = (postData as { id: string }).id

  // 3. Archive the original draft row so it disappears from the default views
  // but is preserved in the Archive tab for audit. The posts row is now the
  // source of truth.
  await supabase
    .from('drafts')
    .update({ status: 'queued', scheduled_at: dt, archived_at: new Date().toISOString() })
    .eq('id', id)

  // 4. Enqueue via pg-boss (non-fatal — fallback queue/process route reads from posts)
  await enqueuePublish(newPostId, dt).catch((e: unknown) =>
    console.warn('[queue] enqueuePublish failed — falling back to Supabase query:', (e as Error).message),
  )

  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
  revalidatePath(`/drafts/${newPostId}`)
}

export async function archiveUploadDraft(id: string) {
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('drafts')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
}

export async function restoreUploadDraft(id: string) {
  const supabase = createAdminClient()
  const { error } = await supabase.from('drafts').update({ archived_at: null }).eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
}

/** Hard-delete — bypasses the archive. */
export async function purgeUploadDraft(id: string) {
  const supabase = createAdminClient()
  const { error } = await supabase.from('drafts').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/drafts')
}

/**
 * Promote an /upload draft to the posts table and publish to Meta immediately.
 * Returns the new post UUID so the UI can redirect there.
 */
export async function publishUploadDraftNow(id: string): Promise<{ postId: string }> {
  const supabase = createAdminClient()
  const user = await getCurrentUser()

  // 1. Fetch the draft
  const { data: draftData, error: fetchErr } = await supabase
    .from('drafts')
    .select('*')
    .eq('id', id)
    .single()
  if (fetchErr || !draftData) throw new Error(fetchErr?.message ?? 'Draft not found')
  const draft = draftData as UploadDraftRow

  const isCarousel = draft.carousel && draft.image_urls?.length >= 2
  const mediaUrls = isCarousel
    ? (draft.edited_image_urls?.length === draft.image_urls.length
        ? draft.edited_image_urls
        : draft.image_urls)
    : [(draft.edited_image_url ?? draft.image_url)]

  // 2. Insert into posts (status='queued' so publishPost will pick it up)
  const { data: postData, error: insertErr } = await supabase
    .from('posts')
    .insert({
      status: 'queued',
      user_id: user.id,
      platform: platformsToColumn(draft.platforms ?? ['instagram']),
      content_type: isCarousel ? 'carousel' : 'post',
      caption: captionWithHashtags(draft.caption, draft.hashtags ?? []),
      media_urls: mediaUrls,
      thumbnail_url: mediaUrls[0],
      scheduled_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (insertErr || !postData) throw new Error(insertErr?.message ?? 'Failed to create post')

  const newPostId = (postData as { id: string }).id

  // 3. Archive the original draft row so the posts row is the only one visible
  // in default views; the drafts row is preserved in the Archive tab for audit.
  await supabase
    .from('drafts')
    .update({ status: 'published', archived_at: new Date().toISOString() })
    .eq('id', id)

  // 4. Publish via Meta Graph API immediately
  const credentials = await getMetaCredentials()
  await publishPostToMeta(supabase, newPostId, { allowAnyStatus: true, credentials })

  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
  revalidatePath(`/drafts/${newPostId}`)

  return { postId: newPostId }
}
