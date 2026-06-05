'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { uploadLogo, removeLogo } from './actions'
import type { BreweryConfig } from '@/lib/get-user-config'

interface Props {
  config: BreweryConfig | null
}

export default function LogoUpload({ config }: Props) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(config?.logo_url ?? null)
  const [hasLogo, setHasLogo] = useState<boolean>(!!config?.logo_url)
  const [picked, setPicked] = useState<File | null>(null)
  const [status, setStatus] = useState<'idle' | 'uploading' | 'removing'>('idle')
  const [error, setError] = useState<string | null>(null)

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    setError(null)
    setPicked(file)
    if (file) setPreview(URL.createObjectURL(file))
  }

  async function handleUpload() {
    if (!picked) return
    setStatus('uploading')
    setError(null)
    const fd = new FormData()
    fd.append('logo', picked)
    const res = await uploadLogo(fd)
    setStatus('idle')
    if (res.error) {
      setError(res.error)
      return
    }
    setPicked(null)
    setHasLogo(true)
    if (res.logoUrl) setPreview(res.logoUrl)
    if (inputRef.current) inputRef.current.value = ''
    router.refresh()
  }

  async function handleRemove() {
    setStatus('removing')
    setError(null)
    const res = await removeLogo()
    setStatus('idle')
    if (res.error) {
      setError(res.error)
      return
    }
    setPreview(null)
    setPicked(null)
    setHasLogo(false)
    if (inputRef.current) inputRef.current.value = ''
    router.refresh()
  }

  return (
    <section className="bg-obsidian border border-white/[0.06] rounded-xl p-6 space-y-4">
      <h2 className="text-base font-semibold text-white">Logo</h2>
      <p className="text-xs text-ash">
        Your logo is placed top-centre on every designed post. PNG with a transparent
        background works best; light/cream marks read well on dark photos. Max 5&nbsp;MB.
      </p>

      <div className="flex items-center gap-5">
        {/* Preview — checkerboard so transparency is visible */}
        <div
          className="h-24 w-24 shrink-0 rounded-lg border border-white/[0.08] flex items-center justify-center overflow-hidden"
          style={{
            backgroundColor: '#1a1a1a',
            backgroundImage:
              'linear-gradient(45deg,#2a2a2a 25%,transparent 25%),linear-gradient(-45deg,#2a2a2a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2a2a2a 75%),linear-gradient(-45deg,transparent 75%,#2a2a2a 75%)',
            backgroundSize: '14px 14px',
            backgroundPosition: '0 0,0 7px,7px -7px,-7px 0',
          }}
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Logo preview" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-smoke text-xs text-center px-2">No logo</span>
          )}
        </div>

        <div className="flex-1 space-y-3">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={onPick}
            className="block w-full text-sm text-ash file:mr-3 file:rounded-full file:border-0 file:bg-onyx file:px-4 file:py-2 file:text-sm file:text-cream hover:file:bg-onyx/70 file:cursor-pointer"
          />

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleUpload}
              disabled={!picked || status !== 'idle'}
              className="bg-cream hover:bg-bone disabled:opacity-40 text-ink font-medium rounded-full px-5 py-2 text-sm transition-colors"
            >
              {status === 'uploading' ? 'Uploading…' : hasLogo ? 'Replace logo' : 'Upload logo'}
            </button>

            {hasLogo && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={status !== 'idle'}
                className="text-red-400 hover:text-red-300 disabled:opacity-40 text-sm transition-colors"
              >
                {status === 'removing' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>
      </div>
    </section>
  )
}
