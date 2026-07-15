import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { rendererLog } from '@renderer/utils/logger'
import { detectPlanIntent } from '@renderer/utils/plan-intent-detector'
import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'
import { useWorkspaceStore } from './workspace.store'
import {
  streamingInternals as internals,
  appendStreamChunkAction,
  finalizeStreamAction,
  finalizeTurnBubbleAction
} from './chat-streaming.actions'
import {
  buildStreamingResetState,
  mergeChatSegments,
  createStoppedMessage,
  createOptimisticUserMessage,
  createErrorMessage
} from './chat-action-utils'
import { executeSwapToSpecialist } from './swap-to-specialist.action'
import type {
  CommunicationTone,
  CompleteResult,
  ContextUsage,
  ContextUsageBreakdown,
  Conversation,
  ConversationMode,
  ConversationPhase,
  GrillAnswerPayload,
  GrillQuestion,
  LLMProvider,
  Message,
  ModelRoleMap,
  ThinkingEffort,
  ToolActivity
} from '../../../shared/types'

// ChatStreamingInternals + internals singleton are in ./chat-streaming.actions.ts

export interface ChatState {
  conversations: Conversation[]
  activeConversation: Conversation | null
  messages: Message[]
  streamingContent: string
  streamingRole: 'da-vinci' | 'specialist'
  streamingSpecialist: string | null
  streamingTaskId: string | null
  isStreaming: boolean
  /** SEND-RACE-01: Immediate mutex — prevents rapid double-clicks from bypassing the isStreaming check
   *  (which relies on React re-render and suffers from stale closure capture). */
  isSending: boolean
  /** Conversations that are currently streaming (backend still processing) — enables per-conversation streaming indicators in sidebar */
  streamingConversationIds: Set<string>
  activeRequestId: string | null
  /** Conversation phase — more precise than isStreaming boolean */
  streamingPhase: ConversationPhase | null
  toolActivities: ToolActivity[]
  /** Streaming segments accumulated during streaming — merged into a single message on completion */
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

  // General chat pending questions (ask_user tool)
  pendingQuestions: GrillQuestion[] | null
  /**
   * Programmatic action tag emitted alongside pendingQuestions (e.g.
   * "swap-to-specialist"). When the user accepts the first option on an
   * action-tagged question, submitQuestionAnswers maps the action to an IPC
   * call (e.g. swapToSpecialist) instead of sending a plain-text answer.
   */
  pendingQuestionAction: string | null
  /** Request ID from IPC bridge ask_user — presence indicates CLI/bridge backend */
  pendingQuestionRequestId: string | null

