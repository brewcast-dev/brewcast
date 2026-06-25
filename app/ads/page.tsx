'use client'

import { useCallback, useEffect, useState } from 'react'
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
import type { AdsSummary, AdCampaignRow } from '@/lib/ads'

type RangeOption = 7 | 30 | 90

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function money(n: number, currency: string | null): string {
  const sym = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency ? `${currency} ` : ''
  return `${sym}${compact(n)}`
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

interface AdsResponse {
  configured: boolean
  summary?: AdsSummary
  error?: string
}

export default function AdsPage() {
  const [range, setRange] = useState<RangeOption>(30)
  const [data, setData] = useState<AdsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (days: RangeOption) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/ads?days=${days}`, { cache: 'no-store' })
      const json = (await res.json()) as AdsResponse
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setData(json)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(range) }, [range, load])

  const summary = data?.summary ?? null

  return (
    <div className="min-h-screen flex flex-col bg-ink text-cream">
      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-10">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-cream">Ads</h1>
            <p className="text-ash text-sm mt-1">
              Paid campaign performance, live from Meta — last {range} days.
              {summary?.account_name && <span className="text-smoke ml-2">{summary.account_name}</span>}
              {summary?.fetched_at && (
                <span className="text-smoke ml-2">· fetched {formatRelative(summary.fetched_at)}</span>
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
              onClick={() => void load(range)}
              disabled={loading}
              className="px-4 py-1.5 rounded-lg bg-cream hover:bg-bone disabled:opacity-50 text-ink text-sm font-medium transition-colors"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-900/50 bg-red-950/40 px-4 py-2.5 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Not configured */}
        {data && !data.configured && (
          <div className="rounded-2xl border border-white/[0.06] bg-obsidian px-6 py-12 text-center">
            <p className="text-cream font-medium">Ad tracking isn&apos;t set up yet.</p>
            <p className="text-ash text-sm mt-1 max-w-md mx-auto">
              Add your <strong>Ad Account ID</strong> and a <strong>Facebook-app token with the
              ads_read scope</strong> in{' '}
              <a href="/settings" className="text-ember underline">Settings → Ad Tracking</a>,
              then come back here.
            </p>
          </div>
        )}

        {/* Loading */}
        {loading && !summary && (
          <div className="flex items-center gap-2 text-ash text-sm">
            <span className="animate-spin">⟳</span> Loading ad performance…
          </div>
        )}

        {/* No spend yet */}
        {summary && !summary.has_spend && (
          <div className="rounded-2xl border border-white/[0.06] bg-obsidian px-6 py-12 text-center">
            <p className="text-cream font-medium">No ad spend in this window.</p>
            <p className="text-ash text-sm mt-1">
              Boost a post or run a campaign in Meta Ads Manager, then refresh — numbers appear here automatically.
            </p>
          </div>
        )}

        {/* Dashboard */}
        {summary && summary.has_spend && (
          <>
            <KPITiles summary={summary} />
            <SpendChart data={summary.by_day} currency={summary.currency} />
            <CampaignsTable campaigns={summary.campaigns} currency={summary.currency} />
          </>
        )}
      </main>
    </div>
  )
}

// ─── Sub-components ────────────────────────────────────────────────────────

function KPITiles({ summary }: { summary: AdsSummary }) {
  const t = summary.totals
  const cur = summary.currency
  // ROAS is meaningful only with conversion tracking; otherwise show cost/result.
  const roasTile = t.roas != null
    ? { label: 'ROAS', value: `${t.roas.toFixed(2)}×` }
    : { label: 'Cost / link click', value: t.link_clicks > 0 ? money(t.spend / t.link_clicks, cur) : '—' }

  const tiles = [
    { label: 'Spend', value: money(t.spend, cur) },
    { label: 'Reach', value: compact(t.reach) },
    { label: 'Impressions', value: compact(t.impressions) },
    { label: 'Clicks', value: compact(t.clicks) },
    { label: 'CTR', value: `${t.ctr.toFixed(2)}%` },
    { label: 'CPC', value: money(t.cpc, cur) },
    { label: 'CPM', value: money(t.cpm, cur) },
    roasTile,
  ]
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-2xl border border-white/[0.06] bg-obsidian px-5 py-4">
          <p className="text-xs uppercase tracking-wider text-ash">{tile.label}</p>
          <p className="mt-1 text-2xl font-semibold text-cream tabular-nums">{tile.value}</p>
        </div>
      ))}
    </div>
  )
}

function SpendChart({ data, currency }: { data: AdsSummary['by_day']; currency: string | null }) {
  if (data.length === 0) return null
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-obsidian p-5 mb-8">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-bone uppercase tracking-wider">Spend &amp; clicks by day</h2>
        <p className="text-xs text-smoke">{currency ?? ''} · daily breakdown</p>
      </div>
      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
            <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
            <XAxis dataKey="date" stroke="#94a3b8" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="left" stroke="#f59e0b" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="right" orientation="right" stroke="#34d399" tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{ backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#e2e8f0' }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
            <Line yAxisId="left" type="monotone" dataKey="spend" name="spend" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
            <Line yAxisId="right" type="monotone" dataKey="clicks" name="clicks" stroke="#34d399" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function CampaignsTable({ campaigns, currency }: { campaigns: AdCampaignRow[]; currency: string | null }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-obsidian overflow-hidden mb-8">
      <div className="flex items-baseline justify-between px-5 py-4 border-b border-white/[0.06]">
        <h2 className="text-sm font-semibold text-bone uppercase tracking-wider">Campaigns</h2>
        <span className="text-xs text-smoke">{campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-ash border-b border-white/[0.06]">
              <th className="text-left font-medium px-5 py-2.5">Campaign</th>
              <th className="text-right font-medium px-3 py-2.5">Spend</th>
              <th className="text-right font-medium px-3 py-2.5">Reach</th>
              <th className="text-right font-medium px-3 py-2.5">Clicks</th>
              <th className="text-right font-medium px-3 py-2.5">CTR</th>
              <th className="text-right font-medium px-3 py-2.5">CPC</th>
              <th className="text-right font-medium pr-5 pl-3 py-2.5">ROAS</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.campaign_id} className="border-b border-white/[0.04] last:border-0 hover:bg-onyx/40 transition-colors">
                <td className="px-5 py-3">
                  <p className="text-cream truncate max-w-[20rem]">{c.campaign_name}</p>
                  <p className="text-xs text-smoke tabular-nums">{compact(c.impressions)} impressions</p>
                </td>
                <td className="px-3 py-3 text-right text-cream tabular-nums">{money(c.spend, currency)}</td>
                <td className="px-3 py-3 text-right text-cream tabular-nums">{compact(c.reach)}</td>
                <td className="px-3 py-3 text-right text-cream tabular-nums">{compact(c.clicks)}</td>
                <td className="px-3 py-3 text-right text-cream tabular-nums">{c.ctr.toFixed(2)}%</td>
                <td className="px-3 py-3 text-right text-cream tabular-nums">{money(c.cpc, currency)}</td>
                <td className="pr-5 pl-3 py-3 text-right text-cream tabular-nums">
                  {c.roas != null ? `${c.roas.toFixed(2)}×` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
