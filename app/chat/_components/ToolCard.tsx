'use client'

import Image from 'next/image'
import Link from 'next/link'
import UploadZone from './UploadZone'

interface ToolCardProps {
  toolName: string
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | string
  input: Record<string, unknown>
  output?: Record<string, unknown>
  onUploadComplete?: (publicUrl: string) => void
}

export default function ToolCard({ toolName, state, input, output, onUploadComplete }: ToolCardProps) {
  const isRunning = state === 'input-streaming' || state === 'input-available'
  const isError = state === 'output-error'

  // ── generate_image ─────────────────────────────────────────────────────────
  if (toolName === 'generate_image') {
    const url = output?.public_url as string | undefined
    if (isRunning) return <RunningCard label="Generating image…" />
    if (!url) return null
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800 overflow-hidden w-52">
        <div className="relative w-52 h-52 bg-zinc-900">
          <Image src={url} alt="Generated" fill className="object-cover" />
        </div>
        <div className="p-3 space-y-2">
          <p className="text-xs text-zinc-400 truncate">{input.prompt as string}</p>
          <button
            onClick={() => onUploadComplete?.(url)}
            className="w-full text-xs py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold transition-colors"
          >
            Use this image
          </button>
        </div>
      </div>
    )
  }

  // ── request_media_upload ────────────────────────────────────────────────────
  if (toolName === 'request_media_upload') {
    const uploadUrl = output?.upload_url as string | undefined
    const publicUrl = output?.public_url as string | undefined
    if (isRunning) return <RunningCard label="Preparing upload…" />
    if (!uploadUrl) return null
    return (
      <UploadZone
        uploadUrl={uploadUrl}
        publicUrl={publicUrl ?? ''}
        contentType={(input.content_type as string) ?? 'image/jpeg'}
        onComplete={(url) => onUploadComplete?.(url)}
      />
    )
  }

  // ── save_draft ──────────────────────────────────────────────────────────────
  if (toolName === 'save_draft') {
    if (isRunning) return <RunningCard label="Saving draft…" />
    const reviewUrl = output?.review_url as string | undefined
    const thumbnailUrl = output?.thumbnail_url as string | undefined
    const caption = (input.caption as string | undefined) ?? ''
    if (!reviewUrl) return null
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800 p-4 space-y-3 max-w-sm">
        <div className="flex items-center gap-2">
          <span className="text-lg">📋</span>
          <span className="font-semibold text-sm text-zinc-100">Draft saved</span>
        </div>
        {thumbnailUrl && (
          <div className="relative h-28 rounded-lg overflow-hidden bg-zinc-900">
            <Image src={thumbnailUrl} alt="Thumbnail" fill className="object-cover" />
          </div>
        )}
        <p className="text-xs text-zinc-400 line-clamp-2">{caption}</p>
        <Link
          href={reviewUrl}
          className="flex items-center justify-center gap-1.5 w-full py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-sm transition-colors"
        >
          Review draft →
        </Link>
      </div>
    )
  }

  // ── publish_post ────────────────────────────────────────────────────────────
  if (toolName === 'publish_post') {
    if (isRunning) {
      return (
        <div className="rounded-xl border border-zinc-700 bg-zinc-800 p-4 flex items-center gap-3">
          <Spinner />
          <span className="text-sm text-zinc-300">Publishing to {
            (input.platform as string) ?? 'Instagram / Facebook'
          }…</span>
        </div>
      )
    }
    const success = output?.success as boolean | undefined
    if (success) {
      return (
        <div className="rounded-xl border border-green-700 bg-green-950 p-4 flex items-center gap-3">
          <span className="text-xl">✅</span>
          <div>
            <p className="text-sm font-semibold text-green-300">Published!</p>
            <p className="text-xs text-green-500">Post is live on {output?.platform as string}</p>
          </div>
        </div>
      )
    }
    return null
  }

  // ── compose_reel ────────────────────────────────────────────────────────────
  if (toolName === 'compose_reel') {
    if (isRunning) {
      return (
        <div className="rounded-xl border border-zinc-700 bg-zinc-800 p-4 flex items-center gap-3">
          <Spinner />
          <span className="text-sm text-zinc-300">Composing your reel… this takes ~30 seconds</span>
        </div>
      )
    }
    const videoUrl = output?.video_url as string | undefined
    const thumbnail = output?.thumbnail_url as string | undefined
    if (!videoUrl) return null
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800 overflow-hidden max-w-xs">
        {thumbnail && (
          <div className="relative h-48 bg-zinc-900">
            <Image src={thumbnail} alt="Reel thumbnail" fill className="object-cover" />
          </div>
        )}
        <div className="p-3">
          <video src={videoUrl} controls className="w-full rounded" />
        </div>
      </div>
    )
  }

  // ── fetch_analytics ─────────────────────────────────────────────────────────
  if (toolName === 'fetch_analytics') {
    if (isRunning) return <RunningCard label="Fetching analytics…" />
    if (!output) return null
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800 p-4 space-y-3">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Analytics</p>
        <div className="grid grid-cols-3 gap-3">
          <MetricTile label="Reach" value={String(output.total_reach ?? 0)} />
          <MetricTile label="Engagement" value={`${output.avg_engagement_rate ?? 0}%`} />
          <MetricTile
            label="Top post"
            value={output.top_post_id ? '→ View' : '—'}
            href={output.top_post_id ? `/drafts/${output.top_post_id}` : undefined}
          />
        </div>
      </div>
    )
  }

  // ── suggest_ad_targeting ───────────────────────────────────────────────────
  if (toolName === 'suggest_ad_targeting') {
    if (isRunning) return <RunningCard label="Generating ad targeting strategy…" />
    if (!output) return null
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800 p-4 space-y-2 max-w-sm">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Ad targeting</p>
        <div className="text-xs space-y-1 text-zinc-300">
          {!!output.age_range && (
            <p>
              <span className="text-zinc-500">Ages:</span>{' '}
              {(output.age_range as { min: number; max: number }).min}–{(output.age_range as { min: number; max: number }).max}
            </p>
          )}
          {!!output.objective && (
            <p>
              <span className="text-zinc-500">Objective:</span> {String(output.objective)}
            </p>
          )}
          {!!output.daily_budget_usd && (
            <p>
              <span className="text-zinc-500">Daily budget:</span> ${String(output.daily_budget_usd)}/day
            </p>
          )}
          {!!output.interests && (
            <p>
              <span className="text-zinc-500">Interests:</span>{' '}
              {(output.interests as string[]).slice(0, 3).join(', ')}
            </p>
          )}
        </div>
      </div>
    )
  }

  // ── generate_voiceover / generate_background_music ─────────────────────────
  if (toolName === 'generate_voiceover' || toolName === 'generate_background_music') {
    if (isRunning) {
      return (
        <RunningCard
          label={toolName === 'generate_voiceover' ? 'Generating voiceover…' : 'Composing background music…'}
        />
      )
    }
    const audioUrl = output?.audio_url as string | undefined
    if (!audioUrl) return null
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800 p-3 space-y-1.5">
        <p className="text-xs text-zinc-400">
          {toolName === 'generate_voiceover' ? '🎙️ Voiceover' : '🎵 Background music'}
        </p>
        <audio controls src={audioUrl} className="w-full h-8" />
      </div>
    )
  }

  // ── get_brewery_profile ─────────────────────────────────────────────────────
  if (toolName === 'get_brewery_profile') {
    if (isRunning) return <RunningCard label="Loading brewery profile…" />
    return null // silently succeed — the agent uses it internally
  }

  // ── write_caption ────────────────────────────────────────────────────────────
  if (toolName === 'write_caption') {
    if (isRunning) return <RunningCard label="Writing caption…" />
    return null // caption appears in the assistant's text reply
  }

  // ── default: generic running / error card ──────────────────────────────────
  if (isError) {
    return (
      <div className="rounded-xl border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
        Tool error: {toolName}
      </div>
    )
  }
  if (isRunning) {
    return (
      <RunningCard label={`Running ${toolName.replace(/_/g, ' ')}…`} />
    )
  }
  return null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function RunningCard({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2">
      <Spinner />
      <span className="text-sm text-zinc-400">{label}</span>
    </div>
  )
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 text-amber-400 flex-shrink-0"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  )
}

function MetricTile({
  label,
  value,
  href,
}: {
  label: string
  value: string
  href?: string
}) {
  const content = (
    <div className="rounded-lg bg-zinc-900 p-2 text-center">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-sm font-semibold text-zinc-200 mt-0.5">{value}</p>
    </div>
  )
  return href ? <Link href={href}>{content}</Link> : content
}
