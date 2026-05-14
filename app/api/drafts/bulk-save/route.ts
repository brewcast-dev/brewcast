import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase'

export interface DraftInsert {
  brewery_id?: string
  image_url: string
  edited_image_url?: string
  filter_applied: string
  caption: string
  hashtags: string[]
  platforms: ('instagram' | 'facebook')[]
  scheduled_at?: string | null
}

export async function POST(req: Request) {
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
    image_url: d.image_url,
    edited_image_url: d.edited_image_url ?? null,
    filter_applied: d.filter_applied,
    caption: d.caption,
    hashtags: d.hashtags,
    platforms: d.platforms,
    status: 'draft',
    scheduled_at: d.scheduled_at ?? null,
  }))

  const supabase = createAdminClient()
  const { data, error } = await supabase.from('drafts').insert(rows).select('id')

  if (error) {
    console.error('[drafts/bulk-save] Supabase error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const ids = (data ?? []).map((r: { id: string }) => r.id)
  return NextResponse.json({ ids, count: ids.length })
}
