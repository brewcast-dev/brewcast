'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import {
  approveUploadDraft,
  queueUploadDraft,
  archiveUploadDraft,
  restoreUploadDraft,
  purgeUploadDraft,
  publishUploadDraftNow,
} from '../../actions'

const ARCHIVE_RETENTION_DAYS = 30

function daysUntilPurge(archivedAt: string): number {
  const archived = new Date(archivedAt).getTime()
  const purgeAt = archived + ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000)))
}

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
  archived_at: string | null
  created_at: string
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate text-bone',
  approved: 'bg-sky-500/15 text-sky-300',
  queued: 'bg-ember/20 text-ember',
  published: 'bg-green-900 text-emerald',
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
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [confirmPurge, setConfirmPurge] = useState(false)
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

  const statusStyle = STATUS_STYLES[draft.status] ?? 'bg-slate text-bone'
  const displayImage = draft.edited_image_url ?? draft.image_url
  const isArchived = !!draft.archived_at
  const canEdit = draft.status !== 'published' && draft.status !== 'queued' && !isArchived
  const canArchive = !isArchived
  const canPublishNow = draft.status !== 'published' && !isArchived

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      {/* ── Left: content preview ── */}
      <div className="flex-1 min-w-0 space-y-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-bold text-cream">Quick Post Review</h1>
          <span className={`px-2.5 py-0.5 rounded text-xs font-medium ${statusStyle}`}>
            {draft.status}
          </span>
          <span className="px-2.5 py-0.5 rounded text-xs font-medium bg-cream/10 text-cream border border-cream/30/20">
            from /upload
          </span>
        </div>

        {/* Image */}
        <div className="relative aspect-square max-w-xl rounded-xl overflow-hidden bg-onyx">
          <Image src={displayImage} alt="Post media" fill className="object-cover" />
        </div>

        {/* Caption */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-ash uppercase tracking-wide">Caption</p>
          <div className="rounded-xl border border-white/[0.06] bg-obsidian p-4">
            <p className="text-sm text-cream whitespace-pre-wrap">{draft.caption}</p>
          </div>
        </div>

        {/* Hashtags */}
        {draft.hashtags?.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-ash uppercase tracking-wide">Hashtags</p>
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
        )}
      </div>

      {/* ── Right: metadata + actions ── */}
      <div className="lg:w-72 flex-shrink-0 space-y-4">
        {/* Details */}
        <div className="rounded-xl border border-white/[0.06] bg-obsidian p-4 space-y-3">
          <p className="text-xs font-medium text-ash uppercase tracking-wide">Details</p>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ash">Platforms</dt>
              <dd className="text-cream capitalize">{(draft.platforms ?? []).join(', ') || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ash">Filter</dt>
              <dd className="text-cream capitalize">{draft.filter_applied}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ash">Created</dt>
              <dd className="text-cream">{new Date(draft.created_at).toLocaleDateString()}</dd>
            </div>
          </dl>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Approve */}
        {canEdit && (draft.status === 'draft' || draft.status === 'failed') && (
          <button
            onClick={() => run(() => approveUploadDraft(draft.id))}
            disabled={isPending}
            className="w-full px-4 py-2.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {isPending ? 'Saving…' : 'Approve'}
          </button>
        )}

        {/* Schedule + queue */}
        {canEdit && (draft.status === 'draft' || draft.status === 'approved' || draft.status === 'failed') && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-ash uppercase tracking-wide">
              Schedule
            </label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="w-full rounded-lg bg-onyx border border-white/[0.08] px-3 py-2 text-sm text-cream focus:outline-none focus:border-cream/30 transition-colors"
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
              className="w-full px-4 py-2.5 rounded-lg bg-cream hover:bg-bone disabled:opacity-50 text-ink text-sm font-medium transition-colors"
            >
              {isPending ? 'Saving…' : 'Queue for publishing'}
            </button>
            <p className="text-xs text-ash leading-relaxed">
              Queueing moves this into the publish pipeline (posts table) and schedules it for Instagram/Facebook.
            </p>
          </div>
        )}

        {/* Queued status */}
        {draft.status === 'queued' && (
          <div className="rounded-xl border border-ember/30 bg-ember/15 px-3 py-3 text-sm text-ember">
            Queued
            {draft.scheduled_at && ` · ${new Date(draft.scheduled_at).toLocaleString()}`}
          </div>
        )}

        {/* Publish Now — bypasses scheduler */}
        {canPublishNow && (
          confirmPublish ? (
            <div className="space-y-2 rounded-xl border border-emerald/30 bg-emerald/10/40 p-3">
              <p className="text-xs text-emerald text-center">
                Publish this to Instagram/Facebook right now?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmPublish(false)}
                  disabled={isPending}
                  className="flex-1 px-3 py-2 rounded-lg border border-white/[0.08] text-ash text-sm hover:bg-onyx transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() =>
                    run(
                      async () => {
                        const { postId } = await publishUploadDraftNow(draft.id)
                        router.push(`/drafts/${postId}`)
                      },
                    )
                  }
                  disabled={isPending}
                  className="flex-1 px-3 py-2 rounded-lg bg-emerald hover:bg-emerald/80 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                >
                  {isPending ? 'Publishing…' : 'Publish'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmPublish(true)}
              disabled={isPending}
              className="w-full px-4 py-2.5 rounded-lg bg-emerald hover:bg-emerald/80 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              Publish now
            </button>
          )
        )}

        {/* Published status */}
        {draft.status === 'published' && (
          <div className="rounded-xl border border-emerald/30 bg-emerald/10 px-3 py-3 text-sm text-emerald">
            Published
          </div>
        )}

        {/* Archive / Restore / Permanent delete */}
        {isArchived ? (
          <div className="space-y-2 rounded-xl border border-ember/30 bg-ember/15/40 p-3">
            <p className="text-xs text-ember text-center">
              In archive · auto-deletes in{' '}
              {daysUntilPurge(draft.archived_at!)} day
              {daysUntilPurge(draft.archived_at!) !== 1 ? 's' : ''}
            </p>
            <button
              onClick={() => run(() => restoreUploadDraft(draft.id))}
              disabled={isPending}
              className="w-full px-3 py-2 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {isPending ? 'Restoring…' : 'Restore'}
            </button>
            {confirmPurge ? (
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmPurge(false)}
                  className="flex-1 px-3 py-2 rounded-lg border border-white/[0.08] text-ash text-xs hover:bg-onyx transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => run(() => purgeUploadDraft(draft.id), () => router.push('/drafts'))}
                  disabled={isPending}
                  className="flex-1 px-3 py-2 rounded-lg bg-red-900 hover:bg-red-800 disabled:opacity-50 text-red-200 text-xs font-medium transition-colors"
                >
                  {isPending ? 'Deleting…' : 'Delete forever'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmPurge(true)}
                disabled={isPending}
                className="w-full px-3 py-2 rounded-lg border border-white/[0.08] hover:border-red-900/50 hover:text-red-400 disabled:opacity-50 text-ash text-xs transition-colors"
              >
                Delete permanently
              </button>
            )}
          </div>
        ) : (
          canArchive && (
            confirmDelete ? (
              <div className="space-y-2">
                <p className="text-xs text-cream text-center">
                  Archive moves this to /drafts?status=archived. You have 30 days to restore.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="flex-1 px-3 py-2 rounded-lg border border-white/[0.08] text-ash text-sm hover:bg-onyx transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => run(() => archiveUploadDraft(draft.id), () => router.push('/drafts'))}
                    disabled={isPending}
                    className="flex-1 px-3 py-2 rounded-lg bg-ember/40 hover:bg-cream disabled:opacity-50 text-cream text-sm font-medium transition-colors"
                  >
                    {isPending ? 'Archiving…' : 'Archive'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={isPending}
                className="w-full px-4 py-2.5 rounded-lg border border-white/[0.08] hover:border-ember/30 hover:text-cream disabled:opacity-50 text-ash text-sm transition-colors"
              >
                Archive draft
              </button>
            )
          )
        )}
      </div>
    </div>
  )
}
