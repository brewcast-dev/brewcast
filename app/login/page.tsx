'use client'

import { useState } from 'react'
import { signIn } from './actions'

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const result = await signIn(new FormData(e.currentTarget))
    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center px-4 overflow-hidden">
      {/* Ambient gradient — soft warmth without imagery */}
      <div className="pointer-events-none absolute inset-0 -z-0">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-ember/[0.05] blur-[120px]" />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="mb-10 text-center">
          <h1 className="font-display text-5xl text-cream tracking-tight">BrewCast</h1>
          <p className="mt-2 text-ash text-sm">AI social media for breweries</p>
        </div>

        <div className="bg-obsidian/60 hairline backdrop-blur-xl rounded-3xl p-8">
          <h2 className="font-display text-2xl text-cream mb-1">Sign in</h2>
          <p className="text-ash text-sm mb-6">Welcome back.</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs uppercase tracking-wider text-ash mb-2">
                Email
              </label>
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                className="w-full bg-ink/60 hairline rounded-xl px-4 py-3 text-cream placeholder-smoke text-sm focus:outline-none focus:border-cream/30 transition-colors"
                placeholder="you@brewery.com"
              />
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-ash mb-2">
                Password
              </label>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="w-full bg-ink/60 hairline rounded-xl px-4 py-3 text-cream placeholder-smoke text-sm focus:outline-none focus:border-cream/30 transition-colors"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="rounded-xl bg-red-950/40 border border-red-900/50 px-4 py-3 text-red-300 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-cream hover:bg-bone disabled:opacity-50 disabled:cursor-not-allowed text-ink font-medium rounded-full py-3 text-sm transition-colors mt-2"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-smoke mt-8">
          Access by invitation only.
        </p>
      </div>
    </div>
  )
}
