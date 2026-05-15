import Link from 'next/link'
import { createSessionClient } from '@/lib/supabase-server'
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
        <Link href="/admin/users" className="text-zinc-400 hover:text-white text-sm transition-colors">
          Admin
        </Link>
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
