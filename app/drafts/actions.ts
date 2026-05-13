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
