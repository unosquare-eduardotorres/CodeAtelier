import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { rendererLog } from '@renderer/utils/logger'
import { detectPlanIntent } from '@renderer/utils/plan-intent-detector'
import {
  StreamSegmentAccumulator,
  type StreamSegment,
  type SegmentState
} from '@renderer/utils/stream-segment-accumulator'
import { useWorkspaceStore } from './workspace.store'
import { useProjectSpecialistStore } from './project-specialist.store'
import type {
  CompleteResult,
  ContextUsage,
  ContextUsageBreakdown,
  Conversation,
  ConversationMode,
  ConversationPhase,
  GrillAnswerPayload,
  GrillProposedTask,
  GrillQuestion,
  LLMProvider,
  Message,
  ToolActivity
} from '../../../shared/types'

/**
 * Encapsulates non-reactive internal state for the chat store.
 * These are operational concerns (timers, buffers) that shouldn't trigger
 * React re-renders or pollute module scope with mutable lets.
 */
class ChatStreamingInternals {
  private safetyTimer: ReturnType<typeof setTimeout> | null = null
  private accumulator: StreamSegmentAccumulator | null = null
  private storeGet: (() => ChatState) | null = null
  private storeSet: ((partial: Partial<ChatState>) => void) | null = null

  /** Bind the Zustand get/set refs — called once during store creation */
  bind(get: () => ChatState, set: (partial: Partial<ChatState>) => void): void {
    this.storeGet = get
    this.storeSet = set
  }

  getOrCreateAccumulator(): StreamSegmentAccumulator {
    if (!this.accumulator) {
      this.accumulator = new StreamSegmentAccumulator((state: SegmentState) => {
        // Sync accumulator state → Zustand store
        this.storeSet?.({
          streamingSegments: state.segments,
          streamingContent: state.currentContent,
          toolActivities: state.currentToolActivities
        })
      })
    }
    return this.accumulator
  }

  resetAccumulator(): void {
    this.accumulator?.reset()
    this.accumulator = null
  }

  /** Flush whatever's currently buffered without creating an accumulator if none exists. */
  flushAccumulator(): void {
    this.accumulator?.flush()
  }

  /** Stop the safety timer if one is running. */
  clearSafetyTimer(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer)
      this.safetyTimer = null
    }
  }

  /**
   * Resets the streaming safety timer — call on any sign of backend activity
   * (text chunks, tool starts, tool completions). This prevents the timer from
   * killing active-but-slow streams (e.g., agent running multiple Bash tools).
   */
  resetSafetyTimer(): void {
    if (this.safetyTimer) clearTimeout(this.safetyTimer)
    this.safetyTimer = setTimeout(
      () => {
        if (this.storeGet?.().isStreaming) {
          rendererLog.warn('Safety timeout: isStreaming stuck for 2 minutes — force-resetting')
          this.storeSet?.({
            isStreaming: false,
            conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
          })
        }
        this.safetyTimer = null
      },
      2 * 60 * 1000
    )
  }
}

/** Singleton internals — encapsulates timers and buffers outside reactive state */
const internals = new ChatStreamingInternals()

interface GrillSessionState {
  active: boolean
  summary: string | null
  proposedTasks: GrillProposedTask[]
  pendingQuestions: GrillQuestion[]
  answers: Record<string, GrillAnswerPayload>
}

interface ChatState {
  conversations: Conversation[]
  activeConversation: Conversation | null
  messages: Message[]
  streamingContent: string
  streamingRole: 'da-vinci' | 'specialist'
  streamingSpecialist: string | null
  streamingTaskId: string | null
  isStreaming: boolean
  activeRequestId: string | null
  /** Conversation phase — more precise than isStreaming boolean */
  streamingPhase: ConversationPhase | null
  toolActivities: ToolActivity[]
  /** Finalized streaming segments — each gets its own MessageBubble */
  streamingSegments: StreamSegment[]

  /** Backend state machine mirror — single source of truth for conversation lifecycle state */
  conversationState: {
    phase: ConversationPhase | 'idle' | 'error' | 'stopped'
    from: string | null
    event: string | null
    conversationId: string | null
  }

  // Compact suggestion state
  compactSuggestion: {
    level: string
    inputTokens: number
    breakdown?: ContextUsageBreakdown
    /** When true, SDK compaction is unavailable (local LLM) */
    isLocalProvider?: boolean
  } | null

  // Grill session state
  grillSession: GrillSessionState | null

  // General chat pending questions (ask_user tool)
  pendingQuestions: GrillQuestion[] | null
  /**
   * Programmatic action tag emitted alongside pendingQuestions (e.g.
   * "swap-to-specialist"). When the user accepts the first option on an
   * action-tagged question, submitQuestionAnswers maps the action to an IPC
   * call (e.g. swapToSpecialist) instead of sending a plain-text answer.
   */
  pendingQuestionAction: string | null

  loadConversations: (workspaceId: string) => Promise<void>
  createConversation: (
    workspaceId: string,
    mode?: ConversationMode,
    title?: string,
    personaSpecialistId?: string,
    llmProvider?: LLMProvider,
    mcpOverrides?: Record<string, boolean>
  ) => Promise<void>
  switchPersona: (personaSpecialistId: string | null) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  updateMode: (mode: ConversationMode) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  stopGeneration: () => Promise<void>
  sendMessage: (text: string, attachments?: string[]) => Promise<void>
  appendStreamChunk: (
    chunk: string,
    role?: 'da-vinci' | 'specialist',
    taskId?: string,
    specialist?: string,
    requestId?: string
  ) => void
  updateStreamingIdentity: (
    role: 'da-vinci' | 'specialist',
    taskId?: string,
    specialist?: string
  ) => void
  finalizeStream: (messageId: string, taskId?: string, requestId?: string) => void
  finalizeTurnBubble: (
    turnId: string,
    turnRole?: 'da-vinci' | 'specialist',
    turnSpecialist?: string
  ) => void
  addToolActivity: (activity: ToolActivity) => void
  updateToolActivity: (activity: Partial<ToolActivity> & { toolName: string }) => void

