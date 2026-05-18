'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts'
import type { AnalyticsSummary, PostWithAnalytics } from '@/lib/analytics'

type RangeOption = 7 | 30 | 90

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeOption>(30)
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const loadSummary = useCallback(async (days: RangeOption) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/analytics?days=${days}`, { cache: 'no-store' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as AnalyticsSummary
      setSummary(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadSummary(range) }, [range, loadSummary])

  const handleRefresh = useCallback(
    async (force: boolean) => {
      setRefreshing(true)
      setStatus(null)
      setError(null)
      try {
        const res = await fetch('/api/analytics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: range, force }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
        if ((data as { skipped?: boolean }).skipped) {
          setStatus(`Skipped — last refresh was ${formatRelative((data as { last_captured_at: string | null }).last_captured_at)}. Click again to force.`)
        } else {
          const d = data as { posts_captured: number; failed: number; summary: AnalyticsSummary }
          setStatus(
            d.failed > 0
              ? `Captured ${d.posts_captured} posts (${d.failed} insights calls failed)`
              : `Captured ${d.posts_captured} posts`,
          )
          setSummary(d.summary)
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setRefreshing(false)
        setTimeout(() => setStatus(null), 5000)
      }
    },
    [range],
  )

  const lastForceClick = useMemo(() => ({ time: 0 }), [])
  const onRefreshClick = () => {
    // Double-click within 5s forces a refresh past the 6h cooldown
    const now = Date.now()
    const force = now - lastForceClick.time < 5000
    lastForceClick.time = now
    void handleRefresh(force)
  }

  return (
    <div className="min-h-screen flex flex-col bg-ink text-cream">
      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-10">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-cream">Analytics</h1>
            <p className="text-ash text-sm mt-1">
              Performance of posts published in the last {range} days.
              {summary?.last_captured_at && (
                <span className="text-smoke ml-2">
                  Refreshed {formatRelative(summary.last_captured_at)}
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-full hairline bg-onyx p-0.5">
              {([7, 30, 90] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setRange(d)}
                  className={`px-3 py-1 rounded-full text-xs transition-colors ${
                    range === d ? 'bg-cream text-ink' : 'text-ash hover:text-cream'
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onRefreshClick}
              disabled={refreshing}
              title="Pull latest insights from Meta (6h cooldown — double-click to force)"
              className="px-4 py-1.5 rounded-lg bg-cream hover:bg-bone disabled:opacity-50 text-ink text-sm font-medium transition-colors"
            >
              {refreshing ? 'Refreshing…' : 'Refresh from Meta'}
            </button>
          </div>
        </div>

        {status && (
          <div className="mb-4 rounded-xl border border-white/[0.08] bg-onyx px-4 py-2.5 text-sm text-cream">
            {status}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-xl border border-red-900/50 bg-red-950/40 px-4 py-2.5 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Loading state */}
        {loading && !summary && (
          <div className="flex items-center gap-2 text-ash text-sm">
            <span className="animate-spin">⟳</span> Loading analytics…
          </div>
        )}

        {/* Empty state */}
        {!loading && summary && summary.posts_count === 0 && (
          <div className="rounded-2xl border border-white/[0.06] bg-obsidian px-6 py-12 text-center">
            <p className="text-cream font-medium">No published posts in this window.</p>
            <p className="text-ash text-sm mt-1">
              Publish a post via /upload or the chat, then come back and click <strong>Refresh from Meta</strong>.
            </p>
          </div>
        )}

        {/* Dashboard */}
        {summary && summary.posts_count > 0 && (
          <>
            <KPITiles summary={summary} />
            <ReachChart data={summary.by_day} />
            <PostsTable posts={summary.posts} topPostId={summary.top_post_id} />
          </>
        )}
      </main>
    </div>
  )
}

// ─── Sub-components ────────────────────────────────────────────────────────

