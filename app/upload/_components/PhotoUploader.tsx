'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Cloud picker helpers — keep all SDK access here so the rest of the page
// doesn't have to think about gapi / Dropbox globals.

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
const GOOGLE_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY
const DROPBOX_APP_KEY = process.env.NEXT_PUBLIC_DROPBOX_APP_KEY

interface UploadResult {
  uploaded: Array<{ url: string; name: string }>
  failed: Array<{ name: string; error: string }>
}

interface PhotoUploaderProps {
  onUploadsComplete: (result: UploadResult) => void
  children: React.ReactNode
}

// ─── Script loader (used for gapi + dropbox) ────────────────────────────────
const loadedScripts = new Set<string>()
function loadScript(src: string, attrs?: Record<string, string>): Promise<void> {
  if (loadedScripts.has(src)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) {
      loadedScripts.add(src)
      resolve()
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.defer = true
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    }
    s.onload = () => { loadedScripts.add(src); resolve() }
    s.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.body.appendChild(s)
  })
}

// ─── Google Drive Picker ────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = any
interface GoogleGlobal {
  accounts: { oauth2: AnyObj }
  picker: AnyObj
}
interface GapiGlobal {
  load: (api: string, cb: () => void) => void
}
declare global {
  interface Window {
    gapi?: GapiGlobal
    google?: GoogleGlobal
    Dropbox?: AnyObj
  }
}

async function openGoogleDrivePicker(): Promise<Array<{ id: string; name: string; mimeType: string; accessToken: string }>> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_API_KEY) {
    throw new Error('Google Drive not configured — set NEXT_PUBLIC_GOOGLE_CLIENT_ID and NEXT_PUBLIC_GOOGLE_API_KEY')
  }

  await Promise.all([
    loadScript('https://apis.google.com/js/api.js'),
    loadScript('https://accounts.google.com/gsi/client'),
  ])

  // Load the picker module
  await new Promise<void>((resolve, reject) => {
    if (!window.gapi) return reject(new Error('gapi failed to load'))
    window.gapi.load('picker', () => resolve())
  })

  // Get an OAuth access token via GIS
  const accessToken = await new Promise<string>((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) return reject(new Error('Google Identity Services failed to load'))
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: (resp: { access_token?: string; error?: string }) => {
        if (resp.access_token) resolve(resp.access_token)
        else reject(new Error(resp.error ?? 'No access token'))
      },
    })
    tokenClient.requestAccessToken({ prompt: '' })
  })

  // Build and show the picker
  return new Promise((resolve, reject) => {
    if (!window.google?.picker) return reject(new Error('Picker not loaded'))
    const picker = window.google.picker
    const view = new picker.View(picker.ViewId.DOCS_IMAGES)
    view.setMimeTypes('image/jpeg,image/png,image/webp,image/gif')

    const built = new picker.PickerBuilder()
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(accessToken)
      .setDeveloperKey(GOOGLE_API_KEY)
      .addView(view)
      .setCallback((data: AnyObj) => {
        if (data.action === picker.Action.PICKED) {
          const docs = (data.docs ?? []) as Array<{ id: string; name: string; mimeType: string }>
          resolve(docs.map((d) => ({ ...d, accessToken })))
        } else if (data.action === picker.Action.CANCEL) {
          resolve([])
        }
      })
      .build()
    built.setVisible(true)
  })
}

// ─── Dropbox Chooser ────────────────────────────────────────────────────────

interface DropboxFile {
  link: string
  name: string
  bytes: number
}

async function openDropboxChooser(): Promise<DropboxFile[]> {
  if (!DROPBOX_APP_KEY) {
    throw new Error('Dropbox not configured — set NEXT_PUBLIC_DROPBOX_APP_KEY')
  }
  await loadScript('https://www.dropbox.com/static/api/2/dropins.js', {
    id: 'dropboxjs',
    'data-app-key': DROPBOX_APP_KEY,
  })
  return new Promise((resolve) => {
    if (!window.Dropbox) return resolve([])
    window.Dropbox.choose({
      success: (files: DropboxFile[]) => resolve(files),
      cancel: () => resolve([]),
      linkType: 'direct',
      multiselect: true,
      extensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
    })
  })
}

// ─── Main component ────────────────────────────────────────────────────────

