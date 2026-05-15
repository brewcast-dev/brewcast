'use client'

import type { UIMessage } from 'ai'
import ReactMarkdown from 'react-markdown'
import ToolCard from './ToolCard'

interface MessageBubbleProps {
  message: UIMessage
  onUploadComplete?: (publicUrl: string) => void
}

export default function MessageBubble({ message, onUploadComplete }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {/* Avatar */}
      {!isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-cream flex items-center justify-center mt-1">
          <span className="text-xs font-bold text-ink">B</span>
        </div>
      )}

      <div className={`flex flex-col gap-2 max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
        {message.parts.map((part, index) => {
          // ── Text part ───────────────────────────────────────────────────────
          if (part.type === 'text') {
            if (!part.text.trim()) return null
            return (
              <div
                key={index}
                className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed
                  ${isUser
                    ? 'bg-cream text-ink rounded-tr-sm'
                    : 'bg-onyx text-cream rounded-tl-sm'
                  }`}
              >
                {isUser ? (
                  part.text
                ) : (
                  <ReactMarkdown
                    components={{
                      p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      em: ({ children }) => <em className="italic">{children}</em>,
                      ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
                      li: ({ children }) => <li>{children}</li>,
                      code: ({ children }) => (
                        <code className="bg-slate text-ember rounded px-1 py-0.5 text-xs font-mono">
                          {children}
                        </code>
                      ),
                      pre: ({ children }) => (
                        <pre className="bg-obsidian rounded-lg p-3 overflow-x-auto text-xs font-mono my-2">
                          {children}
                        </pre>
                      ),
                      a: ({ href, children }) => (
                        <a href={href} className="text-cream underline hover:text-ember">
                          {children}
                        </a>
                      ),
                      h1: ({ children }) => <h1 className="text-base font-bold mb-1">{children}</h1>,
                      h2: ({ children }) => <h2 className="text-sm font-bold mb-1">{children}</h2>,
                      h3: ({ children }) => <h3 className="text-sm font-semibold mb-1">{children}</h3>,
                      blockquote: ({ children }) => (
                        <blockquote className="border-l-2 border-white/[0.10] pl-3 italic text-ash my-2">
                          {children}
                        </blockquote>
                      ),
                      hr: () => <hr className="border-white/[0.10] my-3" />,
                    }}
                  >
                    {part.text}
                  </ReactMarkdown>
                )}
              </div>
            )
          }

          // ── Tool invocation parts ───────────────────────────────────────────
          if (part.type.startsWith('tool-')) {
            const toolName = part.type.slice('tool-'.length)
            const toolPart = part as {
              type: string
              state: string
              input: Record<string, unknown>
              output?: Record<string, unknown>
            }
            const card = (
              <ToolCard
                key={index}
                toolName={toolName}
                state={toolPart.state}
                input={toolPart.input ?? {}}
                output={toolPart.output as Record<string, unknown> | undefined}
                onUploadComplete={onUploadComplete}
              />
            )
            return card
          }

          // ── step-start: skip ────────────────────────────────────────────────
          if (part.type === 'step-start') return null

          return null
        })}
      </div>

      {/* User avatar */}
      {isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-onyx flex items-center justify-center mt-1">
          <span className="text-xs text-bone">👤</span>
        </div>
      )}
    </div>
  )
}
