import { redirect } from 'next/navigation'
import { createSessionClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase'
import CompareClient from './CompareClient'

interface PhotoRow {
  url: string
  mood: string | null
  score: number | null
  description: string | null
}

export default async function CompareEditorsPage() {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()
  const { data } = await admin
    .from('brewery_photos')
    .select('url, mood, score, description')
    .eq('user_id', user.id)
    .order('score', { ascending: false, nullsFirst: false })
    .limit(40)

  const photos = (data ?? []) as PhotoRow[]

  return (
    <main className="max-w-6xl mx-auto py-10 px-4">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Compare photo editors</h1>
        <p className="text-ash text-sm mt-1">
          Pick a photo to run through each AI editor side-by-side. Use this to decide
          which provider gives the best output for your brewery&apos;s look.
        </p>
      </div>
      <CompareClient photos={photos} />
    </main>
  )
}