  // Slash command actions
  clearDisplay: () => void
  appendLocalMessage: (content: string, opts?: { role?: Message['role']; agentId?: string }) => void

  // Compact suggestion
  setCompactSuggestion: (
    data: {
      level: string
      inputTokens: number
      breakdown?: ContextUsageBreakdown
      isLocalProvider?: boolean
    } | null
  ) => void

  // Grill session actions
  startGrillSession: () => void
  endGrillSession: (summary: string, proposedTasks: GrillProposedTask[]) => void
  clearGrillSession: () => void
  setGrillQuestions: (questions: GrillQuestion[]) => void
  submitGrillAnswers: (answers: GrillAnswerPayload[]) => void
  skipAllGrillQuestions: () => void
  createItemsFromGrill: (
    tasks: Array<{ title: string; context: string; description: string }>
  ) => Promise<void>

  // General chat question actions
  setPendingQuestions: (questions: GrillQuestion[], action?: string) => void
  submitQuestionAnswers: (answers: GrillAnswerPayload[]) => void
  skipAllQuestions: () => void

  // Auto mode switch pill (e.g., build → plan on investigation prompts)
  autoModeSwitchPill: { from: ConversationMode; to: ConversationMode } | null
  clearAutoModeSwitchPill: () => void

  // /complete and /close actions
  completeConversation: (
    branchName: string,
    commitMessage: string,
    description: string
  ) => Promise<CompleteResult>
  closeConversation: (id: string) => Promise<void>

  // Draft text per conversation (persists across tab switches)
  draftTexts: Record<string, string>
  setDraftText: (conversationId: string, text: string) => void
  getDraftText: (conversationId: string) => string
  clearDraftText: (conversationId: string) => void

  // Session recovery state
  sessionRecovery: {
    active: boolean
    phase: 'started' | 'building_context' | 'resuming' | 'completed' | 'failed'
    message: string
  } | null
  setSessionRecovery: (data: ChatState['sessionRecovery']) => void

  // Budget cap banner state
  budgetCapBanner: {
    conversationId: string
    message: string
    canContinue: boolean
  } | null
  setBudgetCapBanner: (
    data: { conversationId: string; message: string; canContinue: boolean } | null
  ) => void
  continuePastBudgetCap: () => Promise<void>
  dismissBudgetCap: () => void

  // Conversation state machine mirror
  setConversationState: (data: ChatState['conversationState']) => void

  // Context usage per conversation
  contextUsages: Record<string, ContextUsage>
  loadContextUsage: (conversationId: string) => Promise<void>

  // Conversation reordering
  reorderConversations: (orderedIds: string[]) => Promise<void>

  reset: () => void
}

