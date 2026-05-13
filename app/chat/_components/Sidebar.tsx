'use client'

import Link from 'next/link'

interface Conversation {
  id: string
  title: string
  timestamp: number
}

interface SidebarProps {
  conversations: Conversation[]
  activeChatId: string
  streamingChatIds: string[]
  onNewChat: () => void
  onSelectChat: (id: string) => void
}

export default function Sidebar({
  conversations,
  activeChatId,
  streamingChatIds,
  onNewChat,
  onSelectChat,
}: SidebarProps) {
  return (
    <aside className="flex flex-col w-60 flex-shrink-0 border-r border-zinc-800 bg-zinc-900 overflow-hidden">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-zinc-800">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-amber-400 font-bold text-lg tracking-tight">BrewCast</span>
          <span className="text-zinc-600 text-xs mt-0.5">AI</span>
        </Link>
      </div>

      {/* New chat */}
      <div className="px-3 py-3">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
        >
          <span className="text-base">✏️</span>
          New chat
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1 scrollbar-thin">
        {conversations.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-zinc-600">No conversations yet</p>
        ) : (
          conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => onSelectChat(conv.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2
                ${conv.id === activeChatId
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
            >
              <span className="flex-1 truncate">{conv.title}</span>
              {streamingChatIds.includes(conv.id) && (
                <span
                  className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"
                  title="Generating…"
                />
              )}
            </button>
          ))
        )}
      </div>

      {/* Nav links */}
      <div className="border-t border-zinc-800 px-3 py-3 space-y-1">
        {[
          { href: '/drafts', icon: '📋', label: 'Drafts' },
          { href: '/analytics', icon: '📊', label: 'Analytics' },
          { href: '/settings', icon: '⚙️', label: 'Settings' },
        ].map(({ href, icon, label }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            <span>{icon}</span>
            {label}
          </Link>
        ))}
      </div>
    </aside>
  )
}
