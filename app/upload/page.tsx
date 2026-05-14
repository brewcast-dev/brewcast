'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import type { BreweryPhoto } from '@/app/api/upload/photos/route'
import type { PhotoAnalysis } from '@/app/api/ai/analyze-photo/route'
import type { CaptionResult } from '@/app/api/ai/generate-caption/route'

// ─── Filter definitions ───────────────────────────────────────────────────────

export type FilterName = 'original' | 'warm' | 'cool' | 'moody' | 'vivid' | 'fade' | 'noir' | 'golden'

const FILTERS: Record<FilterName, { label: string; css: string }> = {
  original: { label: 'Original',  css: 'none' },
  warm:     { label: 'Warm',      css: 'brightness(1.08) sepia(0.28) saturate(1.3)' },
  cool:     { label: 'Cool',      css: 'hue-rotate(15deg) saturate(0.9) brightness(1.06)' },
  moody:    { label: 'Moody',     css: 'brightness(0.82) contrast(1.35) saturate(0.75)' },
  vivid:    { label: 'Vivid',     css: 'saturate(1.85) contrast(1.1) brightness(1.04)' },
  fade:     { label: 'Fade',      css: 'brightness(1.1) contrast(0.83) saturate(0.65) sepia(0.15)' },
  noir:     { label: 'Noir',      css: 'grayscale(1) contrast(1.25) brightness(0.88)' },
  golden:   { label: 'Golden',    css: 'sepia(0.5) brightness(1.12) saturate(1.35)' },
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DraftCard {
  id: string
  photo: BreweryPhoto
  analysis: PhotoAnalysis
  caption: string
  hashtags: string[]
  filter: FilterName
  platforms: ('instagram' | 'facebook')[]
  editedImageUrl?: string
}

type Phase = 'setup' | 'generating' | 'review'

// ─── Canvas helpers ───────────────────────────────────────────────────────────

function applyFilterToCanvas(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  filter: FilterName,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  canvas.width = img.naturalWidth || img.width
  canvas.height = img.naturalHeight || img.height
  ctx.filter = FILTERS[filter].css === 'none' ? '' : FILTERS[filter].css
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  ctx.filter = ''
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/jpeg', 0.85)
}

async function uploadEditedImage(dataUrl: string, filename: string): Promise<string> {
  const res = await fetch('/api/upload/edited-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, filename }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error ?? 'Upload failed')
  }
  const { url } = await res.json() as { url: string }
  return url
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Toast({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000)
    return () => clearTimeout(t)
  }, [onClose])

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-5 py-3 shadow-xl text-sm text-zinc-100">
      <span className="text-green-400">✓</span>
      {message}
      <button onClick={onClose} className="ml-2 text-zinc-500 hover:text-zinc-300">✕</button>
    </div>
  )
}