  loadConversations: (workspaceId: string) => Promise<void>
  createConversation: (
    workspaceId: string,
    mode?: ConversationMode,
    title?: string,
    personaSpecialistId?: string,
    llmProvider?: LLMProvider,
    routingOverrides?: Partial<ModelRoleMap>,
    mcpOverrides?: Record<string, boolean>,
    communicationTone?: CommunicationTone | null
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
  /** Reset safety timer without processing content — used by keepalive signals from backend. */
  handleKeepalive: () => void
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
  /**
   * Toggle the chat thinking-indicator spinner for non-streaming background work
   * (e.g. grill plan synthesis). Unlike a real SDK stream it never arms the
   * streaming safety timer, so callers MUST clear it (use try/finally).
   */
  setStreamingIndicator: (active: boolean) => void

  // Compact suggestion
  setCompactSuggestion: (
    data: {
      level: string
      inputTokens: number
      breakdown?: ContextUsageBreakdown
      isLocalProvider?: boolean
    } | null
  ) => void

  // General chat question actions
  setPendingQuestions: (questions: GrillQuestion[], action?: string, requestId?: string) => void
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

  // Turn limit reached — shows Continue button when auto-continuations are exhausted
  turnLimitReached: {
    continuable: boolean
    continuationsUsed: number
    continuationsMax: number
  } | null
  continuePastTurnLimit: () => void
  dismissTurnLimit: () => void

  // Conversation state machine mirror
  setConversationState: (data: ChatState['conversationState']) => void

  // Context usage per conversation
  contextUsages: Record<string, ContextUsage>
  loadContextUsage: (conversationId: string) => Promise<void>

  // Thinking effort per conversation (defaults to 'medium')
  effortLevels: Record<string, ThinkingEffort>
  setEffort: (conversationId: string, effort: ThinkingEffort) => Promise<void>

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
  isSending: false,
  streamingConversationIds: previousChatState?.streamingConversationIds ?? new Set<string>(),
  activeRequestId: previousChatState?.activeRequestId ?? null,
  streamingPhase: previousChatState?.streamingPhase ?? null,
  toolActivities: previousChatState?.toolActivities ?? [],
  streamingSegments: previousChatState?.streamingSegments ?? [],
  compactSuggestion: previousChatState?.compactSuggestion ?? null,
  pendingQuestions: previousChatState?.pendingQuestions ?? null,
  pendingQuestionAction: previousChatState?.pendingQuestionAction ?? null,
  pendingQuestionRequestId: previousChatState?.pendingQuestionRequestId ?? null,
  autoModeSwitchPill: null,
  sessionRecovery: null,
  budgetCapBanner: null,
  turnLimitReached: null,
  conversationState: previousChatState?.conversationState ?? {
    phase: 'idle',
    from: null,
    event: null,
    conversationId: null
  },
  draftTexts: previousChatState?.draftTexts ?? {},
  contextUsages: previousChatState?.contextUsages ?? {},
  effortLevels: previousChatState?.effortLevels ?? {},

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
      // Hydrate effort levels from persisted conversation state
      const hydratedEfforts: Record<string, ThinkingEffort> = {}
      for (const conv of conversations) {
        if (conv.effort) {
          hydratedEfforts[conv.id] = conv.effort
        }
      }
      set((state) => ({
        conversations,
        effortLevels: { ...state.effortLevels, ...hydratedEfforts }
      }))
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
    routingOverrides?: Partial<ModelRoleMap>,
    mcpOverrides?: Record<string, boolean>,
    communicationTone?: CommunicationTone | null
  ) => {
    const conversation = await window.api.createConversation({
      workspaceId,
      mode,
      title,
      personaSpecialistId,
      llmProvider,
      routingOverrides,
      mcpOverrides,
      communicationTone
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
    // MSG-RELOAD-01: Bump generation so any in-flight DB reload from a previous
    // conversation is discarded instead of overwriting this conversation's messages.
    internals.bumpGeneration()

    const messages = await window.api.getMessages({ conversationId: id })

    // Query backend for streaming state BEFORE resetting — restores streaming indicator
    // if this conversation is still being processed by the backend
    let isConversationStillStreaming = false
    let restoredRequestId: string | null = null
    try {
      const backendState = await window.api.getStreamingState()
      isConversationStillStreaming = backendState.isStreaming && backendState.conversationId === id
      if (isConversationStillStreaming) {
        restoredRequestId = backendState.requestId
      }
    } catch {
      // If backend query fails, default to non-streaming (safe fallback)
    }

    set((state) => ({
      activeConversation: conversation,
      messages,
      streamingContent: '',
      // RESTORE streaming if backend says this conversation is still active
      isStreaming: isConversationStillStreaming,
      // Reset streaming identity — prevents stale specialist/DaVinci avatar leak
      streamingRole: 'da-vinci' as const,
      streamingSpecialist: null,
      streamingTaskId: null,
      // Clear ephemeral UI state from previous conversation
      toolActivities: [],
      streamingSegments: [],
      compactSuggestion: null,
      budgetCapBanner: null,
      turnLimitReached: null,
      // Preserve any in-flight ask_user question when re-opening / re-rendering the
      // SAME actively-streaming conversation. Hard-nulling here wiped the requestId,
      // so submitQuestionAnswers could no longer route the answer and it looked like
      // a timeout. Only clear when switching to a different / non-streaming convo.
      ...(isConversationStillStreaming
        ? {}
        : {
            pendingQuestions: null,
            pendingQuestionAction: null,
            pendingQuestionRequestId: null
          }),
      activeRequestId: isConversationStillStreaming ? restoredRequestId : null,
      // Hydrate effort from persisted conversation state
      effortLevels: conversation.effort
        ? { ...state.effortLevels, [conversation.id]: conversation.effort }
        : state.effortLevels,
      // Restore state machine mirror based on backend
      conversationState: isConversationStillStreaming
        ? {
            phase: 'da-vinci-responding' as ConversationPhase,
            from: null,
            event: null,
            conversationId: id
          }
        : { phase: 'idle' as const, from: null, event: null, conversationId: null }
    }))

    // CLI mode sync is deferred — will happen automatically on next message send
    // No need to restart the CLI process just because the user switched conversations

    // Branch-per-conversation: switch git branch if conversation has one
    if (conversation.branchName) {
      try {
        const result = await window.api.switchBranch({ conversationId: id })
        if (result.switched) {
          // Refresh repoInfo so status bar shows the new branch
          const workspace = useWorkspaceStore.getState().activeWorkspace
          if (workspace) {
            useWorkspaceStore.getState().loadRepoInfo(workspace.id)
          }
        }
      } catch (e) {
        rendererLog.warn('Branch switch failed:', e)
      }
    }
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
      const { mergedContent, mergedTools } = mergeChatSegments(streamingSegments, streamingContent)
      const stoppedMessage = createStoppedMessage(
        activeConversation.id,
        mergedContent,
        mergedTools,
        streamingRole,
        streamingSpecialist,
        streamingSegments
      )

      set((state) => ({
        messages: [...state.messages, stoppedMessage],
        ...buildStreamingResetState(activeConversation.id, state.streamingConversationIds),
        // STOP-ASKUSER-01: Clear orphaned pending questions so the card doesn't persist after stop
        pendingQuestions: null,
        pendingQuestionAction: null,
        pendingQuestionRequestId: null
      }))
    } else if (activeConversation) {
      // No partial content — still show a local indicator
      const stoppedMessage = createStoppedMessage(
        activeConversation.id,
        '',
        [],
        'da-vinci',
        null,
        []
      )
      set((state) => ({
        messages: [...state.messages, stoppedMessage],
        ...buildStreamingResetState(activeConversation.id, state.streamingConversationIds),
        // STOP-ASKUSER-01: Clear orphaned pending questions so the card doesn't persist after stop
        pendingQuestions: null,
        pendingQuestionAction: null,
        pendingQuestionRequestId: null
      }))
    } else {
      set({
        ...buildStreamingResetState(null, get().streamingConversationIds),
        // STOP-ASKUSER-01: Clear orphaned pending questions so the card doesn't persist after stop
        pendingQuestions: null,
        pendingQuestionAction: null,
        pendingQuestionRequestId: null
      })
    }

    internals.resetAccumulator()
  },

  sendMessage: async (text: string, attachments?: string[]) => {
    const { activeConversation, updateMode, isStreaming: alreadyStreaming, isSending } = get()
    // SEND-RACE-01: Guard against rapid double-clicks. isSending is set synchronously
    // before the async IPC call, so it can't be bypassed by stale React closures.
    if (!activeConversation || alreadyStreaming || isSending) return
    set({
      isSending: true,
      // SEND-ASKUSER-01: Clear stale pending questions so the card doesn't persist alongside new stream
      pendingQuestions: null,
      pendingQuestionAction: null,
      pendingQuestionRequestId: null
    })
    // MSG-RELOAD-01: Bump generation so any in-flight DB reload is discarded
    internals.bumpGeneration()

    // Auto-detect plan intent in build mode → switch to plan
    if (activeConversation.mode === 'build' && detectPlanIntent(text)) {
      await updateMode('plan')
    }

    const optimisticMessage = createOptimisticUserMessage(activeConversation.id, text, attachments)

    set((state) => ({
      messages: [...state.messages, optimisticMessage],
      isStreaming: true,
      streamingContent: '',
      streamingSegments: [],
      toolActivities: [],
      budgetCapBanner: null,
      turnLimitReached: null,
      // activeRequestId is set AFTER the backend returns — see below.
      activeRequestId: null,
      // Track this conversation as streaming (for sidebar indicator when user switches away)
      streamingConversationIds: new Set([...state.streamingConversationIds, activeConversation.id])
    }))

    // Reset segment accumulator for new message
    internals.resetAccumulator()

    // Safety: force-reset if streaming state gets stuck (e.g., process dies without emitting complete)
    internals.resetSafetyTimer()

    try {
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

      const errorMsg = error instanceof Error ? error.message : String(error)
      const { activeConversation: conv } = get()
      if (conv) {
        const errMessage = createErrorMessage(conv.id, errorMsg)
        set((state) => ({
          messages: [...state.messages, errMessage],
          ...buildStreamingResetState(conv.id, state.streamingConversationIds)
        }))
      } else {
        set(buildStreamingResetState(null, get().streamingConversationIds))
      }
    } finally {
      set({ isSending: false })
    }
  },

  appendStreamChunk: (
    chunk: string,
    role?: 'da-vinci' | 'specialist',
    taskId?: string,
    specialist?: string,
    requestId?: string
  ) => {
    appendStreamChunkAction(get, set, chunk, role, taskId, specialist, requestId)
  },

  handleKeepalive: () => {
    // Backend is alive — reset safety timer without processing any content.
    // Used when MCP tools block the SDK message loop for extended periods.
    internals.resetSafetyTimer()
  },

  updateStreamingIdentity: (role, taskId?, specialist?) => {
    set((state) => ({
      streamingRole: role,
      streamingSpecialist: specialist ?? state.streamingSpecialist,
      streamingTaskId: taskId ?? state.streamingTaskId
    }))
  },

  addToolActivity: (activity: ToolActivity) => {
    internals.resetSafetyTimer()
    internals.getOrCreateAccumulator().handleToolActivity(activity)
  },

  updateToolActivity: (activity: Partial<ToolActivity> & { toolName: string; id?: string }) => {
    internals.resetSafetyTimer()
    internals
      .getOrCreateAccumulator()
      .handleToolActivity(activity as Partial<ToolActivity> & { id: string; toolName: string })
  },

  finalizeStream: (messageId: string, taskId?: string, requestId?: string) => {
    finalizeStreamAction(get, set, messageId, taskId, requestId)
  },

  finalizeTurnBubble: (
    turnId: string,
    turnRole?: 'da-vinci' | 'specialist',
    turnSpecialist?: string
  ) => {
    finalizeTurnBubbleAction(get, set, turnId, turnRole, turnSpecialist)
  },

  clearAutoModeSwitchPill: () => set({ autoModeSwitchPill: null }),

  setSessionRecovery: (data) => set({ sessionRecovery: data }),

  setBudgetCapBanner: (data) => set({ budgetCapBanner: data }),

  continuePastBudgetCap: async () => {
    const { budgetCapBanner, activeConversation, isStreaming, isSending } = get()
    if (!budgetCapBanner || !activeConversation || isStreaming || isSending) return
    set({ budgetCapBanner: null })
    void get().sendMessage('Continue where you left off.')
  },

  dismissBudgetCap: () => set({ budgetCapBanner: null }),

  continuePastTurnLimit: () => {
    const { activeConversation, isStreaming, isSending } = get()
    if (!activeConversation || isStreaming || isSending) return
    set({ turnLimitReached: null })
    void get().sendMessage('Continue where you left off. Do not repeat completed work.')
  },

  dismissTurnLimit: () => set({ turnLimitReached: null }),

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
      messages: activeConversation?.id === id ? [] : get().messages,
      // CONV-CLOSE-STREAMING-01: Clear streaming state to prevent stale isStreaming
      // lock and ghost streaming bubbles when a conversation is closed mid-stream.
      ...(activeConversation?.id === id
        ? {
            isStreaming: false,
            streamingContent: '',
            streamingSegments: [],
            activeRequestId: null,
            toolActivities: [],
            // CONV-CLOSE-ASKUSER-01: Clear pending questions when closing a conversation
            pendingQuestions: null,
            pendingQuestionAction: null,
            pendingQuestionRequestId: null
          }
        : {})
    })
  },

  // General chat question actions (ask_user tool)
  setPendingQuestions: (questions, action, requestId) => {
    set({
      pendingQuestions: questions,
      pendingQuestionAction: action ?? null,
      pendingQuestionRequestId: requestId ?? null
    })
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

      set({ pendingQuestions: null, pendingQuestionAction: null, pendingQuestionRequestId: null })

      if (accepted) {
        executeSwapToSpecialist(get, set)
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

    const requestId = get().pendingQuestionRequestId
    set({ pendingQuestions: null, pendingQuestionAction: null, pendingQuestionRequestId: null })

    // If requestId is present (CLI/IPC bridge backend), route through the bridge
    // so the control-actions MCP server's askUserAndWaitForResponse promise resolves.
    if (requestId) {
      window.api.respondToAskUser({ requestId, response: lines.join('\n') })
    } else {
      // SDK backend fallback — send as new message
      get().sendMessage(lines.join('\n'))
    }
  },

  skipAllQuestions: () => {
    const requestId = get().pendingQuestionRequestId
    set({ pendingQuestions: null, pendingQuestionAction: null, pendingQuestionRequestId: null })
    const skipText = "I'll skip these questions for now — let's continue."
    if (requestId) {
      window.api.respondToAskUser({ requestId, response: skipText })
    } else {
      get().sendMessage(skipText)
    }
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

  setStreamingIndicator: (active: boolean) =>
    set((state) => ({
      isStreaming: active,
      conversationState: active
        ? {
            phase: 'da-vinci-responding' as ConversationPhase,
            from: null,
            event: null,
            conversationId: state.activeConversation?.id ?? null
          }
        : { phase: 'idle' as const, from: null, event: null, conversationId: null }
    })),

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
  // ── Thinking effort ──
  setEffort: async (conversationId: string, effort: ThinkingEffort) => {
    // Optimistic update
    set((state) => ({
      effortLevels: { ...state.effortLevels, [conversationId]: effort }
    }))
    try {
      await window.api.updateEffort({ conversationId, effort })
    } catch (error) {
      rendererLog.error('Failed to update effort:', error)
    }
  },

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
      streamingConversationIds: new Set<string>(),
      activeRequestId: null,
      streamingPhase: null,
      toolActivities: [],
      compactSuggestion: null,
      pendingQuestions: null,
      pendingQuestionAction: null,
      pendingQuestionRequestId: null,
      budgetCapBanner: null,
      turnLimitReached: null,
      sessionRecovery: null,
      autoModeSwitchPill: null,
      draftTexts: {},
      contextUsages: {},
      effortLevels: {},
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
  | 'setStreamingIndicator'
  | 'completeConversation'
  | 'closeConversation'
  | 'createConversation'
  | 'switchPersona'
  | 'selectConversation'
  | 'deleteConversation'
  | 'updateMode'
  | 'renameConversation'
  | 'loadConversations'
  | 'setCompactSuggestion'
  | 'setBudgetCapBanner'
  | 'appendStreamChunk'
  | 'handleKeepalive'
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
  | 'setEffort'
> =>
  useChatStore(
    useShallow((s) => ({
      sendMessage: s.sendMessage,
      stopGeneration: s.stopGeneration,
      clearDisplay: s.clearDisplay,
      appendLocalMessage: s.appendLocalMessage,
      setStreamingIndicator: s.setStreamingIndicator,
      completeConversation: s.completeConversation,
      closeConversation: s.closeConversation,
      createConversation: s.createConversation,
      switchPersona: s.switchPersona,
      selectConversation: s.selectConversation,
      deleteConversation: s.deleteConversation,
      updateMode: s.updateMode,
      renameConversation: s.renameConversation,
      loadConversations: s.loadConversations,
      setCompactSuggestion: s.setCompactSuggestion,
      setBudgetCapBanner: s.setBudgetCapBanner,
      appendStreamChunk: s.appendStreamChunk,
      handleKeepalive: s.handleKeepalive,
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
      setConversationState: s.setConversationState,
      setEffort: s.setEffort
    }))
  )

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.chatStoreState = useChatStore.getState()
  })
}
