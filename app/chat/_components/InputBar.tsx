'use client'

import { useRef, useCallback, type KeyboardEvent } from 'react'

interface InputBarProps {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  disabled: boolean
  isStreaming: boolean
}

export default function InputBar({ value, onChange, onSend, onStop, disabled, isStreaming }: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (!disabled && value.trim()) onSend()
      }
    },
    [disabled, value, onSend],
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value)
      // Auto-resize textarea
      const el = textareaRef.current
      if (el) {
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`
      }
    },
    [onChange],
  )

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-end gap-3 rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 focus-within:border-amber-500/50 transition-colors">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Message BrewCast…"
          rows={1}
          disabled={disabled && !isStreaming}
          className="flex-1 resize-none bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none leading-relaxed disabled:opacity-50"
          style={{ minHeight: '24px', maxHeight: '200px' }}
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            className="flex-shrink-0 w-8 h-8 rounded-full bg-zinc-700 hover:bg-zinc-600 flex items-center justify-center transition-colors"
            title="Stop generation"
          >
            <span className="w-2.5 h-2.5 bg-zinc-300 rounded-sm" />
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={disabled || !value.trim()}
            className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
            title="Send (Enter)"
          >
            <svg
              className="w-3.5 h-3.5 text-zinc-950 rotate-90"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          </button>
        )}
      </div>
      <p className="mt-1.5 text-center text-xs text-zinc-600">
        Enter to send · Shift+Enter for new line
      </p>
    </div>
  )
}
