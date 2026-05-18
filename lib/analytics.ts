import { createAdminClient } from './supabase'

type SupabaseClient = ReturnType<typeof createAdminClient>

const GRAPH_BASE = 'https://graph.facebook.com/v19.0'
const REFRESH_COOLDOWN_HOURS = 6

export interface MetaCredentials {
  igUserId: string
  accessToken: string
}

export interface AnalyticsRow {
  reach: number
  impressions: number
  likes: number
  comments: number
  shares: number
  saves: number
  plays: number
  captured_at: string
}

export interface PostWithAnalytics {
  id: string
  meta_post_id: string | null
  caption: string | null
  platform: string
  content_type: string
  media_urls: string[] | null
  thumbnail_url: string | null
  published_at: string
  analytics: AnalyticsRow | null
}

export interface AnalyticsSummary {
  range_days: number
  posts_count: number
  total_reach: number
  total_impressions: number
  total_engagements: number
  avg_engagement_rate: number
  top_post_id: string | null
  by_day: Array<{ date: string; reach: number; engagements: number }>
  posts: PostWithAnalytics[]
  last_captured_at: string | null
}

interface MetaMediaItem {
  id: string
  timestamp: string
  media_type: string
}

interface MetaInsightsResponse {
  data?: Array<{ name: string; values?: Array<{ value: number }> }>
}

// ─── Meta refresh ──────────────────────────────────────────────────────────

/**
 * Pull insights from Meta Graph API for the last N days and insert one
 * analytics snapshot per matched post. Returns the number of posts captured.
 *
 * Caller should check shouldRefresh() first to avoid hammering the API.
 */
export async function refreshMetaAnalytics(
  supabase: SupabaseClient,
  creds: MetaCredentials,
  days: number,
): Promise<{ posts_captured: number; failed: number }> {
  const since = Math.floor(Date.now() / 1000) - days * 86400
  const { igUserId, accessToken } = creds

  const mediaRes = await fetch(
    `${GRAPH_BASE}/${igUserId}/media?fields=id,timestamp,media_type&limit=50&since=${since}&access_token=${accessToken}`,
  )
  if (!mediaRes.ok) throw new Error(`Meta media list error ${mediaRes.status}`)
  const mediaData = (await mediaRes.json()) as { data?: MetaMediaItem[] }
  const items = mediaData.data ?? []

  let captured = 0
  let failed = 0
  const nowIso = new Date().toISOString()

  for (const media of items) {
    try {
      const insightsRes = await fetch(
        `${GRAPH_BASE}/${media.id}/insights?metric=reach,impressions,like_count,comments_count,shares,saved,plays&access_token=${accessToken}`,
      )
      if (!insightsRes.ok) {
        failed++
        continue
      }
      const insightsData = (await insightsRes.json()) as MetaInsightsResponse
      const m: Record<string, number> = {}
      for (const metric of insightsData.data ?? []) {
        m[metric.name] = metric.values?.[0]?.value ?? 0
      }

      const { data: dbPost } = await supabase
        .from('posts')
        .select('id')
        .eq('meta_post_id', media.id)
        .maybeSingle()

      if (!dbPost) continue // Post wasn't published via BrewCast; skip.

      await supabase.from('analytics').insert({
        post_id: (dbPost as { id: string }).id,
        captured_at: nowIso,
        reach: m.reach ?? 0,
        impressions: m.impressions ?? 0,
        likes: m.like_count ?? 0,
        comments: m.comments_count ?? 0,
        shares: m.shares ?? 0,
        saves: m.saved ?? 0,
        plays: m.plays ?? 0,
      })
      captured++
    } catch (err) {
      console.warn(`[analytics] insights failed for ${media.id}:`, (err as Error).message)
      failed++
    }
  }

  return { posts_captured: captured, failed }
}

/**
 * True if the most recent analytics row is older than the cooldown window.
 * Used to avoid refetching from Meta on every page load.
 */
export async function shouldRefresh(
  supabase: SupabaseClient,
): Promise<{ stale: boolean; last_captured_at: string | null }> {
  const { data } = await supabase
    .from('analytics')
    .select('captured_at')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const last = (data as { captured_at: string } | null)?.captured_at ?? null
  if (!last) return { stale: true, last_captured_at: null }
  const ageMs = Date.now() - new Date(last).getTime()
  return { stale: ageMs > REFRESH_COOLDOWN_HOURS * 3600 * 1000, last_captured_at: last }
}

