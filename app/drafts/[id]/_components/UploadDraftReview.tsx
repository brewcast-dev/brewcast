'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { approveUploadDraft, queueUploadDraft, deleteUploadDraft } from '../../actions'

export interface UploadDraft {
  id: string
  brewery_id: string
  image_url: string
  edited_image_url: string | null
  filter_applied: string
  caption: string
  hashtags: string[]
  platforms: string[]
  status: string
  scheduled_at: string | null
  created_at: string
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-zinc-700 text-zinc-300',
  approved: 'bg-blue-900 text-blue-300',
  queued: 'bg-amber-900 text-amber-300',
  published: 'bg-green-900 text-green-300',
  failed: 'bg-red-900 text-red-300',
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const istOffset = 5.5 * 60 * 60 * 1000
  const istDate = new Date(date.getTime() + istOffset)
  return istDate.toISOString().slice(0, 16)
}

export default function UploadDraftReview({ draft }: { draft: UploadDraft }) {
  const router = useRouter()
  const [scheduledAt, setScheduledAt] = useState(() => toDatetimeLocal(draft.scheduled_at))
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isPending, startTransition] = useTransition()

  function run(action: () => Promise<void>, onSuccess?: () => void) {
    setError(null)
    startTransition(async () => {
      try {
        await action()
        onSuccess?.()
      } catch (e) {
        setError((e as Error).message)
      }
    })
  }

  const statusStyle = STATUS_STYLES[draft.status] ?? 'bg-zinc-700 text-zinc-300'
  const displayImage = draft.edited_image_url ?? draft.image_url
  const canEdit = draft.status !== 'published' && draft.status !== 'queued'
  const canDelete = draft.status !== 'published' && draft.status !== 'queued'

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      {/* ── Left: content preview ── */}
      <div className="flex-1 min-w-0 space-y-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-bold text-zinc-100">Quick Post Review</h1>
          <span className={`px-2.5 py-0.5 rounded text-xs font-medium ${statusStyle}`}>
            {draft.status}
          </span>
          <span className="px-2.5 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
            from /upload
          </span>
        </div>

        {/* Image */}
        <div className="relative aspect-square max-w-xl rounded-xl overflow-hidden bg-zinc-800">
          <Image src={displayImage} alt="Post media" fill className="object-cover" />
        </div>

        {/* Caption */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Caption</p>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-sm text-zinc-200 whitespace-pre-wrap">{draft.caption}</p>
          </div>
        </div>

        {/* Hashtags */}
        {draft.hashtags?.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Hashtags</p>
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
        )}
      </div>

      {/* ── Right: metadata + actions ── */}
      <div className="lg:w-72 flex-shrink-0 space-y-4">
        {/* Details */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Details</p>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Platforms</dt>
              <dd className="text-zinc-200 capitalize">{(draft.platforms ?? []).join(', ') || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Filter</dt>
              <dd className="text-zinc-200 capitalize">{draft.filter_applied}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Created</dt>
              <dd className="text-zinc-200">{new Date(draft.created_at).toLocaleDateString()}</dd>
            </div>
          </dl>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Approve */}
        {canEdit && (draft.status === 'draft' || draft.status === 'failed') && (
          <button
            onClick={() => run(() => approveUploadDraft(draft.id))}
            disabled={isPending}
            className="w-full px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {isPending ? 'Saving…' : 'Approve'}
          </button>
        )}

        {/* Schedule + queue */}
        {canEdit && (draft.status === 'draft' || draft.status === 'approved' || draft.status === 'failed') && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
              Schedule
            </label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-amber-500 transition-colors"
            />
            <button
              onClick={() => {
                const utcIso = scheduledAt
                  ? new Date(scheduledAt).toISOString()
                  : new Date().toISOString()
                run(
                  () => queueUploadDraft(draft.id, utcIso),
                  () => router.push('/drafts?status=queued'),
                )
              }}
              disabled={isPending}
              className="w-full px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-950 text-sm font-medium transition-colors"
            >
              {isPending ? 'Saving…' : 'Queue for publishing'}
            </button>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Queueing moves this into the publish pipeline (posts table) and schedules it for Instagram/Facebook.
            </p>
          </div>
        )}

        {/* Queued status */}
        {draft.status === 'queued' && (
          <div className="rounded-xl border border-amber-800 bg-amber-950 px-3 py-3 text-sm text-amber-300">
            Queued
            {draft.scheduled_at && ` · ${new Date(draft.scheduled_at).toLocaleString()}`}
          </div>
        )}

        {/* Published status */}
        {draft.status === 'published' && (
          <div className="rounded-xl border border-green-800 bg-green-950 px-3 py-3 text-sm text-green-300">
            Published
          </div>
        )}

        {/* Delete */}
        {canDelete && (
          confirmDelete ? (
            <div className="space-y-2">
              <p className="text-xs text-red-400 text-center">This cannot be undone.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="flex-1 px-3 py-2 rounded-lg border border-zinc-700 text-zinc-400 text-sm hover:bg-zinc-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => run(() => deleteUploadDraft(draft.id), () => router.push('/drafts'))}
                  disabled={isPending}
                  className="flex-1 px-3 py-2 rounded-lg bg-red-900 hover:bg-red-800 disabled:opacity-50 text-red-200 text-sm font-medium transition-colors"
                >
                  {isPending ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={isPending}
              className="w-full px-4 py-2.5 rounded-lg border border-zinc-700 hover:border-red-800 hover:text-red-400 disabled:opacity-50 text-zinc-500 text-sm transition-colors"
            >
              Delete draft
            </button>
          )
        )}
      </div>
    </div>
  )
}
