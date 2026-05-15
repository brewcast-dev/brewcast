'use client'

import { useState, useRef } from 'react'
import { addAllowedUser } from './actions'

export default function AddUserForm() {
  const [status, setStatus] = useState<'idle' | 'adding' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus('adding')
    setErrorMsg(null)
    const result = await addAllowedUser(new FormData(e.currentTarget))
    if (result.error) {
      setErrorMsg(result.error)
      setStatus('error')
    } else {
      setStatus('idle')
      formRef.current?.reset()
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="bg-obsidian border border-white/[0.06] rounded-xl p-5 space-y-4">
      <h2 className="text-sm font-semibold text-white">Add allowed email</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-ash mb-1">Email *</label>
          <input
            name="email"
            type="email"
            required
            placeholder="owner@brewery.com"
            className="w-full bg-onyx border border-white/[0.08] rounded-lg px-3 py-2 text-white text-sm placeholder-smoke focus:outline-none focus:ring-2 focus:ring-cream/30"
          />
        </div>
        <div>
          <label className="block text-xs text-ash mb-1">Brewery name</label>
          <input
            name="brewery_name"
            type="text"
            placeholder="Toit Brewpub"
            className="w-full bg-onyx border border-white/[0.08] rounded-lg px-3 py-2 text-white text-sm placeholder-smoke focus:outline-none focus:ring-2 focus:ring-cream/30"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-bone cursor-pointer">
        <input type="checkbox" name="is_admin" className="accent-amber-500" />
        Grant admin access (can manage other users)
      </label>

      {errorMsg && <p className="text-red-400 text-sm">{errorMsg}</p>}

      <button
        type="submit"
        disabled={status === 'adding'}
        className="bg-cream hover:bg-bone disabled:opacity-50 text-ink font-medium rounded-full px-5 py-2 text-sm transition-colors"
      >
        {status === 'adding' ? 'Adding…' : 'Add user'}
      </button>
    </form>
  )
}
