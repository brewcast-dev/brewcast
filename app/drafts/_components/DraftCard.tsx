import Link from 'next/link'
import Image from 'next/image'
import type { Post, PostStatus } from '@/types/database'

const STATUS_STYLES: Record<PostStatus, string> = {
  draft:     'bg-zinc-700 text-zinc-300',
  approved:  'bg-blue-900 text-blue-300',
  queued:    'bg-amber-900 text-amber-300',
  published: 'bg-green-900 text-green-300',
  failed:    'bg-red-900 text-red-300',
}

const PLATFORM_LABEL: Record<string, string> = {
  instagram: 'IG',
  facebook:  'FB',
  both:      'IG+FB',
}

export default function DraftCard({ post }: { post: Post }) {
  const thumbnail = post.thumbnail_url ?? post.media_urls?.[0] ?? null

  return (
    <Link
      href={`/drafts/${post.id}`}
      className="group flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 hover:border-zinc-700 transition-colors overflow-hidden"
    >
      {/* Thumbnail */}
      <div className="relative w-full aspect-video bg-zinc-800 overflow-hidden flex items-center justify-center">
        {thumbnail ? (
          <Image
            src={thumbnail}
            alt="Post media"
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <span className="text-zinc-600 text-xs capitalize">{post.content_type}</span>
        )}
        {post.video_url && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center">
              <span className="text-white text-lg pl-0.5">▶</span>
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-4 flex flex-col gap-2 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[post.status] ?? 'bg-zinc-700 text-zinc-300'}`}>
            {post.status}
          </span>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-zinc-800 text-zinc-400">
            {PLATFORM_LABEL[post.platform] ?? post.platform}
          </span>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-zinc-800 text-zinc-400 capitalize">
            {post.content_type}
          </span>
        </div>

        <p className="text-sm text-zinc-300 line-clamp-3 flex-1 min-h-[3.75rem]">
          {post.caption ?? <span className="text-zinc-600 italic">No caption</span>}
        </p>

        <div className="text-xs text-zinc-600 pt-2 border-t border-zinc-800">
          {post.scheduled_at
            ? `Scheduled: ${new Date(post.scheduled_at).toLocaleDateString()}`
            : `Created: ${new Date(post.created_at).toLocaleDateString()}`}
        </div>
      </div>
    </Link>
  )
}
