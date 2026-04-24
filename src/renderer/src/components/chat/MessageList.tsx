import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageSquarePlus } from 'lucide-react'
import { useChatStore, useChatActions, useSpecialistStore } from '@renderer/store'
import { CORE_AGENT_DEFAULTS, getDefaultAvatarForRole } from '@renderer/utils/agentIdentity'
import {
  MessageBubble,
  TaskPlanCard,
  GrillQuestionCard,
  BuildProgressCard
} from '@renderer/components/chat'
// InvestigationReportCard has been merged into TaskPlanCard (unified card)
import IdeaPopover from './IdeaPopover'
import { Avatar, CompactContextModal } from '@renderer/components/common'
import type { MessageBubbleActions } from './MessageBubble'
import type { StructuredPlan } from '../../../../shared/types'
import AutoModeSwitchPill from './AutoModeSwitchPill'
import FloatingRobots from './FloatingRobots'
import ScrollToBottomButton from './ScrollToBottomButton'

interface MessageListProps {
  searchQuery?: string
}

export default function MessageList({ searchQuery }: MessageListProps): React.JSX.Element {
  const messages = useChatStore((s) => s.messages)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const streamingRole = useChatStore((s) => s.streamingRole)
  const streamingSpecialist = useChatStore((s) => s.streamingSpecialist)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const toolActivities = useChatStore((s) => s.toolActivities)
  const isExecutingPlan = useChatStore((s) => s.isExecutingPlan)
  const decomposedTasks = useChatStore((s) => s.decomposedTasks)
  const taskProgress = useChatStore((s) => s.taskProgress)
  const compactSuggestion = useChatStore((s) => s.compactSuggestion)
  const contextUsages = useChatStore((s) => s.contextUsages)
  const pendingGrillQuestions = useChatStore((s) => s.grillSession?.pendingQuestions ?? null)
  const hasPendingGrillQuestions = (pendingGrillQuestions?.length ?? 0) > 0
  const pendingQuestions = useChatStore((s) => s.pendingQuestions)
  const hasPendingQuestions = (pendingQuestions?.length ?? 0) > 0
  const investigationReport = useChatStore((s) => s.investigationReport)

  const {
    setCompactSuggestion,
    sendMessage,
    submitGrillAnswers,
    skipAllGrillQuestions,
    submitQuestionAnswers,
    skipAllQuestions,
    updateMode,
    appendLocalMessage,
    clearGrillSession,
    createItemsFromGrill,
    executeInvestigationFix
  } = useChatActions()

  // Single actions object passed to all MessageBubbles — avoids N×useShallow subscriptions
  const handleSaveAsIdea = useCallback((title: string, description: string): void => {
    setIdeaPopoverData({ title, description })
    setShowIdeaPopover(true)
  }, [])

  const activeConversationId = useChatStore((s) => s.activeConversation?.id ?? null)

  /**
   * "Build this" button — switches to Build mode and sends the plan to the
   * Project Specialist as a regular chat message. Post-migration 66 there is
   * no multi-specialist pipeline to orchestrate; the workspace's Project
   * Specialist executes the plan as a standard build-mode turn.
   */
  const handleBuildFromPlan = useCallback(
    async (_plan: StructuredPlan, planContent: string): Promise<void> => {
      if (!activeConversationId) return
      await updateMode('build')
      await sendMessage(
        `Please execute the following plan, step by step, with file edits and tests:\n\n${planContent}`
      )
    },
    [activeConversationId, updateMode, sendMessage]
  )

  const bubbleActions: MessageBubbleActions = useMemo(
    () => ({
      updateMode,
      sendMessage,
      appendLocalMessage,
      clearGrillSession,
      createItemsFromGrill,
      submitGrillAnswers,
      skipAllGrillQuestions,
      saveAsIdea: handleSaveAsIdea,
      buildFromPlan: handleBuildFromPlan
    }),
    [
      updateMode,
      sendMessage,
      appendLocalMessage,
      clearGrillSession,
      createItemsFromGrill,
      submitGrillAnswers,
      skipAllGrillQuestions,
      handleSaveAsIdea,
      handleBuildFromPlan
    ]
  )

  const generalistSpec = useSpecialistStore(
    (s) => s.specialists.find((sp) => sp.agentId === 'generalist') ?? null
  )
  const generalistAlias =
    generalistSpec?.alias ??
    generalistSpec?.displayName ??
    CORE_AGENT_DEFAULTS.generalist.displayName
  const thinkingAvatarKey = generalistSpec?.avatarUrl ?? CORE_AGENT_DEFAULTS.generalist.avatarKey
  const thinkingAccentColor = generalistSpec?.color ?? CORE_AGENT_DEFAULTS.generalist.color

  // Coordinator role is deprecated — map to generalist identity (Da Vinci)
  const coordinatorAlias = generalistAlias
  const coordinatorAvatarKey = thinkingAvatarKey

  // Resolve specialist identity from the store
  const streamingSpecialistData = useSpecialistStore((s) =>
    streamingSpecialist
      ? (s.specialists.find((sp) => sp.agentId === streamingSpecialist) ?? null)
      : null
  )

  // Compute thinking indicator identity based on streamingRole
  const thinkingIdentity = useMemo(() => {
    if (streamingRole === 'coordinator') {
      // Coordinator role deprecated — use generalist identity (Da Vinci)
      return {
        name: coordinatorAlias,
        avatarKey: coordinatorAvatarKey,
        accentColor: CORE_AGENT_DEFAULTS.generalist.color
      }
    }
    if (streamingRole === 'specialist' && streamingSpecialistData) {
      return {
        name: streamingSpecialistData.alias ?? streamingSpecialistData.displayName,
        avatarKey:
          streamingSpecialistData.avatarUrl ??
          getDefaultAvatarForRole(streamingSpecialistData.agentId),
        accentColor: streamingSpecialistData.color ?? '#F59E0B'
      }
    }
    if (streamingRole === 'specialist' && streamingSpecialist) {
      // Fallback for unknown specialist
      return {
        name: streamingSpecialist,
        avatarKey: getDefaultAvatarForRole(streamingSpecialist),
        accentColor: '#F59E0B'
      }
    }
    // Default: generalist (Da Vinci)
    return {
      name: generalistAlias,
      avatarKey: thinkingAvatarKey,
      accentColor: thinkingAccentColor
    }
  }, [
    streamingRole,
    streamingSpecialistData,
    streamingSpecialist,
    generalistAlias,
    thinkingAvatarKey,
    thinkingAccentColor,
    coordinatorAlias,
    coordinatorAvatarKey
  ])

  const userName = useSpecialistStore((s) => {
    const userSpec = s.specialists.find((sp) => sp.agentId === 'user')
    const name = userSpec?.alias ?? userSpec?.displayName
    return name?.split(' ')[0] ?? null
  })

  // Scroll container ref for virtualizer
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll state
  const shouldAutoScroll = useRef(true)
  const isUserScrolling = useRef(false)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [showIdeaPopover, setShowIdeaPopover] = useState(false)
  const [ideaPopoverData, setIdeaPopoverData] = useState<{
    title: string
    description: string
  } | null>(null)

  const handleReviseInvestigation = useCallback((): void => {
    // Don't clear investigationReport — card stays visible with buttons hidden
    // (TaskPlanCard's internal userClicked state hides the buttons after click)
    appendLocalMessage("Refine this investigation — tell me what to re-analyze and I'll update it.")
  }, [appendLocalMessage])

  const handleSaveInvestigationAsIdea = useCallback((): void => {
    if (!investigationReport) return
    const { report } = investigationReport
    const title =
      report.problem.length > 60 ? report.problem.substring(0, 57) + '...' : report.problem
    const description = [
      `## Problem\n${report.problem}`,
      `## Root Cause\n${report.rootCause}`,
      `## Proposed Fix\n${report.proposedFix}`,
      `## Files Affected`,
      report.filesAffected.map((f) => `- \`${f.path}\`: ${f.reason}`).join('\n'),
      `## Impact: ${report.impact}\n${report.impactReason}`
    ].join('\n\n')
    setIdeaPopoverData({ title, description })
    setShowIdeaPopover(true)
  }, [investigationReport])

  // Force scroll to bottom when switching conversations
  useEffect(() => {
    if (!activeConversationId) return
    shouldAutoScroll.current = true
    setIsAtBottom(true)
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
  }, [activeConversationId])

  // Handle scroll events to determine if user is at bottom
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    let scrollTimeout: ReturnType<typeof setTimeout>

    const handleScroll = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = container
      // Use 150px threshold (larger than virtualizer's estimateSize) to avoid jitter
      const nearBottom = scrollHeight - scrollTop - clientHeight < 150
      shouldAutoScroll.current = nearBottom
      setIsAtBottom(nearBottom)

      isUserScrolling.current = true
      clearTimeout(scrollTimeout)
      scrollTimeout = setTimeout(() => {
        isUserScrolling.current = false
      }, 250) // Longer debounce to let virtualizer settle
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

  // Auto-scroll to bottom when new messages arrive, streaming content updates, or investigation report appears
  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current && !isUserScrolling.current) {
      // Use requestAnimationFrame to let virtualizer settle first
      requestAnimationFrame(() => {
        if (shouldAutoScroll.current && scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      })
    }
  }, [messages.length, streamingContent, investigationReport, decomposedTasks.length])

  // Scroll-to-bottom handler for the floating button
  // Two-step approach: first tell virtualizer to render bottom items,
  // then scroll to true bottom (including non-virtualized footer content)
  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return

    // Step 1: Tell the virtualizer to scroll to the last message.
    // This forces it to render the bottom items so scrollHeight becomes accurate.
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    }

    // Step 2: After virtualizer updates, scroll to true bottom
    // (captures non-virtualized footer items below the virtual list)
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      shouldAutoScroll.current = true
      setIsAtBottom(true)
    })
  }, [messages.length, virtualizer])

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
      <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto px-6 py-4 h-full">
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
                    isExecutingPlan={isExecutingPlan}
                    toolActivities={msg.toolActivities}
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

        {/* Auto mode switch pill (e.g., build → plan on investigation prompts) */}
        <AutoModeSwitchPill />

        {/* Investigation report — rendered via unified TaskPlanCard */}
        {investigationReport && (
          <TaskPlanCard
            summary={investigationReport.report.problem}
            mode="plan"
            investigation={investigationReport.report}
            investigationSpecialist={investigationReport.specialist}
            isExecuting={isExecutingPlan}
            onBuildNow={() => executeInvestigationFix('sequential')}
            onOrchestratedBuild={() => executeInvestigationFix('parallel')}
            onRefine={handleReviseInvestigation}
            onSaveAsIdea={handleSaveInvestigationAsIdea}
          />
        )}

        {/* Build progress card — live task checklist during execution */}
        {isExecutingPlan && decomposedTasks.length > 0 && (
          <div className="px-4">
            <BuildProgressCard
              tasks={decomposedTasks}
              taskProgress={taskProgress}
              isExecuting={isExecutingPlan}
            />
          </div>
        )}

        {showIdeaPopover && ideaPopoverData && (
          <div className="relative px-4 mt-2">
            <IdeaPopover
              onClose={() => {
                setShowIdeaPopover(false)
                setIdeaPopoverData(null)
              }}
              initialTitle={ideaPopoverData.title}
              initialDescription={ideaPopoverData.description}
            />
          </div>
        )}

        {/* Compact context modal */}
        <CompactContextModal
          isOpen={!!compactSuggestion}
          inputTokens={compactSuggestion?.inputTokens ?? 0}
          level={compactSuggestion?.level ?? 'suggest'}
          categories={activeConversationId ? contextUsages[activeConversationId]?.categories : undefined}
          onExtractNuance={() => {
            setCompactSuggestion(null)
            sendMessage('/compact --nuance')
          }}
          onQuickCompact={() => {
            setCompactSuggestion(null)
            sendMessage('/compact')
          }}
          onCancel={() => setCompactSuggestion(null)}
        />

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

        {/* General chat ask_user card — reuses GrillQuestionCard */}
        {hasPendingQuestions && pendingQuestions && (
          <div className="flex justify-start px-4">
            <div className="max-w-[85%]">
              <GrillQuestionCard
                questions={pendingQuestions}
                onSubmit={submitQuestionAnswers}
                onSkipAll={skipAllQuestions}
              />
            </div>
          </div>
        )}

        {/* Thinking indicator: shows when streaming but no content yet */}
        {isStreaming && !streamingContent && (
          <div className="flex gap-3 flex-row">
            {/* Avatar — matches MessageBubble layout */}
            <div className="flex-shrink-0 mt-0.5">
              <Avatar
                avatarKey={thinkingIdentity.avatarKey}
                size="xl"
                accentColor={thinkingIdentity.accentColor}
                fallbackInitials={thinkingIdentity.name}
              />
            </div>
            <div className="flex flex-col max-w-[85%] items-start">
              <div className="flex flex-col mb-1 px-1 items-start">
                <span className="text-sm font-semibold text-text-primary leading-tight">
                  {thinkingIdentity.name}
                </span>
              </div>
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
                  <span className="text-sm text-text-secondary">Thinking...</span>
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
                            <span
                              className="text-text-muted truncate max-w-[300px]"
                              title={activity.input}
                            >
                              {activity.input}
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Streaming message bubble — content arrives sentence-by-sentence via SentenceBuffer */}
        {isStreaming && streamingContent && (
          <div className="animate-sentence-reveal streaming-bubble-content">
            <MessageBubble
              message={{
                id: 'streaming',
                conversationId: '',
                role: streamingRole,
                ...(streamingRole === 'specialist' && streamingSpecialist
                  ? { agentId: streamingSpecialist }
                  : {}),
                contentMd: streamingContent,
                attachmentsJson: '[]',
                createdAt: new Date().toISOString()
              }}
              isStreaming
              toolActivities={toolActivities}
              actions={bubbleActions}
            />
          </div>
        )}
      </div>
      <ScrollToBottomButton visible={!isAtBottom} onClick={scrollToBottom} />
    </div>
  )
}
