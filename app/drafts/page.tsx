import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase'
import type { Post } from '@/types/database'
import DraftCard, { type DraftItem } from './_components/DraftCard'

const STATUS_TABS = [
  { label: 'All',       value: 'all'       },
  { label: 'Draft',     value: 'draft'     },
  { label: 'Approved',  value: 'approved'  },
  { label: 'Queued',    value: 'queued'    },
  { label: 'Published', value: 'published' },
  { label: 'Failed',    value: 'failed'    },
]

interface UploadDraftRow {
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

function platformLabel(platforms: string[]): string {
  const has = (p: string) => platforms.includes(p)
  if (has('instagram') && has('facebook')) return 'IG+FB'
  if (has('instagram')) return 'IG'
  if (has('facebook')) return 'FB'
  return platforms.join(',') || '—'
}

function postPlatformLabel(p: string): string {
  return p === 'instagram' ? 'IG' : p === 'facebook' ? 'FB' : p === 'both' ? 'IG+FB' : p
}

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: { status?: string }
}) {
  const supabase = createAdminClient()
  const activeStatus = searchParams.status ?? 'all'

  // ── Fetch from both tables in parallel ─────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let postsQuery: any = supabase.from('posts').select('*').order('created_at', { ascending: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let draftsQuery: any = supabase.from('drafts').select('*').order('created_at', { ascending: false })

  if (activeStatus !== 'all') {
    postsQuery  = postsQuery.eq('status', activeStatus)
    draftsQuery = draftsQuery.eq('status', activeStatus)
  }

  const [postsRes, draftsRes] = await Promise.all([postsQuery, draftsQuery])

  const posts: Post[] = (postsRes.data ?? []) as Post[]
  const uploadDrafts: UploadDraftRow[] = (draftsRes.data ?? []) as UploadDraftRow[]

  // Normalize both tables into the unified DraftItem shape
  const postItems: DraftItem[] = posts.map((p) => ({
    id:           p.id,
    source:       'posts',
    status:       p.status,
    platformLabel: postPlatformLabel(p.platform),
    contentType:  p.content_type,
    caption:      p.caption,
    thumbnail:    p.thumbnail_url ?? p.media_urls?.[0] ?? null,
    hasVideo:     !!p.video_url,
    scheduledAt:  p.scheduled_at,
    createdAt:    p.created_at,
  }))

  const draftItems: DraftItem[] = uploadDrafts.map((d) => ({
    id:           d.id,
    source:       'drafts',
    status:       d.status,
    platformLabel: platformLabel(d.platforms ?? []),
    contentType:  'post',
    caption:      d.caption,
    thumbnail:    d.edited_image_url ?? d.image_url,
    hasVideo:     false,
    scheduledAt:  d.scheduled_at,
    createdAt:    d.created_at,
  }))

  const allItems = [...postItems, ...draftItems].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  const loadError = postsRes.error ?? draftsRes.error

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-zinc-900">
        <Link href="/" className="text-amber-400 font-bold text-lg tracking-tight">
          BrewCast
        </Link>
        <nav className="flex items-center gap-1">
          <Link
            href="/chat"
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            ← Chat
          </Link>
          <Link
            href="/upload"
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            Upload
          </Link>
          <Link
            href="/analytics"
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            Analytics
          </Link>
          <Link
            href="/settings"
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            Settings
          </Link>
        </nav>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-zinc-100">Drafts</h1>
          <div className="flex gap-2">
            <Link
              href="/upload"
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 text-sm font-medium transition-colors"
            >
              + Quick generate
            </Link>
            <Link
              href="/chat"
              className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-sm font-medium transition-colors"
            >
              + New via chat
            </Link>
          </div>
        </div>

        {/* Status tabs */}
        <div className="flex gap-1 border-b border-zinc-800 mb-6">
          {STATUS_TABS.map(({ label, value }) => (
            <Link
              key={value}
              href={value === 'all' ? '/drafts' : `/drafts?status=${value}`}
              className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
                activeStatus === value
                  ? 'border-amber-400 text-amber-400'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
            </Link>
          ))}
        </div>

        {loadError && (
          <div className="rounded-xl border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300 mb-6">
            Failed to load: {(loadError as { message: string }).message}
          </div>
        )}

        {allItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <p className="text-zinc-500 text-sm">No posts here yet.</p>
            <Link href="/upload" className="text-amber-400 text-sm hover:underline">
              Try /upload to generate posts →
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {allItems.map((item) => (
              <DraftCard key={`${item.source}_${item.id}`} item={item} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