export default function PhotoUploader({ onUploadsComplete, children }: PhotoUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragCounter = useRef(0)
  const [hasDrive, setHasDrive] = useState(false)
  const [hasDropbox, setHasDropbox] = useState(false)

  // Public env vars only become available on the client at runtime — read on mount
  useEffect(() => {
    setHasDrive(Boolean(GOOGLE_CLIENT_ID && GOOGLE_API_KEY))
    setHasDropbox(Boolean(DROPBOX_APP_KEY))
  }, [])

  const uploadLocalFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) {
      setStatus('No image files in selection')
      setTimeout(() => setStatus(null), 3000)
      return
    }

    setBusy(true)
    setStatus(`Uploading ${imageFiles.length} photo${imageFiles.length !== 1 ? 's' : ''}…`)

    const form = new FormData()
    for (const f of imageFiles) form.append('files', f)

    try {
      const res = await fetch('/api/upload/photo', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      const result = await res.json() as UploadResult
      const okCount = result.uploaded.length
      const failCount = result.failed.length
      setStatus(
        failCount > 0
          ? `${okCount} uploaded, ${failCount} failed`
          : `${okCount} photo${okCount !== 1 ? 's' : ''} uploaded`,
      )
      onUploadsComplete(result)
    } catch (err) {
      setStatus(`Upload failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
      setTimeout(() => setStatus(null), 4000)
    }
  }, [onUploadsComplete])

  const uploadRemote = useCallback(async (items: Array<{ remoteUrl: string; filename: string; authHeader?: string }>, sourceLabel: string) => {
    if (items.length === 0) return
    setBusy(true)

    const results: UploadResult = { uploaded: [], failed: [] }
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      setStatus(`Importing from ${sourceLabel} (${i + 1}/${items.length})…`)
      try {
        const res = await fetch('/api/upload/photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          results.failed.push({ name: item.filename, error: (data as { error?: string }).error ?? `HTTP ${res.status}` })
        } else {
          const ok = (data as UploadResult).uploaded
          if (ok?.length) results.uploaded.push(...ok)
        }
      } catch (err) {
        results.failed.push({ name: item.filename, error: (err as Error).message })
      }
    }

    setStatus(
      results.failed.length > 0
        ? `${results.uploaded.length} imported, ${results.failed.length} failed`
        : `${results.uploaded.length} photo${results.uploaded.length !== 1 ? 's' : ''} imported`,
    )
    onUploadsComplete(results)
    setBusy(false)
    setTimeout(() => setStatus(null), 4000)
  }, [onUploadsComplete])

  const handleDeviceClick = () => fileInputRef.current?.click()

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // allow re-selecting the same file
    if (files.length > 0) void uploadLocalFiles(files)
  }

  const handleDriveClick = async () => {
    try {
      const picked = await openGoogleDrivePicker()
      if (picked.length === 0) return
      await uploadRemote(
        picked.map((p) => ({
          remoteUrl: `https://www.googleapis.com/drive/v3/files/${p.id}?alt=media`,
          filename: p.name,
          authHeader: `Bearer ${p.accessToken}`,
        })),
        'Google Drive',
      )
    } catch (err) {
      setStatus((err as Error).message)
      setTimeout(() => setStatus(null), 4000)
    }
  }

  const handleDropboxClick = async () => {
    try {
      const picked = await openDropboxChooser()
      if (picked.length === 0) return
      await uploadRemote(
        picked.map((p) => ({ remoteUrl: p.link, filename: p.name })),
        'Dropbox',
      )
    } catch (err) {
      setStatus((err as Error).message)
      setTimeout(() => setStatus(null), 4000)
    }
  }

  // ── Drag-drop handlers on the wrapper ──────────────────────────────────────
  // Use a counter so child enter/leave events don't unset dragging prematurely.
  const handleDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    dragCounter.current++
    setDragging(true)
  }
  const handleDragLeave = () => {
    dragCounter.current--
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setDragging(false)
    }
  }
  const handleDragOver = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current = 0
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) void uploadLocalFiles(files)
  }

  return (
    <div>
      {/* Upload bar */}
      <div className="mb-4 rounded-2xl border border-white/[0.06] bg-obsidian p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[12rem]">
          <p className="text-sm font-medium text-cream">Add photos to your library</p>
          <p className="text-xs text-ash mt-0.5">
            {busy
              ? status ?? 'Working…'
              : status ?? 'Drop files here or use the buttons. New uploads land in the Available view.'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={handleFileInputChange}
          />
          <button
            type="button"
            onClick={handleDeviceClick}
            disabled={busy}
            className="px-3.5 py-2 rounded-lg bg-cream hover:bg-bone disabled:opacity-50 text-ink font-medium text-xs transition-colors"
          >
            From device
          </button>
          {hasDrive && (
            <button
              type="button"
              onClick={handleDriveClick}
              disabled={busy}
              className="px-3.5 py-2 rounded-lg border border-white/[0.10] bg-onyx hover:bg-slate disabled:opacity-50 text-cream text-xs transition-colors"
            >
              Google Drive
            </button>
          )}
          {hasDropbox && (
            <button
              type="button"
              onClick={handleDropboxClick}
              disabled={busy}
              className="px-3.5 py-2 rounded-lg border border-white/[0.10] bg-onyx hover:bg-slate disabled:opacity-50 text-cream text-xs transition-colors"
            >
              Dropbox
            </button>
          )}
        </div>
      </div>

      {/* Drop-zone wrapper around library */}
      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`relative rounded-2xl transition-colors ${
          dragging ? 'ring-2 ring-cream/40 ring-offset-2 ring-offset-ink' : ''
        }`}
      >
        {dragging && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-ink/80 border-2 border-dashed border-cream/30 pointer-events-none">
            <div className="text-center">
              <div className="text-3xl">↓</div>
              <p className="text-cream text-sm font-medium mt-1">Drop to upload</p>
            </div>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
