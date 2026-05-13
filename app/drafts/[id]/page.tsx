import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase'
import type { Post } from '@/types/database'
import PostReview from './_components/PostReview'

export default async function DraftReviewPage({ params }: { params: { id: string } }) {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .eq('id', params.id)
    .single()

  if (error || !data) notFound()
  const post = data as Post

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/drafts"
            className="flex-shrink-0 text-zinc-400 hover:text-zinc-200 text-sm transition-colors"
          >
            ← Drafts
          </Link>
          <span className="text-zinc-700">/</span>
          <span className="text-zinc-400 text-sm truncate capitalize">
            {post.content_type} · {post.platform}
          </span>
        </div>
        <Link href="/" className="flex-shrink-0 text-amber-400 font-bold text-lg tracking-tight">
          BrewCast
        </Link>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8">
        <PostReview post={post} />
      </main>
    </div>
  )
}
