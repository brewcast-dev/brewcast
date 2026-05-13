'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import type { Post, PostStatus } from '@/types/database'
import { approvePost, queuePost, deletePost } from '../../actions'

const STATUS_STYLES: Record<PostStatus, string> = {
  draft:     'bg-zinc-700 text-zinc-300',
  approved:  'bg-blue-900 text-blue-300',
  queued:    'bg-amber-900 text-amber-300',
  published: 'bg-green-900 text-green-300',
  failed:    'bg-red-900 text-red-300',
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return ''
  // Slice to 'YYYY-MM-DDTHH:mm' which is what datetime-local expects
  return iso.slice(0, 16)
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

  const mediaUrls = post.media_urls ?? []
  const statusStyle = STATUS_STYLES[post.status] ?? 'bg-zinc-700 text-zinc-300'
  const canEdit = post.status !== 'published'
  const canDelete = post.status !== 'published' && post.status !== 'queued'

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      {/* ── Left: content preview ── */}
      <div className="flex-1 min-w-0 space-y-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-zinc-100">Post Review</h1>
          <span className={`px-2.5 py-0.5 rounded text-xs font-medium ${statusStyle}`}>
            {post.status}
          </span>
        </div>

        {/* Video */}
        {post.video_url && (
          <div className="rounded-xl overflow-hidden bg-zinc-800 aspect-video">
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
              <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-zinc-800">
                <Image src={url} alt={`Media ${i + 1}`} fill className="object-cover" />
              </div>
            ))}
          </div>
        )}

        {/* No media placeholder */}
        {!post.video_url && mediaUrls.length === 0 && (
          <div className="rounded-xl border-2 border-dashed border-zinc-800 aspect-video flex items-center justify-center">
            <p className="text-zinc-600 text-sm">No media attached</p>
          </div>
        )}

        {/* Voiceover */}
        {post.audio_url && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Voiceover</p>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={post.audio_url} controls className="w-full" />
          </div>
        )}

        {/* Caption */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Caption</p>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            {post.caption ? (
              <p className="text-sm text-zinc-200 whitespace-pre-wrap">{post.caption}</p>
            ) : (
              <p className="text-sm text-zinc-600 italic">No caption</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Right: metadata + actions ── */}
      <div className="lg:w-72 flex-shrink-0 space-y-4">
        {/* Details */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Details</p>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Platform</dt>
              <dd className="text-zinc-200 capitalize">{post.platform}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Type</dt>
              <dd className="text-zinc-200 capitalize">{post.content_type}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Created</dt>
              <dd className="text-zinc-200">{new Date(post.created_at).toLocaleDateString()}</dd>
            </div>
            {post.published_at && (
              <div className="flex justify-between">
                <dt className="text-zinc-500">Published</dt>
                <dd className="text-zinc-200">{new Date(post.published_at).toLocaleString()}</dd>
              </div>
            )}
            {post.meta_post_id && (
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-500 flex-shrink-0">Meta ID</dt>
                <dd className="text-zinc-400 font-mono text-xs truncate">{post.meta_post_id}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Approve */}
        {canEdit && (post.status === 'draft' || post.status === 'failed') && (
          <button
            onClick={() => run(() => approvePost(post.id))}
            disabled={isPending}
            className="w-full px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {isPending ? 'Saving…' : 'Approve'}
          </button>
        )}

        {/* Schedule + queue */}
        {canEdit && (post.status === 'draft' || post.status === 'approved' || post.status === 'failed') && (
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
              onClick={() =>
                run(() => queuePost(post.id, scheduledAt || new Date().toISOString()))
              }
              disabled={isPending}
              className="w-full px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-950 text-sm font-medium transition-colors"
            >
              {isPending ? 'Saving…' : 'Queue for publishing'}
            </button>
          </div>
        )}

        {/* Queued status */}
        {post.status === 'queued' && (
          <div className="rounded-xl border border-amber-800 bg-amber-950 px-3 py-3 text-sm text-amber-300">
            Queued
            {post.scheduled_at && ` · ${new Date(post.scheduled_at).toLocaleString()}`}
          </div>
        )}

        {/* Published status */}
        {post.status === 'published' && (
          <div className="rounded-xl border border-green-800 bg-green-950 px-3 py-3 text-sm text-green-300">
            Published
            {post.published_at && ` · ${new Date(post.published_at).toLocaleString()}`}
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
                  onClick={() => run(() => deletePost(post.id), () => router.push('/drafts'))}
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
