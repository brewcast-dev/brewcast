import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'
import {
  getAnalyticsSummary,
  refreshMetaAnalytics,
  shouldRefresh,
} from '@/lib/analytics'

function parseDays(raw: string | null): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 30
  if (n < 1) return 1
  if (n > 90) return 90
  return Math.round(n)
}

// GET — return the dashboard summary for the given range
export async function GET(req: Request) {
  const session = createSessionClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const days = parseDays(url.searchParams.get('days'))

  const supabase = createAdminClient()
  const summary = await getAnalyticsSummary(supabase, days, user.id)
  return NextResponse.json(summary)
}

// POST — manually refresh analytics from Meta. Honors a 6h cooldown unless
// force=true is passed in the body to prevent accidental spamming.
export async function POST(req: Request) {
  const session = createSessionClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: { days?: number; force?: boolean } = {}
  try {
    body = await req.json()
  } catch {
    // empty body is fine
  }
  const days = parseDays(String(body.days ?? 30))
  const force = body.force === true

  const supabase = createAdminClient()
  const config = resolveConfig(await getUserConfig(user.id))
  const igUserId = config.metaIgUserId
  const accessToken = config.metaAccessToken
  if (!igUserId || !accessToken) {
    return NextResponse.json(
      { error: 'Meta credentials not configured. Set them in /settings.' },
      { status: 400 },
    )
  }

  if (!force) {
    const { stale, last_captured_at } = await shouldRefresh(supabase, user.id)
    if (!stale) {
      return NextResponse.json({
        skipped: true,
        reason: 'cooldown',
        last_captured_at,
      })
    }
  }

  try {
    const result = await refreshMetaAnalytics(
      supabase,
      { igUserId, accessToken },
      days,
      user.id,
    )
    const summary = await getAnalyticsSummary(supabase, days, user.id)
    return NextResponse.json({ ...result, summary })
  } catch (err) {
    console.error('[api/analytics] refresh failed:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
