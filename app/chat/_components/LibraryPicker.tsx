'use client'

import { useEffect, useState } from 'react'
import type { BreweryPhoto } from '@/app/api/upload/photos/route'

interface LibraryPickerProps {
  open: boolean
  onClose: () => void
  onConfirm: (photos: BreweryPhoto[]) => void
}

const MAX_PICK = 10

export default function LibraryPicker({ open, onClose, onConfirm }: LibraryPickerProps) {
  const [photos, setPhotos] = useState<BreweryPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setSelected(new Set())
    fetch('/api/upload/photos?view=available')
      .then((r) => r.json())
      .then(({ photos: p }: { photos: BreweryPhoto[] }) => {
        setPhotos(p)
        setLoading(false)
      })
      .catch((err) => {
        setError(String(err))
        setLoading(false)
      })
  }, [open])

  if (!open) return null

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else if (next.size < MAX_PICK) next.add(name)
      return next
    })
  }

  const handleConfirm = () => {
    const picked = photos.filter((p) => selected.has(p.name))
    onConfirm(picked)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border border-white/[0.08] bg-obsidian overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold text-cream uppercase tracking-wider">Photo Library</h2>
            <p className="text-xs text-ash mt-0.5">
              {selected.size === 0
                ? `Pick up to ${MAX_PICK} photos to attach`
                : `${selected.size} selected${selected.size >= MAX_PICK ? ` (max ${MAX_PICK})` : ''}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ash hover:text-cream text-sm"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
          {loading && (
            <div className="flex items-center gap-2 text-ash text-sm">
              <span className="animate-spin">⟳</span> Loading photos…
            </div>
          )}
          {error && (
            <div className="rounded-xl border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-300">
              Could not load photo library: {error}
            </div>
          )}
          {!loading && !error && photos.length === 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-onyx px-5 py-8 text-center">
              <p className="text-ash text-sm">No photos in the library yet.</p>
              <p className="text-smoke text-xs mt-1">Upload some from /upload first.</p>
            </div>
          )}
          {!loading && photos.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {photos.map((photo) => {
                const isSelected = selected.has(photo.name)
                return (
                  <button
                    key={photo.name}
                    type="button"
                    onClick={() => toggle(photo.name)}
                    className={`group relative aspect-square w-full overflow-hidden rounded-lg border transition-all ${
                      isSelected
                        ? 'border-cream/30 ring-2 ring-amber-500/40'
                        : 'border-white/[0.06] hover:border-white/[0.10]'
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.url}
                      alt={photo.name}
                      className={`w-full h-full object-cover transition-opacity ${
                        !isSelected ? 'opacity-80 group-hover:opacity-100' : ''
                      }`}
                    />
                    {typeof photo.score === 'number' && (
                      <div className="absolute top-1.5 left-1.5 rounded-full bg-black/70 text-cream text-[10px] font-semibold px-1.5 py-0.5 tabular-nums">
                        {photo.score}
                      </div>
                    )}
                    <div
                      className={`absolute top-1.5 right-1.5 w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-all ${
                        isSelected
                          ? 'border-cream bg-cream text-ink'
                          : 'border-white/60 bg-black/30 text-transparent group-hover:border-white'
                      }`}
                    >
                      ✓
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-sm text-ash hover:text-cream transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={selected.size === 0}
            className="px-4 py-1.5 rounded-lg bg-cream hover:bg-bone disabled:opacity-40 disabled:cursor-not-allowed text-ink font-medium text-sm transition-colors"
          >
            Attach {selected.size > 0 && `(${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  )
}
