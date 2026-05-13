import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase'
import type { Post } from '@/types/database'
import DraftCard from './_components/DraftCard'

const STATUS_TABS = [
  { label: 'All',       value: 'all'       },
  { label: 'Draft',     value: 'draft'     },
  { label: 'Approved',  value: 'approved'  },
  { label: 'Queued',    value: 'queued'    },
  { label: 'Published', value: 'published' },
  { label: 'Failed',    value: 'failed'    },
]

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: { status?: string }
}) {
  const supabase = createAdminClient()
  const activeStatus = searchParams.status ?? 'all'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase.from('posts').select('*').order('created_at', { ascending: false })
  if (activeStatus !== 'all') query = query.eq('status', activeStatus)

  const { data, error } = await query
  const posts: Post[] = (data ?? []) as Post[]

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
          <Link
            href="/chat"
            className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 text-sm font-medium transition-colors"
          >
            + New post
          </Link>
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

        {error && (
          <div className="rounded-xl border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300 mb-6">
            Failed to load posts: {(error as { message: string }).message}
          </div>
        )}

        {posts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <p className="text-zinc-500 text-sm">No posts here yet.</p>
            <Link href="/chat" className="text-amber-400 text-sm hover:underline">
              Start creating in the chat →
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {posts.map((post) => (
              <DraftCard key={post.id} post={post} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
