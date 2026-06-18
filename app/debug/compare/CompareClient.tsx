'use client'

import { useState } from 'react'

interface Photo {
  url: string
  mood: string | null
  score: number | null
  description: string | null
}

interface ProviderResult {
  url?: string
  error?: string
  ms: number
  inputSize?: string
  outputSize?: string
  prompt?: string
}

interface CompareResponse {
  original: string
  mood: string
  results: {
    nano_banana: ProviderResult
    claid: ProviderResult
    generative_design: ProviderResult
  }
}

interface Props {
  photos: Photo[]
}

const MOODS = ['vibrant', 'cozy', 'moody', 'clean', 'festive', 'premium', 'casual']

export default function CompareClient({ photos }: Props) {
  const [selected, setSelected] = useState<Photo | null>(null)
  const [moodOverride, setMoodOverride] = useState<string>('')
  const [headline, setHeadline] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CompareResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runCompare() {
    if (!selected) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/debug/compare-editors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: selected.url,
          mood: moodOverride || undefined,
          headline: headline.trim() || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setResult(json as CompareResponse)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Photo picker */}
      <section>
        <h2 className="text-sm font-semibold text-cream mb-3">1. Pick a photo</h2>
        {photos.length === 0 ? (
          <p className="text-ash text-sm">
            No photos in your library yet. Upload some at <a href="/upload" className="text-ember underline">/upload</a> first.
          </p>
        ) : (
          <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
            {photos.map((p) => (
              <button
                key={p.url}
                onClick={() => setSelected(p)}
                className={`relative aspect-square overflow-hidden rounded border-2 transition ${
                  selected?.url === p.url ? 'border-ember' : 'border-transparent hover:border-onyx'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt="" className="w-full h-full object-cover" />
                {p.mood && (
                  <span className="absolute bottom-1 left-1 bg-ink/80 text-cream text-[10px] px-1 py-0.5 rounded">
                    {p.mood}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Controls */}
      {selected && (
        <section className="bg-obsidian rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-semibold text-cream">2. Run the comparison</h2>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-sm text-ash">
              Mood override:{' '}
              <select
                value={moodOverride}
                onChange={(e) => setMoodOverride(e.target.value)}
                className="bg-ink text-cream rounded px-2 py-1 border border-onyx"
              >
                <option value="">(use stored: {selected.mood ?? 'none'})</option>
                {MOODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="text-sm text-ash">
              Headline:{' '}
              <input
                type="text"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                placeholder="(blank = let the model write it)"
                className="bg-ink text-cream rounded px-2 py-1 border border-onyx w-64"
              />
            </label>
            <button
              onClick={runCompare}
              disabled={loading}
              className="bg-ember text-ink font-semibold px-4 py-2 rounded hover:bg-ember/80 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Running all three…' : 'Compare'}
            </button>
          </div>
          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}
        </section>
      )}

      {/* Results */}
      {result && (
        <section>
          <h2 className="text-sm font-semibold text-cream mb-3">
            3. Results — mood: <span className="text-ember">{result.mood}</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <ResultCard label="Original" url={result.original} />
            <ResultCard
              label="★ Generative design (full)"
              url={result.results.generative_design.url}
              error={result.results.generative_design.error}
              ms={result.results.generative_design.ms}
              prompt={result.results.generative_design.prompt}
            />
            <ResultCard
              label="Nano Banana (grade only)"
              url={result.results.nano_banana.url}
              error={result.results.nano_banana.error}
              ms={result.results.nano_banana.ms}
            />
            <ResultCard
              label="Claid.ai (enhance)"
              url={result.results.claid.url}
              error={result.results.claid.error}
              ms={result.results.claid.ms}
              inputSize={result.results.claid.inputSize}
              outputSize={result.results.claid.outputSize}
            />
          </div>
        </section>
      )}
    </div>
  )
}

function ResultCard({
  label,
  url,
  error,
  ms,
  inputSize,
  outputSize,
  prompt,
}: {
  label: string
  url?: string
  error?: string
  ms?: number
  inputSize?: string
  outputSize?: string
  prompt?: string
}) {
  return (
    <div className="bg-obsidian rounded-lg overflow-hidden">
      <div className="p-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-cream">{label}</h3>
        <div className="flex items-center gap-2 text-xs text-ash">
          {inputSize && outputSize && (
            <span title="input → output dimensions">{inputSize} → {outputSize}</span>
          )}
          {ms !== undefined && <span>{(ms / 1000).toFixed(1)}s</span>}
        </div>
      </div>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={label} className="w-full aspect-[4/5] object-contain bg-ink" />
      ) : (
        <div className="w-full aspect-[4/5] flex items-center justify-center bg-ink p-4">
          <p className="text-red-400 text-xs text-center break-words">
            {error ?? 'No output'}
          </p>
        </div>
      )}
      {prompt && (
        <details className="p-3 border-t border-onyx">
          <summary className="text-xs text-ash cursor-pointer select-none">View prompt sent to model</summary>
          <pre className="mt-2 text-[11px] text-ash whitespace-pre-wrap break-words font-mono leading-relaxed">{prompt}</pre>
        </details>
      )}
    </div>
  )
}
