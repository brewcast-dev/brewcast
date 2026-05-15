import { createSessionClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase'
import NavClient from './NavClient'

export default async function Nav() {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return null

  const admin = createAdminClient()
  const { data: me } = await admin
    .from('allowed_users')
    .select('is_admin')
    .eq('user_id', user.id)
    .maybeSingle()
  const isAdmin = (me as { is_admin: boolean } | null)?.is_admin === true

  return <NavClient userEmail={user.email ?? ''} isAdmin={isAdmin} />
}
