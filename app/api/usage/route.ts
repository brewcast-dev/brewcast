import { NextResponse } from 'next/server'
import { createSessionClient } from '@/lib/supabase-server'
import {
  getBudgetStatus,
  getMonthToDateSpend,
  getSpendSince,
  AI_BUDGET_INR,
} from '@/lib/ai/usage'

// GET /api/usage — account-wide AI spend + prepaid budget status.
//
// Returns the running Gemini spend against your prepaid ₹ deposit (the
// `budget` block, which never blocks calls — it only grades ok/warn/over),
// plus month-to-date and all-time token/cost summaries. Wire into the admin
// page to show a live "₹X of ₹Y used" meter.

export async function GET() {
  const session = createSessionClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const [budget, mtdAll, mtdGoogle, allTimeGoogle] = await Promise.all([
      getBudgetStatus(),
      getMonthToDateSpend(),
      getMonthToDateSpend({ provider: 'google' }),
      getSpendSince(null, { provider: 'google' }),
    ])

    return NextResponse.json({
      budget,
      monthToDate: { all: mtdAll, gemini: mtdGoogle },
      allTime: { gemini: allTimeGoogle },
      note:
        budget.level === 'over'
          ? `Gemini spend has passed your ₹${AI_BUDGET_INR} prepaid budget. On prepaid, calls fail rather than overbilling — top up to avoid interruptions.`
          : budget.level === 'warn'
            ? `Gemini spend is at ${Math.round(budget.pctUsed * 100)}% of your ₹${AI_BUDGET_INR} prepaid budget.`
            : `Gemini spend is at ${Math.round(budget.pctUsed * 100)}% of your ₹${AI_BUDGET_INR} prepaid budget.`,
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
