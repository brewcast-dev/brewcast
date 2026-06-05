import {
  getBudgetStatus,
  getMonthToDateSpend,
  getSpendSince,
  getSpendByFeature,
} from '@/lib/ai/usage'

// Admin-only AI spend panel. Server component — reads the ai_usage ledger
// directly (no client fetch). Shows the running Gemini spend against the
// prepaid/credit budget, month-to-date + all-time totals, and a per-feature
// breakdown for the current month.

function inr(n: number): string {
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const LEVEL_COLOR: Record<'ok' | 'warn' | 'over', string> = {
  ok: '#4ade80',
  warn: '#f5b740',
  over: '#f87171',
}

export default async function UsagePanel() {
  let budget, mtd, allTime, byFeature
  try {
    ;[budget, mtd, allTime, byFeature] = await Promise.all([
      getBudgetStatus(),
      getMonthToDateSpend({ provider: 'google' }),
      getSpendSince(null, { provider: 'google' }),
      getSpendByFeature(null, { provider: 'google' }),
    ])
  } catch (err) {
    return (
      <div className="bg-obsidian border border-white/[0.06] rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white">AI Spend</h2>
        <p className="text-ash text-sm mt-1">Couldn&apos;t load usage: {(err as Error).message}</p>
      </div>
    )
  }

  const pct = Math.min(100, Math.round(budget.pctUsed * 100))
  const barColor = LEVEL_COLOR[budget.level]

  return (
    <div className="bg-obsidian border border-white/[0.06] rounded-xl p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-white">Gemini API Spend</h2>
        <span className="text-xs text-ash">est. from token usage · INR</span>
      </div>

      {/* Budget meter */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-bold text-white">{inr(budget.spentInr)}</span>
          <span className="text-sm text-ash">of {inr(budget.capInr)} budget</span>
        </div>
        <div className="h-2.5 w-full rounded-full bg-onyx overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${Math.max(pct, 1)}%`, backgroundColor: barColor }}
          />
        </div>
        <div className="flex items-center justify-between text-xs">
          <span style={{ color: barColor }}>
            {budget.level === 'over' ? 'Over budget' : budget.level === 'warn' ? 'Approaching budget' : 'On track'} · {pct}% used
          </span>
          <span className="text-ash">{inr(budget.remainingInr)} remaining</span>
        </div>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-onyx/50 rounded-lg p-3">
          <div className="text-xs text-ash">This month</div>
          <div className="text-lg font-semibold text-white">{inr(mtd.costInr)}</div>
          <div className="text-xs text-ash">{mtd.calls} calls · {mtd.totalTokens.toLocaleString('en-IN')} tokens</div>
        </div>
        <div className="bg-onyx/50 rounded-lg p-3">
          <div className="text-xs text-ash">All time</div>
          <div className="text-lg font-semibold text-white">{inr(allTime.costInr)}</div>
          <div className="text-xs text-ash">{allTime.calls} calls · {allTime.totalTokens.toLocaleString('en-IN')} tokens</div>
        </div>
      </div>

      {/* Per-feature breakdown */}
      {byFeature.length > 0 && (
        <div>
          <div className="text-xs font-medium text-ash mb-2">By feature (all time)</div>
          <div className="space-y-1">
            {byFeature.map((f) => (
              <div key={`${f.feature}-${f.model}`} className="flex items-center justify-between text-sm">
                <span className="text-cream">
                  {f.feature} <span className="text-ash text-xs">· {f.model}</span>
                </span>
                <span className="text-ash">
                  {f.calls}× · <span className="text-white">{inr(f.costInr)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-ash/70">
        Estimated from logged tokens × current rates; Google&apos;s billing is authoritative and lags ~a day.
      </p>
    </div>
  )
}
