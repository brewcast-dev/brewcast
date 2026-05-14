import Link from 'next/link'
import Image from 'next/image'

// Unified shape — works for rows from either `posts` or `drafts` table
export interface DraftItem {
  id: string
  source: 'posts' | 'drafts'
  status: string
  platformLabel: string         // "IG", "FB", "IG+FB"
  contentType: string           // "post" | "reel" | "story" (or "post" for drafts)
  caption: string | null
  thumbnail: string | null
  hasVideo: boolean
  scheduledAt: string | null
  createdAt: string
}

const STATUS_STYLES: Record<string, string> = {
  draft:     'bg-zinc-700 text-zinc-300',
  approved:  'bg-blue-900 text-blue-300',
  queued:    'bg-amber-900 text-amber-300',
  published: 'bg-green-900 text-green-300',
  failed:    'bg-red-900 text-red-300',
}

export default function DraftCard({ item }: { item: DraftItem }) {
  const href = `/drafts/${item.id}`

  return (
    <Link
      href={href}
      className="group flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 hover:border-zinc-700 transition-colors overflow-hidden"
    >
      {/* Thumbnail */}
      <div className="relative w-full aspect-video bg-zinc-800 overflow-hidden flex items-center justify-center">
        {item.thumbnail ? (
          <Image
            src={item.thumbnail}
            alt="Post media"
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <span className="text-zinc-600 text-xs capitalize">{item.contentType}</span>
        )}
        {item.hasVideo && (
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
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[item.status] ?? 'bg-zinc-700 text-zinc-300'}`}>
            {item.status}
          </span>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-zinc-800 text-zinc-400">
            {item.platformLabel}
          </span>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-zinc-800 text-zinc-400 capitalize">
            {item.contentType}
          </span>
          {item.source === 'drafts' && (
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
              /upload
            </span>
          )}
        </div>

        <p className="text-sm text-zinc-300 line-clamp-3 flex-1 min-h-[3.75rem]">
          {item.caption ?? <span className="text-zinc-600 italic">No caption</span>}
        </p>

        <div className="text-xs text-zinc-600 pt-2 border-t border-zinc-800">
          {item.scheduledAt
            ? `Scheduled: ${new Date(item.scheduledAt).toLocaleDateString()}`
            : `Created: ${new Date(item.createdAt).toLocaleDateString()}`}
        </div>
      </div>
    </Link>
  )
}
