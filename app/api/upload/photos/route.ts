import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import fs from 'fs'
import path from 'path'

export interface BreweryPhoto {
  name: string
  url: string
  source: 'supabase' | 'local'
  createdAt?: string
}

export async function GET() {
  const photos: BreweryPhoto[] = []

  // Primary: Supabase Storage `brewery-photos` bucket
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase.storage.from('brewery-photos').list('', {
      limit: 100,
      sortBy: { column: 'created_at', order: 'desc' },
    })

    if (!error && data && data.length > 0) {
      for (const file of data) {
        if (!file.name.match(/\.(jpg|jpeg|png|webp|gif)$/i)) continue
        const { data: urlData } = supabase.storage
          .from('brewery-photos')
          .getPublicUrl(file.name)
        photos.push({
          name: file.name,
          url: urlData.publicUrl,
          source: 'supabase',
          createdAt: file.created_at ?? undefined,
        })
      }
    }
  } catch (err) {
    console.warn('[upload/photos] Supabase Storage unavailable, trying local fallback:', err)
  }

  // Fallback: local public/brewery-photos/
  if (photos.length === 0) {
    const localDir =
      process.env.BREWERY_PHOTOS_DIR ??
      path.join(process.cwd(), 'public', 'brewery-photos')
    if (fs.existsSync(localDir)) {
      const files = fs.readdirSync(localDir)
      for (const file of files) {
        if (!file.match(/\.(jpg|jpeg|png|webp|gif)$/i)) continue
        photos.push({
          name: file,
          url: `/brewery-photos/${file}`,
          source: 'local',
        })
      }
    }
  }

  return NextResponse.json({ photos })
}
