'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import Link from 'next/link'
import MessageBubble from './MessageBubble'
import InputBar from './InputBar'

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
  const bottomRef = useRef<HTMLDivElement>(null)
  // true while we're doing the first localStorage restore — scroll instantly
  const restoringFromStorage = useRef(false)

  const { messages, status, sendMessage, stop, setMessages } = useChat({
    id: 'brewcast-main',
    // No initialMessages here — starting empty ensures server and client render
    // the same empty state. localStorage is loaded in useEffect below.
    transport: new DefaultChatTransport({ api: '/api/agent' }),
  })

  const isStreaming = status === 'streaming' || status === 'submitted'
  const isReady = status === 'ready'

  // Load saved messages after mount — localStorage is only available client-side
  useEffect(() => {
    const saved = loadMessages()
    if (saved.length > 0) {
      restoringFromStorage.current = true
      setMessages(saved)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist every message change (skips the initial empty render)
  useEffect(() => {
    if (messages.length > 0) saveMessages(messages)
  }, [messages])

  // Scroll to bottom — instant when restoring history, smooth for new messages
  useEffect(() => {
    if (messages.length === 0) return
    const behavior = restoringFromStorage.current ? 'auto' : 'smooth'
    restoringFromStorage.current = false
    bottomRef.current?.scrollIntoView({ behavior })
  }, [messages])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || isStreaming) return
    setInput('')
    sendMessage({ text })
  }, [input, isStreaming, sendMessage])

  const handleClear = useCallback(() => {
    stop()
    setMessages([])
    localStorage.removeItem(STORAGE_KEY)
  }, [setMessages, stop])

  const handleUploadComplete = useCallback(
    (publicUrl: string) => {
      sendMessage({ text: `I've uploaded the file. The public URL is: ${publicUrl}` })
    },
    [sendMessage],
  )

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Page header — global nav lives in the root layout */}
      <header className="flex items-center justify-end px-6 py-2 border-b border-zinc-800 flex-shrink-0">
        <button
          onClick={handleClear}
          disabled={messages.length === 0 && !isStreaming}
          className="px-3 py-1.5 rounded-lg text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Clear chat
        </button>
      </header>

      {/* Message list — scroll container is full-width so the scrollbar sits
          flush with the right viewport edge, not inset inside the centered column */}
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

          {/* Typing indicator — three bouncing dots while waiting for first token */}
          {status === 'submitted' && (
            <div className="flex gap-3 justify-start">
              <div className="w-7 h-7 rounded-full bg-amber-500 flex items-center justify-center flex-shrink-0">
                <span className="text-xs font-bold text-zinc-950">B</span>
              </div>
              <div className="rounded-2xl rounded-tl-sm bg-zinc-800 px-4 py-3 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {status === 'error' && (
        <div className="max-w-3xl mx-auto w-full px-6 mb-3">
          <div className="rounded-xl border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
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
      />
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

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
        <h2 className="text-3xl font-bold text-amber-400">Good day, brewer! 👋</h2>
        <p className="text-zinc-400 max-w-md">
          I&apos;m BrewCast, your AI social media manager. What would you like to create today?
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 max-w-lg w-full">
        {STARTER_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            onClick={() => onPrompt(prompt)}
            className="text-left rounded-xl border border-zinc-700 bg-zinc-800 hover:border-zinc-600 px-4 py-3 text-sm text-zinc-300 transition-colors"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  )
}