function PhotoCard({
  draft,
  onChange,
}: {
  draft: DraftCard
  onChange: (updated: Partial<DraftCard>) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgLoaded, setImgLoaded] = useState(false)

  // Draw canvas whenever filter or image changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imgLoaded) return
    const img = imgRef.current
    if (!img) return
    applyFilterToCanvas(canvas, img, draft.filter)
  }, [draft.filter, imgLoaded])

  // Pre-load image
  useEffect(() => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      setImgLoaded(true)
    }
    img.src = draft.photo.url
  }, [draft.photo.url])

  const togglePlatform = (p: 'instagram' | 'facebook') => {
    const has = draft.platforms.includes(p)
    const next = has
      ? draft.platforms.filter((x) => x !== p)
      : [...draft.platforms, p]
    if (next.length > 0) onChange({ platforms: next })
  }

  return (
    <div className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      {/* Canvas preview */}
      <div className="relative w-full aspect-square bg-zinc-800">
        {!imgLoaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-zinc-500 text-xs">Loading…</span>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={`w-full h-full object-cover transition-opacity duration-200 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
        />
      </div>

      <div className="flex flex-col gap-3 p-4">
        {/* Filter picker */}
        <div>
          <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Filter</label>
          <select
            value={draft.filter}
            onChange={(e) => onChange({ filter: e.target.value as FilterName })}
            className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm px-3 py-1.5 focus:outline-none focus:border-amber-500"
          >
            {(Object.keys(FILTERS) as FilterName[]).map((f) => (
              <option key={f} value={f}>{FILTERS[f].label}</option>
            ))}
          </select>
        </div>

        {/* Caption */}
        <div>
          <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1 block">Caption</label>
          <textarea
            value={draft.caption}
            onChange={(e) => onChange({ caption: e.target.value })}
            rows={4}
            className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm px-3 py-2 resize-none focus:outline-none focus:border-amber-500 leading-relaxed"
          />
        </div>

        {/* Hashtags */}
        <div>
          <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1.5 block">Hashtags</label>
          <div className="flex flex-wrap gap-1.5">
            {draft.hashtags.map((tag) => (
              <span
                key={tag}
                className="inline-block rounded-full bg-zinc-800 border border-zinc-700 px-2.5 py-0.5 text-xs text-amber-400"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>

        {/* Platform toggles */}
        <div>
          <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1.5 block">Platforms</label>
          <div className="flex gap-2">
            {(['instagram', 'facebook'] as const).map((p) => (
              <button
                key={p}
                onClick={() => togglePlatform(p)}
                className={`flex-1 rounded-lg border text-xs py-1.5 capitalize transition-colors ${
                  draft.platforms.includes(p)
                    ? 'border-amber-500 bg-amber-500/10 text-amber-400'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Progress step display ────────────────────────────────────────────────────

function ProgressStep({
  label,
  done,
  active,
}: {
  label: string
  done: boolean
  active: boolean
}) {
  return (
    <div className={`flex items-center gap-2 text-sm transition-colors ${
      done ? 'text-green-400' : active ? 'text-amber-400' : 'text-zinc-600'
    }`}>
      <span className="w-4 text-center">
        {done ? '✓' : active ? '⟳' : '○'}
      </span>
      {label}
    </div>
  )
}

// ─── Scoring helper — pick best N photos ─────────────────────────────────────

async function scoreAndSelect(
  photos: BreweryPhoto[],
  count: number,
): Promise<{ photo: BreweryPhoto; analysis: PhotoAnalysis }[]> {
  // Cap candidates and limit concurrency — Gemini free tier is ~15 RPM,
  // hammering with 20 parallel calls trips rate-limits and fails the whole batch.
  const CONCURRENCY = 3
  // Score at most the number of posts wanted + a small pool for variety
  const candidates = photos.slice(0, Math.min(photos.length, Math.max(count + 4, 8)))

  const results: PromiseSettledResult<{ photo: BreweryPhoto; analysis: PhotoAnalysis }>[] = []
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY)
    const chunkResults = await Promise.allSettled(
      chunk.map(async (photo) => {
        const res = await fetch('/api/ai/analyze-photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageUrl: photo.url }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(
            `analyze-photo ${res.status}: ${(body as { error?: string }).error ?? 'unknown'}`,
          )
        }
        const analysis: PhotoAnalysis = await res.json()
        return { photo, analysis }
      }),
    )
    results.push(...chunkResults)
  }

  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length > 0) {
    console.warn(
      `[scoreAndSelect] ${failures.length}/${results.length} analyses failed.`,
      (failures[0] as PromiseRejectedResult).reason,
    )
  }

  const scored = results
    .filter((r): r is PromiseFulfilledResult<{ photo: BreweryPhoto; analysis: PhotoAnalysis }> =>
      r.status === 'fulfilled',
    )
    .map((r) => r.value)
    .sort((a, b) => b.analysis.score - a.analysis.score)

  if (scored.length === 0) {
    throw new Error('All photo analyses failed — check the server console for the underlying Gemini/Groq error.')
  }

  // Ensure variety by avoiding duplicate filters when possible
  const selected: typeof scored = []
  const usedFilters = new Set<string>()
  for (const item of scored) {
    if (selected.length >= count) break
    if (!usedFilters.has(item.analysis.suggestedFilter) || selected.length < count) {
      selected.push(item)
      usedFilters.add(item.analysis.suggestedFilter)
    }
  }
  return selected.slice(0, count)
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const [phase, setPhase] = useState<Phase>('setup')
  const [photos, setPhotos] = useState<BreweryPhoto[]>([])
  const [photosLoading, setPhotosLoading] = useState(true)
  const [photosError, setPhotosError] = useState<string | null>(null)
  const [postCount, setPostCount] = useState(3)
  const [drafts, setDrafts] = useState<DraftCard[]>([])
  const [progressSteps, setProgressSteps] = useState<{ label: string; done: boolean }[]>([])
  const [activeStep, setActiveStep] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const canvasWorkRef = useRef<HTMLCanvasElement | null>(null)

  // Load photo library on mount
  useEffect(() => {
    setPhotosLoading(true)
    fetch('/api/upload/photos')
      .then((r) => r.json())
      .then(({ photos: p }: { photos: BreweryPhoto[] }) => {
        setPhotos(p)
        setPhotosLoading(false)
      })
      .catch((err) => {
        setPhotosError(String(err))
        setPhotosLoading(false)
      })
  }, [])

  const updateDraft = useCallback((id: string, patch: Partial<DraftCard>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  }, [])

  // ── Apply filter + upload edited image in browser ─────────────────────────
  const renderAndUploadFiltered = useCallback(
    async (draft: DraftCard): Promise<string | undefined> => {
      return new Promise<string | undefined>((resolve) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = async () => {
          const canvas = canvasWorkRef.current ?? document.createElement('canvas')
          applyFilterToCanvas(canvas, img, draft.filter)
          const dataUrl = canvasToDataUrl(canvas)
          try {
            const url = await uploadEditedImage(
              dataUrl,
              `edited_${Date.now()}_${draft.photo.name}`,
            )
            resolve(url)
          } catch {
            resolve(undefined)
          }
        }
        img.onerror = () => resolve(undefined)
        img.src = draft.photo.url
      })
    },
    [],
  )

  // ── Full generation pipeline ──────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    setPhase('generating')

    const steps = [
      { label: 'Scoring photos with Gemini Vision…', done: false },
      ...Array.from({ length: postCount }, (_, i) => ({
        label: `Generating post ${i + 1}/${postCount}…`,
        done: false,
      })),
      { label: 'Uploading edited images…', done: false },
    ]
    setProgressSteps(steps)
    setActiveStep(0)

    try {
      // Step 0: score + select photos
      const selected = await scoreAndSelect(photos, postCount)
      setProgressSteps((prev) => {
        const next = [...prev]
        next[0] = { ...next[0], done: true }
        return next
      })
      setActiveStep(1)

      // Steps 1..N: generate captions per photo
      const generated: DraftCard[] = []
      for (let i = 0; i < selected.length; i++) {
        const { photo, analysis } = selected[i]

        const captionRes = await fetch('/api/ai/generate-caption', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ analysis }),
        })
        let caption = `Fresh craft from the tap. 🍺 #District6Bangalore`
        let hashtags = ['District6Bangalore', 'CraftBeerIndia', 'BeerLovers', 'BangaloreBeer', 'CraftBeer']
        if (captionRes.ok) {
          const data: CaptionResult = await captionRes.json()
          caption = data.caption
          hashtags = data.hashtags
        }

        generated.push({
          id: `draft_${Date.now()}_${i}`,
          photo,
          analysis,
          caption,
          hashtags,
          filter: analysis.suggestedFilter as FilterName,
          platforms: ['instagram'],
        })

        setProgressSteps((prev) => {
          const next = [...prev]
          next[i + 1] = { ...next[i + 1], done: true }
          return next
        })
        setActiveStep(i + 2)
      }

      // Final step: upload edited images
      const withUploads = await Promise.all(
        generated.map(async (d) => {
          const editedImageUrl = await renderAndUploadFiltered(d)
          return { ...d, editedImageUrl }
        }),
      )
      setProgressSteps((prev) => {
        const next = [...prev]
        next[next.length - 1] = { ...next[next.length - 1], done: true }
        return next
      })

      setDrafts(withUploads)
      setPhase('review')
    } catch (err) {
      console.error('[UploadPage] Generation failed:', err)
      setToast(`Generation failed: ${(err as Error).message}`)
      setPhase('setup')
    }
  }, [photos, postCount, renderAndUploadFiltered])

  // ── Save all drafts ────────────────────────────────────────────────────────
  const handleSaveAll = useCallback(async () => {
    setSaving(true)
    try {
      // Re-render edited images for any cards whose filter changed during review
      const finalized = await Promise.all(
        drafts.map(async (d) => {
          let editedUrl = d.editedImageUrl
          if (!editedUrl || d.filter !== d.analysis.suggestedFilter) {
            editedUrl = await renderAndUploadFiltered(d)
          }
          return {
            image_url: d.photo.url,
            edited_image_url: editedUrl,
            filter_applied: d.filter,
            caption: d.caption,
            hashtags: d.hashtags,
            platforms: d.platforms,
          }
        }),
      )

      const res = await fetch('/api/drafts/bulk-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drafts: finalized }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? 'Save failed')
      }

      const { count } = await res.json() as { count: number }
      setToast(`${count} draft${count !== 1 ? 's' : ''} saved — view in /drafts`)
    } catch (err) {
      setToast(`Error: ${String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [drafts, renderAndUploadFiltered])

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* Hidden off-screen canvas for filter rendering */}
      <canvas
        ref={canvasWorkRef}
        style={{ position: 'absolute', left: '-9999px', top: '-9999px' }}
        aria-hidden
      />

      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-zinc-900">
        <Link href="/" className="text-amber-400 font-bold text-lg tracking-tight">
          BrewCast
        </Link>
        <nav className="flex items-center gap-1">
          <Link
            href="/chat"
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            Chat
          </Link>
          <Link
            href="/drafts"
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            Drafts
          </Link>
          <Link
            href="/analytics"
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            Analytics
          </Link>
        </nav>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-10">

        {/* ── SETUP PHASE ─────────────────────────────────────────────────── */}
        {phase === 'setup' && (
          <div className="flex flex-col gap-8">
            <div>
              <h1 className="text-2xl font-bold text-zinc-100">Quick Post Generator</h1>
              <p className="text-zinc-400 text-sm mt-1">
                AI selects your best photos, applies filters, and writes captions — you just review.
              </p>
            </div>

            {/* Photo library preview */}
            <div>
              <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-3">
                Photo Library
                {!photosLoading && photos.length > 0 && (
                  <span className="ml-2 text-zinc-500 font-normal normal-case">
                    ({photos.length} photos)
                  </span>
                )}
              </h2>

              {photosLoading && (
                <div className="flex items-center gap-2 text-zinc-500 text-sm">
                  <span className="animate-spin">⟳</span> Loading photos…
                </div>
              )}

              {photosError && (
                <div className="rounded-xl border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
                  Could not load photo library: {photosError}
                </div>
              )}

              {!photosLoading && photos.length === 0 && !photosError && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-8 text-center">
                  <p className="text-zinc-500 text-sm">No photos found in the brewery-photos bucket.</p>
                  <p className="text-zinc-600 text-xs mt-1">
                    Upload photos to the <code className="text-amber-400">brewery-photos</code> Supabase Storage bucket
                    or add them to <code className="text-amber-400">public/brewery-photos/</code>.
                  </p>
                </div>
              )}

              {!photosLoading && photos.length > 0 && (
                <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
                  {photos.slice(0, 32).map((photo) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={photo.name}
                      src={photo.url}
                      alt={photo.name}
                      className="aspect-square w-full object-cover rounded-lg border border-zinc-800"
                    />
                  ))}
                  {photos.length > 32 && (
                    <div className="aspect-square w-full rounded-lg border border-zinc-800 bg-zinc-900 flex items-center justify-center text-xs text-zinc-500">
                      +{photos.length - 32}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Post count input + generate */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 flex flex-col sm:flex-row items-start sm:items-center gap-6">
              <div className="flex flex-col gap-1.5 flex-1">
                <label htmlFor="post-count" className="text-sm font-medium text-zinc-200">
                  How many posts do you want to create today?
                </label>
                <p className="text-xs text-zinc-500">
                  AI will pick the best {postCount} photo{postCount !== 1 ? 's' : ''}, apply filters,
                  and write captions automatically.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <input
                  id="post-count"
                  type="number"
                  min={1}
                  max={10}
                  value={postCount}
                  onChange={(e) => {
                    const v = Math.min(10, Math.max(1, parseInt(e.target.value) || 1))
                    setPostCount(v)
                  }}
                  className="w-20 text-center rounded-xl border border-zinc-700 bg-zinc-800 text-zinc-100 text-xl font-bold py-2 focus:outline-none focus:border-amber-500"
                />
                <button
                  onClick={handleGenerate}
                  disabled={photos.length === 0 || photosLoading}
                  className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-950 font-semibold text-sm transition-colors"
                >
                  Generate
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── GENERATING PHASE ────────────────────────────────────────────── */}
        {phase === 'generating' && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8">
            <div className="text-center">
              <div className="text-4xl mb-4 animate-spin inline-block">⟳</div>
              <h2 className="text-xl font-bold text-zinc-100">AI is working its magic…</h2>
              <p className="text-zinc-500 text-sm mt-1">Analysing photos and writing captions</p>
            </div>

            <div className="flex flex-col gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 px-8 py-6 w-full max-w-sm">
              {progressSteps.map((step, i) => (
                <ProgressStep
                  key={i}
                  label={step.label}
                  done={step.done}
                  active={i === activeStep}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── REVIEW PHASE ────────────────────────────────────────────────── */}
        {phase === 'review' && (
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-zinc-100">Review Your Posts</h1>
                <p className="text-zinc-400 text-sm mt-1">
                  Edit captions, swap filters, or toggle platforms before saving.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setPhase('setup')}
                  className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 text-sm transition-colors"
                >
                  ← Start over
                </button>
                <button
                  onClick={handleSaveAll}
                  disabled={saving}
                  className="px-5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-950 font-semibold text-sm transition-colors"
                >
                  {saving ? 'Saving…' : `Save All to Drafts (${drafts.length})`}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {drafts.map((draft) => (
                <PhotoCard
                  key={draft.id}
                  draft={draft}
                  onChange={(patch) => updateDraft(draft.id, patch)}
                />
              ))}
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={handleSaveAll}
                disabled={saving}
                className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-950 font-semibold text-sm transition-colors"
              >
                {saving ? 'Saving…' : `Save All to Drafts (${drafts.length})`}
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Toast */}
      {toast && (
        <Toast
          message={toast}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  )
}
