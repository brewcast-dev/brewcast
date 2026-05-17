import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'

export interface DraftInsert {
  brewery_id?: string
  image_url: string
  edited_image_url?: string
  filter_applied: string
  caption: string
  hashtags: string[]
  platforms: ('instagram' | 'facebook')[]
  scheduled_at?: string | null
  carousel?: boolean
  image_urls?: string[]
  edited_image_urls?: string[]
}

export async function POST(req: Request) {
  const sessionClient = createSessionClient()
  const { data: { user } } = await sessionClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { drafts: DraftInsert[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { drafts } = body
  if (!Array.isArray(drafts) || drafts.length === 0) {
    return NextResponse.json({ error: 'drafts array is required and must not be empty' }, { status: 400 })
  }

  const rows = drafts.map((d) => ({
    brewery_id: d.brewery_id ?? 'district6',
    user_id: user.id,
    image_url: d.image_url,
    edited_image_url: d.edited_image_url ?? null,
    filter_applied: d.filter_applied,
    caption: d.caption,
    hashtags: d.hashtags,
    platforms: d.platforms,
    status: 'draft',
    scheduled_at: d.scheduled_at ?? null,
    carousel: d.carousel ?? false,
    image_urls: d.image_urls ?? [],
    edited_image_urls: d.edited_image_urls ?? [],
  }))

  const supabase = createAdminClient()
  const { data, error } = await supabase.from('drafts').insert(rows).select('id')

  if (error) {
    console.error('[drafts/bulk-save] Supabase error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const ids = (data ?? []).map((r: { id: string }) => r.id)
  revalidatePath('/drafts')
  return NextResponse.json({ ids, count: ids.length })
}
