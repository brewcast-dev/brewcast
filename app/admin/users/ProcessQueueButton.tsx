'use client'

import { useState } from 'react'
import { processQueueNow } from './actions'

interface Result {
  ok?: boolean
  processed?: number
  failed?: number
  purged?: number
  error?: string
}

export default function ProcessQueueButton() {
  const [status, setStatus] = useState<'idle' | 'running'>('idle')
  const [result, setResult] = useState<Result | null>(null)

  async function handleClick() {
    setStatus('running')
    setResult(null)
    const res = await processQueueNow()
    setResult(res)
    setStatus('idle')
  }

  return (
    <div className="bg-obsidian border border-white/[0.06] rounded-xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Process queue now</h2>
          <p className="text-xs text-ash mt-1">
            Runs the same endpoint the GitHub Actions cron hits. Publishes any
            posts whose <code className="text-cream">scheduled_at</code> is
            in the past and status is <code className="text-cream">queued</code>.
          </p>
        </div>
        <button
          onClick={handleClick}
          disabled={status === 'running'}
          className="bg-cream hover:bg-bone disabled:opacity-50 text-ink font-medium rounded-full px-5 py-2 text-sm transition-colors flex-shrink-0"
        >
          {status === 'running' ? 'Running…' : 'Run now'}
        </button>
      </div>

      {result && (
        <div
          className={`text-sm rounded-lg px-3 py-2 ${
            result.error
              ? 'bg-red-950/40 border border-red-900/50 text-red-300'
              : 'bg-emerald-950 border border-emerald-800 text-emerald-300'
          }`}
        >
          {result.error ? (
            <span>Error: {result.error}</span>
          ) : (
            <span>
              Processed {result.processed} · Failed {result.failed} · Purged{' '}
              {result.purged}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
