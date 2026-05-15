'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import type { Post, PostStatus } from '@/types/database'
import {
  approvePost,
  queuePost,
  archivePost,
  restorePost,
  purgePost,
  publishPostNow,
} from '../../actions'

const ARCHIVE_RETENTION_DAYS = 30

function daysUntilPurge(archivedAt: string): number {
  const archived = new Date(archivedAt).getTime()
  const purgeAt = archived + ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000)))
}

const STATUS_STYLES: Record<PostStatus, string> = {
  draft: 'bg-slate text-bone',
  approved: 'bg-sky-500/15 text-sky-300',
  queued: 'bg-ember/20 text-ember',
  published: 'bg-green-900 text-emerald',
  failed: 'bg-red-900 text-red-300',
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  // Convert UTC to IST (UTC+5:30) for display
  const istOffset = 5.5 * 60 * 60 * 1000
  const istDate = new Date(date.getTime() + istOffset)
  return istDate.toISOString().slice(0, 16)
}

export default function PostReview({ post }: { post: Post }) {
  const router = useRouter()
  const [scheduledAt, setScheduledAt] = useState(() => toDatetimeLocal(post.scheduled_at))
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

  const [confirmPublish, setConfirmPublish] = useState(false)
  const [confirmPurge, setConfirmPurge] = useState(false)
  const mediaUrls = post.media_urls ?? []
  const statusStyle = STATUS_STYLES[post.status] ?? 'bg-slate text-bone'
  const isArchived = !!post.archived_at
  const canEdit = post.status !== 'published' && !isArchived
  const canArchive = !isArchived
  const canPublishNow = post.status !== 'published' && !isArchived

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      {/* ── Left: content preview ── */}
      <div className="flex-1 min-w-0 space-y-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-cream">Post Review</h1>
          <span className={`px-2.5 py-0.5 rounded text-xs font-medium ${statusStyle}`}>
            {post.status}
          </span>
        </div>

        {/* Video */}
        {post.video_url && (
          <div className="rounded-xl overflow-hidden bg-onyx aspect-video">
            <video
              src={post.video_url}
              controls
              poster={post.thumbnail_url ?? undefined}
              className="w-full h-full object-contain"
            />
          </div>
        )}

        {/* Image grid */}
        {!post.video_url && mediaUrls.length > 0 && (
          <div className={`grid gap-2 ${mediaUrls.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
            {mediaUrls.map((url, i) => (
              <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-onyx">
                <Image src={url} alt={`Media ${i + 1}`} fill className="object-cover" />
              </div>
            ))}
          </div>
        )}

        {/* No media placeholder */}
        {!post.video_url && mediaUrls.length === 0 && (
          <div className="rounded-xl border-2 border-dashed border-white/[0.06] aspect-video flex items-center justify-center">
            <p className="text-smoke text-sm">No media attached</p>
          </div>
        )}

        {/* Voiceover */}
        {post.audio_url && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-ash uppercase tracking-wide">Voiceover</p>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={post.audio_url} controls className="w-full" />
          </div>
        )}

        {/* Caption */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-ash uppercase tracking-wide">Caption</p>
          <div className="rounded-xl border border-white/[0.06] bg-obsidian p-4">
            {post.caption ? (
              <p className="text-sm text-cream whitespace-pre-wrap">{post.caption}</p>
            ) : (
              <p className="text-sm text-smoke italic">No caption</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Right: metadata + actions ── */}
      <div className="lg:w-72 flex-shrink-0 space-y-4">
        {/* Details */}
        <div className="rounded-xl border border-white/[0.06] bg-obsidian p-4 space-y-3">
          <p className="text-xs font-medium text-ash uppercase tracking-wide">Details</p>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ash">Platform</dt>
              <dd className="text-cream capitalize">{post.platform}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ash">Type</dt>
              <dd className="text-cream capitalize">{post.content_type}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ash">Created</dt>
              <dd className="text-cream">{new Date(post.created_at).toLocaleDateString()}</dd>
            </div>
            {post.published_at && (
              <div className="flex justify-between">
                <dt className="text-ash">Published</dt>
                <dd className="text-cream">{new Date(post.published_at).toLocaleString()}</dd>
              </div>
            )}
            {post.meta_post_id && (
              <div className="flex justify-between gap-2">
                <dt className="text-ash flex-shrink-0">Meta ID</dt>
                <dd className="text-ash font-mono text-xs truncate">{post.meta_post_id}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Approve */}
        {canEdit && (post.status === 'draft' || post.status === 'failed') && (
          <button
            onClick={() => run(() => approvePost(post.id))}
            disabled={isPending}
            className="w-full px-4 py-2.5 rounded-full bg-sky-500/20 hover:bg-sky-500/30 disabled:opacity-50 text-cream text-sm font-medium transition-colors"
          >
            {isPending ? 'Saving…' : 'Approve'}
          </button>
        )}

        {/* Schedule + queue */}
        {canEdit && (post.status === 'draft' || post.status === 'approved' || post.status === 'failed') && (
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
                // Convert local datetime-local value to UTC ISO string
                const utcIso = scheduledAt
                  ? new Date(scheduledAt).toISOString()
                  : new Date().toISOString()
                run(() => queuePost(post.id, utcIso))
              }}
              disabled={isPending}
              className="w-full px-4 py-2.5 rounded-lg bg-cream hover:bg-bone disabled:opacity-50 text-ink text-sm font-medium transition-colors"
            >
              {isPending ? 'Saving…' : 'Queue for publishing'}
            </button>
          </div>
        )}

        {/* Queued status */}
        {post.status === 'queued' && (
          <div className="rounded-xl border border-ember/30 bg-ember/15 px-3 py-3 text-sm text-ember">
            Queued
            {post.scheduled_at && ` · ${new Date(post.scheduled_at).toLocaleString()}`}
          </div>
        )}

        {/* Publish Now — bypasses the scheduler and publishes immediately */}
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
                  onClick={() => run(() => publishPostNow(post.id))}
                  disabled={isPending}
                  className="flex-1 px-3 py-2 rounded-full bg-emerald hover:bg-emerald/80 disabled:opacity-50 text-ink text-sm font-medium transition-colors"
                >
                  {isPending ? 'Publishing…' : 'Publish'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmPublish(true)}
              disabled={isPending}
              className="w-full px-4 py-2.5 rounded-full bg-emerald hover:bg-emerald/80 disabled:opacity-50 text-ink text-sm font-medium transition-colors"
            >
              Publish now
            </button>
          )
        )}

        {/* Published status */}
        {post.status === 'published' && (
          <div className="rounded-xl border border-emerald/30 bg-emerald/10 px-3 py-3 text-sm text-emerald">
            Published
            {post.published_at && ` · ${new Date(post.published_at).toLocaleString()}`}
          </div>
        )}

        {/* Archive / Restore / Permanent delete */}
        {isArchived ? (
          <div className="space-y-2 rounded-xl border border-ember/30 bg-ember/15/40 p-3">
            <p className="text-xs text-ember text-center">
              In archive · auto-deletes in{' '}
              {daysUntilPurge(post.archived_at!)} day
              {daysUntilPurge(post.archived_at!) !== 1 ? 's' : ''}
            </p>
            <button
              onClick={() => run(() => restorePost(post.id))}
              disabled={isPending}
              className="w-full px-3 py-2 rounded-full bg-sky-500/20 hover:bg-sky-500/30 disabled:opacity-50 text-cream text-sm font-medium transition-colors"
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
                  onClick={() => run(() => purgePost(post.id), () => router.push('/drafts'))}
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
                    onClick={() => run(() => archivePost(post.id), () => router.push('/drafts'))}
                    disabled={isPending}
                    className="flex-1 px-3 py-2 rounded-full bg-ember/40 hover:bg-ember/60 disabled:opacity-50 text-cream text-sm font-medium transition-colors"
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