// Preserve Zustand state across HMR (dev only)
const previousChatState = import.meta.hot?.data?.chatStoreState as Partial<ChatState> | undefined

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: previousChatState?.conversations ?? [],
  activeConversation: previousChatState?.activeConversation ?? null,
  messages: previousChatState?.messages ?? [],
  streamingContent: previousChatState?.streamingContent ?? '',
  streamingRole: previousChatState?.streamingRole ?? ('da-vinci' as const),
  streamingSpecialist: previousChatState?.streamingSpecialist ?? null,
  streamingTaskId: previousChatState?.streamingTaskId ?? null,
  isStreaming: previousChatState?.isStreaming ?? false,
  activeRequestId: previousChatState?.activeRequestId ?? null,
  streamingPhase: previousChatState?.streamingPhase ?? null,
  toolActivities: previousChatState?.toolActivities ?? [],
  streamingSegments: previousChatState?.streamingSegments ?? [],
  compactSuggestion: previousChatState?.compactSuggestion ?? null,
  grillSession: previousChatState?.grillSession ?? null,
  pendingQuestions: previousChatState?.pendingQuestions ?? null,
  pendingQuestionAction: previousChatState?.pendingQuestionAction ?? null,
  autoModeSwitchPill: null,
  sessionRecovery: null,
  budgetCapBanner: null,
  conversationState: previousChatState?.conversationState ?? {
    phase: 'idle',
    from: null,
    event: null,
    conversationId: null
  },
  draftTexts: previousChatState?.draftTexts ?? {},
  contextUsages: previousChatState?.contextUsages ?? {},

  // Bind internals refs for safety timer + segment accumulator (runs once on store creation)
  ...(() => {
    internals.bind(get, set)
    return {}
  })(),

  loadConversations: async (workspaceId: string) => {
    try {
      // Detect workspace switch — clear stale chat state from previous workspace.
      // Without this, activeConversation + messages from the old workspace leak
      // into the new workspace's ChatPanel until the user explicitly selects a
      // conversation (or creates one).
      const { activeConversation } = get()
      if (activeConversation && activeConversation.workspaceId !== workspaceId) {
        get().reset()
        internals.resetAccumulator()
        internals.clearSafetyTimer()
      }

      const conversations = await window.api.getConversations({ workspaceId })
      set({ conversations })
    } catch (error) {
      rendererLog.error('Failed to load conversations:', error)
    }
  },

  createConversation: async (
    workspaceId: string,
    mode?: ConversationMode,
    title?: string,
    personaSpecialistId?: string,
    llmProvider?: LLMProvider,
    mcpOverrides?: Record<string, boolean>
  ) => {
    const conversation = await window.api.createConversation({
      workspaceId,
      mode,
      title,
      personaSpecialistId,
      llmProvider,
      mcpOverrides
    })
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      activeConversation: conversation,
      messages: [],
      streamingContent: '',
      streamingSegments: [],
      isStreaming: false,
      // Reset streaming identity — prevents stale specialist/DaVinci avatar leak
      streamingRole: 'da-vinci' as const,
      streamingSpecialist: null,
      streamingTaskId: null
    }))
  },

  switchPersona: async (personaSpecialistId: string | null) => {
    const { activeConversation } = get()
    if (!activeConversation) return
    const updated = await window.api.updatePersona({
      conversationId: activeConversation.id,
      personaSpecialistId
    })
    set((state) => ({
      activeConversation: updated,
      conversations: state.conversations.map((c) => (c.id === updated.id ? updated : c))
    }))
  },

  deleteConversation: async (id: string) => {
    // Delete uses the same flow as /close
    await get().closeConversation(id)
  },

  updateMode: async (mode: ConversationMode) => {
    const { activeConversation } = get()
    if (!activeConversation) return
    const previousMode = activeConversation.mode
    if (previousMode === mode) return // no-op guard

    // Optimistic update — immediately reflect in UI
    const optimistic = { ...activeConversation, mode }
    set((state) => ({
      activeConversation: optimistic,
      conversations: state.conversations.map((c) =>
        c.id === activeConversation.id ? optimistic : c
      )
    }))

    // Show mode switch pill for any direction
    set({ autoModeSwitchPill: { from: previousMode, to: mode } })
    setTimeout(() => {
      const current = get()
      if (current?.autoModeSwitchPill?.to === mode) {
        set({ autoModeSwitchPill: null })
      }
    }, 5000)

    try {
      const updated = await window.api.updateConversationMode({
        conversationId: activeConversation.id,
        mode
      })

      // Reconcile with DB response
      set((state) => ({
        activeConversation:
          state.activeConversation?.id === updated.id ? updated : state.activeConversation,
        conversations: state.conversations.map((c) => (c.id === updated.id ? updated : c))
      }))
    } catch (error) {
      rendererLog.error('Failed to update mode:', error)
      // Rollback optimistic update
      set((state) => ({
        activeConversation:
          state.activeConversation?.id === activeConversation.id
            ? activeConversation
            : state.activeConversation,
        conversations: state.conversations.map((c) =>
          c.id === activeConversation.id ? activeConversation : c
        )
      }))
    }
  },

  selectConversation: async (id: string) => {
    const conversation = get().conversations.find((c) => c.id === id)
    if (!conversation) return

    const messages = await window.api.getMessages({ conversationId: id })
    set({
      activeConversation: conversation,
      messages,
      streamingContent: '',
      isStreaming: false,
      // Reset streaming identity — prevents stale specialist/DaVinci avatar leak
      streamingRole: 'da-vinci' as const,
      streamingSpecialist: null,
      streamingTaskId: null,
      // Clear ephemeral UI state from previous conversation
      toolActivities: [],
      streamingSegments: [],
      grillSession: null,
      compactSuggestion: null,
      budgetCapBanner: null,
      pendingQuestions: null,
      pendingQuestionAction: null,
      activeRequestId: null,
      // Reset state machine mirror — prevents stale phase from previous conversation
      conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
    })

    // CLI mode sync is deferred — will happen automatically on next message send
    // No need to restart the CLI process just because the user switched conversations
  },

  renameConversation: async (id: string, title: string) => {
    const updated = await window.api.renameConversation({
      conversationId: id,
      title
    })
    set((state) => ({
      conversations: state.conversations.map((c) => (c.id === id ? updated : c)),
      activeConversation: state.activeConversation?.id === id ? updated : state.activeConversation
    }))
  },

  stopGeneration: async () => {
    // Flush any remaining buffered content before stopping
    internals.flushAccumulator()

    const {
      streamingContent,
      streamingSegments,
      streamingRole,
      streamingSpecialist,
      activeConversation
    } = get()

    try {
      await window.api.stopGeneration()
    } catch (error) {
      rendererLog.error('Failed to stop generation:', error)
    }

    // Preserve partial streaming content as a single merged message with a "stopped" suffix
    if ((streamingContent || streamingSegments.length > 0) && activeConversation) {
      const stopTs = Date.now()

      // Merge all segments + current content into one stopped message
      const mergedContent = [...streamingSegments.map((s) => s.content), streamingContent || '']
        .map((c) => c.trim())
        .filter(Boolean)
        .join('\n\n')

      const mergedTools = [
        ...streamingSegments.flatMap((s) => s.toolActivities)
        // Note: don't include current toolActivities here — they weren't part of streamed content
      ].map((a) => (a.status === 'running' ? { ...a, status: 'completed' as const } : a))

      const stoppedMessage: Message = {
        id: `stopped-${stopTs}`,
        conversationId: activeConversation.id,
        role: streamingRole,
        ...(streamingRole === 'specialist' && streamingSpecialist
          ? { agentId: streamingSpecialist }
          : {}),
        contentMd: (mergedContent || '') + '\n\n---\n\n⏹ *Generation stopped by user.*',
        attachmentsJson: '[]',
        createdAt:
          streamingSegments.length > 0
            ? new Date(streamingSegments[0].timestamp).toISOString()
            : new Date().toISOString(),
        toolActivities: mergedTools.length > 0 ? mergedTools : undefined
      }

      set((state) => ({
        messages: [...state.messages, stoppedMessage],
        streamingContent: '',
        streamingSegments: [],
        isStreaming: false,
        toolActivities: [],
        activeRequestId: null,
        conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
      }))
    } else if (activeConversation) {
      // No partial content — still show a local indicator
      const stoppedMessage: Message = {
        id: `stopped-${Date.now()}`,
        conversationId: activeConversation.id,
        role: 'da-vinci',
        contentMd: '⏹ *Generation stopped by user.*',
        attachmentsJson: '[]',
        createdAt: new Date().toISOString()
      }
      set((state) => ({
        messages: [...state.messages, stoppedMessage],
        streamingContent: '',
        streamingSegments: [],
        isStreaming: false,
        toolActivities: [],
        activeRequestId: null,
        conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
      }))
    } else {
      set({
        isStreaming: false,
        streamingContent: '',
        streamingSegments: [],
        toolActivities: [],
        activeRequestId: null,
        conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
      })
    }

    internals.resetAccumulator()
  },

  sendMessage: async (text: string, attachments?: string[]) => {
    const { activeConversation, updateMode } = get()
    if (!activeConversation) return

    // Auto-detect plan intent in build mode → switch to plan
    if (activeConversation.mode === 'build' && detectPlanIntent(text)) {
      await updateMode('plan')
    }

    // Add optimistic user message
    const optimisticMessage: Message = {
      id: `temp-${Date.now()}`,
      conversationId: activeConversation.id,
      role: 'user',
      contentMd: text,
      attachmentsJson: attachments ? JSON.stringify(attachments) : '[]',
      createdAt: new Date().toISOString()
    }

    set((state) => ({
      messages: [...state.messages, optimisticMessage],
      isStreaming: true,
      streamingContent: '',
      streamingSegments: [],
      toolActivities: [],
      budgetCapBanner: null,
      // activeRequestId is set AFTER the backend returns — see below.
      // This prevents the mismatch where renderer and backend generate different IDs.
      activeRequestId: null
    }))

    // Reset segment accumulator for new message
    internals.resetAccumulator()

    // Safety: force-reset if streaming state gets stuck (e.g., process dies without emitting complete)
    internals.resetSafetyTimer()

    try {
      // Backend is the single source of truth for requestId — it generates the ID
      // in ConversationLifecycle.begin() and returns it via the IPC response.
      const result = await window.api.sendMessage({
        conversationId: activeConversation.id,
        text,
        attachments
      })
      // Set the backend-generated requestId so chunk filtering works correctly
      set({ activeRequestId: result.requestId })
    } catch (error) {
      rendererLog.error('Failed to send message:', error)
      internals.clearSafetyTimer()

      // Show user-visible error instead of silent failure
      const errorMsg = error instanceof Error ? error.message : String(error)
      const { activeConversation: conv } = get()
      if (conv) {
        const errorMessage: Message = {
          id: `error-${Date.now()}`,
          conversationId: conv.id,
          role: 'da-vinci',
          contentMd: `**Failed to send message:** ${errorMsg}`,
          attachmentsJson: '[]',
          createdAt: new Date().toISOString()
        }
        set((state) => ({
          messages: [...state.messages, errorMessage],
          isStreaming: false,
          streamingSegments: [],
          conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
        }))
      } else {
        set({
          isStreaming: false,
          streamingSegments: [],
          conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
        })
      }
    }
  },

  appendStreamChunk: (
    chunk: string,
    role?: 'da-vinci' | 'specialist',
    taskId?: string,
    specialist?: string,
    requestId?: string
  ) => {
    const activeRequestId = get().activeRequestId
    if (activeRequestId && requestId && requestId !== activeRequestId) return

    // Reset safety timer — backend is still alive
    internals.resetSafetyTimer()
    if (!chunk) return // Skip empty chunks (tool-only messages)

    const isNewTask = taskId != null && taskId !== get().streamingTaskId

    // If task changed, flush old accumulator and reset
    if (isNewTask) {
      internals.flushAccumulator()
      internals.resetAccumulator()
    }

    // Update streaming metadata (non-content state) immediately
    set((state) => ({
      isStreaming: true, // Ensure streaming bubble renders for specialist chunks
      streamingPhase: role === 'specialist' ? 'specialist-executing' : 'da-vinci-responding',
      streamingSegments: isNewTask ? [] : state.streamingSegments,
      streamingContent: isNewTask ? '' : state.streamingContent,
      streamingRole: role ?? state.streamingRole,
      streamingSpecialist: specialist ?? state.streamingSpecialist,
      streamingTaskId: taskId ?? state.streamingTaskId
    }))

    // Push chunk through segment accumulator (auto-segments at sentence + tool boundaries)
    internals.getOrCreateAccumulator().appendText(chunk)
  },

  updateStreamingIdentity: (role, taskId?, specialist?) => {
    set((state) => ({
      streamingRole: role,
      streamingSpecialist: specialist ?? state.streamingSpecialist,
      streamingTaskId: taskId ?? state.streamingTaskId
    }))
  },

  addToolActivity: (activity: ToolActivity) => {
    // Reset safety timer — tool started, backend is active
    internals.resetSafetyTimer()
    internals.getOrCreateAccumulator().handleToolActivity(activity)
  },

  updateToolActivity: (activity: Partial<ToolActivity> & { toolName: string; id?: string }) => {
    // Reset safety timer — tool completed, backend is active
    internals.resetSafetyTimer()
    internals
      .getOrCreateAccumulator()
      .handleToolActivity(activity as Partial<ToolActivity> & { id: string; toolName: string })
  },

  finalizeStream: (messageId: string, taskId?: string, requestId?: string) => {
    // Force-flush any remaining buffered content before finalizing
    internals.flushAccumulator()

    const activeRequestId = get().activeRequestId
    if (activeRequestId && requestId && requestId !== activeRequestId) return

    // Clear safety timer on normal stream completion (only on final complete, not per-task)
    if (!taskId) {
      internals.clearSafetyTimer()
    }

    const {
      streamingSegments,
      streamingContent,
      streamingRole,
      streamingSpecialist,
      activeConversation,
      toolActivities
    } = get()

    // (Removed) The specialist-pool guard that previously returned early here
    // was vestigial — there is no specialist pool or parallel specialist execution
    // in the current architecture. The guard blocked ALL specialist/persona
    // completions, causing isStreaming to remain true indefinitely.

    if ((streamingContent || streamingSegments.length > 0) && activeConversation) {
      // Merge all segments + current content into a single message
      const mergedContent = [...streamingSegments.map((s) => s.content), streamingContent]
        .map((c) => c.trim())
        .filter(Boolean)
        .join('\n\n')

      const mergedTools = [
        ...streamingSegments.flatMap((s) => s.toolActivities),
        ...toolActivities
      ].map((a) => (a.status === 'running' ? { ...a, status: 'completed' as const } : a))

      const newMessages: Message[] = []
      if (mergedContent || mergedTools.length > 0) {
        newMessages.push({
          id: messageId,
          conversationId: activeConversation.id,
          role: streamingRole,
          ...(streamingRole === 'specialist' && streamingSpecialist
            ? { agentId: streamingSpecialist }
            : {}),
          contentMd: mergedContent,
          attachmentsJson: '[]',
          createdAt:
            streamingSegments.length > 0
              ? new Date(streamingSegments[0].timestamp).toISOString()
              : new Date().toISOString(),
          toolActivities: mergedTools.length > 0 ? [...mergedTools] : undefined
        })
      }

      set((state) => ({
        messages: [...state.messages, ...newMessages],
        streamingContent: '',
        streamingSegments: [],
        // Only stop streaming if this is the final complete (no taskId = final summary)
        isStreaming: !!taskId,
        activeRequestId: taskId ? state.activeRequestId : null,
        streamingPhase: taskId ? state.streamingPhase : null,
        toolActivities: taskId ? state.toolActivities : [],
        streamingTaskId: null,
        streamingSpecialist: taskId ? state.streamingSpecialist : null
      }))
    } else if (taskId) {
      // Per-task complete with no accumulated content — just reset task tracking
      set({ streamingContent: '', streamingSegments: [], streamingTaskId: null })
    } else if (activeConversation) {
      // Clear streaming state synchronously to prevent the thinking indicator
      // from hanging while the DB reload completes.
      set({
        streamingContent: '',
        streamingSegments: [],
        isStreaming: false,
        activeRequestId: null,
        toolActivities: [],
        streamingTaskId: null
      })
      // Then reload messages from DB asynchronously
      window.api
        .getMessages({ conversationId: activeConversation.id })
        .then((dbMessages) => {
          if (dbMessages.length > 0) {
            const currentMessages = get()?.messages ?? []
            set({
              messages: dbMessages.length > 0 ? dbMessages : currentMessages
            })
          }
        })
        .catch((error) => {
          rendererLog.error('Failed to reload messages after stream finalize:', error)
        })
    } else {
      set({
        streamingContent: '',
        streamingSegments: [],
        isStreaming: false,
        activeRequestId: null,
        toolActivities: [],
        streamingTaskId: null
      })
    }

    internals.resetAccumulator()
  },

  finalizeTurnBubble: (
    turnId: string,
    turnRole?: 'da-vinci' | 'specialist',
    turnSpecialist?: string
  ) => {
    // Flush any remaining buffered content before finalizing the turn.
    // Without this, text streamed just before a tool call stays in the
    // accumulator (waiting for a sentence boundary / 250ms timeout)
    // and is never captured into the turn message.
    internals.flushAccumulator()

    const {
      streamingSegments,
      streamingContent,
      streamingRole,
      streamingSpecialist,
      activeConversation,
      toolActivities
    } = get()

    // Nothing to finalize — agent went straight to tools without text
    if (!streamingContent && streamingSegments.length === 0 && toolActivities.length === 0) return

    // Use identity from the turn boundary chunk if provided (defensive against stale store state)
    const role = turnRole ?? streamingRole
    const specialist = turnSpecialist ?? streamingSpecialist

    if (activeConversation) {
      // Merge ALL segments + current content into a single message per turn
      const mergedContent = [...streamingSegments.map((s) => s.content), streamingContent]
        .map((c) => c.trim())
        .filter(Boolean)
        .join('\n\n')

      const mergedTools = [
        ...streamingSegments.flatMap((s) => s.toolActivities),
        ...toolActivities
      ].map((a) => (a.status === 'running' ? { ...a, status: 'completed' as const } : a))

      if (mergedContent || mergedTools.length > 0) {
        const message: Message = {
          id: turnId,
          conversationId: activeConversation.id,
          role,
          ...(role === 'specialist' && specialist ? { agentId: specialist } : {}),
          contentMd: mergedContent,
          attachmentsJson: '[]',
          createdAt:
            streamingSegments.length > 0
              ? new Date(streamingSegments[0].timestamp).toISOString()
              : new Date().toISOString(),
          toolActivities: mergedTools.length > 0 ? mergedTools : undefined
        }

        set((state) => ({
          messages: [...state.messages, message],
          streamingContent: '',
          streamingSegments: [],
          toolActivities: [],
          isStreaming: true
        }))
      } else {
        set({ streamingContent: '', streamingSegments: [], toolActivities: [], isStreaming: true })
      }
    }

    internals.resetAccumulator()
  },

  clearAutoModeSwitchPill: () => set({ autoModeSwitchPill: null }),

  setSessionRecovery: (data) => set({ sessionRecovery: data }),

  setBudgetCapBanner: (data) => set({ budgetCapBanner: data }),

  continuePastBudgetCap: async () => {
    const { budgetCapBanner, activeConversation } = get()
    if (!budgetCapBanner || !activeConversation) return
    set({ budgetCapBanner: null })
    // Resume by sending a continuation prompt — the SDK session is still alive
    try {
      await window.api.sendMessage({
        conversationId: activeConversation.id,
        text: 'Continue where you left off.',
        attachments: []
      })
    } catch (err) {
      console.error('Failed to continue past budget cap:', err)
    }
  },

  dismissBudgetCap: () => set({ budgetCapBanner: null }),

  setConversationState: (data) => {
    // Only update conversationState — do NOT derive isStreaming from phase.
    // isStreaming is controlled by sendMessage/stopGeneration/appendStreamChunk/finalizeStream
    // which have direct knowledge of streaming lifecycle. Deriving from async state machine
    // events causes races (e.g., delayed phase IPC re-enables isStreaming after stop).
    set({ conversationState: data })
  },

  completeConversation: async (branchName: string, commitMessage: string, description: string) => {
    const { activeConversation, conversations } = get()
    if (!activeConversation) throw new Error('No active conversation')

    const result = await window.api.completeConversation({
      conversationId: activeConversation.id,
      branchName,
      commitMessage,
      description
    })

    // Remove conversation from state (it's been deleted in DB)
    const newConversations = conversations.filter((c) => c.id !== activeConversation.id)
    set({
      conversations: newConversations,
      activeConversation: null,
      messages: [],
      streamingContent: '',
      streamingSegments: [],
      isStreaming: false,
      toolActivities: []
    })

    return result
  },

  closeConversation: async (id: string) => {
    try {
      await window.api.closeConversation({ conversationId: id })
    } catch (error) {
      rendererLog.error('Failed to close conversation on backend:', error)
      // Still remove from UI state even if backend cleanup fails
    }
    const { activeConversation, conversations } = get()
    const newConversations = conversations.filter((c) => c.id !== id)
    set({
      conversations: newConversations,
      activeConversation: activeConversation?.id === id ? null : activeConversation,
      messages: activeConversation?.id === id ? [] : get().messages
    })
  },

  startGrillSession: () => {
    set({
      grillSession: {
        active: true,
        summary: null,
        proposedTasks: [],
        pendingQuestions: [],
        answers: {}
      }
    })
  },

  endGrillSession: (summary: string, proposedTasks: GrillProposedTask[]) => {
    set((state) => ({
      grillSession: {
        active: false,
        summary,
        proposedTasks,
        pendingQuestions: [],
        answers: state.grillSession?.answers ?? {}
      }
    }))
  },

  clearGrillSession: () => {
    set({ grillSession: null })
  },

  setGrillQuestions: (questions: GrillQuestion[]) => {
    set((state) => ({
      grillSession: {
        active: state.grillSession?.active ?? true,
        summary: state.grillSession?.summary ?? null,
        proposedTasks: state.grillSession?.proposedTasks ?? [],
        pendingQuestions: questions,
        answers: {}
      }
    }))
  },

  submitGrillAnswers: (answers: GrillAnswerPayload[]) => {
    // Format answers into a readable message for the AI
    const lines: string[] = ['Here are my answers:\n']
    for (const answer of answers) {
      const question = get().grillSession?.pendingQuestions.find((q) => q.id === answer.questionId)
      const header = question?.header || question?.question || answer.questionId

      if (answer.skipped) {
        lines.push(`**${header}**: [SKIPPED]`)
      } else {
        const selections = answer.selectedOptions.map((opt) => {
          const option = question?.options.find((o) => o.label === opt)
          return option?.recommended ? `${opt} (recommended)` : opt
        })
        let line = `**${header}**: ${selections.join(', ')}`
        if (answer.otherText) {
          line += ` + "${answer.otherText}"`
        }
        lines.push(line)
      }
    }

    const formattedMessage = lines.join('\n')

    // Clear pending questions
    set((state) => ({
      grillSession: state.grillSession
        ? {
            ...state.grillSession,
            pendingQuestions: [],
            answers: {}
          }
        : null
    }))

    // Send the formatted message
    get().sendMessage(formattedMessage)
  },

  skipAllGrillQuestions: () => {
    // Clear pending questions and notify the AI
    set((state) => ({
      grillSession: state.grillSession
        ? {
            ...state.grillSession,
            pendingQuestions: [],
            answers: {}
          }
        : null
    }))

    get().sendMessage('All questions skipped — proceeding with defaults.')
  },

  createItemsFromGrill: async (
    tasks: Array<{ title: string; context: string; description: string }>
  ) => {
    const { activeConversation } = get()
    if (!activeConversation) return

    const workspaceId = activeConversation.workspaceId
    for (const task of tasks) {
      try {
        const conversation = (await window.api.createConversation({
          workspaceId,
          title: task.title,
          mode: 'build'
        })) as Conversation

        // Inject context + task as the first message
        const initialMessage = `## Context\n\n${task.context}\n\n## Task\n\n${task.description}`
        await window.api.sendMessage({
          conversationId: conversation.id,
          text: initialMessage
        })

        // Add to conversations list
        set((state) => ({
          conversations: [conversation, ...state.conversations]
        }))
      } catch (error) {
        rendererLog.error(`Failed to create item conversation for "${task.title}":`, error)
      }
    }

    // Clear the grill session after creating items
    set({ grillSession: null })
  },

  // General chat question actions (ask_user tool)
  setPendingQuestions: (questions, action) => {
    set({ pendingQuestions: questions, pendingQuestionAction: action ?? null })
  },

  submitQuestionAnswers: (answers) => {
    const action = get().pendingQuestionAction

    // Programmatic action: "swap-to-specialist" — the renderer handles the
    // swap directly via IPC instead of echoing an answer back to DaVinci.
    // The tool-emitted proposal always has the "accept" option as the first
    // option label ("Swap now"). If the user selected it, invoke the IPC.
    if (action === 'swap-to-specialist') {
      const firstQuestion = get().pendingQuestions?.[0]
      const firstAnswer = answers.find((a) => a.questionId === firstQuestion?.id)
      const acceptLabel = firstQuestion?.options?.[0]?.label
      const accepted =
        !!firstAnswer &&
        !firstAnswer.skipped &&
        !!acceptLabel &&
        firstAnswer.selectedOptions.includes(acceptLabel)

      set({ pendingQuestions: null, pendingQuestionAction: null })

      if (accepted) {
        const workspaceId = useWorkspaceStore.getState().activeWorkspace?.id
        if (workspaceId) {
          // Show immediate feedback
          get().appendLocalMessage('🔄 *Swapping to Project Specialist…*')

          window.api
            .swapToSpecialist({ workspaceId })
            .then(async () => {
              // Reload messages to get clean state after swap
              const { activeConversation } = get()
              if (activeConversation) {
                const messages = await window.api.getMessages({
                  conversationId: activeConversation.id
                })
                set({ messages })
              }

              // Resolve the Project Specialist to get its identity
              await useProjectSpecialistStore.getState().loadForWorkspace(workspaceId)
              const specialist = useProjectSpecialistStore.getState().byWorkspace[workspaceId]

              if (specialist) {
                // Switch the persona selector to the specialist
                await get().switchPersona(specialist.id)

                // Greeting from the specialist (with specialist avatar/identity)
                get().appendLocalMessage(
                  `👋 **${specialist.displayName}** is now active and ready. I'm your dedicated specialist for this workspace — send a message and let's get to work!`,
                  { role: 'specialist', agentId: specialist.agentId }
                )
              } else {
                get().appendLocalMessage(
                  '✅ *Specialist is now active. Send a message to start working with your Project Specialist.*'
                )
              }

              // ── Auto-continue: re-send the user's original message ──
              // The swap was triggered by a user request that DaVinci deferred
              // to the specialist. Re-sending ensures the specialist picks up
              // immediately instead of sitting idle waiting for new input.
              const { messages: currentMessages } = get()
              const lastUserMessage = [...currentMessages]
                .reverse()
                .find((m) => m.role === 'user')
              if (lastUserMessage?.contentMd?.trim()) {
                // Parse attachments from the original message (if any)
                let attachments: string[] | undefined
                try {
                  const parsed = JSON.parse(
                    lastUserMessage.attachmentsJson || '[]'
                  ) as string[]
                  if (parsed.length > 0) attachments = parsed
                } catch {
                  /* no attachments */
                }

                // Brief delay to let the greeting render and scroll settle
                await new Promise((resolve) => setTimeout(resolve, 300))
                await get().sendMessage(lastUserMessage.contentMd, attachments)
              }
            })
            .catch((err) => {
              rendererLog.error('swapToSpecialist failed:', err)
              get().appendLocalMessage(
                '❌ *Failed to swap to specialist. Please try again from workspace settings.*'
              )
            })
        } else {
          rendererLog.warn('swap-to-specialist: no active workspace — skipping IPC call')
        }
      } else {
        // User declined — let DaVinci know so it doesn't re-propose immediately.
        get().sendMessage("I'll keep DaVinci for now.")
      }
      return
    }

    const lines: string[] = ['Here are my answers:\n']
    for (const answer of answers) {
      const question = get().pendingQuestions?.find((q) => q.id === answer.questionId)
      const header = question?.header || question?.question || answer.questionId
      if (answer.skipped) {
        lines.push(`**${header}**: [SKIPPED]`)
      } else {
        const selected = answer.selectedOptions.join(', ')
        const other = answer.otherText ? ` (Other: ${answer.otherText})` : ''
        lines.push(`**${header}**: ${selected}${other}`)
      }
    }
    set({ pendingQuestions: null, pendingQuestionAction: null })
    get().sendMessage(lines.join('\n'))
  },

  skipAllQuestions: () => {
    set({ pendingQuestions: null, pendingQuestionAction: null })
    get().sendMessage("I'll skip these questions for now — let's continue.")
  },

  setCompactSuggestion: (data) => set({ compactSuggestion: data }),

  clearDisplay: () => {
    set({ messages: [], streamingContent: '', streamingSegments: [], toolActivities: [] })
  },

  appendLocalMessage: (content: string, opts?: { role?: Message['role']; agentId?: string }) => {
    const { activeConversation } = get()
    if (!activeConversation) return

    const localMessage: Message = {
      id: `local-${Date.now()}`,
      conversationId: activeConversation.id,
      role: opts?.role ?? 'da-vinci',
      ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      contentMd: content,
      attachmentsJson: '[]',
      createdAt: new Date().toISOString()
    }

    set((state) => ({
      messages: [...state.messages, localMessage]
    }))
  },

  // ── Draft text per conversation ──
  setDraftText: (conversationId: string, text: string) =>
    set((state) => ({
      draftTexts: { ...state.draftTexts, [conversationId]: text }
    })),

  getDraftText: (conversationId: string) => get().draftTexts[conversationId] ?? '',

  clearDraftText: (conversationId: string) =>
    set((state) => {
      const { [conversationId]: _, ...rest } = state.draftTexts
      return { draftTexts: rest }
    }),

  // ── Context usage per conversation ──
  loadContextUsage: async (conversationId: string) => {
    try {
      const usage = await window.api.getContextUsage({ conversationId })
      set((state) => ({
        contextUsages: { ...state.contextUsages, [conversationId]: usage }
      }))
    } catch (error) {
      rendererLog.error('Failed to load context usage:', error)
    }
  },

  // ─��� Conversation reordering ──
  reorderConversations: async (orderedIds: string[]) => {
    // Optimistically reorder local state
    set((state) => {
      const map = new Map(state.conversations.map((c) => [c.id, c]))
      const reordered = orderedIds
        .map((id, i) => {
          const c = map.get(id)
          return c ? { ...c, sortOrder: i } : null
        })
        .filter(Boolean) as Conversation[]
      const remaining = state.conversations.filter((c) => !orderedIds.includes(c.id))
      return { conversations: [...reordered, ...remaining] }
    })
    try {
      await window.api.reorderConversations({ orderedIds })
    } catch (error) {
      rendererLog.error('Failed to reorder conversations:', error)
    }
  },

  reset: () => {
    internals.resetAccumulator()
    internals.clearSafetyTimer()
    set({
      conversations: [],
      activeConversation: null,
      messages: [],
      streamingContent: '',
      streamingSegments: [],
      streamingRole: 'da-vinci' as const,
      streamingSpecialist: null,
      streamingTaskId: null,
      isStreaming: false,
      activeRequestId: null,
      streamingPhase: null,
      toolActivities: [],
      compactSuggestion: null,
      grillSession: null,
      pendingQuestions: null,
      pendingQuestionAction: null,
      budgetCapBanner: null,
      sessionRecovery: null,
      autoModeSwitchPill: null,
      draftTexts: {},
      contextUsages: {},
      conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
    })
  }
}))

