import Link from 'next/link'
import Image from 'next/image'

export interface DraftItem {
  id: string
  source: 'posts' | 'drafts'
  status: string
  platformLabel: string
  contentType: string
  caption: string | null
  thumbnail: string | null
  hasVideo: boolean
  scheduledAt: string | null
  archivedAt: string | null
  createdAt: string
}

const ARCHIVE_RETENTION_DAYS = 30

function daysUntilPurge(archivedAt: string): number {
  const archived = new Date(archivedAt).getTime()
  const purgeAt = archived + ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const remaining = Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000))
  return Math.max(0, remaining)
}

const STATUS_STYLES: Record<string, string> = {
  draft:     'bg-white/[0.06] text-bone',
  approved:  'bg-sky-500/10 text-sky-300',
  queued:    'bg-ember/15 text-ember',
  published: 'bg-emerald/15 text-emerald',
  failed:    'bg-red-500/15 text-red-300',
}

export default function DraftCard({ item }: { item: DraftItem }) {
  const href = `/drafts/${item.id}`

  return (
    <Link
      href={href}
      className="group flex flex-col rounded-2xl hairline bg-obsidian hover:bg-onyx transition-all overflow-hidden"
    >
      <div className="relative w-full aspect-video bg-ink overflow-hidden flex items-center justify-center">
        {item.thumbnail ? (
          <Image
            src={item.thumbnail}
            alt="Post media"
            fill
            className="object-cover group-hover:scale-[1.02] transition-transform duration-500"
          />
        ) : (
          <span className="text-smoke text-xs capitalize font-display italic">{item.contentType}</span>
        )}
        {item.hasVideo && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full glass flex items-center justify-center">
              <span className="text-cream text-lg pl-0.5">▶</span>
            </div>
          </div>
        )}
      </div>

      <div className="p-5 flex flex-col gap-3 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-medium ${STATUS_STYLES[item.status] ?? 'bg-white/[0.06] text-bone'}`}>
            {item.status}
          </span>
          <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-medium bg-white/[0.04] text-ash">
            {item.platformLabel}
          </span>
          <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-medium bg-white/[0.04] text-ash">
            {item.contentType}
          </span>
          {item.source === 'drafts' && (
            <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-medium bg-ember/10 text-ember/90">
              upload
            </span>
          )}
        </div>

        <p className="text-sm text-bone line-clamp-3 flex-1 min-h-[3.75rem] leading-relaxed">
          {item.caption ?? <span className="text-smoke italic font-display">No caption</span>}
        </p>

        <div className="text-xs text-smoke pt-3 border-t border-white/[0.05]">
          {item.archivedAt ? (
            <span className="text-ember">
              Archived · {daysUntilPurge(item.archivedAt)} day
              {daysUntilPurge(item.archivedAt) !== 1 ? 's' : ''} until auto-delete
            </span>
          ) : item.scheduledAt ? (
            `Scheduled · ${new Date(item.scheduledAt).toLocaleString()}`
          ) : (
            `Created · ${new Date(item.createdAt).toLocaleDateString()}`
          )}
        </div>
      </div>
    </Link>
  )
}
