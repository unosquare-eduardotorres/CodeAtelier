import { useShallow } from 'zustand/react/shallow'
import { MessageSquarePlus } from 'lucide-react'
import { useChatStore } from '@renderer/store'
import { useAutoScroll } from '@renderer/hooks'
import { MessageBubble, HandoffIndicator, TaskPlanCard } from '@renderer/components/chat'
import FloatingRobots from './FloatingRobots'

function CompactSuggestionBanner({
  inputTokens,
  onCompact,
  onDismiss
}: {
  inputTokens: number
  onCompact: () => void
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div className="mx-4 mb-2 px-4 py-2.5 rounded-lg bg-warning-muted border border-amber-600/30 flex items-center gap-3">
      <span className="text-warning text-sm font-medium">!</span>
      <div className="flex-1">
        <p className="text-sm text-amber-200">
          Context is getting large ({Math.round(inputTokens / 1000)}K tokens). Consider compacting
          to preserve performance.
        </p>
      </div>
      <button
        onClick={onCompact}
        className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-colors"
      >
        /compact
      </button>
      <button onClick={onDismiss} className="text-text-muted hover:text-text-primary text-xs">
        Dismiss
      </button>
    </div>
  )
}

interface MessageListProps {
  searchQuery?: string
}

export default function MessageList({ searchQuery }: MessageListProps): React.JSX.Element {
  const messages = useChatStore((s) => s.messages)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const streamingRole = useChatStore((s) => s.streamingRole)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const activeHandoff = useChatStore((s) => s.activeHandoff)
  const toolActivities = useChatStore((s) => s.toolActivities)
  const activeTaskPlan = useChatStore((s) => s.activeTaskPlan)
  const isExecutingPlan = useChatStore((s) => s.isExecutingPlan)
  const compactSuggestion = useChatStore((s) => s.compactSuggestion)

  const { taskProgress, executePlan, clearTaskPlan, setCompactSuggestion, sendMessage } =
    useChatStore(
      useShallow((s) => ({
        taskProgress: s.taskProgress,
        executePlan: s.executePlan,
        clearTaskPlan: s.clearTaskPlan,
        setCompactSuggestion: s.setCompactSuggestion,
        sendMessage: s.sendMessage
      }))
    )

  const scrollRef = useAutoScroll([messages.length, streamingContent])

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="relative flex-1 flex flex-col items-center justify-center text-center px-8">
        <FloatingRobots />
        <div className="relative z-10 w-14 h-14 rounded-2xl bg-primary-muted border border-primary/20 flex items-center justify-center mb-4">
          <MessageSquarePlus size={24} className="text-primary-text" />
        </div>
        <h3 className="relative z-10 text-lg font-medium text-text-secondary mb-2">
          Start a conversation
        </h3>
        <p className="relative z-10 text-sm text-text-muted max-w-md">
          Chat with your AI development partner. Ask questions, brainstorm ideas, review code, or
          describe what you want built — the generalist will handle it or hand off to specialists.
        </p>
      </div>
    )
  }

  return (
    <div className="relative flex-1 min-h-0">
      <FloatingRobots />
      <div
        ref={scrollRef}
        className="relative z-10 flex-1 overflow-y-auto px-6 py-4 space-y-4 h-full"
      >
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} searchHighlight={searchQuery} />
        ))}

        {/* Handoff indicator — shown when generalist triggers a handoff */}
        {activeHandoff && !activeTaskPlan && (
          <HandoffIndicator
            summary={activeHandoff.summary}
            specialists={activeHandoff.specialists}
            mode={activeHandoff.mode}
          />
        )}

        {/* Task plan card — shown after orchestrator decomposes the handoff */}
        {activeTaskPlan && (
          <TaskPlanCard
            summary={activeTaskPlan.summary}
            tasks={activeTaskPlan.tasks}
            mode={activeTaskPlan.mode}
            taskProgress={taskProgress}
            isExecuting={isExecutingPlan}
            onExecute={executePlan}
            onDismiss={clearTaskPlan}
          />
        )}

        {/* Compact suggestion banner */}
        {compactSuggestion && (
          <CompactSuggestionBanner
            inputTokens={compactSuggestion.inputTokens}
            onCompact={() => {
              setCompactSuggestion(null)
              sendMessage('/compact')
            }}
            onDismiss={() => setCompactSuggestion(null)}
          />
        )}

        {/* Thinking indicator: shows when streaming but no content yet */}
        {isStreaming && !streamingContent && (
          <div className="flex justify-start">
            <div className="flex flex-col gap-2 px-5 py-4 rounded-xl bg-surface-overlay border border-border-subtle shadow-sm">
              <div className="flex items-center gap-2">
                <svg
                  className="animate-spin h-4 w-4 text-primary-text"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                <span className="text-sm text-text-secondary">
                  {activeHandoff ? 'Working on it...' : 'Thinking...'}
                </span>
              </div>
              {toolActivities.some((a) => a.status === 'running') && (
                <div className="space-y-1 border-l-2 border-border-subtle pl-3 ml-1">
                  {toolActivities
                    .filter((a) => a.status === 'running')
                    .slice(-5)
                    .map((activity) => (
                      <div key={activity.id} className="flex items-center gap-2 text-xs">
                        <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                        <span className="font-mono text-text-body">{activity.toolName}</span>
                        {activity.input && (
                          <span className="text-text-muted truncate max-w-[300px]">
                            {activity.input}
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Streaming message bubble */}
        {isStreaming && streamingContent && (
          <MessageBubble
            message={{
              id: 'streaming',
              conversationId: '',
              role: streamingRole,
              contentMd: streamingContent,
              attachmentsJson: '[]',
              createdAt: new Date().toISOString()
            }}
            isStreaming
            toolActivities={toolActivities}
          />
        )}
      </div>
    </div>
  )
}
