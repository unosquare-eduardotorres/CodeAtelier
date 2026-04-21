import { useState, useEffect } from 'react'
import { X, User, Bot, Wrench } from 'lucide-react'

interface SpecialistInspectorProps {
  sessionId: string
  subagentId: string
  onClose: () => void
}

export default function SpecialistInspector({
  sessionId,
  subagentId,
  onClose
}: SpecialistInspectorProps): React.JSX.Element {
  const [messages, setMessages] = useState<unknown[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    window.api
      .sdkGetSubagentMessages({ sessionId, subagentId })
      .then((msgs) => {
        setMessages(msgs)
        setLoading(false)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load messages')
        setLoading(false)
      })
  }, [sessionId, subagentId])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2 min-w-0">
          <Bot size={16} className="text-primary-text flex-shrink-0" />
          <span className="text-sm font-semibold text-text-primary truncate">
            Specialist: {subagentId}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors flex-shrink-0"
          aria-label="Close inspector"
        >
          <X size={16} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-text-secondary animate-pulse">
              Loading transcript&hellip;
            </span>
          </div>
        )}
        {error && (
          <div className="text-sm text-danger px-3 py-2 rounded bg-danger-muted">{error}</div>
        )}
        {!loading && !error && messages.length === 0 && (
          <div className="text-sm text-text-muted text-center py-8">No messages found</div>
        )}
        {messages.map((msg, idx) => {
          const m = msg as Record<string, unknown>
          const role = m.role as string
          const isAssistant = role === 'assistant'
          const content = m.content

          return (
            <div key={idx} className="text-sm">
              <div className="flex items-center gap-1.5 mb-1">
                {isAssistant ? (
                  <Bot size={12} className="text-primary-text" />
                ) : (
                  <User size={12} className="text-text-secondary" />
                )}
                <span className="text-xs font-medium text-text-secondary uppercase">{role}</span>
              </div>
              <div className="pl-5 text-text-body">
                {typeof content === 'string' ? (
                  <p className="whitespace-pre-wrap">{content}</p>
                ) : Array.isArray(content) ? (
                  (content as Record<string, unknown>[]).map((block, bi) => {
                    if (block.type === 'text') {
                      return (
                        <p key={bi} className="whitespace-pre-wrap">
                          {block.text as string}
                        </p>
                      )
                    }
                    if (block.type === 'tool_use') {
                      return (
                        <div
                          key={bi}
                          className="my-1.5 px-2 py-1.5 rounded bg-surface-overlay border border-border-subtle"
                        >
                          <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                            <Wrench size={10} />
                            <span className="font-mono">{block.name as string}</span>
                          </div>
                          <pre className="text-[10px] text-text-muted mt-1 truncate max-w-full overflow-hidden">
                            {JSON.stringify(block.input, null, 2).substring(0, 200)}
                          </pre>
                        </div>
                      )
                    }
                    if (block.type === 'tool_result') {
                      return (
                        <div
                          key={bi}
                          className="my-1 px-2 py-1 rounded bg-surface-base border border-border-subtle text-xs text-text-muted"
                        >
                          Result:{' '}
                          {typeof block.content === 'string'
                            ? block.content.substring(0, 200)
                            : '...'}
                        </div>
                      )
                    }
                    return null
                  })
                ) : (
                  <p className="text-text-muted italic">Unknown content format</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
