import { redirect } from 'next/navigation'
import { createSessionClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase'
import AddUserForm from './AddUserForm'
import UserRow from './UserRow'
import ProcessQueueButton from './ProcessQueueButton'

interface AllowedUser {
  id: string
  email: string
  brewery_name: string | null
  is_admin: boolean
  user_id: string | null
  created_at: string
}

export default async function AdminUsersPage() {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()

  // Only admins can access this page
  const { data: me } = await admin
    .from('allowed_users')
    .select('is_admin')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!me?.is_admin) redirect('/')

  const { data: users } = await admin
    .from('allowed_users')
    .select('*')
    .order('created_at', { ascending: false })

  const allowedUsers = (users ?? []) as AllowedUser[]

  return (
    <main className="max-w-4xl mx-auto py-10 px-4 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">User Management</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Control which emails can sign in to BrewCast. Each user gets their own API key config via Settings.
        </p>
      </div>

      <ProcessQueueButton />

      <AddUserForm />

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-zinc-800/50">
              <th className="text-left py-3 px-4 text-xs font-medium text-zinc-400">Email</th>
              <th className="text-left py-3 px-4 text-xs font-medium text-zinc-400">Brewery</th>
              <th className="text-left py-3 px-4 text-xs font-medium text-zinc-400">Status</th>
              <th className="text-left py-3 px-4 text-xs font-medium text-zinc-400">Role</th>
              <th className="text-left py-3 px-4 text-xs font-medium text-zinc-400">Added</th>
              <th className="py-3 px-4" />
            </tr>
          </thead>
          <tbody>
            {allowedUsers.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-zinc-500 text-sm">
                  No users yet. Add one above.
                </td>
              </tr>
            ) : (
              allowedUsers.map((u) => <UserRow key={u.id} user={u} />)
            )}
          </tbody>
        </table>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-2">
        <h2 className="text-sm font-semibold text-white">After adding a user</h2>
        <ol className="text-sm text-zinc-400 space-y-1 list-decimal list-inside">
          <li>Create their account in the Supabase Auth dashboard with their email + a temporary password.</li>
          <li>Share the login URL and credentials with them.</li>
          <li>Ask them to visit <span className="text-amber-400">/settings</span> and paste in their API keys.</li>
          <li>Their first sign-in automatically links their auth account to this allowlist entry.</li>
        </ol>
      </div>
    </main>
  )
}
