import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase'
import type { Post } from '@/types/database'
import PostReview from './_components/PostReview'
import UploadDraftReview, { type UploadDraft } from './_components/UploadDraftReview'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function DraftReviewPage({ params }: { params: { id: string } }) {
  const supabase = createAdminClient()

  // Check the legacy `posts` table first
  const postRes = await supabase.from('posts').select('*').eq('id', params.id).maybeSingle()
  if (postRes.data) {
    const post = postRes.data as Post
    return (
      <Layout title={`${post.content_type} · ${post.platform}`}>
        <PostReview post={post} />
      </Layout>
    )
  }

  // Otherwise check the new `drafts` table (from /upload flow)
  const draftRes = await supabase.from('drafts').select('*').eq('id', params.id).maybeSingle()
  if (draftRes.data) {
    const draft = draftRes.data as UploadDraft
    const platformsLabel = (draft.platforms ?? []).join(' + ')
    return (
      <Layout title={`Quick post · ${platformsLabel || 'instagram'}`}>
        <UploadDraftReview draft={draft} />
      </Layout>
    )
  }

  notFound()
}

function Layout({ title, children }: { title: string; children: React.ReactNode }) {
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
          <span className="text-zinc-400 text-sm truncate capitalize">{title}</span>
        </div>
        <Link href="/" className="flex-shrink-0 text-amber-400 font-bold text-lg tracking-tight">
          BrewCast
        </Link>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8">{children}</main>
    </div>
  )
}
