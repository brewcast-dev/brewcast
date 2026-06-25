import { NextResponse } from 'next/server'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig, resolveConfig } from '@/lib/get-user-config'
import { getAdsSummary } from '@/lib/ads'

function parseDays(raw: string | null): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 30
  if (n < 1) return 1
  if (n > 90) return 90
  return Math.round(n)
}

// GET — live ad-performance summary for the given range, pulled straight from
// the Meta Marketing API. Returns { configured:false } (not an error) when the
// brewery hasn't set up ad credentials yet, so the page can show a setup hint.
export async function GET(req: Request) {
  const session = createSessionClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const days = parseDays(new URL(req.url).searchParams.get('days'))
  const config = resolveConfig(await getUserConfig(user.id))

  if (!config.metaAdAccountId || !config.metaAdsToken) {
    return NextResponse.json({ configured: false })
  }

  try {
    const summary = await getAdsSummary(
      { adAccountId: config.metaAdAccountId, accessToken: config.metaAdsToken },
      days,
    )
    return NextResponse.json({ configured: true, summary })
  } catch (err) {
    console.error('[api/ads] fetch failed:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
