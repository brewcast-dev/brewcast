import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'
import type { Post } from '@/types/database'
import DraftCard, { type DraftItem } from './_components/DraftCard'

// Never cache this page — rows inserted via /upload's bulk-save route handler
// need to appear immediately, and Next's route segment cache otherwise serves
// stale HTML on Vercel.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const STATUS_TABS = [
  { label: 'All',       value: 'all'       },
  { label: 'Draft',     value: 'draft'     },
  { label: 'Approved',  value: 'approved'  },
  { label: 'Queued',    value: 'queued'    },
  { label: 'Published', value: 'published' },
  { label: 'Failed',    value: 'failed'    },
  { label: 'Archive',   value: 'archived'  },
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
  archived_at: string | null
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
  const sessionClient = createSessionClient()
  const { data: { user } } = await sessionClient.auth.getUser()
  if (!user) redirect('/login')

  const supabase = createAdminClient()
  const activeStatus = searchParams.status ?? 'all'
  const isArchiveView = activeStatus === 'archived'

  // ── Fetch from both tables in parallel, scoped to this user ─────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let postsQuery: any = supabase.from('posts').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let draftsQuery: any = supabase.from('drafts').select('*').eq('user_id', user.id).order('created_at', { ascending: false })

  if (isArchiveView) {
    // Only archived rows
    postsQuery  = postsQuery.not('archived_at', 'is', null)
    draftsQuery = draftsQuery.not('archived_at', 'is', null)
  } else {
    // Hide archived rows from all other views
    postsQuery  = postsQuery.is('archived_at', null)
    draftsQuery = draftsQuery.is('archived_at', null)
    if (activeStatus !== 'all') {
      postsQuery  = postsQuery.eq('status', activeStatus)
      draftsQuery = draftsQuery.eq('status', activeStatus)
    }
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
    archivedAt:   p.archived_at,
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
    archivedAt:   d.archived_at,
    createdAt:    d.created_at,
  }))

  const allItems = [...postItems, ...draftItems].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  const loadError = postsRes.error ?? draftsRes.error

  return (
    <div className="min-h-screen flex flex-col">
      <main className="flex-1 max-w-6xl mx-auto w-full px-6 pt-28 pb-16">
        <div className="flex items-end justify-between mb-10 gap-4 flex-wrap">
          <div>
            <h1 className="font-display text-5xl md:text-6xl text-cream tracking-tight">Drafts</h1>
            <p className="text-ash text-sm mt-2">Review, schedule, and publish your queue.</p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/upload"
              className="px-5 py-2.5 rounded-full bg-cream text-ink text-sm font-medium hover:bg-bone transition-colors"
            >
              Quick generate
            </Link>
            <Link
              href="/chat"
              className="px-5 py-2.5 rounded-full hairline text-cream text-sm hover:bg-white/[0.04] transition-colors"
            >
              New via chat
            </Link>
          </div>
        </div>

        <div className="flex gap-1 border-b border-white/[0.06] mb-8 overflow-x-auto scrollbar-thin">
          {STATUS_TABS.map(({ label, value }) => (
            <Link
              key={value}
              href={value === 'all' ? '/drafts' : `/drafts?status=${value}`}
              className={`px-4 py-3 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${
                activeStatus === value
                  ? 'border-cream text-cream'
                  : 'border-transparent text-ash hover:text-cream'
              }`}
            >
              {label}
            </Link>
          ))}
        </div>

        {loadError && (
          <div className="rounded-2xl border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300 mb-6">
            Failed to load: {(loadError as { message: string }).message}
          </div>
        )}

        {allItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 gap-3">
            <p className="text-ash text-sm font-display italic text-lg">Nothing here yet.</p>
            <Link href="/upload" className="text-cream text-sm hover:text-bone transition-colors">
              Try /upload to generate posts →
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {allItems.map((item) => (
              <DraftCard key={`${item.source}_${item.id}`} item={item} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
