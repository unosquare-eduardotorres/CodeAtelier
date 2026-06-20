import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import {
  useChatStore,
  useChatActions,
  useSpecialistStore,
  useWorkspaceStore
} from '@renderer/store'
import { CORE_AGENT_DEFAULTS } from '@renderer/utils/agentIdentity'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'
import { getWorkspaceMannequin } from '@renderer/utils/workspaceMannequin'
import { MessageBubble } from '@renderer/components/chat'
import type { MessageBubbleActions } from './MessageBubble'
import type { StructuredPlan } from '../../../../shared/types'
import FloatingRobots from './FloatingRobots'
import ScrollToBottomButton from './ScrollToBottomButton'
import MessageListFooter from './MessageListFooter'
import { useAutoScroll } from './useAutoScroll'
import { useMessageVirtualizer } from './useMessageVirtualizer'

interface MessageListProps {
  searchQuery?: string
}

export default function MessageList({ searchQuery }: MessageListProps): React.JSX.Element {
  const messages = useChatStore((s) => s.messages)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const streamingSegments = useChatStore((s) => s.streamingSegments)
  const streamingRole = useChatStore((s) => s.streamingRole)
  const streamingSpecialist = useChatStore((s) => s.streamingSpecialist)
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

  const handleBuildFromPlan = useCallback(
    async (_plan: StructuredPlan, _planContent: string): Promise<void> => {
      if (!activeConversationId) return
      await updateMode('build')
      await sendMessage('Build the plan.')
    },
    [activeConversationId, updateMode, sendMessage]
  )

  const bubbleActions: MessageBubbleActions = useMemo(
    () => ({
      updateMode,
      sendMessage,
      appendLocalMessage,
      saveAsIdea: handleSaveAsIdea,
      buildFromPlan: handleBuildFromPlan
    }),
    [updateMode, sendMessage, appendLocalMessage, handleSaveAsIdea, handleBuildFromPlan]
  )

  // ── Specialist identity resolution ──
  const generalistSpec = useSpecialistStore(
    (s) => s.specialists.find((sp) => sp.agentId === 'da-vinci') ?? null
  )
  const generalistAlias =
    generalistSpec?.alias ??
    generalistSpec?.displayName ??
    CORE_AGENT_DEFAULTS['da-vinci'].displayName
  const thinkingAvatarKey = CORE_AGENT_DEFAULTS['da-vinci'].avatarKey
  const thinkingAccentColor = generalistSpec?.color ?? CORE_AGENT_DEFAULTS['da-vinci'].color

  const streamingSpecialistData = useSpecialistStore((s) =>
    streamingSpecialist
      ? (s.specialists.find((sp) => sp.agentId === streamingSpecialist) ?? null)
      : null
  )

  const activeConversationWorkspaceId = useChatStore(
    (s) => s.activeConversation?.workspaceId ?? null
  )
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  const projectSpecialist = useProjectSpecialistStore((s) =>
    activeConversationWorkspaceId ? s.byWorkspace[activeConversationWorkspaceId] : null
  )
  const specialistMannequinKey = useMemo(
    () =>
      activeConversationWorkspaceId
        ? getWorkspaceMannequin(activeConversationWorkspaceId, workspaces)
        : 'mannequin-main',
    [activeConversationWorkspaceId, workspaces]
  )

  const thinkingIdentity = useMemo(() => {
    if (streamingRole === 'specialist' && streamingSpecialistData) {
      return {
        name: streamingSpecialistData.alias ?? streamingSpecialistData.displayName,
        avatarKey: specialistMannequinKey,
        accentColor: streamingSpecialistData.color ?? '#F59E0B'
      }
    }
    if (streamingRole === 'specialist' && streamingSpecialist) {
      return {
        name: streamingSpecialist,
        avatarKey: specialistMannequinKey,
        accentColor: '#F59E0B'
      }
    }
    if (projectSpecialist?.buildStatus === 'ready') {
      return {
        name: projectSpecialist.displayName,
        avatarKey: specialistMannequinKey,
        accentColor: projectSpecialist.color ?? '#F59E0B'
      }
    }
    return {
      name: generalistAlias,
      avatarKey: thinkingAvatarKey,
      accentColor: thinkingAccentColor
    }
  }, [
    streamingRole,
    streamingSpecialistData,
    streamingSpecialist,
    specialistMannequinKey,
    generalistAlias,
    thinkingAvatarKey,
    thinkingAccentColor,
    projectSpecialist
  ])

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
  const { virtualizer, measureElement } = useMessageVirtualizer(messages.length, scrollRef)

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

  const { isAtBottom, scrollToBottom } = useAutoScroll(
    scrollRef,
    activeConversationId,
    messages.length,
    streamingContent,
    allStreamingTools.length,
    virtualizer
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

  // eslint-disable-next-line react-hooks/refs -- @tanstack/react-virtual API is designed to be called during render
  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div data-testid="message-list" className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
      <FloatingRobots />
      <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto px-6 py-4 h-full">
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
      <ScrollToBottomButton visible={!isAtBottom} onClick={scrollToBottom} />
    </div>
  )
}