// ── Stable action selectors (never trigger re-renders) ──
// Zustand actions are referentially stable — extracting them into a dedicated hook
// prevents components from re-rendering on every streaming chunk (~50+/sec) when
// they only need actions (functions) and not state values.
export const useChatActions = (): Pick<
  ChatState,
  | 'sendMessage'
  | 'stopGeneration'
  | 'clearDisplay'
  | 'appendLocalMessage'
  | 'completeConversation'
  | 'closeConversation'
  | 'createConversation'
  | 'switchPersona'
  | 'selectConversation'
  | 'deleteConversation'
  | 'updateMode'
  | 'renameConversation'
  | 'loadConversations'
  | 'startGrillSession'
  | 'clearGrillSession'
  | 'submitGrillAnswers'
  | 'skipAllGrillQuestions'
  | 'createItemsFromGrill'
  | 'setCompactSuggestion'
  | 'setBudgetCapBanner'
  | 'setGrillQuestions'
  | 'endGrillSession'
  | 'appendStreamChunk'
  | 'updateStreamingIdentity'
  | 'finalizeStream'
  | 'finalizeTurnBubble'
  | 'addToolActivity'
  | 'updateToolActivity'
  | 'setPendingQuestions'
  | 'submitQuestionAnswers'
  | 'skipAllQuestions'
  | 'setDraftText'
  | 'clearDraftText'
  | 'loadContextUsage'
  | 'reorderConversations'
  | 'setConversationState'
