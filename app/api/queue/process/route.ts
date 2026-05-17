import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { getBoss, PUBLISH_QUEUE, type PublishJobData } from '@/lib/queue'
import { publishPost } from '@/lib/publish'
import { getMetaCredentialsForUser, resolveConfig } from '@/lib/get-user-config'
import { syncBucketToRegistry, analyzeUnanalyzed, cleanupArchivedPhotos } from '@/lib/brewery-photos'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'

// Allow up to 60 s — reels need polling for Meta transcoding
export const maxDuration = 60

type SupabaseClient = ReturnType<typeof createAdminClient>

async function publishWithOwnerCredentials(supabase: SupabaseClient, postId: string) {
  const { data: postRow } = await supabase
    .from('posts')
    .select('user_id')
    .eq('id', postId)
    .maybeSingle()
  const userId = (postRow as { user_id: string | null } | null)?.user_id ?? null
  const credentials = await getMetaCredentialsForUser(userId)
  await publishPost(supabase, postId, { credentials })
}

export async function GET(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = req.headers.get('authorization')
  if (!auth || auth !== `Bearer ${process.env.QUEUE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const results = {
    processed: 0,
    failed: 0,
    purged: 0,
    photos_synced: 0,
    photos_analyzed: 0,
    photos_purged: 0,
  }

  // ── 1. pg-boss path ───────────────────────────────────────────────────────
  // Fetch all jobs that have reached their startAfter time (up to 100 at once).
  try {
    const boss = await getBoss()
    const jobs = await boss.fetch<PublishJobData>(PUBLISH_QUEUE, { batchSize: 100 })
    for (const job of jobs) {
      try {
        await publishWithOwnerCredentials(supabase, job.data.post_id)
        await boss.complete(PUBLISH_QUEUE, job.id)
        results.processed++
      } catch (err) {
        await boss.fail(PUBLISH_QUEUE, job.id, { error: (err as Error).message })
        results.failed++
      }
    }
  } catch (bossErr) {
    // pg-boss unavailable (e.g. SUPABASE_DB_URL not set) — fall through
    console.error('[queue] pg-boss unavailable:', (bossErr as Error).message)
  }

  // ── 2. Supabase fallback ──────────────────────────────────────────────────
  // Catches posts queued before pg-boss was wired up, or when enqueuePublish
  // silently failed. publishPost uses an .eq('status','queued') guard so
  // posts already published by path 1 are skipped automatically.
  const { data: duePosts } = await supabase
    .from('posts')
    .select('id, user_id')
    .eq('status', 'queued')
    .is('archived_at', null) // skip archived rows
    .lte('scheduled_at', new Date().toISOString())

  for (const row of (duePosts ?? []) as Array<{ id: string; user_id: string | null }>) {
    try {
      const credentials = await getMetaCredentialsForUser(row.user_id)
      await publishPost(supabase, row.id, { credentials })
      results.processed++
    } catch (err) {
      // publishPost already set status = 'failed' in the DB
      console.error(`[queue] failed to publish post ${row.id}:`, (err as Error).message)
      results.failed++
    }
  }

  // ── 3. Auto-purge archived rows older than 30 days ────────────────────────
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  for (const table of ['posts', 'drafts'] as const) {
    const { data: purged, error: purgeErr } = await supabase
      .from(table)
      .delete()
      .lt('archived_at', thirtyDaysAgo)
      .select('id')
    if (purgeErr) {
      console.error(`[queue] purge ${table} failed:`, purgeErr.message)
    } else {
      results.purged += purged?.length ?? 0
    }
  }

  // ── 4. Brewery photos: sync bucket, analyze unanalyzed, cleanup archive ───
  try {
    results.photos_synced = await syncBucketToRegistry(supabase)
    const envConfig = resolveConfig(null)
    const providers = {
      google: createGoogleGenerativeAI({ apiKey: envConfig.googleApiKey }),
      groq: createGroq({ apiKey: envConfig.groqApiKey }),
      mistral: createMistral({ apiKey: envConfig.mistralApiKey }),
    }
    const analysisResult = await analyzeUnanalyzed(supabase, providers, 5)
    results.photos_analyzed = analysisResult.analyzed
    results.photos_purged = await cleanupArchivedPhotos(supabase)
  } catch (err) {
    console.error('[queue] brewery_photos maintenance failed:', (err as Error).message)
  }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    ...results,
  })
}
