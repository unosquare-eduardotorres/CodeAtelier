import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageSquarePlus } from 'lucide-react'
import { useChatStore, useChatActions, useProfileStore } from '@renderer/store'
import { CORE_AGENT_DEFAULTS } from '@renderer/utils/agentIdentity'
import { MessageBubble, HandoffIndicator, TaskPlanCard, GrillQuestionCard } from '@renderer/components/chat'
import type { MessageBubbleActions } from './MessageBubble'
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
    <div className="mx-4 mb-2 px-4 py-2.5 rounded-lg bg-warning-muted border border-warning/30 flex items-center gap-3">
      <span className="text-warning text-sm font-medium">!</span>
      <div className="flex-1">
        <p className="text-sm text-warning">
          Context is getting large ({Math.round(inputTokens / 1000)}K tokens). Consider compacting
          to preserve performance.
        </p>
      </div>
      <button
        onClick={onCompact}
        className="px-3 py-1 rounded bg-mode-build hover:brightness-110 text-white text-xs font-medium transition-colors"
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
  const pendingGrillQuestions = useChatStore((s) => s.grillSession?.pendingQuestions ?? null)
  const hasPendingGrillQuestions = (pendingGrillQuestions?.length ?? 0) > 0

  const { executePlan, clearTaskPlan, setCompactSuggestion, sendMessage, submitGrillAnswers, skipAllGrillQuestions, updateMode, appendLocalMessage, clearGrillSession, createItemsFromGrill } =
    useChatActions()
  const taskProgress = useChatStore((s) => s.taskProgress)

  // Single actions object passed to all MessageBubbles — avoids N×useShallow subscriptions
  const bubbleActions: MessageBubbleActions = useMemo(() => ({
    updateMode,
    sendMessage,
    appendLocalMessage,
    clearGrillSession,
    createItemsFromGrill,
    submitGrillAnswers,
    skipAllGrillQuestions
  }), [updateMode, sendMessage, appendLocalMessage, clearGrillSession, createItemsFromGrill, submitGrillAnswers, skipAllGrillQuestions])

  const generalistAlias = useProfileStore((s) => {
    const alias = s.coreAgentAliases.find((a) => a.agentRole === 'generalist')
    return alias?.alias || CORE_AGENT_DEFAULTS.generalist.displayName
  })

  const userName = useProfileStore((s) => s.profile?.displayName?.split(' ')[0] ?? null)

  // Scroll container ref for virtualizer
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll state
  const shouldAutoScroll = useRef(true)
  const isUserScrolling = useRef(false)

  // Handle scroll events to determine if user is at bottom
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    let scrollTimeout: ReturnType<typeof setTimeout>

    const handleScroll = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = container
      shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 100

      isUserScrolling.current = true
      clearTimeout(scrollTimeout)
      scrollTimeout = setTimeout(() => {
        isUserScrolling.current = false
      }, 150)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      clearTimeout(scrollTimeout)
    }
  }, [])

  // Virtualizer for messages
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 150,
    overscan: 5
  })

  // Auto-scroll to bottom when new messages arrive or streaming content updates
  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, streamingContent])

  // Measure callback for virtualizer — wrapped in useCallback for stable reference
  const measureElement = useCallback(
    (el: HTMLElement | null) => {
      if (el) {
        virtualizer.measureElement(el)
      }
    },
    [virtualizer]
  )

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="relative flex-1 flex flex-col items-center justify-center text-center px-8">
        <FloatingRobots />
        <div className="relative z-10 w-14 h-14 rounded-2xl bg-primary-muted border border-primary/20 flex items-center justify-center mb-4">
          <MessageSquarePlus size={24} className="text-primary-text" />
        </div>
        <h3 className="relative z-10 text-lg font-medium text-text-secondary mb-2">
          {userName ? `What are we building, ${userName}?` : 'Start a conversation'}
        </h3>
        <p className="relative z-10 text-sm text-text-muted max-w-md">
          {userName
            ? `Ask anything, brainstorm ideas, or describe what you want built — ${generalistAlias} and the specialists are standing by.`
            : `Chat with your AI development partner. Ask questions, brainstorm ideas, review code, or describe what you want built — ${generalistAlias} will handle it or hand off to specialists.`}
        </p>
      </div>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="relative flex-1 min-h-0">
      <FloatingRobots />
      <div
        ref={scrollRef}
        className="relative z-10 flex-1 overflow-y-auto px-6 py-4 h-full"
      >
        {/* Virtualized message list */}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative'
          }}
        >
          {virtualItems.map((virtualRow) => {
            const msg = messages[virtualRow.index]
            return (
              <div
                key={msg.id}
                ref={measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                <div className="pb-4">
                  <MessageBubble
                    message={msg}
                    searchHighlight={searchQuery}
                    actions={bubbleActions}
                    suppressInlineGrillCard={
                      hasPendingGrillQuestions &&
                      msg.role !== 'user' &&
                      virtualRow.index === messages.length - 1
                    }
                  />
                </div>
              </div>
            )
          })}
        </div>

        {/* Non-virtualized footer items — always rendered below the virtual list */}

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

        {/* Store-driven Grill Question Card — authoritative rendering */}
        {hasPendingGrillQuestions && pendingGrillQuestions && (
          <div className="flex justify-start px-4">
            <div className="max-w-[85%]">
              <GrillQuestionCard
                questions={pendingGrillQuestions}
                onSubmit={submitGrillAnswers}
                onSkipAll={skipAllGrillQuestions}
              />
            </div>
          </div>
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
                        <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
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
            actions={bubbleActions}
          />
        )}
      </div>
    </div>
  )
}
