'use server'

import { createAdminClient } from '@/lib/supabase'
import { revalidatePath } from 'next/cache'
import { enqueuePublish } from '@/lib/queue'

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

export async function deletePost(id: string) {
  const supabase = createAdminClient()
  const { error } = await supabase.from('posts').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/drafts')
  // Navigation is handled client-side to avoid redirect-in-server-action edge cases
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

  // 1. Fetch the draft
  const { data: draftData, error: fetchErr } = await supabase
    .from('drafts')
    .select('*')
    .eq('id', id)
    .single()
  if (fetchErr || !draftData) throw new Error(fetchErr?.message ?? 'Draft not found')
  const draft = draftData as UploadDraftRow

  const dt = scheduledAt || new Date().toISOString()
  const mediaUrl = draft.edited_image_url ?? draft.image_url

  // 2. Insert into posts so the existing publish pipeline can pick it up
  const { data: postData, error: insertErr } = await supabase
    .from('posts')
    .insert({
      status: 'queued',
      platform: platformsToColumn(draft.platforms ?? ['instagram']),
      content_type: 'post',
      caption: captionWithHashtags(draft.caption, draft.hashtags ?? []),
      media_urls: [mediaUrl],
      thumbnail_url: mediaUrl,
      scheduled_at: dt,
    })
    .select('id')
    .single()
  if (insertErr || !postData) throw new Error(insertErr?.message ?? 'Failed to create post')

  const newPostId = (postData as { id: string }).id

  // 3. Mark the draft as queued (keep the row for audit; do not delete)
  await supabase.from('drafts').update({ status: 'queued', scheduled_at: dt }).eq('id', id)

  // 4. Enqueue via pg-boss (non-fatal — fallback queue/process route reads from posts)
  await enqueuePublish(newPostId, dt).catch((e: unknown) =>
    console.warn('[queue] enqueuePublish failed — falling back to Supabase query:', (e as Error).message),
  )

  revalidatePath('/drafts')
  revalidatePath(`/drafts/${id}`)
  revalidatePath(`/drafts/${newPostId}`)
}

export async function deleteUploadDraft(id: string) {
  const supabase = createAdminClient()
  const { error } = await supabase.from('drafts').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/drafts')
}
