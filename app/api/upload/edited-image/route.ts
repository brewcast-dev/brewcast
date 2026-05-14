import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase'

// Accepts a base64-encoded JPEG from the browser canvas, uploads it to
// Supabase Storage `edited-posts/` bucket, and returns the public URL.
export async function POST(req: Request) {
  let body: { dataUrl: string; filename?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { dataUrl, filename } = body
  if (!dataUrl?.startsWith('data:image/')) {
    return NextResponse.json({ error: 'dataUrl must be a data: image URI' }, { status: 400 })
  }

  // Strip the data URL header
  const [header, base64] = dataUrl.split(',')
  const mimeMatch = header.match(/data:([^;]+)/)
  const mimeType = mimeMatch?.[1] ?? 'image/jpeg'
  const ext = mimeType.split('/')[1] ?? 'jpg'

  const buffer = Buffer.from(base64, 'base64')
  const storageName = filename ?? `edited_${Date.now()}.${ext}`
  const storagePath = `edited-posts/${storageName}`

  const supabase = createAdminClient()
  const { error } = await supabase.storage
    .from('edited-posts')
    .upload(storagePath, buffer, { contentType: mimeType, upsert: true })

  if (error) {
    console.error('[upload/edited-image] Storage error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { data: urlData } = supabase.storage
    .from('edited-posts')
    .getPublicUrl(storagePath)

  return NextResponse.json({ url: urlData.publicUrl })
}
