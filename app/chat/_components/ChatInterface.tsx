'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import MessageBubble from './MessageBubble'
import InputBar, { type ChatAttachment } from './InputBar'
import LibraryPicker from './LibraryPicker'
import type { BreweryPhoto } from '@/app/api/upload/photos/route'

const STORAGE_KEY = 'brewcast_chat'

function loadMessages(): UIMessage[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveMessages(messages: UIMessage[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
  } catch {
    // storage quota — silently ignore
  }
}

export default function ChatInterface() {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const restoringFromStorage = useRef(false)

  const { messages, status, sendMessage, stop, setMessages } = useChat({
    id: 'brewcast-main',
    transport: new DefaultChatTransport({ api: '/api/agent' }),
  })

  const isStreaming = status === 'streaming' || status === 'submitted'
  const isReady = status === 'ready'

  useEffect(() => {
    const saved = loadMessages()
    if (saved.length > 0) {
      restoringFromStorage.current = true
      setMessages(saved)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (messages.length > 0) saveMessages(messages)
  }, [messages])

  useEffect(() => {
    if (messages.length === 0) return
    const behavior = restoringFromStorage.current ? 'auto' : 'smooth'
    restoringFromStorage.current = false
    bottomRef.current?.scrollIntoView({ behavior })
  }, [messages])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || isStreaming) return

    // Prepend attachment URLs so the agent knows which photos to operate on.
    // The agent's system prompt looks for this marker and uses these URLs
    // directly with caption/draft tools, skipping list_brewery_photos.
    const finalText = attachments.length > 0
      ? `[Attached photos — work with these URLs (do NOT call list_brewery_photos):\n${attachments.map((a) => a.url).join('\n')}]\n\n${text || 'Please use these photos.'}`
      : text

    setInput('')
    setAttachments([])
    sendMessage({ text: finalText })
  }, [input, attachments, isStreaming, sendMessage])

  const handleClear = useCallback(() => {
    stop()
    setMessages([])
    setAttachments([])
    localStorage.removeItem(STORAGE_KEY)
  }, [setMessages, stop])

  const handleUploadComplete = useCallback(
    (publicUrl: string) => {
      sendMessage({ text: `I've uploaded the file. The public URL is: ${publicUrl}` })
    },
    [sendMessage],
  )

  const handleRemoveAttachment = useCallback((url: string) => {
    setAttachments((prev) => prev.filter((a) => a.url !== url))
  }, [])

  const handleLibraryConfirm = useCallback((picked: BreweryPhoto[]) => {
    setPickerOpen(false)
    setAttachments((prev) => {
      const existing = new Set(prev.map((a) => a.url))
      const fresh = picked
        .filter((p) => !existing.has(p.url))
        .map<ChatAttachment>((p) => ({ url: p.url, name: p.name, source: 'library' }))
      return [...prev, ...fresh].slice(0, 10)
    })
  }, [])

  const handleLocalFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    setUploading(true)
    const form = new FormData()
    for (const f of imageFiles) form.append('files', f)

    try {
      const res = await fetch('/api/upload/photo', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      const result = await res.json() as {
        uploaded: Array<{ url: string; name: string }>
        failed: Array<{ name: string; error: string }>
      }
      setAttachments((prev) => {
        const existing = new Set(prev.map((a) => a.url))
        const fresh = result.uploaded
          .filter((u) => !existing.has(u.url))
          .map<ChatAttachment>((u) => ({ url: u.url, name: u.name, source: 'upload' }))
        return [...prev, ...fresh].slice(0, 10)
      })
    } catch (err) {
      console.error('[chat upload]', err)
    } finally {
      setUploading(false)
    }
  }, [])

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <header className="flex items-center justify-end px-6 py-2 border-b border-white/[0.06] flex-shrink-0">
        <button
          onClick={handleClear}
          disabled={messages.length === 0 && !isStreaming}
          className="px-3 py-1.5 rounded-lg text-xs text-ash hover:bg-onyx hover:text-bone disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Clear chat
        </button>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          {messages.length === 0 ? (
            <EmptyState onPrompt={setInput} />
          ) : (
            messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onUploadComplete={handleUploadComplete}
              />
            ))
          )}

          {status === 'submitted' && (
            <div className="flex gap-3 justify-start">
              <div className="w-7 h-7 rounded-full bg-cream flex items-center justify-center flex-shrink-0">
                <span className="text-xs font-bold text-ink">B</span>
              </div>
              <div className="rounded-2xl rounded-tl-sm bg-onyx px-4 py-3 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-ash animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-ash animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-ash animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {status === 'error' && (
        <div className="max-w-3xl mx-auto w-full px-6 mb-3">
          <div className="rounded-xl border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            Something went wrong — please try again.
          </div>
        </div>
      )}

      <InputBar
        value={input}
        onChange={setInput}
        onSend={handleSend}
        onStop={stop}
        disabled={!isReady}
        isStreaming={isStreaming}
        attachments={attachments}
        onRemoveAttachment={handleRemoveAttachment}
        onOpenLibrary={() => setPickerOpen(true)}
        onLocalFiles={handleLocalFiles}
        uploading={uploading}
      />

      <LibraryPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onConfirm={handleLibraryConfirm}
      />
    </div>
  )
}

const STARTER_PROMPTS = [
  "Let's create a post for a new beer launch 🍺",
  "Make a reel for our upcoming tap takeover event",
  "Behind-the-scenes content from the brewery floor",
  "Seasonal promo for our summer IPA",
]

function EmptyState({ onPrompt }: { onPrompt: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 py-16">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold text-cream">Good day, brewer! 👋</h2>
        <p className="text-ash max-w-md">
          I&apos;m BrewCast, your AI social media manager. What would you like to create today?
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 max-w-lg w-full">
        {STARTER_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            onClick={() => onPrompt(prompt)}
            className="text-left rounded-xl border border-white/[0.08] bg-onyx hover:border-white/[0.10] px-4 py-3 text-sm text-bone transition-colors"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  )
}
