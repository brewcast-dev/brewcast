'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { signOut } from '@/app/login/actions'

const NAV_LINKS = [
  { href: '/upload',    label: 'Upload'    },
  { href: '/drafts',    label: 'Drafts'    },
  { href: '/chat',      label: 'Chat'      },
  { href: '/analytics', label: 'Analytics' },
]

interface Props {
  userEmail: string
  isAdmin: boolean
}

export default function NavClient({ userEmail, isAdmin }: Props) {
  const pathname = usePathname()
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="sticky top-0 z-50 flex justify-center pointer-events-none">
      <nav
        className={`
          pointer-events-auto mt-4 flex items-center transition-all duration-300 ease-out
          ${scrolled
            ? 'glass rounded-full border border-white/[0.06] px-3 py-2 gap-1 shadow-[0_8px_32px_rgba(0,0,0,0.4)]'
            : 'bg-transparent rounded-full px-6 py-3 gap-2'}
        `}
      >
        <Link
          href="/"
          className="px-3 text-cream font-display text-base tracking-tight hover:text-bone transition-colors"
        >
          BrewCast
        </Link>

        <div className="w-px h-4 bg-white/10 mx-1" />

        {NAV_LINKS.map(({ href, label }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link
              key={href}
              href={href}
              className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                active ? 'text-cream' : 'text-ash hover:text-cream'
              }`}
            >
              {label}
            </Link>
          )
        })}

        <div className="w-px h-4 bg-white/10 mx-1" />

        <Link
          href="/settings"
          className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
            pathname === '/settings' ? 'text-cream' : 'text-ash hover:text-cream'
          }`}
        >
          Settings
        </Link>

        {isAdmin && (
          <Link
            href="/admin/users"
            className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
              pathname.startsWith('/admin') ? 'text-cream' : 'text-ash hover:text-cream'
            }`}
          >
            Admin
          </Link>
        )}

        <span className="text-smoke text-xs px-2 hidden md:inline-block max-w-[140px] truncate">
          {userEmail}
        </span>

        <form action={signOut} className="flex">
          <button
            type="submit"
            className="px-4 py-1.5 rounded-full text-sm bg-cream text-ink hover:bg-bone transition-colors font-medium"
          >
            Sign out
          </button>
        </form>
      </nav>
    </div>
  )
}
