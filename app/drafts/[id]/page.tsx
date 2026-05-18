import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'
import type { Post } from '@/types/database'
import PostReview from './_components/PostReview'
import UploadDraftReview, { type UploadDraft } from './_components/UploadDraftReview'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function DraftReviewPage({ params }: { params: { id: string } }) {
  const sessionClient = createSessionClient()
  const { data: { user } } = await sessionClient.auth.getUser()
  if (!user) redirect('/login')

  const supabase = createAdminClient()

  // Check the legacy `posts` table first — scoped to this user
  const postRes = await supabase
    .from('posts')
    .select('*')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (postRes.data) {
    const post = postRes.data as Post
    return (
      <Layout title={`${post.content_type} · ${post.platform}`}>
        <PostReview post={post} />
      </Layout>
    )
  }

  // Otherwise check the new `drafts` table (from /upload flow)
  const draftRes = await supabase
    .from('drafts')
    .select('*')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle()
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
      <main className="flex-1 max-w-5xl mx-auto w-full px-6 pt-28 pb-12">
        <nav className="flex items-center gap-3 text-sm mb-8">
          <Link href="/drafts" className="text-ash hover:text-cream transition-colors">
            ← Drafts
          </Link>
          <span className="text-smoke">/</span>
          <span className="text-cream truncate capitalize font-display italic">{title}</span>
        </nav>
        {children}
      </main>
    </div>
  )
}
