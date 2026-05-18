import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'

// Accepts new brewery photos from three paths:
//   1. multipart/form-data with one or more "files" — local device uploads
//   2. JSON { remoteUrl, filename, authHeader? } — Google Drive / Dropbox imports
// All paths land in the brewery-photos Supabase Storage bucket so the existing
// registry sync + scoring pipeline picks them up on the next /upload load.

const BUCKET = 'brewery-photos'
const MAX_BYTES = 25 * 1024 * 1024 // 25MB
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
])

// Hosts we trust to fetch bytes from when the client passes a remoteUrl.
// Keeps this endpoint from being abused as a generic URL fetcher / SSRF vector.
const ALLOWED_REMOTE_HOSTS = [
  'www.googleapis.com',
  'googleapis.com',
  'drive.google.com',
  'lh3.googleusercontent.com',
  'dl.dropboxusercontent.com',
  'www.dropbox.com',
  'dropbox.com',
  'content.dropboxapi.com',
]

function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? 'photo'
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  const dot = cleaned.lastIndexOf('.')
  const ext = dot >= 0 ? cleaned.slice(dot).toLowerCase() : '.jpg'
  const stem = dot >= 0 ? cleaned.slice(0, dot) : cleaned
  return `${stem}_${Date.now()}${ext}`
}

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/png': return '.png'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return '.jpg'
  }
}

async function uploadBuffer(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  buffer: Buffer,
  filename: string,
  contentType: string,
): Promise<{ url: string; name: string }> {
  // Files are namespaced by user_id so two users uploading the same filename
  // don't collide, and storage can be browsed per-user.
  const fullPath = `${userId}/${filename}`
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(fullPath, buffer, { contentType, upsert: false })
  if (error) throw new Error(error.message)
  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(fullPath)

  // Insert a registry row so the photo shows up in /upload immediately rather
  // than waiting for the next background sync. Vision analysis still runs in
  // the background — the row starts with score=null and analyzed=false.
  const { error: insertErr } = await supabase
    .from('brewery_photos')
    .insert({ name: fullPath, url: urlData.publicUrl, user_id: userId })
  if (insertErr && !insertErr.message.includes('duplicate')) {
    console.warn('[upload/photo] registry insert failed:', insertErr.message)
  }

  return { url: urlData.publicUrl, name: fullPath }
}

export async function POST(req: Request) {
  // Auth check — only signed-in users can drop into the bucket
  const session = createSessionClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const contentType = req.headers.get('content-type') ?? ''

  // ─── Path 1: multipart upload from the browser file picker / drop zone ────
  if (contentType.includes('multipart/form-data')) {
    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
    }

    const files = form.getAll('files').filter((f): f is File => f instanceof File)
    if (files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }

    const uploaded: Array<{ url: string; name: string }> = []
    const failed: Array<{ name: string; error: string }> = []

    for (const file of files) {
      try {
        if (!ALLOWED_MIME.has(file.type)) {
          failed.push({ name: file.name, error: `Unsupported type: ${file.type}` })
          continue
        }
        if (file.size > MAX_BYTES) {
          failed.push({ name: file.name, error: `Too large (max ${MAX_BYTES / 1024 / 1024}MB)` })
          continue
        }
        const buf = Buffer.from(await file.arrayBuffer())
        const finalName = sanitizeFilename(file.name)
        const result = await uploadBuffer(supabase, user.id, buf, finalName, file.type)
        uploaded.push(result)
      } catch (err) {
        failed.push({ name: file.name, error: (err as Error).message })
      }
    }

    return NextResponse.json({ uploaded, failed })
  }

  // ─── Path 2: JSON body — fetch a remote URL (Drive / Dropbox) ──────────────
  let body: { remoteUrl?: string; filename?: string; authHeader?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { remoteUrl, filename, authHeader } = body
  if (!remoteUrl || typeof remoteUrl !== 'string') {
    return NextResponse.json({ error: 'remoteUrl required' }, { status: 400 })
  }

  let parsed: URL
  try {
    parsed = new URL(remoteUrl)
  } catch {
    return NextResponse.json({ error: 'Invalid remoteUrl' }, { status: 400 })
  }
  if (parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'remoteUrl must be https' }, { status: 400 })
  }
  if (!ALLOWED_REMOTE_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
    return NextResponse.json({ error: `Host not allowed: ${parsed.hostname}` }, { status: 400 })
  }

  // Fetch the bytes
  let res: Response
  try {
    res = await fetch(remoteUrl, {
      headers: authHeader ? { Authorization: authHeader } : undefined,
    })
  } catch (err) {
    return NextResponse.json({ error: `Fetch failed: ${(err as Error).message}` }, { status: 502 })
  }
  if (!res.ok) {
    return NextResponse.json({ error: `Remote returned ${res.status}` }, { status: 502 })
  }

  const remoteMime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg'
  if (!ALLOWED_MIME.has(remoteMime)) {
    return NextResponse.json({ error: `Unsupported remote type: ${remoteMime}` }, { status: 400 })
  }

  const lenHeader = res.headers.get('content-length')
  if (lenHeader && Number(lenHeader) > MAX_BYTES) {
    return NextResponse.json({ error: `Remote file too large` }, { status: 400 })
  }

  const ab = await res.arrayBuffer()
  if (ab.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: `Remote file too large` }, { status: 400 })
  }

  const baseName = filename ?? `import${extFromMime(remoteMime)}`
  const finalName = sanitizeFilename(baseName)
  try {
    const result = await uploadBuffer(supabase, user.id, Buffer.from(ab), finalName, remoteMime)
    return NextResponse.json({ uploaded: [result], failed: [] })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
