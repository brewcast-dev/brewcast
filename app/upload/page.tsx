'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type { BreweryPhoto } from '@/app/api/upload/photos/route'
import type { PhotoAnalysis } from '@/app/api/ai/analyze-photo/route'
import type { CaptionResult } from '@/app/api/ai/generate-caption/route'
import PhotoUploader from './_components/PhotoUploader'

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
  editedImageUrl?: string        // Filter-only render (intermediate)
  designedImageUrl?: string      // Final designed image (filter + overlay layer)
  designHeadline?: string
  designSubhead?: string | null
  designBadge?: string | null
  designIntensity?: 'subtle' | 'bold' | 'heavy'
  designing?: boolean            // True while the design step is in flight
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
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-white/[0.08] bg-obsidian px-5 py-3 shadow-2xl shadow-black/40 text-sm text-cream">
      <span className="text-emerald">✓</span>
      {message}
      <button onClick={onClose} className="ml-2 text-ash hover:text-bone">✕</button>
    </div>
  )
}

// Full-size photo preview. Click backdrop or X to dismiss; Esc also closes.
function Lightbox({
  photo,
  onClose,
}: {
  photo: BreweryPhoto
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Lock body scroll while open
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-8 cursor-zoom-out"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Photo preview"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-5 right-5 w-10 h-10 rounded-full bg-black/60 hover:bg-black/80 text-cream flex items-center justify-center transition-colors"
        aria-label="Close preview"
      >
        ✕
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.url}
        alt={photo.name}
        className="max-w-full max-h-full object-contain rounded-lg shadow-2xl cursor-default"
        onClick={(e) => e.stopPropagation()}
      />
      {(typeof photo.score === 'number' || photo.publishedAt) && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-full bg-black/60 px-4 py-2 text-sm text-cream">
          {typeof photo.score === 'number' && <span>Score: <span className="tabular-nums">{photo.score}</span></span>}
          {photo.publishedAt && <span className="text-ash">Published {new Date(photo.publishedAt).toLocaleDateString()}</span>}
        </div>
      )}
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
    <div className="flex flex-col rounded-2xl border border-white/[0.06] bg-obsidian overflow-hidden">
      {/* Preview: designed image (final, with overlay) if available, else canvas filter preview.
          aspect-[4/5] matches the new design output. Falls back gracefully for older
          square images. */}
      <div className="relative w-full aspect-[4/5] bg-onyx">
        {!imgLoaded && !draft.designedImageUrl && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-ash text-xs">Loading…</span>
          </div>
        )}
        {draft.designedImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={draft.designedImageUrl}
            alt={draft.designHeadline ?? draft.photo.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <canvas
            ref={canvasRef}
            className={`w-full h-full object-cover transition-opacity duration-200 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
        {draft.designing && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <span className="text-cream text-xs animate-pulse">Designing…</span>
          </div>
        )}
        {draft.designIntensity && (
          <div className="absolute bottom-1.5 right-1.5 rounded-full bg-black/70 text-cream text-[10px] font-medium px-2 py-0.5 capitalize">
            {draft.designIntensity}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 p-4">
        {/* Designed headline preview */}
        {draft.designHeadline && (
          <div className="rounded-lg border border-white/[0.06] bg-onyx px-3 py-2">
            <p className="text-[10px] text-ash uppercase tracking-wider mb-0.5">Headline burned in</p>
            <p className="text-sm text-cream font-semibold leading-tight">{draft.designHeadline}</p>
            {draft.designSubhead && (
              <p className="text-xs text-ash mt-0.5">{draft.designSubhead}</p>
            )}
          </div>
        )}

        {/* Filter picker */}
        <div>
          <label className="text-xs text-ash uppercase tracking-wider mb-1 block">Filter</label>
          <select
            value={draft.filter}
            onChange={(e) => onChange({ filter: e.target.value as FilterName })}
            className="w-full rounded-lg bg-onyx border border-white/[0.08] text-cream text-sm px-3 py-1.5 focus:outline-none focus:border-cream/30"
          >
            {(Object.keys(FILTERS) as FilterName[]).map((f) => (
              <option key={f} value={f}>{FILTERS[f].label}</option>
            ))}
          </select>
        </div>

        {/* Caption */}
        <div>
          <label className="text-xs text-ash uppercase tracking-wider mb-1 block">Caption</label>
          <textarea
            value={draft.caption}
            onChange={(e) => onChange({ caption: e.target.value })}
            rows={4}
            className="w-full rounded-lg bg-onyx border border-white/[0.08] text-cream text-sm px-3 py-2 resize-none focus:outline-none focus:border-cream/30 leading-relaxed"
          />
        </div>

        {/* Hashtags */}
        <div>
          <label className="text-xs text-ash uppercase tracking-wider mb-1.5 block">Hashtags</label>
          <div className="flex flex-wrap gap-1.5">
            {draft.hashtags.map((tag) => (
              <span
                key={tag}
                className="inline-block rounded-full bg-onyx border border-white/[0.08] px-2.5 py-0.5 text-xs text-cream"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>

        {/* Platform toggles */}
        <div>
          <label className="text-xs text-ash uppercase tracking-wider mb-1.5 block">Platforms</label>
          <div className="flex gap-2">
            {(['instagram', 'facebook'] as const).map((p) => (
              <button
                key={p}
                onClick={() => togglePlatform(p)}
                className={`flex-1 rounded-lg border text-xs py-1.5 capitalize transition-colors ${
                  draft.platforms.includes(p)
                    ? 'border-cream/30 bg-cream/10 text-cream'
                    : 'border-white/[0.08] bg-onyx text-ash hover:text-bone'
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

// ─── Carousel sub-components ─────────────────────────────────────────────────

function CarouselItemCard({
  draft,
  index,
  onFilterChange,
}: {
  draft: DraftCard
  index: number
  onFilterChange: (id: string, filter: FilterName) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgLoaded, setImgLoaded] = useState(false)

  useEffect(() => {
    if (!canvasRef.current || !imgLoaded || !imgRef.current) return
    applyFilterToCanvas(canvasRef.current, imgRef.current, draft.filter)
  }, [draft.filter, imgLoaded])

  useEffect(() => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { imgRef.current = img; setImgLoaded(true) }
    img.src = draft.photo.url
  }, [draft.photo.url])

  return (
    <div className="flex-none flex flex-col gap-2" style={{ width: '9rem' }}>
      <div className="relative aspect-square bg-onyx rounded-lg overflow-hidden">
        <span className="absolute top-1.5 left-1.5 z-10 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center text-xs font-semibold text-cream">
          {index + 1}
        </span>
        {!imgLoaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-ash text-xs">Loading…</span>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={`w-full h-full object-cover transition-opacity duration-200 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
        />
      </div>
      <select
        value={draft.filter}
        onChange={(e) => onFilterChange(draft.id, e.target.value as FilterName)}
        className="w-full rounded-lg bg-onyx border border-white/[0.08] text-cream text-xs px-2 py-1.5 focus:outline-none focus:border-cream/30"
      >
        {(Object.keys(FILTERS) as FilterName[]).map((f) => (
          <option key={f} value={f}>{FILTERS[f].label}</option>
        ))}
      </select>
    </div>
  )
}

function CarouselDraftCard({
  drafts,
  caption,
  hashtags,
  platforms,
  onCaptionChange,
  onPlatformsChange,
  onFilterChange,
}: {
  drafts: DraftCard[]
  caption: string
  hashtags: string[]
  platforms: ('instagram' | 'facebook')[]
  onCaptionChange: (c: string) => void
  onPlatformsChange: (p: ('instagram' | 'facebook')[]) => void
  onFilterChange: (draftId: string, filter: FilterName) => void
}) {
  const togglePlatform = (p: 'instagram' | 'facebook') => {
    const has = platforms.includes(p)
    const next = has ? platforms.filter((x) => x !== p) : [...platforms, p]
    if (next.length > 0) onPlatformsChange(next)
  }

  return (
    <div className="rounded-2xl border border-amber-500/20 bg-obsidian overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
          Carousel · {drafts.length} images
        </span>
        <span className="text-xs text-smoke">Scroll to see all · select a filter per image</span>
      </div>

      {/* Horizontal filmstrip */}
      <div className="flex gap-3 px-4 pb-4 overflow-x-auto">
        {drafts.map((draft, i) => (
          <CarouselItemCard
            key={draft.id}
            draft={draft}
            index={i}
            onFilterChange={onFilterChange}
          />
        ))}
      </div>

      {/* Shared caption, hashtags, platforms */}
      <div className="flex flex-col gap-3 p-4 border-t border-white/[0.06]">
        <div>
          <label className="text-xs text-ash uppercase tracking-wider mb-1 block">
            Caption{' '}
            <span className="text-smoke normal-case">(shared across all {drafts.length} images)</span>
          </label>
          <textarea
            value={caption}
            onChange={(e) => onCaptionChange(e.target.value)}
            rows={4}
            className="w-full rounded-lg bg-onyx border border-white/[0.08] text-cream text-sm px-3 py-2 resize-none focus:outline-none focus:border-cream/30 leading-relaxed"
          />
        </div>

        <div>
          <label className="text-xs text-ash uppercase tracking-wider mb-1.5 block">Hashtags</label>
          <div className="flex flex-wrap gap-1.5">
            {hashtags.map((tag) => (
              <span
                key={tag}
                className="inline-block rounded-full bg-onyx border border-white/[0.08] px-2.5 py-0.5 text-xs text-cream"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-ash uppercase tracking-wider mb-1.5 block">Platforms</label>
          <div className="flex gap-2 max-w-xs">
            {(['instagram', 'facebook'] as const).map((p) => (
              <button
                key={p}
                onClick={() => togglePlatform(p)}
                className={`flex-1 rounded-lg border text-xs py-1.5 capitalize transition-colors ${
                  platforms.includes(p)
                    ? 'border-cream/30 bg-cream/10 text-cream'
                    : 'border-white/[0.08] bg-onyx text-ash hover:text-bone'
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
      done ? 'text-emerald' : active ? 'text-cream' : 'text-smoke'
    }`}>
      <span className="w-4 text-center">
        {done ? '✓' : active ? '⟳' : '○'}
      </span>
      {label}
    </div>
  )
}

// ─── Scoring helper — pick best N photos ─────────────────────────────────────

// Concurrency-limited photo analysis. Used by both auto (scoreAndSelect) and
// manual (analyzeSelected) flows. Gemini free tier is ~15 RPM so we cap at 3.
async function analyzePhotos(
  photos: BreweryPhoto[],
): Promise<{ photo: BreweryPhoto; analysis: PhotoAnalysis }[]> {
  const CONCURRENCY = 3
  const results: PromiseSettledResult<{ photo: BreweryPhoto; analysis: PhotoAnalysis }>[] = []
  for (let i = 0; i < photos.length; i += CONCURRENCY) {
    const chunk = photos.slice(i, i + CONCURRENCY)
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
      `[analyzePhotos] ${failures.length}/${results.length} analyses failed.`,
      (failures[0] as PromiseRejectedResult).reason,
    )
  }

  const ok = results
    .filter((r): r is PromiseFulfilledResult<{ photo: BreweryPhoto; analysis: PhotoAnalysis }> =>
      r.status === 'fulfilled',
    )
    .map((r) => r.value)

  if (ok.length === 0) {
    throw new Error('All photo analyses failed — check the server console for the underlying Gemini/Groq/Mistral error.')
  }
  return ok
}

// Auto mode: score a pool of candidates and pick the top N with filter variety.
async function scoreAndSelect(
  photos: BreweryPhoto[],
  count: number,
): Promise<{ photo: BreweryPhoto; analysis: PhotoAnalysis }[]> {
  const candidates = photos.slice(0, Math.min(photos.length, Math.max(count + 4, 8)))
  const scored = (await analyzePhotos(candidates)).sort(
    (a, b) => b.analysis.score - a.analysis.score,
  )

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

type Mode = 'auto' | 'manual'

export default function UploadPage() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('setup')
  const [mode, setMode] = useState<Mode>('auto')
  const [photos, setPhotos] = useState<BreweryPhoto[]>([])
  const [photosLoading, setPhotosLoading] = useState(true)
  const [photosError, setPhotosError] = useState<string | null>(null)
  const [libraryView, setLibraryView] = useState<'available' | 'archive'>('available')
  const [postCount, setPostCount] = useState(3)
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<DraftCard[]>([])
  const [progressSteps, setProgressSteps] = useState<{ label: string; done: boolean }[]>([])
  const [activeStep, setActiveStep] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [carouselMode, setCarouselMode] = useState(false)
  const [carouselCaption, setCarouselCaption] = useState('')
  const [carouselHashtags, setCarouselHashtags] = useState<string[]>([])
  const [carouselPlatforms, setCarouselPlatforms] = useState<('instagram' | 'facebook')[]>(['instagram'])
  // Pre-generated during the AI pipeline so toggling Carousel is instant.
  const [carouselSuggestedCaption, setCarouselSuggestedCaption] = useState<string | null>(null)
  const [carouselSuggestedHashtags, setCarouselSuggestedHashtags] = useState<string[] | null>(null)
  const [lightboxPhoto, setLightboxPhoto] = useState<BreweryPhoto | null>(null)
  const canvasWorkRef = useRef<HTMLCanvasElement | null>(null)

  const togglePhotoSelection = useCallback((name: string) => {
    setSelectedNames((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else if (next.size < 10) next.add(name)
      return next
    })
  }, [])

  // When switching modes, clear out the mode-specific state
  const switchMode = useCallback((next: Mode) => {
    setMode(next)
    setSelectedNames(new Set())
  }, [])

  // Load photo library — called on mount, view toggle, and after uploads complete
  const refreshPhotos = useCallback((view: 'available' | 'archive', opts?: { keepSelection?: boolean }) => {
    setPhotosLoading(true)
    if (!opts?.keepSelection) setSelectedNames(new Set())
    fetch(`/api/upload/photos?view=${view}`)
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

  useEffect(() => {
    refreshPhotos(libraryView)
  }, [libraryView, refreshPhotos])

  const handleUploadsComplete = useCallback((result: { uploaded: Array<{ url: string; name: string }>; failed: Array<{ name: string; error: string }> }) => {
    if (result.uploaded.length === 0) return
    if (libraryView !== 'available') setLibraryView('available')
    else refreshPhotos('available', { keepSelection: true })
    setToast(
      result.failed.length > 0
        ? `${result.uploaded.length} uploaded, ${result.failed.length} failed`
        : `${result.uploaded.length} photo${result.uploaded.length !== 1 ? 's' : ''} added`,
    )
  }, [libraryView, refreshPhotos])

  const updateDraft = useCallback((id: string, patch: Partial<DraftCard>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  }, [])

  const toggleCarouselMode = useCallback(() => {
    setCarouselMode((prev) => {
      if (!prev && drafts.length > 0) {
        // Prefer the pre-generated carousel caption; fall back to draft[0] if
        // generation hasn't returned yet or failed.
        setCarouselCaption(carouselSuggestedCaption ?? drafts[0].caption)
        setCarouselHashtags(carouselSuggestedHashtags ?? drafts[0].hashtags)
        setCarouselPlatforms(drafts[0].platforms)
      }
      return !prev
    })
  }, [drafts, carouselSuggestedCaption, carouselSuggestedHashtags])

  // ── Run the AI design pass server-side: returns a fresh JPEG URL with the
  // headline/subhead/badge/logo composited over the filtered image. ───────────
  const designImage = useCallback(
    async (sourceUrl: string): Promise<{
      url: string
      headline: string
      subhead: string | null
      badge: string | null
      intensity: 'subtle' | 'bold' | 'heavy'
    } | null> => {
      try {
        const res = await fetch('/api/upload/design', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageUrl: sourceUrl, handle: '@district6bangalore' }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          const msg = (err as { error?: string }).error ?? `HTTP ${res.status}`
          console.error('[design] FAILED:', msg)
          // Make this VISIBLE — silent failure was hiding real bugs from the user
          setToast(`Design step failed: ${msg.slice(0, 120)}`)
          return null
        }
        const result = await res.json()
        // Surface diagnostic flags as a one-time toast so we can SEE if the
        // AI edit ran and whether fonts loaded for the text overlay.
        const flags: string[] = []
        if (result.ai_edit_applied === false) {
          flags.push(`AI edit skipped: ${result.ai_edit_error ?? 'unknown'}`)
        } else if (result.ai_edit_provider) {
          flags.push(`AI grade: ${result.ai_edit_provider}`)
        }
        if (result.fonts_loaded === false) {
          flags.push('fonts NOT loaded — text will be missing')
        }
        if (result.headline_fallback) {
          flags.push(`headline AI failed (${String(result.headline_fallback).slice(0, 60)}…) — using fallback`)
        }
        if (flags.length > 0) setToast(flags.join(' · '))
        return result
      } catch (err) {
        const msg = (err as Error).message
        console.error('[design] FAILED:', msg)
        setToast(`Design step failed: ${msg.slice(0, 120)}`)
        return null
      }
    },
    [],
  )

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
    // Resolve which photos to process based on mode
    let inputPhotos: BreweryPhoto[]
    let targetCount: number
    if (mode === 'manual') {
      inputPhotos = photos.filter((p) => selectedNames.has(p.name))
      targetCount = inputPhotos.length
      if (targetCount === 0) {
        setToast('Pick at least one photo first.')
        return
      }
    } else {
      inputPhotos = photos
      targetCount = postCount
    }

    setPhase('generating')
    // Reset carousel state — a fresh run gets a fresh suggested caption.
    setCarouselMode(false)
    setCarouselSuggestedCaption(null)
    setCarouselSuggestedHashtags(null)

    const firstStepLabel =
      mode === 'manual'
        ? `Analysing ${targetCount} selected photo${targetCount !== 1 ? 's' : ''}…`
        : 'Scoring photos with Gemini Vision…'

    const carouselStepIdx = targetCount >= 2 ? targetCount + 1 : -1
    const steps = [
      { label: firstStepLabel, done: false },
      ...Array.from({ length: targetCount }, (_, i) => ({
        label: `Generating post ${i + 1}/${targetCount}…`,
        done: false,
      })),
      ...(carouselStepIdx >= 0 ? [{ label: 'Drafting carousel caption…', done: false }] : []),
      { label: 'Uploading edited images…', done: false },
    ]
    setProgressSteps(steps)
    setActiveStep(0)

    try {
      // Step 0: get analyses for the chosen photos
      const selected =
        mode === 'manual'
          ? await analyzePhotos(inputPhotos)
          : await scoreAndSelect(inputPhotos, targetCount)
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

      // Kick off carousel caption in parallel with image uploads so toggling
      // Carousel in the review phase is instant. Non-blocking — if it fails,
      // the toggle falls back to the first per-photo caption.
      const carouselCaptionPromise: Promise<void> = generated.length >= 2
        ? fetch('/api/ai/generate-carousel-caption', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ analyses: generated.map((g) => g.analysis) }),
          })
            .then(async (res) => {
              if (res.ok) {
                const data = await res.json() as CaptionResult
                setCarouselSuggestedCaption(data.caption)
                setCarouselSuggestedHashtags(data.hashtags)
              }
            })
            .catch((e) => console.warn('[carousel-caption] failed:', e))
            .finally(() => {
              if (carouselStepIdx >= 0) {
                setProgressSteps((prev) => {
                  const next = [...prev]
                  next[carouselStepIdx] = { ...next[carouselStepIdx], done: true }
                  return next
                })
              }
            })
        : Promise.resolve()

      // Upload edited images in parallel with the carousel caption request,
      // then run the design pass per image (overlay + headline + logo).
      const uploadsPromise = Promise.all(
        generated.map(async (d) => {
          const editedImageUrl = await renderAndUploadFiltered(d)
          // Don't block on design — if it fails, the filtered image still works
          // and the card falls back to that.
          let designed = null as Awaited<ReturnType<typeof designImage>>
          if (editedImageUrl) designed = await designImage(editedImageUrl)
          return {
            ...d,
            editedImageUrl,
            designedImageUrl: designed?.url,
            designHeadline: designed?.headline,
            designSubhead: designed?.subhead ?? null,
            designBadge: designed?.badge ?? null,
            designIntensity: designed?.intensity,
          }
        }),
      )

      const [withUploads] = await Promise.all([uploadsPromise, carouselCaptionPromise])
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
  }, [mode, photos, postCount, selectedNames, renderAndUploadFiltered, designImage])

  // ── Save all drafts ────────────────────────────────────────────────────────
  const handleSaveAll = useCallback(async () => {
    setSaving(true)
    try {
      if (carouselMode && drafts.length >= 2) {
        // Bundle all photos into a single carousel draft. Prefer designed URLs
        // (filter + overlay) when available; fall back to filter-only.
        const uploadedDrafts = await Promise.all(
          drafts.map(async (d) => {
            let editedUrl = d.editedImageUrl
            if (!editedUrl || d.filter !== d.analysis.suggestedFilter) {
              editedUrl = await renderAndUploadFiltered(d)
            }
            return { ...d, editedImageUrl: editedUrl ?? undefined }
          }),
        )

        const imageUrls = uploadedDrafts.map((d) => d.photo.url)
        const editedImageUrls = uploadedDrafts.map((d) => d.designedImageUrl ?? d.editedImageUrl ?? d.photo.url)

        const res = await fetch('/api/drafts/bulk-save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            drafts: [{
              image_url: imageUrls[0],
              edited_image_url: editedImageUrls[0],
              filter_applied: drafts[0].filter,
              caption: carouselCaption,
              hashtags: carouselHashtags,
              platforms: carouselPlatforms,
              carousel: true,
              image_urls: imageUrls,
              edited_image_urls: editedImageUrls,
            }],
          }),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error((err as { error?: string }).error ?? 'Save failed')
        }

        setToast(`Carousel draft saved (${drafts.length} images) — opening /drafts…`)
      } else {
        // Normal mode: one draft per photo. Prefer the designed URL (filter +
        // overlay) so the published post uses it; fall back to filter-only.
        const finalized = await Promise.all(
          drafts.map(async (d) => {
            let editedUrl = d.editedImageUrl
            if (!editedUrl || d.filter !== d.analysis.suggestedFilter) {
              editedUrl = await renderAndUploadFiltered(d)
            }
            return {
              image_url: d.photo.url,
              edited_image_url: d.designedImageUrl ?? editedUrl,
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
        setToast(`${count} draft${count !== 1 ? 's' : ''} saved — opening /drafts…`)
      }

      router.refresh()
      setTimeout(() => router.push('/drafts'), 800)
    } catch (err) {
      setToast(`Error: ${String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [drafts, carouselMode, carouselCaption, carouselHashtags, carouselPlatforms, renderAndUploadFiltered, router])

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-ink text-cream">
      {/* Hidden off-screen canvas for filter rendering */}
      <canvas
        ref={canvasWorkRef}
        style={{ position: 'absolute', left: '-9999px', top: '-9999px' }}
        aria-hidden
      />

      {/* Header */}
      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-10">

        {/* ── SETUP PHASE ─────────────────────────────────────────────────── */}
        {phase === 'setup' && (
          <div className="flex flex-col gap-8">
            <div>
              <h1 className="text-2xl font-bold text-cream">Quick Post Generator</h1>
              <p className="text-ash text-sm mt-1">
                Let BrewCast pick the best photos for you, or hand-pick the ones you want.
              </p>
            </div>

            {/* Mode toggle */}
            <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/[0.06] bg-obsidian p-1.5">
              <button
                onClick={() => switchMode('auto')}
                className={`px-4 py-3 rounded-xl text-sm font-medium transition-colors text-left ${
                  mode === 'auto'
                    ? 'bg-cream text-ink'
                    : 'text-ash hover:text-cream hover:bg-onyx'
                }`}
              >
                <div className="font-semibold">Let BrewCast pick the best fit</div>
                <div className={`text-xs mt-0.5 ${mode === 'auto' ? 'text-cream' : 'text-ash'}`}>
                  Choose how many posts to be drafted
                </div>
              </button>
              <button
                onClick={() => switchMode('manual')}
                className={`px-4 py-3 rounded-xl text-sm font-medium transition-colors text-left ${
                  mode === 'manual'
                    ? 'bg-cream text-ink'
                    : 'text-ash hover:text-cream hover:bg-onyx'
                }`}
              >
                <div className="font-semibold">I&apos;ll pick the photos myself</div>
                <div className={`text-xs mt-0.5 ${mode === 'manual' ? 'text-cream' : 'text-ash'}`}>
                  Multi-select up to 10 photos from the library
                </div>
              </button>
            </div>

            {/* Photo library */}
            <PhotoUploader onUploadsComplete={handleUploadsComplete}>
            <div>
              <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
                <div className="flex items-baseline gap-3">
                  <h2 className="text-sm font-semibold text-bone uppercase tracking-wider">
                    {libraryView === 'available' ? 'Photo Library' : 'Archive'}
                    {!photosLoading && photos.length > 0 && (
                      <span className="ml-2 text-ash font-normal normal-case">
                        ({photos.length} photo{photos.length !== 1 ? 's' : ''})
                      </span>
                    )}
                  </h2>
                  <div className="flex items-center gap-1 rounded-full hairline bg-onyx p-0.5">
                    <button
                      type="button"
                      onClick={() => setLibraryView('available')}
                      className={`px-3 py-1 rounded-full text-xs transition-colors ${
                        libraryView === 'available' ? 'bg-cream text-ink' : 'text-ash hover:text-cream'
                      }`}
                    >
                      Available
                    </button>
                    <button
                      type="button"
                      onClick={() => setLibraryView('archive')}
                      className={`px-3 py-1 rounded-full text-xs transition-colors ${
                        libraryView === 'archive' ? 'bg-cream text-ink' : 'text-ash hover:text-cream'
                      }`}
                    >
                      Archive
                    </button>
                  </div>
                </div>
                {mode === 'manual' && selectedNames.size > 0 && libraryView === 'available' && (
                  <button
                    onClick={() => setSelectedNames(new Set())}
                    className="text-xs text-ash hover:text-bone transition-colors"
                  >
                    Clear selection ({selectedNames.size})
                  </button>
                )}
              </div>
              {libraryView === 'archive' && (
                <p className="text-xs text-smoke mb-3">
                  Photos used in a published post. Auto-deleted 30 days after publication.
                </p>
              )}

              {photosLoading && (
                <div className="flex items-center gap-2 text-ash text-sm">
                  <span className="animate-spin">⟳</span> Loading photos…
                </div>
              )}

              {photosError && (
                <div className="rounded-xl border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                  Could not load photo library: {photosError}
                </div>
              )}

              {!photosLoading && photos.length === 0 && !photosError && (
                <div className="rounded-xl border border-white/[0.06] bg-obsidian px-5 py-8 text-center">
                  <p className="text-ash text-sm">No photos found in the brewery-photos bucket.</p>
                  <p className="text-smoke text-xs mt-1">
                    Upload photos to the <code className="text-cream">brewery-photos</code> Supabase Storage bucket
                    or add them to <code className="text-cream">public/brewery-photos/</code>.
                  </p>
                </div>
              )}

              {!photosLoading && photos.length > 0 && (
                <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
                  {photos.map((photo) => {
                    const isSelected = selectedNames.has(photo.name)
                    const interactive = mode === 'manual' && libraryView === 'available'
                    return (
                      <div
                        key={photo.name}
                        className={`group relative aspect-square w-full cursor-zoom-in rounded-lg border transition-all duration-200 hover:scale-110 hover:z-20 hover:shadow-2xl hover:shadow-black/60 ${
                          isSelected
                            ? 'border-cream/30 ring-2 ring-amber-500/40'
                            : 'border-white/[0.06] hover:border-white/[0.20]'
                        } ${libraryView === 'archive' ? 'opacity-60 hover:opacity-100' : ''}`}
                        onClick={() => setLightboxPhoto(photo)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setLightboxPhoto(photo)
                          }
                        }}
                        aria-label={`Preview ${photo.name}`}
                      >
                        <div className="absolute inset-0 overflow-hidden rounded-lg">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={photo.url}
                            alt={photo.name}
                            className={`w-full h-full object-cover transition-opacity ${
                              interactive && !isSelected ? 'opacity-80 group-hover:opacity-100' : ''
                            }`}
                          />
                        </div>
                        {/* Score badge for analyzed photos in the available view */}
                        {libraryView === 'available' && typeof photo.score === 'number' && (
                          <div className="absolute top-1.5 left-1.5 z-10 rounded-full bg-black/70 text-cream text-[10px] font-semibold px-1.5 py-0.5 tabular-nums pointer-events-none">
                            {photo.score}
                          </div>
                        )}
                        {libraryView === 'available' && photo.analyzed === false && (
                          <div className="absolute top-1.5 left-1.5 z-10 rounded-full bg-black/70 text-amber-300 text-[10px] font-semibold px-1.5 py-0.5 pointer-events-none">
                            …
                          </div>
                        )}
                        {libraryView === 'archive' && (
                          <div className="absolute bottom-1.5 left-1.5 z-10 rounded-full bg-black/70 text-cream text-[10px] font-medium px-2 py-0.5 pointer-events-none">
                            published
                          </div>
                        )}
                        {interactive && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              togglePhotoSelection(photo.name)
                            }}
                            className={`absolute top-1.5 right-1.5 z-10 w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-all hover:scale-125 ${
                              isSelected
                                ? 'border-cream bg-cream text-ink'
                                : 'border-white/60 bg-black/40 text-transparent group-hover:border-white group-hover:text-white/60'
                            }`}
                            aria-pressed={isSelected}
                            aria-label={isSelected ? 'Deselect photo' : 'Select photo'}
                          >
                            ✓
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            </PhotoUploader>

            {/* Action bar */}
            {mode === 'auto' ? (
              <div className="rounded-2xl border border-white/[0.06] bg-obsidian p-6 flex flex-col sm:flex-row items-start sm:items-center gap-6">
                <div className="flex flex-col gap-1.5 flex-1">
                  <label htmlFor="post-count" className="text-sm font-medium text-cream">
                    Let BrewCast pick the best fit — choose how many posts to be drafted
                  </label>
                  <p className="text-xs text-ash">
                    AI will pick the best {postCount} photo{postCount !== 1 ? 's' : ''}, apply filters,
                    and write captions automatically.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex items-center rounded-full hairline bg-onyx overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setPostCount(Math.max(1, postCount - 1))}
                      disabled={postCount <= 1}
                      aria-label="Decrease count"
                      className="px-3.5 py-2 text-cream hover:bg-slate disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-lg leading-none"
                    >
                      −
                    </button>
                    <div className="px-4 py-2 text-cream font-medium text-base min-w-[2.75rem] text-center tabular-nums">
                      {postCount}
                    </div>
                    <button
                      type="button"
                      onClick={() => setPostCount(Math.min(10, postCount + 1))}
                      disabled={postCount >= 10}
                      aria-label="Increase count"
                      className="px-3.5 py-2 text-cream hover:bg-slate disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-lg leading-none"
                    >
                      +
                    </button>
                  </div>
                  <button
                    onClick={handleGenerate}
                    disabled={photos.length === 0 || photosLoading || libraryView === 'archive'}
                    title={libraryView === 'archive' ? 'Switch to Available to generate posts' : undefined}
                    className="px-6 py-2.5 rounded-full bg-cream hover:bg-bone disabled:opacity-40 disabled:cursor-not-allowed text-ink font-medium text-sm transition-colors"
                  >
                    Generate
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-white/[0.06] bg-obsidian p-6 flex flex-col sm:flex-row items-start sm:items-center gap-6">
                <div className="flex flex-col gap-1.5 flex-1">
                  <p className="text-sm font-medium text-cream">
                    {selectedNames.size === 0
                      ? 'Tap photos above to add them to your batch'
                      : `${selectedNames.size} photo${selectedNames.size !== 1 ? 's' : ''} selected`}
                  </p>
                  <p className="text-xs text-ash">
                    BrewCast will analyse each selected photo, suggest a filter, and write a caption.
                    {selectedNames.size >= 10 && ' (Max 10 reached)'}
                  </p>
                </div>

                <button
                  onClick={handleGenerate}
                  disabled={selectedNames.size === 0 || photosLoading || libraryView === 'archive'}
                  title={libraryView === 'archive' ? 'Switch to Available to generate posts' : undefined}
                  className="px-6 py-2.5 rounded-full bg-cream hover:bg-bone disabled:opacity-40 disabled:cursor-not-allowed text-ink font-medium text-sm transition-colors"
                >
                  Generate {selectedNames.size > 0 && `(${selectedNames.size})`}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── GENERATING PHASE ────────────────────────────────────────────── */}
        {phase === 'generating' && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8">
            <div className="text-center">
              <div className="text-4xl mb-4 animate-spin inline-block">⟳</div>
              <h2 className="text-xl font-bold text-cream">AI is working its magic…</h2>
              <p className="text-ash text-sm mt-1">Analysing photos and writing captions</p>
            </div>

            <div className="flex flex-col gap-2 rounded-2xl border border-white/[0.06] bg-obsidian px-8 py-6 w-full max-w-sm">
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
                <h1 className="text-2xl font-bold text-cream">Review Your Posts</h1>
                <p className="text-ash text-sm mt-1">
                  Edit captions, swap filters, or toggle platforms before saving.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { setPhase('setup'); setCarouselMode(false) }}
                  className="px-4 py-2 rounded-lg border border-white/[0.08] text-ash hover:text-cream hover:border-white/[0.10] text-sm transition-colors"
                >
                  ← Start over
                </button>
                {drafts.length >= 2 && (
                  <button
                    onClick={toggleCarouselMode}
                    className={`px-4 py-2 rounded-lg border text-sm transition-colors ${
                      carouselMode
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                        : 'border-white/[0.08] text-ash hover:text-cream hover:border-white/[0.10]'
                    }`}
                  >
                    {carouselMode ? '◼ Carousel on' : '◻ Carousel'}
                  </button>
                )}
                <button
                  onClick={handleSaveAll}
                  disabled={saving}
                  className="px-5 py-2 rounded-lg bg-cream hover:bg-bone disabled:opacity-50 text-ink font-semibold text-sm transition-colors"
                >
                  {saving
                    ? 'Saving…'
                    : carouselMode
                    ? 'Save Carousel Draft'
                    : `Save All to Drafts (${drafts.length})`}
                </button>
              </div>
            </div>

            {carouselMode ? (
              <CarouselDraftCard
                drafts={drafts}
                caption={carouselCaption}
                hashtags={carouselHashtags}
                platforms={carouselPlatforms}
                onCaptionChange={setCarouselCaption}
                onPlatformsChange={setCarouselPlatforms}
                onFilterChange={(id, filter) => updateDraft(id, { filter })}
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {drafts.map((draft) => (
                  <PhotoCard
                    key={draft.id}
                    draft={draft}
                    onChange={(patch) => updateDraft(draft.id, patch)}
                  />
                ))}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                onClick={handleSaveAll}
                disabled={saving}
                className="px-6 py-2.5 rounded-xl bg-cream hover:bg-bone disabled:opacity-50 text-ink font-semibold text-sm transition-colors"
              >
                {saving
                  ? 'Saving…'
                  : carouselMode
                  ? 'Save Carousel Draft'
                  : `Save All to Drafts (${drafts.length})`}
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

      {/* Full-size lightbox */}
      {lightboxPhoto && (
        <Lightbox photo={lightboxPhoto} onClose={() => setLightboxPhoto(null)} />
      )}
    </div>
  )
}
