import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { syncBucketToRegistry, analyzeUnanalyzed } from '@/lib/brewery-photos'
import fs from 'fs'
import path from 'path'

export interface BreweryPhoto {
  name: string
  url: string
  source: 'supabase' | 'local'
  createdAt?: string
  score?: number | null
  analyzed?: boolean
  publishedAt?: string | null
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const view = url.searchParams.get('view') === 'archive' ? 'archive' : 'available'

  const supabase = createAdminClient()
  let photos: BreweryPhoto[] = []
  let registryFailed = false

  // Try the registry first
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = supabase
      .from('brewery_photos')
      .select('name, url, score, analyzed_at, published_at, created_at')
      .order('score', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(200)
    query = view === 'archive'
      ? query.not('published_at', 'is', null)
      : query.is('published_at', null)

    const { data, error } = await query
    if (error) throw error

    const rows = (data ?? []) as Array<{
      name: string
      url: string
      score: number | null
      analyzed_at: string | null
      published_at: string | null
      created_at: string
    }>
    photos = rows.map((r) => ({
      name: r.name,
      url: r.url,
      source: 'supabase' as const,
      createdAt: r.created_at,
      score: r.score,
      analyzed: r.analyzed_at !== null,
      publishedAt: r.published_at,
    }))
  } catch (err) {
    registryFailed = true
    console.warn('[upload/photos] registry query failed (run migration 008?):', (err as Error).message)
  }

  // Bucket-direct fallback: if the registry is missing (migration not run) or
  // empty AND we're showing available, list the bucket directly so the page
  // isn't blank while the background sync catches up.
  if (photos.length === 0 && view === 'available') {
    try {
      const { data, error } = await supabase.storage.from('brewery-photos').list('', {
        limit: 200,
        sortBy: { column: 'created_at', order: 'desc' },
      })
      if (!error && data) {
        for (const file of data) {
          if (!file.name.match(/\.(jpg|jpeg|png|webp|gif)$/i)) continue
          const { data: urlData } = supabase.storage.from('brewery-photos').getPublicUrl(file.name)
          photos.push({
            name: file.name,
            url: urlData.publicUrl,
            source: 'supabase',
            createdAt: file.created_at ?? undefined,
            score: null,
            analyzed: false,
          })
        }
      }
    } catch (err) {
      if (!registryFailed) console.warn('[upload/photos] bucket list failed:', (err as Error).message)
    }
  }

  // Local fallback (dev) — only when both registry and bucket are empty
  if (photos.length === 0 && view === 'available') {
    const localDir = process.env.BREWERY_PHOTOS_DIR ?? path.join(process.cwd(), 'public', 'brewery-photos')
    if (fs.existsSync(localDir)) {
      for (const file of fs.readdirSync(localDir)) {
        if (!file.match(/\.(jpg|jpeg|png|webp|gif)$/i)) continue
        photos.push({
          name: file,
          url: `/brewery-photos/${file}`,
          source: 'local',
          analyzed: false,
          score: null,
        })
      }
    }
  }

  // Fire-and-forget: sync bucket → registry, then analyze a small batch.
  // Wrapped so the response isn't blocked.
  if (view === 'available') {
    void (async () => {
      try {
        const sessionClient = createSessionClient()
        const { data: { user } } = await sessionClient.auth.getUser()
        if (!user) return
        const config = resolveConfig(await getUserConfig(user.id))
        const providers = {
          google: createGoogleGenerativeAI({ apiKey: config.googleApiKey }),
          groq: createGroq({ apiKey: config.groqApiKey }),
          mistral: createMistral({ apiKey: config.mistralApiKey }),
        }
        const added = await syncBucketToRegistry(supabase)
        if (added > 0) console.log(`[upload/photos] synced ${added} new photos`)
        const { analyzed, failed } = await analyzeUnanalyzed(supabase, providers, 3)
        if (analyzed + failed > 0) {
          console.log(`[upload/photos] background analyze: ${analyzed} ok, ${failed} failed`)
        }
      } catch (err) {
        console.warn('[upload/photos] background sync failed:', (err as Error).message)
      }
    })()
  }

  return NextResponse.json({ photos })
}
