'use client'

import { useCallback, useRef, useState } from 'react'

interface UploadZoneProps {
  uploadUrl: string
  publicUrl: string
  contentType: string
  onComplete: (publicUrl: string) => void
}

export default function UploadZone({ uploadUrl, publicUrl, contentType, onComplete }: UploadZoneProps) {
  const [progress, setProgress] = useState<number | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragOver = useRef(false)
  const [dragging, setDragging] = useState(false)

  const upload = useCallback(
    async (file: File) => {
      setError(null)
      setProgress(0)

      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('PUT', uploadUrl)
          xhr.setRequestHeader('Content-Type', file.type || contentType)
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
          }
          xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)))
          xhr.onerror = () => reject(new Error('Network error'))
          xhr.send(file)
        })
        setProgress(100)
        setDone(true)
        onComplete(publicUrl)
      } catch (e: unknown) {
        setError((e as Error).message)
        setProgress(null)
      }
    },
    [uploadUrl, publicUrl, contentType, onComplete],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) upload(file)
    },
    [upload],
  )

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) upload(file)
    },
    [upload],
  )

  if (done) {
    return (
      <div className="rounded-xl border border-green-700 bg-green-950 px-4 py-3 flex items-center gap-2">
        <span className="text-green-400">✓</span>
        <span className="text-sm text-green-300">File uploaded successfully</span>
      </div>
    )
  }

  const accept = contentType.startsWith('video') ? 'video/mp4' : 'image/jpeg,image/png,image/webp'

  return (
    <div
      className={`rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors
        ${dragging ? 'border-amber-400 bg-amber-400/10' : 'border-zinc-600 bg-zinc-800 hover:border-zinc-500'}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragOver.current) { setDragging(true); dragOver.current = true }
      }}
      onDragLeave={() => { setDragging(false); dragOver.current = false }}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={handleFile} />

      {progress !== null ? (
        <div className="space-y-2">
          <p className="text-sm text-zinc-400">Uploading… {progress}%</p>
          <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-400 transition-all duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-2xl">📎</p>
          <p className="text-sm text-zinc-300">
            {contentType.startsWith('video')
              ? 'Drop a video clip here (MP4, max 60s)'
              : 'Drop an image here (JPG / PNG / WEBP)'}
          </p>
          <p className="text-xs text-zinc-500">or click to browse</p>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