> =>
  useChatStore(
    useShallow((s) => ({
      sendMessage: s.sendMessage,
      stopGeneration: s.stopGeneration,
      clearDisplay: s.clearDisplay,
      appendLocalMessage: s.appendLocalMessage,
      completeConversation: s.completeConversation,
      closeConversation: s.closeConversation,
      createConversation: s.createConversation,
      switchPersona: s.switchPersona,
      selectConversation: s.selectConversation,
      deleteConversation: s.deleteConversation,
      updateMode: s.updateMode,
      renameConversation: s.renameConversation,
      loadConversations: s.loadConversations,
      startGrillSession: s.startGrillSession,
      clearGrillSession: s.clearGrillSession,
      submitGrillAnswers: s.submitGrillAnswers,
      skipAllGrillQuestions: s.skipAllGrillQuestions,
      createItemsFromGrill: s.createItemsFromGrill,
      setCompactSuggestion: s.setCompactSuggestion,
      setBudgetCapBanner: s.setBudgetCapBanner,
      setGrillQuestions: s.setGrillQuestions,
      endGrillSession: s.endGrillSession,
      appendStreamChunk: s.appendStreamChunk,
      updateStreamingIdentity: s.updateStreamingIdentity,
      finalizeStream: s.finalizeStream,
      finalizeTurnBubble: s.finalizeTurnBubble,
      addToolActivity: s.addToolActivity,
      updateToolActivity: s.updateToolActivity,
      setPendingQuestions: s.setPendingQuestions,
      submitQuestionAnswers: s.submitQuestionAnswers,
      skipAllQuestions: s.skipAllQuestions,
      setDraftText: s.setDraftText,
      clearDraftText: s.clearDraftText,
      loadContextUsage: s.loadContextUsage,
      reorderConversations: s.reorderConversations,
      setConversationState: s.setConversationState
    }))
  )

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.chatStoreState = useChatStore.getState()
  })
}
