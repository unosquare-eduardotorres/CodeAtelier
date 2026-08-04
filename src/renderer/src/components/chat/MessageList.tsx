import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { useChatStore, useChatActions, useSpecialistStore } from '@renderer/store'
import { MessageBubble } from '@renderer/components/chat'
import type { MessageBubbleActions } from './MessageBubble'
import FloatingRobots from './FloatingRobots'
import ScrollToBottomButton from './ScrollToBottomButton'
import MessageListFooter from './MessageListFooter'
import AuditProvenanceBanner from './AuditProvenanceBanner'
import { useAutoScroll } from './useAutoScroll'
import { useMessageVirtualizer } from './useMessageVirtualizer'
import { useThinkingIdentity } from './useThinkingIdentity'
import { PLAN_BLOCK_RE, PLAN_BLOCK_CAPTURE_RE, BUILD_SUMMARY_RE } from './plan-detection'
import { usePlanExecutionStore } from '@renderer/store/plan-execution.store'

interface MessageListProps {
  searchQuery?: string
}

export default function MessageList({ searchQuery }: MessageListProps): React.JSX.Element {
  const allMessages = useChatStore((s) => s.messages)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const streamingSegments = useChatStore((s) => s.streamingSegments)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const toolActivities = useChatStore((s) => s.toolActivities)

  const { sendMessage, updateMode, appendLocalMessage } = useChatActions()

  // Idea popover state
  const [showIdeaPopover, setShowIdeaPopover] = useState(false)
  const [ideaPopoverData, setIdeaPopoverData] = useState<{
    title: string
    description: string
  } | null>(null)
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null)

  const handleSaveAsIdea = useCallback((title: string, description: string): void => {
    setIdeaPopoverData({ title, description })
    setShowIdeaPopover(true)
  }, [])

  const activeConversationId = useChatStore((s) => s.activeConversation?.id ?? null)
  const sourceAuditRunId = useChatStore((s) => s.activeConversation?.sourceAuditRunId ?? null)

  // Filter out hidden messages (auto-send messages persisted for context but not displayed)
  const messages = useMemo(() => allMessages.filter((m) => !m.hidden), [allMessages])

  // ── Latest plan message detection ──
  // Scan all messages (including hidden) in reverse to find the most recent plan message.
  // Only this message shows the non-superseded slim indicator; older plan messages show "superseded".
  const latestPlanMessageId = useMemo(() => {
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const msg = allMessages[i]
      if (msg.role !== 'user' && msg.contentMd && PLAN_BLOCK_RE.test(msg.contentMd) && !BUILD_SUMMARY_RE.test(msg.contentMd)) {
        return msg.id
      }
    }
    return null
  }, [allMessages])

  // ── Push latest plan content to store for ChatExecutionPanel ──
  useEffect(() => {
    if (!latestPlanMessageId || !activeConversationId) return
    const msg = allMessages.find((m) => m.id === latestPlanMessageId)
    if (!msg?.contentMd) return
    const match = PLAN_BLOCK_CAPTURE_RE.exec(msg.contentMd)
    if (match?.[1]) {
      usePlanExecutionStore.getState().setLatestPlanContent(activeConversationId, match[1])
    }
  }, [latestPlanMessageId, messages, activeConversationId])

  const bubbleActions: MessageBubbleActions = useMemo(
    () => ({
      updateMode,
      sendMessage,
      appendLocalMessage,
      saveAsIdea: handleSaveAsIdea
    }),
    [updateMode, sendMessage, appendLocalMessage, handleSaveAsIdea]
  )

  // ── Specialist identity resolution (extracted hook) ──
  const thinkingIdentity = useThinkingIdentity()

  const agentAlias = useSpecialistStore((s) => {
    const spec = s.specialists.find((sp) => sp.agentId === 'specialist')
    return spec?.alias ?? spec?.displayName ?? 'Agent'
  })

  // Aggregate all tool activities for the thinking indicator
  const allStreamingTools = useMemo(() => {
    if (!isStreaming) return []
    return [...streamingSegments.flatMap((s) => s.toolActivities), ...toolActivities]
  }, [isStreaming, streamingSegments, toolActivities])

  const userName = useSpecialistStore((s) => {
    const userSpec = s.specialists.find((sp) => sp.agentId === 'user')
    const name = userSpec?.alias ?? userSpec?.displayName
    return name?.split(' ')[0] ?? null
  })

  // ── Virtualizer + auto-scroll (extracted hooks) ──
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { virtualizer, measureElement } = useMessageVirtualizer(messages.length, scrollRef)


  // ── Scroll position preservation on plan supersession ──
  // When latestPlanMessageId changes, an old plan card collapses from ~400px to ~50px.
  // If the user is mid-scroll above the collapsing card, the viewport jumps upward.
  // We snapshot scrollHeight before the change and compensate afterward.
  const prevLatestPlanRef = useRef(latestPlanMessageId)
  const scrollSnapshotRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)

  // Snapshot scroll position BEFORE React commits the DOM update for the new latestPlanMessageId
  if (prevLatestPlanRef.current !== latestPlanMessageId && prevLatestPlanRef.current !== null) {
    if (scrollRef.current) {
      scrollSnapshotRef.current = {
        scrollTop: scrollRef.current.scrollTop,
        scrollHeight: scrollRef.current.scrollHeight
      }
    }
  }

  // After DOM update: compute the height delta and compensate scrollTop
  useEffect(() => {
    if (prevLatestPlanRef.current !== latestPlanMessageId) {
      const snapshot = scrollSnapshotRef.current
      prevLatestPlanRef.current = latestPlanMessageId
      scrollSnapshotRef.current = null

      if (snapshot && scrollRef.current) {
        // Wait one frame for the virtualizer to re-measure after the collapse
        requestAnimationFrame(() => {
          if (!scrollRef.current) return
          const newScrollHeight = scrollRef.current.scrollHeight
          const delta = snapshot.scrollHeight - newScrollHeight
          if (delta > 0 && snapshot.scrollTop > 0) {
            // Only compensate when the user is NOT at the bottom — if they're
            // pinned to bottom, auto-scroll will keep them there.
            const wasAtBottom =
              snapshot.scrollHeight - snapshot.scrollTop - scrollRef.current.clientHeight < 150
            if (!wasAtBottom) {
              scrollRef.current.scrollTop = Math.max(0, snapshot.scrollTop - delta)
            }
          }
        })
      }
    }
  }, [latestPlanMessageId])

  // Listen for prompt suggestions from SDK
  useEffect(() => {
    const cleanup = window.api.onPromptSuggestion((data) => {
      if (data.conversationId === activeConversationId) {
        setPromptSuggestion(data.suggestion)
      }
    })
    return cleanup
  }, [activeConversationId])

  // Clear suggestion when a new stream starts
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear suggestion when stream starts
    if (isStreaming) setPromptSuggestion(null)
  }, [isStreaming])

  // Track streaming → complete transition for animation
  const justCompletedRef = useRef(false)
  const prevIsStreaming = useRef(isStreaming)
  const prevMessageCountRef = useRef(messages.length)

  useEffect(() => {
    if (prevIsStreaming.current && !isStreaming) {
      const newMessageCount = messages.length - prevMessageCountRef.current
      justCompletedRef.current = newMessageCount <= 1
      const timer = setTimeout(() => {
        justCompletedRef.current = false
      }, 400)
      prevIsStreaming.current = isStreaming
      prevMessageCountRef.current = messages.length
      return () => clearTimeout(timer)
    }
    prevIsStreaming.current = isStreaming
    prevMessageCountRef.current = messages.length
    return undefined
  }, [isStreaming, messages.length])

  const isEmpty = messages.length === 0 && !isStreaming

  const { isAtBottom, scrollToBottom } = useAutoScroll(
    scrollRef,
    contentRef,
    activeConversationId,
    messages.length,
    streamingContent,
    allStreamingTools.length,
    virtualizer,
    isEmpty
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
            ? `Ask anything, brainstorm ideas, or describe what you want built — ${agentAlias} is standing by.`
            : `Chat with your AI development partner. Ask questions, brainstorm ideas, review code, or describe what you want built — ${agentAlias} is ready to help.`}
        </p>
      </div>
    )
  }

  // eslint-disable-next-line react-hooks/refs -- @tanstack/react-virtual API is designed to be called during render
  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div data-testid="message-list" className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
      <FloatingRobots />
      <div
        ref={scrollRef}
        data-testid="message-scroll"
        className="relative z-10 flex-1 overflow-y-auto px-6 py-4 h-full"
      >
        {/* Outer content wrapper observed by ResizeObserver — covers banner + list + footer
            so that height changes from any sibling (prompt suggestions, thinking indicator,
            audit banner) trigger a re-pin / button update. */}
        <div ref={contentRef}>
          {/* Audit provenance banner (when conversation originated from Health audit) */}
          {sourceAuditRunId && (
            <AuditProvenanceBanner
              auditRunId={sourceAuditRunId}
              onViewAudit={() => {
                // Navigate to health page — handled by app layout
                window.dispatchEvent(new CustomEvent('navigate-to-health'))
              }}
            />
          )}
          {/* Virtualized message list */}
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative'
            }}
          >
            {/* eslint-disable-next-line react-hooks/refs -- virtualItems is from @tanstack/react-virtual, designed for render */}
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
                  <div
                    className={`pb-4 ${
                      virtualRow.index === messages.length - 1 && justCompletedRef.current
                        ? 'animate-message-reveal'
                        : ''
                    }`}
                  >
                    <MessageBubble
                      message={msg}
                      toolActivities={msg.toolActivities}
                      searchHighlight={searchQuery}
                      actions={bubbleActions}
                      isLatestPlan={msg.id === latestPlanMessageId}
                    />
                  </div>
                </div>
              )
            })}
          </div>

          {/* Non-virtualized footer items */}
          <MessageListFooter
            promptSuggestion={promptSuggestion}
            onDismissPromptSuggestion={() => setPromptSuggestion(null)}
            showIdeaPopover={showIdeaPopover}
            ideaPopoverData={ideaPopoverData}
            onCloseIdeaPopover={() => {
              setShowIdeaPopover(false)
              setIdeaPopoverData(null)
            }}
            thinkingIdentity={thinkingIdentity}
            allStreamingTools={allStreamingTools}
          />
        </div>
        {/* end contentRef wrapper */}
      </div>
      <ScrollToBottomButton visible={!isAtBottom} onClick={scrollToBottom} />
    </div>
  )
}