function KPITiles({ summary }: { summary: AnalyticsSummary }) {
  const tiles = [
    { label: 'Posts published', value: formatNumber(summary.posts_count) },
    { label: 'Total reach', value: formatNumber(summary.total_reach) },
    { label: 'Engagement rate', value: `${summary.avg_engagement_rate.toFixed(1)}%` },
    { label: 'Total engagements', value: formatNumber(summary.total_engagements) },
  ]
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-2xl border border-white/[0.06] bg-obsidian px-5 py-4">
          <p className="text-xs uppercase tracking-wider text-ash">{t.label}</p>
          <p className="mt-1 text-2xl font-semibold text-cream tabular-nums">{t.value}</p>
        </div>
      ))}
    </div>
  )
}

function ReachChart({ data }: { data: AnalyticsSummary['by_day'] }) {
  if (data.length === 0) return null
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-obsidian p-5 mb-8">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-bone uppercase tracking-wider">Reach & engagements by publish day</h2>
        <p className="text-xs text-smoke">latest snapshot per post, grouped by publication date</p>
      </div>
      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
            <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
            <XAxis dataKey="date" stroke="#94a3b8" tick={{ fontSize: 11 }} />
            <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{ backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#e2e8f0' }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
            <Line type="monotone" dataKey="reach" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="engagements" stroke="#34d399" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function PostsTable({ posts, topPostId }: { posts: PostWithAnalytics[]; topPostId: string | null }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-obsidian overflow-hidden mb-8">
      <div className="flex items-baseline justify-between px-5 py-4 border-b border-white/[0.06]">
        <h2 className="text-sm font-semibold text-bone uppercase tracking-wider">Published posts</h2>
        <span className="text-xs text-smoke">{posts.length} post{posts.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-ash border-b border-white/[0.06]">
              <th className="text-left font-medium px-5 py-2.5">Post</th>
              <th className="text-left font-medium px-3 py-2.5">Published</th>
              <th className="text-right font-medium px-3 py-2.5">Reach</th>
              <th className="text-right font-medium px-3 py-2.5">Likes</th>
              <th className="text-right font-medium px-3 py-2.5">Comments</th>
              <th className="text-right font-medium px-3 py-2.5">Shares</th>
              <th className="text-right font-medium px-3 py-2.5">Saves</th>
              <th className="text-right font-medium pr-5 pl-3 py-2.5">Engagement</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => {
              const thumb = p.thumbnail_url ?? p.media_urls?.[0] ?? null
              const captionPreview = (p.caption ?? '').replace(/\s+/g, ' ').slice(0, 70)
              const a = p.analytics
              const eng = a ? a.likes + a.comments + a.shares + a.saves : 0
              const rate = a && a.reach > 0 ? (eng / a.reach) * 100 : 0
              return (
                <tr key={p.id} className="border-b border-white/[0.04] last:border-0 hover:bg-onyx/40 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumb} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-slate flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-cream truncate max-w-[16rem]">{captionPreview || '(no caption)'}</p>
                        <p className="text-xs text-smoke capitalize">
                          {p.content_type} · {p.platform}
                          {p.id === topPostId && <span className="ml-2 text-amber-400">★ top</span>}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-ash text-xs whitespace-nowrap">
                    {new Date(p.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="px-3 py-3 text-right text-cream tabular-nums">{a ? formatNumber(a.reach) : '—'}</td>
                  <td className="px-3 py-3 text-right text-cream tabular-nums">{a ? formatNumber(a.likes) : '—'}</td>
                  <td className="px-3 py-3 text-right text-cream tabular-nums">{a ? formatNumber(a.comments) : '—'}</td>
                  <td className="px-3 py-3 text-right text-cream tabular-nums">{a ? formatNumber(a.shares) : '—'}</td>
                  <td className="px-3 py-3 text-right text-cream tabular-nums">{a ? formatNumber(a.saves) : '—'}</td>
                  <td className="pr-5 pl-3 py-3 text-right text-cream tabular-nums">
                    {a ? `${rate.toFixed(1)}%` : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
