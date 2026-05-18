'use client'

import { useRef, useCallback, useState, useEffect, type KeyboardEvent } from 'react'

export interface ChatAttachment {
  url: string
  name: string
  source: 'library' | 'upload'
}

interface InputBarProps {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  disabled: boolean
  isStreaming: boolean
  attachments: ChatAttachment[]
  onRemoveAttachment: (url: string) => void
  onOpenLibrary: () => void
  onLocalFiles: (files: File[]) => void
  uploading?: boolean
}

export default function InputBar({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  isStreaming,
  attachments,
  onRemoveAttachment,
  onOpenLibrary,
  onLocalFiles,
  uploading,
}: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [menuOpen])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (!disabled && (value.trim() || attachments.length > 0)) onSend()
      }
    },
    [disabled, value, attachments.length, onSend],
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value)
      const el = textareaRef.current
      if (el) {
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`
      }
    },
    [onChange],
  )

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length > 0) onLocalFiles(files)
  }

  const canSend = !disabled && (value.trim().length > 0 || attachments.length > 0)
  const placeholder = attachments.length > 0
    ? 'Tell BrewCast what to do with these…'
    : 'Message BrewCast…'

  return (
    <div className="border-t border-white/[0.06] bg-ink p-4">
      {/* Attachment strip */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((att) => (
            <div
              key={att.url}
              className="relative group w-14 h-14 rounded-lg overflow-hidden border border-white/[0.10] bg-onyx"
              title={att.name}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={att.url} alt={att.name} className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => onRemoveAttachment(att.url)}
                className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/80 text-cream text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="Remove attachment"
              >
                ✕
              </button>
              <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-cream/80 text-center py-0.5">
                {att.source === 'library' ? 'library' : 'uploaded'}
              </span>
            </div>
          ))}
          {uploading && (
            <div className="w-14 h-14 rounded-lg border border-white/[0.10] bg-onyx flex items-center justify-center">
              <span className="text-ash text-xs animate-spin">⟳</span>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 rounded-2xl border border-white/[0.08] bg-obsidian px-3 py-3 focus-within:border-cream/30/50 transition-colors">
        {/* + button + menu */}
        <div className="relative flex-shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={disabled && !isStreaming}
            className="w-8 h-8 rounded-full border border-white/[0.10] bg-onyx hover:bg-slate text-cream flex items-center justify-center transition-colors disabled:opacity-40"
            title="Attach photos"
            aria-label="Attach photos"
          >
            <span className="text-lg leading-none">+</span>
          </button>
          {menuOpen && (
            <div
              className="absolute z-50 w-60 rounded-xl border border-white/[0.10] bg-obsidian shadow-xl overflow-hidden"
              style={{ bottom: 'calc(100% + 8px)', left: 0 }}
            >
              <button
                type="button"
                onClick={() => { setMenuOpen(false); onOpenLibrary() }}
                className="w-full px-4 py-2.5 text-left text-sm text-cream hover:bg-onyx transition-colors flex items-center gap-2 whitespace-nowrap"
              >
                <span>🖼️</span>
                <span>From BrewCast library</span>
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); fileInputRef.current?.click() }}
                className="w-full px-4 py-2.5 text-left text-sm text-cream hover:bg-onyx transition-colors border-t border-white/[0.06] flex items-center gap-2 whitespace-nowrap"
              >
                <span>📤</span>
                <span>Upload from device</span>
              </button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={handleFileInputChange}
          />
        </div>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled && !isStreaming}
          className="flex-1 resize-none bg-transparent text-sm text-cream placeholder-smoke outline-none leading-relaxed disabled:opacity-50"
          style={{ minHeight: '24px', maxHeight: '200px' }}
        />

        {isStreaming ? (
          <button
            onClick={onStop}
            className="flex-shrink-0 w-8 h-8 rounded-full bg-slate hover:bg-onyx flex items-center justify-center transition-colors"
            title="Stop generation"
          >
            <span className="w-2.5 h-2.5 bg-bone rounded-sm" />
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!canSend}
            className="flex-shrink-0 w-8 h-8 rounded-full bg-cream hover:bg-bone disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
            title="Send (Enter)"
          >
            <svg
              className="w-3.5 h-3.5 text-ink rotate-90"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          </button>
        )}
      </div>
      <p className="mt-1.5 text-center text-xs text-smoke">
        Enter to send · Shift+Enter for new line
      </p>
    </div>
  )
}
