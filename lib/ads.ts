// Meta Marketing API client — pulls live paid-campaign performance for the
// /ads dashboard. Unlike lib/analytics.ts (organic Instagram insights via
// graph.instagram.com) this hits the FACEBOOK Graph API with an `ads_read`
// token and an ad-account id (act_…).
//
// Live-fetch model: the Marketing API returns historical data for any window,
// so there's no snapshot table — each dashboard load (or refresh) queries Meta
// directly for the requested range.

const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

export interface MetaAdsCredentials {
  adAccountId: string   // act_1234567890 (we normalize a bare id too)
  accessToken: string   // Facebook-app token with ads_read
}

export interface AdCampaignRow {
  campaign_id: string
  campaign_name: string
  spend: number
  impressions: number
  reach: number
  clicks: number
  ctr: number            // %
  cpc: number            // currency per click
  link_clicks: number
  purchases: number
  purchase_value: number
  roas: number | null    // purchase_value / spend, or null when no conversions
}

export interface AdsTotals {
  spend: number
  impressions: number
  reach: number
  clicks: number
  link_clicks: number
  ctr: number            // %
  cpc: number
  cpm: number            // cost per 1,000 impressions
  purchases: number
  purchase_value: number
  roas: number | null
}

export interface AdsSummary {
  range_days: number
  currency: string | null
  account_name: string | null
  totals: AdsTotals
  by_day: Array<{ date: string; spend: number; clicks: number; impressions: number }>
  campaigns: AdCampaignRow[]
  fetched_at: string
  has_spend: boolean
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Accept "act_123" or bare "123" and always return the act_-prefixed form.
export function normalizeAdAccountId(raw: string): string {
  const t = raw.trim()
  return t.startsWith('act_') ? t : `act_${t.replace(/^act_?/, '')}`
}

interface MetaAction { action_type: string; value: string }

// Marketing API returns `actions` / `action_values` as arrays of typed rows.
// Pull the numbers we care about: link clicks (the awareness "result") and any
// purchase conversions (for ROAS, when a pixel/CAPI is wired up).
function readActions(actions?: MetaAction[], actionValues?: MetaAction[]): {
  linkClicks: number
  purchases: number
  purchaseValue: number
} {
  let linkClicks = 0
  let purchases = 0
  let purchaseValue = 0
  for (const a of actions ?? []) {
    if (a.action_type === 'link_click') linkClicks += Number(a.value) || 0
    if (a.action_type.includes('purchase')) purchases += Number(a.value) || 0
  }
  for (const a of actionValues ?? []) {
    if (a.action_type.includes('purchase')) purchaseValue += Number(a.value) || 0
  }
  return { linkClicks, purchases, purchaseValue }
}

function timeRange(days: number): string {
  const until = new Date()
  const since = new Date(Date.now() - days * 86400 * 1000)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return JSON.stringify({ since: iso(since), until: iso(until) })
}

async function metaGet<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text()
    let msg = body.slice(0, 400)
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } }
      if (parsed.error?.message) msg = parsed.error.message
    } catch { /* keep raw */ }
    throw new Error(`Meta Ads ${res.status}: ${msg}`)
  }
  return (await res.json()) as T
}

interface InsightsRow {
  campaign_id?: string
  campaign_name?: string
  spend?: string
  impressions?: string
  reach?: string
  clicks?: string
  date_start?: string
  actions?: MetaAction[]
  action_values?: MetaAction[]
}

// ─── Main fetch ──────────────────────────────────────────────────────────────

const INSIGHT_FIELDS = 'spend,impressions,reach,clicks,actions,action_values'

/**
 * Pull a full ads dashboard payload live from Meta for the given window.
 * Three parallel calls: account totals (deduped reach), per-campaign rows, and
 * a daily series for the spend chart. Throws on transport / auth errors.
 */
export async function getAdsSummary(creds: MetaAdsCredentials, days: number): Promise<AdsSummary> {
  const acct = normalizeAdAccountId(creds.adAccountId)
  const token = creds.accessToken
  const range = encodeURIComponent(timeRange(days))

  const totalsUrl = `${GRAPH_BASE}/${acct}/insights?fields=${INSIGHT_FIELDS}&time_range=${range}&access_token=${token}`
  const campaignsUrl = `${GRAPH_BASE}/${acct}/insights?level=campaign&fields=campaign_id,campaign_name,${INSIGHT_FIELDS}&time_range=${range}&limit=200&access_token=${token}`
  const dailyUrl = `${GRAPH_BASE}/${acct}/insights?fields=spend,clicks,impressions&time_increment=1&time_range=${range}&access_token=${token}`
  const acctUrl = `${GRAPH_BASE}/${acct}?fields=name,currency&access_token=${token}`

  const [totalsRes, campaignsRes, dailyRes, acctRes] = await Promise.all([
    metaGet<{ data?: InsightsRow[] }>(totalsUrl),
    metaGet<{ data?: InsightsRow[] }>(campaignsUrl),
    metaGet<{ data?: InsightsRow[] }>(dailyUrl),
    metaGet<{ name?: string; currency?: string }>(acctUrl).catch(() => ({} as { name?: string; currency?: string })),
  ])

  // Totals (one aggregated row; absent when no spend in the window).
  const t = totalsRes.data?.[0]
  const tActions = readActions(t?.actions, t?.action_values)
  const spend = Number(t?.spend) || 0
  const impressions = Number(t?.impressions) || 0
  const reach = Number(t?.reach) || 0
  const clicks = Number(t?.clicks) || 0
  const totals: AdsTotals = {
    spend,
    impressions,
    reach,
    clicks,
    link_clicks: tActions.linkClicks,
    ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
    cpc: clicks > 0 ? round2(spend / clicks) : 0,
    cpm: impressions > 0 ? round2((spend / impressions) * 1000) : 0,
    purchases: tActions.purchases,
    purchase_value: round2(tActions.purchaseValue),
    roas: tActions.purchaseValue > 0 && spend > 0 ? round2(tActions.purchaseValue / spend) : null,
  }

  // Per-campaign rows.
  const campaigns: AdCampaignRow[] = (campaignsRes.data ?? []).map((r) => {
    const a = readActions(r.actions, r.action_values)
    const cSpend = Number(r.spend) || 0
    const cImpr = Number(r.impressions) || 0
    const cClicks = Number(r.clicks) || 0
    return {
      campaign_id: r.campaign_id ?? '',
      campaign_name: r.campaign_name ?? '(unnamed campaign)',
      spend: round2(cSpend),
      impressions: cImpr,
      reach: Number(r.reach) || 0,
      clicks: cClicks,
      ctr: cImpr > 0 ? round2((cClicks / cImpr) * 100) : 0,
      cpc: cClicks > 0 ? round2(cSpend / cClicks) : 0,
      link_clicks: a.linkClicks,
      purchases: a.purchases,
      purchase_value: round2(a.purchaseValue),
      roas: a.purchaseValue > 0 && cSpend > 0 ? round2(a.purchaseValue / cSpend) : null,
    }
  }).sort((a, b) => b.spend - a.spend)

  // Daily series for the spend chart.
  const by_day = (dailyRes.data ?? [])
    .map((r) => ({
      date: r.date_start ?? '',
      spend: round2(Number(r.spend) || 0),
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
    }))
    .filter((d) => d.date)
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    range_days: days,
    currency: acctRes.currency ?? null,
    account_name: acctRes.name ?? null,
    totals,
    by_day,
    campaigns,
    fetched_at: new Date().toISOString(),
    has_spend: spend > 0,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