// ─── Summary aggregation ───────────────────────────────────────────────────

/**
 * Read the analytics + posts tables and produce the full dashboard payload:
 * tiles, daily time-series, per-post table. Each post is paired with its
 * MOST RECENT analytics snapshot (de-duplicated in JS).
 */
export async function getAnalyticsSummary(
  supabase: SupabaseClient,
  days: number,
): Promise<AnalyticsSummary> {
  const sinceIso = new Date(Date.now() - days * 86400 * 1000).toISOString()

  // 1. Posts published in window
  const { data: postsData } = await supabase
    .from('posts')
    .select('id, meta_post_id, caption, platform, content_type, media_urls, thumbnail_url, published_at')
    .eq('status', 'published')
    .not('published_at', 'is', null)
    .gte('published_at', sinceIso)
    .order('published_at', { ascending: false })

  const posts = (postsData ?? []) as Array<{
    id: string
    meta_post_id: string | null
    caption: string | null
    platform: string
    content_type: string
    media_urls: string[] | null
    thumbnail_url: string | null
    published_at: string
  }>

  if (posts.length === 0) {
    return {
      range_days: days,
      posts_count: 0,
      total_reach: 0,
      total_impressions: 0,
      total_engagements: 0,
      avg_engagement_rate: 0,
      top_post_id: null,
      by_day: [],
      posts: [],
      last_captured_at: null,
    }
  }

  const postIds = posts.map((p) => p.id)

  // 2. All analytics snapshots for those posts, newest first.
  // De-dup to the latest per post in JS — Postgres DISTINCT ON via supabase-js
  // is awkward and the row count here is small.
  const { data: analyticsRows } = await supabase
    .from('analytics')
    .select('post_id, captured_at, reach, impressions, likes, comments, shares, saves, plays')
    .in('post_id', postIds)
    .order('captured_at', { ascending: false })

  const rows = (analyticsRows ?? []) as Array<{
    post_id: string
    captured_at: string
    reach: number | null
    impressions: number | null
    likes: number | null
    comments: number | null
    shares: number | null
    saves: number | null
    plays: number | null
  }>

  const latestByPost = new Map<string, AnalyticsRow>()
  for (const r of rows) {
    if (latestByPost.has(r.post_id)) continue
    latestByPost.set(r.post_id, {
      reach: r.reach ?? 0,
      impressions: r.impressions ?? 0,
      likes: r.likes ?? 0,
      comments: r.comments ?? 0,
      shares: r.shares ?? 0,
      saves: r.saves ?? 0,
      plays: r.plays ?? 0,
      captured_at: r.captured_at,
    })
  }

  // 3. Build per-post rows
  const withAnalytics: PostWithAnalytics[] = posts.map((p) => ({
    ...p,
    analytics: latestByPost.get(p.id) ?? null,
  }))

  // 4. Aggregates
  let totalReach = 0
  let totalImpressions = 0
  let totalEngagements = 0
  let topPost: { id: string; reach: number } | null = null
  for (const p of withAnalytics) {
    if (!p.analytics) continue
    totalReach += p.analytics.reach
    totalImpressions += p.analytics.impressions
    totalEngagements += p.analytics.likes + p.analytics.comments + p.analytics.shares + p.analytics.saves
    if (!topPost || p.analytics.reach > topPost.reach) {
      topPost = { id: p.id, reach: p.analytics.reach }
    }
  }
  const avgEngagementRate = totalReach > 0 ? Math.round((totalEngagements / totalReach) * 1000) / 10 : 0

  // 5. Time series: reach + engagements grouped by published_at date
  const byDayMap = new Map<string, { reach: number; engagements: number }>()
  for (const p of withAnalytics) {
    if (!p.analytics) continue
    const date = p.published_at.slice(0, 10)
    const entry = byDayMap.get(date) ?? { reach: 0, engagements: 0 }
    entry.reach += p.analytics.reach
    entry.engagements +=
      p.analytics.likes + p.analytics.comments + p.analytics.shares + p.analytics.saves
    byDayMap.set(date, entry)
  }
  const by_day = Array.from(byDayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }))

  return {
    range_days: days,
    posts_count: posts.length,
    total_reach: totalReach,
    total_impressions: totalImpressions,
    total_engagements: totalEngagements,
    avg_engagement_rate: avgEngagementRate,
    top_post_id: topPost?.id ?? null,
    by_day,
    posts: withAnalytics,
    last_captured_at: rows[0]?.captured_at ?? null,
  }
}
