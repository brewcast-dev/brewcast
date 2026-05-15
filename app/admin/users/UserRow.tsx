'use client'

import { useState } from 'react'
import { removeAllowedUser, toggleAdmin } from './actions'

interface AllowedUser {
  id: string
  email: string
  brewery_name: string | null
  is_admin: boolean
  user_id: string | null
  created_at: string
}

export default function UserRow({ user }: { user: AllowedUser }) {
  const [removing, setRemoving] = useState(false)

  async function handleRemove() {
    if (!confirm(`Remove ${user.email} from the allowlist?`)) return
    setRemoving(true)
    await removeAllowedUser(user.id)
  }

  async function handleToggleAdmin() {
    await toggleAdmin(user.id, !user.is_admin)
  }

  return (
    <tr className="border-t border-zinc-800">
      <td className="py-3 px-4 text-sm text-white">{user.email}</td>
      <td className="py-3 px-4 text-sm text-zinc-400">{user.brewery_name ?? '—'}</td>
      <td className="py-3 px-4 text-sm">
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            user.user_id
              ? 'bg-emerald-950 text-emerald-400'
              : 'bg-zinc-800 text-zinc-500'
          }`}
        >
          {user.user_id ? 'Active' : 'Pending'}
        </span>
      </td>
      <td className="py-3 px-4 text-sm">
        <button
          onClick={handleToggleAdmin}
          className={`text-xs px-2 py-0.5 rounded-full font-medium transition-colors ${
            user.is_admin
              ? 'bg-amber-950 text-amber-400 hover:bg-amber-900'
              : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'
          }`}
        >
          {user.is_admin ? 'Admin' : 'User'}
        </button>
      </td>
      <td className="py-3 px-4 text-sm text-zinc-500">
        {new Date(user.created_at).toLocaleDateString()}
      </td>
      <td className="py-3 px-4">
        <button
          onClick={handleRemove}
          disabled={removing}
          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
        >
          Remove
        </button>
      </td>
    </tr>
  )
}
