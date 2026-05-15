import Link from 'next/link'
import { createSessionClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase'
import { signOut } from '@/app/login/actions'

const NAV_LINKS = [
  { href: '/upload',    label: 'Upload'    },
  { href: '/drafts',    label: 'Drafts'    },
  { href: '/chat',      label: 'Chat'      },
  { href: '/analytics', label: 'Analytics' },
]

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

  return (
    <nav className="border-b border-zinc-800 bg-zinc-950 px-5 py-3 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <Link href="/" className="text-amber-400 font-bold text-sm tracking-tight">
          BrewCast
        </Link>
        {NAV_LINKS.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className="text-zinc-400 hover:text-white text-sm transition-colors"
          >
            {label}
          </Link>
        ))}
      </div>

      <div className="flex items-center gap-5">
        <Link href="/settings" className="text-zinc-400 hover:text-white text-sm transition-colors">
          Settings
        </Link>
        {isAdmin && (
          <Link href="/admin/users" className="text-zinc-400 hover:text-white text-sm transition-colors">
            Admin
          </Link>
        )}
        <span className="text-zinc-600 text-xs hidden sm:block">{user.email}</span>
        <form action={signOut}>
          <button
            type="submit"
            className="text-zinc-400 hover:text-red-400 text-sm transition-colors"
          >
            Sign out
          </button>
        </form>
      </div>
    </nav>
  )
}
