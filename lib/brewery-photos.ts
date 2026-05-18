import { createAdminClient } from './supabase'
import { analyzePhoto, type AnalyzePhotoProviders } from './ai/photo-analysis'

type SupabaseClient = ReturnType<typeof createAdminClient>

const BUCKET = 'brewery-photos'

export interface BreweryPhotoRow {
  id: string
  name: string
  url: string
  mood: string | null
  subjects: string[] | null
  suggested_filter: string | null
  score: number | null
  confidence: number | null
  description: string | null
  analyzed_at: string | null
  analysis_error: string | null
  used_in_post_ids: string[]
  published_at: string | null
  created_at: string
}

/**
 * Find files in the user's namespace (or legacy root for the demo account)
 * that don't have a brewery_photos row yet, and insert them.
 * Returns the number of new rows created.
 *
 * Lists `<userId>/` prefix in the bucket. Legacy files at the bucket root
 * already have rows from migration 009's backfill, so we don't list root
 * here (no user owns "the root namespace" any more).
 */
export async function syncBucketToRegistry(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  let bucketFiles: Array<{ name: string }> = []
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(userId, { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } })
    if (error) throw error
    bucketFiles = (data ?? [])
      .filter((f) => f.name.match(/\.(jpg|jpeg|png|webp|gif)$/i))
      .map((f) => ({ name: `${userId}/${f.name}` }))
  } catch (err) {
    console.warn('[brewery-photos] sync — bucket list failed:', (err as Error).message)
    return 0
  }

  if (bucketFiles.length === 0) return 0

  // Find existing names within this user's rows so we only insert new ones.
  // (name is globally unique but we still scope to the user for safety.)
  const { data: existing } = await supabase
    .from('brewery_photos')
    .select('name')
    .eq('user_id', userId)
    .in('name', bucketFiles.map((f) => f.name))
  const existingNames = new Set(((existing ?? []) as Array<{ name: string }>).map((r) => r.name))

  const newRows = bucketFiles
    .filter((f) => !existingNames.has(f.name))
    .map((f) => ({
      name: f.name,
      url: supabase.storage.from(BUCKET).getPublicUrl(f.name).data.publicUrl,
      user_id: userId,
    }))

  if (newRows.length === 0) return 0

  const { error } = await supabase.from('brewery_photos').insert(newRows)
  if (error) {
    console.error('[brewery-photos] sync insert failed:', error.message)
    return 0
  }
  return newRows.length
}

/**
 * Run vision analysis on up to `limit` unanalyzed rows. Conservative limit to
 * stay under Gemini's 20 req/min free-tier quota.
 */
export async function analyzeUnanalyzed(
  supabase: SupabaseClient,
  providers: AnalyzePhotoProviders,
  limit = 5,
  userId?: string,
): Promise<{ analyzed: number; failed: number }> {
  let query = supabase
    .from('brewery_photos')
    .select('id, name, url')
    .is('analyzed_at', null)
    .is('analysis_error', null)
  if (userId) query = query.eq('user_id', userId)
  const { data, error } = await query
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error) {
    console.error('[brewery-photos] analyze — fetch failed:', error.message)
    return { analyzed: 0, failed: 0 }
  }

  const rows = (data ?? []) as Array<{ id: string; name: string; url: string }>
  let analyzed = 0
  let failed = 0

  // Sequential to be gentle on rate limits; the libs do per-photo provider fallback
  for (const row of rows) {
    try {
      const a = await analyzePhoto(row.url, providers)
      await supabase
        .from('brewery_photos')
        .update({
          mood: a.mood,
          subjects: a.subjects,
          suggested_filter: a.suggestedFilter,
          score: Math.round(a.score),
          confidence: a.confidence,
          description: a.description,
          analyzed_at: new Date().toISOString(),
          analysis_error: null,
        })
        .eq('id', row.id)
      analyzed++
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500)
      console.warn(`[brewery-photos] analyze ${row.name} failed:`, msg)
      await supabase
        .from('brewery_photos')
        .update({ analysis_error: msg })
        .eq('id', row.id)
      failed++
    }
  }

  return { analyzed, failed }
}

/**
 * Mark every brewery_photos row whose URL appears in `mediaUrls` as published.
 * Hides them from the upload library and starts the 30-day archive clock.
 */
export async function markPhotosPublished(
  supabase: SupabaseClient,
  mediaUrls: string[],
  postId: string,
  userId: string,
): Promise<void> {
  if (mediaUrls.length === 0) return

  // Match by URL exactly; also match by tail filename in case URLs got rewritten
  // (e.g. through the edited-posts bucket). We do a lookup on both URL and name.
  const names = mediaUrls
    .map((u) => {
      try {
        return decodeURIComponent(new URL(u).pathname.split('/').pop() ?? '')
      } catch {
        return u.split('/').pop() ?? ''
      }
    })
    .filter(Boolean)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase.from('brewery_photos').select('id, used_in_post_ids').eq('user_id', userId)
  query = query.or(
    `url.in.(${mediaUrls.map((u) => `"${u}"`).join(',')}),name.in.(${names.map((n) => `"${n}"`).join(',')})`,
  )
  const { data, error } = await query
  if (error) {
    console.warn('[brewery-photos] markPublished lookup failed:', error.message)
    return
  }

  const rows = (data ?? []) as Array<{ id: string; used_in_post_ids: string[] }>
  if (rows.length === 0) return

  const nowIso = new Date().toISOString()
  for (const r of rows) {
    const ids = Array.from(new Set([...(r.used_in_post_ids ?? []), postId]))
    await supabase
      .from('brewery_photos')
      .update({ used_in_post_ids: ids, published_at: nowIso })
      .eq('id', r.id)
  }
}

/**
 * Delete brewery_photos rows whose published_at is older than 30 days, and
 * remove the underlying Storage objects. Returns the number deleted.
 */
export async function cleanupArchivedPhotos(
  supabase: SupabaseClient,
  userId?: string,
): Promise<number> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  let query = supabase
    .from('brewery_photos')
    .select('id, name')
    .lt('published_at', thirtyDaysAgo)
  if (userId) query = query.eq('user_id', userId)
  const { data: rows, error } = await query

  if (error) {
    console.error('[brewery-photos] cleanup fetch failed:', error.message)
    return 0
  }
  const toDelete = (rows ?? []) as Array<{ id: string; name: string }>
  if (toDelete.length === 0) return 0

  // Delete the bucket files first; ignore errors (file may already be gone)
  await supabase.storage.from(BUCKET).remove(toDelete.map((r) => r.name))

  // Then the registry rows
  const { error: delErr } = await supabase
    .from('brewery_photos')
    .delete()
    .in('id', toDelete.map((r) => r.id))

  if (delErr) {
    console.error('[brewery-photos] cleanup delete failed:', delErr.message)
    return 0
  }
  return toDelete.length
}
