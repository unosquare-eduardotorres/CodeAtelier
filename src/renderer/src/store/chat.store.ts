import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { rendererLog } from '@renderer/utils/logger'
import { detectPlanIntent } from '@renderer/utils/plan-intent-detector'
import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'
import { useWorkspaceStore } from './workspace.store'
import { useTodoStore } from './todo.store'
import { usePlanExecutionStore } from './plan-execution.store'
import type { PhaseStatus } from './plan-execution.store'
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
  createErrorMessage,
  parseBlockedByError,
  captureStreamState,
  emptyStreamState
} from './chat-action-utils'
import type { PerConversationStreamState } from './chat-action-utils'
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

// Re-export for consumers that import from chat.store
export type { PerConversationStreamState } from './chat-action-utils'

export interface ChatState {
  conversations: Conversation[]
  activeConversation: Conversation | null
  messages: Message[]
  streamingContent: string
  streamingRole: 'specialist'
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
  /** STALL-DETECT-01: Conversation ID whose stream has stalled (no real content for 3 minutes).
   *  null when no stall detected. Used to show a warning banner — does NOT kill the stream. */
  streamStalledConversationId: string | null

  /**
   * MULTI-CHAT-06: Per-conversation streaming state snapshots.
   * When the user switches away from a streaming conversation, the active streaming
   * state is stashed here. When they switch back, it's restored. Background chunks
   * are also accumulated here.
   */
  conversationStreams: Map<string, PerConversationStreamState>

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
   * Programmatic action tag emitted alongside pendingQuestions.
   * When set, submitQuestionAnswers can map the action to custom
   * handling instead of sending a plain-text answer.
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
    communicationTone?: CommunicationTone | null,
    sourceAuditRunId?: string
  ) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  updateMode: (mode: ConversationMode) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  stopGeneration: () => Promise<void>
  sendMessage: (text: string, attachments?: string[]) => Promise<void>
  appendStreamChunk: (
    chunk: string,
    role?: 'specialist',
    taskId?: string,
    specialist?: string,
    requestId?: string
  ) => void
  /** Reset safety timer without processing content — used by keepalive signals from backend. */
  handleKeepalive: (conversationId?: string) => void
  updateStreamingIdentity: (
    role: 'specialist',
    taskId?: string,
    specialist?: string
  ) => void
  finalizeStream: (messageId: string, taskId?: string, requestId?: string) => void
  finalizeTurnBubble: (
    turnId: string,
    turnRole?: 'specialist',
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

  // MULTI-CHAT-04: Blocked-by banner — shown when another chat is still streaming
  blockedByBanner: {
    blockedConvId: string
    blockedConvTitle: string | undefined
    retryText: string
    retryAttachments?: string[]
    /** MULTI-CHAT-06: Track the optimistic message ID so we can remove it on dismiss */
    optimisticMessageId?: string
  } | null
  switchToBlockingChat: () => Promise<void>
  stopBlockingChat: () => Promise<void>
  dismissBlockedBy: () => void

  // Turn limit reached — shows Continue button when auto-continuations are exhausted
  turnLimitReached: {
    continuable: boolean
    continuationsUsed: number
    continuationsMax: number
  } | null
  continuePastTurnLimit: () => void
  dismissTurnLimit: () => void

  // STALL-DETECT-03: Dismiss stall detection banner
  dismissStallBanner: () => void

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
  streamingRole: previousChatState?.streamingRole ?? ('specialist' as const),
  streamingSpecialist: previousChatState?.streamingSpecialist ?? null,
  streamingTaskId: previousChatState?.streamingTaskId ?? null,
  isStreaming: previousChatState?.isStreaming ?? false,
  isSending: false,
  streamingConversationIds: previousChatState?.streamingConversationIds ?? new Set<string>(),
  activeRequestId: previousChatState?.activeRequestId ?? null,
  streamingPhase: previousChatState?.streamingPhase ?? null,
  toolActivities: previousChatState?.toolActivities ?? [],
  streamingSegments: previousChatState?.streamingSegments ?? [],
  streamStalledConversationId: null,
  conversationStreams: previousChatState?.conversationStreams ?? new Map(),
  compactSuggestion: previousChatState?.compactSuggestion ?? null,
  pendingQuestions: previousChatState?.pendingQuestions ?? null,
  pendingQuestionAction: previousChatState?.pendingQuestionAction ?? null,
  pendingQuestionRequestId: previousChatState?.pendingQuestionRequestId ?? null,
  autoModeSwitchPill: null,
  sessionRecovery: null,
  budgetCapBanner: null,
  blockedByBanner: null,
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
        // reset() already calls internals.resetAccumulator() and internals.clearSafetyTimer()
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
        effortLevels: { ...state.effortLevels, ...hydratedEfforts },
        // MULTI-CHAT-06: Clear stashed streaming state from previous workspace.
        // Stale entries with different conversation IDs are harmless but waste memory.
        conversationStreams: new Map()
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
    communicationTone?: CommunicationTone | null,
    sourceAuditRunId?: string
  ) => {
    const conversation = await window.api.createConversation({
      workspaceId,
      mode,
      title,
      personaSpecialistId,
      llmProvider,
      routingOverrides,
      mcpOverrides,
      communicationTone,
      sourceAuditRunId
    })
    // GAP-R5-1: Stash streaming state of the current conversation before switching.
    // Without this, creating a new conv while viewing a streaming one loses the
    // previous conv's streaming content. Mirrors selectConversation's stash logic.
    const prevConvId = get().activeConversation?.id
    if (prevConvId && get().isStreaming) {
      internals.flushAccumulator()
      const snapshot = captureStreamState(get())
      const newStreams = new Map(get().conversationStreams)
      newStreams.set(prevConvId, snapshot)
      set({ conversationStreams: newStreams })
    }
    internals.resetAccumulator()
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      activeConversation: conversation,
      messages: [],
      streamingContent: '',
      streamingSegments: [],
      isStreaming: false,
      // Reset streaming identity — prevents stale specialist avatar leak
      streamingRole: 'specialist' as const,
      streamingSpecialist: null,
      streamingTaskId: null,
      // GAP-R6-1: Clear ephemeral state from previous conversation.
      // Without this, stale banners/questions/tools from the prev conv
      // appear on the new conversation.
      activeRequestId: null,
      toolActivities: [],
      streamingPhase: null,
      streamStalledConversationId: null,
      pendingQuestions: null,
      pendingQuestionAction: null,
      pendingQuestionRequestId: null,
      compactSuggestion: null,
      budgetCapBanner: null,
      blockedByBanner: null,
      turnLimitReached: null,
      conversationState: { phase: 'idle' as const, from: null, event: null, conversationId: null }
    }))
  },

  deleteConversation: async (id: string) => {
    // Delete uses the same flow as /close
    await get().closeConversation(id)
    // Clean up plan execution and todos for the deleted conversation
    usePlanExecutionStore.getState().clearExecution(id)
    useTodoStore.getState().clearTodos(id)
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
    // MULTI-CHAT-06: Flush and discard the current accumulator so it doesn't
    // bleed buffered text from the previous conversation into the target.
    internals.flushAccumulator()

    // MULTI-CHAT-06: Save the current conversation's streaming state BEFORE the
    // async gap. captureStreamState reads from the store which flushAccumulator
    // just populated. Doing this before resetAccumulator + getMessages prevents
    // losing unflushed accumulator state during the async window.
    const prevConvId = get().activeConversation?.id
    if (prevConvId && prevConvId !== id && get().isStreaming) {
      const snapshot = captureStreamState(get())
      const newStreams = new Map(get().conversationStreams)
      newStreams.set(prevConvId, snapshot)
      set({ conversationStreams: newStreams })
    }

    internals.resetAccumulator()

    const messages = await window.api.getMessages({ conversationId: id })

    // MULTI-CHAT-06: Check if we have a stashed streaming state for the target conversation.
    const stashedState = get().conversationStreams.get(id)
    const hasStashedStreaming = stashedState?.isStreaming ?? false

    // MULTI-CHAT-06: Query backend for streaming state using the per-conversation
    // streams array instead of the legacy single-stream fields.
    let isConversationStillStreaming = hasStashedStreaming
    let restoredRequestId: string | null = stashedState?.activeRequestId ?? null
    try {
      const backendState = await window.api.getStreamingState()
      // Use per-conversation streams array for precise lookup
      const convStream = backendState.streams?.find((s) => s.conversationId === id)
      // BUG-R7-1: Backend is authoritative when query succeeds — override in BOTH
      // directions. The stash may be stale (safety timeout killed the stream but
      // didn't clean the stash). Only fall back to stash when backend is unreachable.
      isConversationStillStreaming = !!convStream
      if (convStream) {
        restoredRequestId = convStream.requestId
      }
    } catch {
      // If backend query fails, use stashed state as fallback
    }

    // MULTI-CHAT-06: Restore from stash if the conversation has buffered streaming state.
    const restored = isConversationStillStreaming && stashedState
      ? stashedState
      : emptyStreamState()

    set((state) => {
      // Clean up the stash for this conversation since we're restoring it
      const newStreams = new Map(state.conversationStreams)
      newStreams.delete(id)
      // BUG-R8-1: Detect re-selection (selecting the already-active conversation)
      const isReselection = state.activeConversation?.id === id

      return {
        activeConversation: conversation,
        messages,
        conversationStreams: newStreams,
        // MULTI-CHAT-06: Restore streaming state from stash, or reset to empty
        streamingContent: restored.streamingContent,
        streamingSegments: restored.streamingSegments,
        streamingRole: restored.streamingRole,
        streamingSpecialist: restored.streamingSpecialist,
        streamingTaskId: restored.streamingTaskId,
        streamingPhase: restored.streamingPhase,
        toolActivities: restored.toolActivities,
        isStreaming: isConversationStillStreaming,
        activeRequestId: isConversationStillStreaming ? restoredRequestId : null,
        // Clear ephemeral UI state from previous conversation
        compactSuggestion: null,
        budgetCapBanner: null,
        blockedByBanner: null,
        turnLimitReached: null,
        // STALL-DETECT-03: Clear stall banner from previous conversation on switch
        streamStalledConversationId: null,
        // BUG-R8-1: Only fall back to current store state when re-selecting the SAME
        // conversation (state.pendingQuestions is still THIS conv's questions). For
        // cross-conv switches, the stash is the only valid source — falling back to
        // state leaks the previous conv's pending questions into the new conv.
        pendingQuestions: isConversationStillStreaming
          ? (restored.pendingQuestions ?? (isReselection ? state.pendingQuestions : null))
          : null,
        pendingQuestionAction: isConversationStillStreaming
          ? (restored.pendingQuestionAction ?? (isReselection ? state.pendingQuestionAction : null))
          : null,
        pendingQuestionRequestId: isConversationStillStreaming
          ? (restored.pendingQuestionRequestId ?? (isReselection ? state.pendingQuestionRequestId : null))
          : null,
        // Hydrate effort from persisted conversation state
        effortLevels: conversation.effort
          ? { ...state.effortLevels, [conversation.id]: conversation.effort }
          : state.effortLevels,
        // Restore state machine mirror based on backend
        conversationState: isConversationStillStreaming
          ? {
              phase: 'specialist-responding' as ConversationPhase,
              from: null,
              event: null,
              conversationId: id
            }
          : { phase: 'idle' as const, from: null, event: null, conversationId: null }
      }
    })

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

    // Load persisted todos for the selected conversation
    try {
      const persistedTodos = await window.api.getTodos({ conversationId: id })
      if (persistedTodos.length > 0) {
        const { todos } = useTodoStore.getState()
        // Only hydrate if the store doesn't already have todos for this conversation
        if (!todos[id] || todos[id].length === 0) {
          useTodoStore.setState((state) => ({
            todos: {
              ...state.todos,
              [id]: persistedTodos.map((t) => ({
                text: t.text,
                completed: t.completed,
                index: t.itemIndex ?? undefined,
                updatedAt: new Date(t.updatedAt).getTime()
              }))
            }
          }))
        }
      }
    } catch { /* non-critical — todos are ephemeral fallback */ }

    // Load persisted phase progress for the selected conversation
    try {
      const phaseData = await window.api.getPhaseProgress({ conversationId: id })
      if (phaseData && phaseData.progress.length > 0) {
        const { startExecution, updatePhase, markFileTouched } = usePlanExecutionStore.getState()
        startExecution(id, {
          planId: phaseData.planId,
          title: phaseData.planTitle,
          phases: phaseData.phases
        })
        for (const p of phaseData.progress) {
          updatePhase(id, {
            phaseId: p.phaseId,
            phaseTitle: phaseData.phases.find((ph) => ph.id === p.phaseId)?.title ?? `Phase ${p.phaseId}`,
            status: p.status as PhaseStatus['status'],
            totalPhases: phaseData.phases.length
          })
          // Hydrate touchedFiles from persisted data
          if (p.touchedFiles && p.touchedFiles.length > 0) {
            for (const file of p.touchedFiles) {
              markFileTouched(id, file)
            }
          }
        }
      }
    } catch { /* non-critical */ }
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
      // MULTI-CHAT-03: Pass conversationId so only THIS chat is stopped,
      // not all streams across the workspace.
      await window.api.stopGeneration(activeConversation?.id)
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
        'specialist',
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

    // STALL-DETECT-04: Clear stall/safety timers on stop — prevents orphaned timers
    // that could fire after the stream is already stopped.
    if (activeConversation) {
      internals.clearSafetyTimer(activeConversation.id)
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

    // SEND-SAFETY-TIMEOUT: Auto-reset isSending if it stays true for >30s
    // (covers IPC hangs or missed resets from unexpected errors)
    const isSendingTimeout = setTimeout(() => {
      if (get().isSending) {
        rendererLog.warn('[SEND-SAFETY] isSending stuck for 30s — force-resetting')
        set({ isSending: false })
      }
    }, 30_000)

    try {
      // MSG-RELOAD-01: Bump generation so any in-flight DB reload is discarded
      internals.bumpGeneration()

      // Auto-detect plan intent in build mode → switch to plan
      if (activeConversation.mode === 'build' && detectPlanIntent(text)) {
        await updateMode('plan')
      }

      const optimisticMessage = createOptimisticUserMessage(activeConversation.id, text, attachments)

      set((state) => ({
        // MULTI-CHAT-06: Remove stale optimistic message from a previous blocked-by attempt
        // before appending the new one (edge case: blocking conv finishes naturally, user re-sends)
        messages: [
          ...state.messages.filter((m) => m.id !== state.blockedByBanner?.optimisticMessageId),
          optimisticMessage
        ],
        isStreaming: true,
        streamingContent: '',
        streamingSegments: [],
        toolActivities: [],
        budgetCapBanner: null,
        blockedByBanner: null,
        turnLimitReached: null,
        // activeRequestId is set AFTER the backend returns — see below.
        activeRequestId: null,
        // Track this conversation as streaming (for sidebar indicator when user switches away)
        streamingConversationIds: new Set([...state.streamingConversationIds, activeConversation.id])
      }))

      // Reset segment accumulator for new message
      internals.resetAccumulator()

      // Safety: force-reset if streaming state gets stuck (e.g., process dies without emitting complete)
      internals.resetSafetyTimer(activeConversation.id)

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
        internals.clearSafetyTimer(activeConversation.id)

        const rawErrorMsg = error instanceof Error ? error.message : String(error)

        // G2-FIX: Parse the F6 blockedBy tag and build a clean user-facing message.
        // Extracted to parseBlockedByError (chat-action-utils.ts) for testability.
        // @see chat-stream.service.ts acquireStreamLock — F6-FIX throws the tagged error.
        const { errorMsg, blockedConvId, blockedConvTitle } = parseBlockedByError(
          rawErrorMsg,
          get().conversations
        )

        const { activeConversation: conv } = get()
        if (conv) {
          // MULTI-CHAT-04: When blocked by another chat, show an actionable banner
          // with "Switch to it" and "Stop it" buttons instead of a plain error message.
          if (blockedConvId) {
            set((state) => ({
              blockedByBanner: {
                blockedConvId,
                blockedConvTitle,
                retryText: text,
                retryAttachments: attachments,
                // MULTI-CHAT-06: Track optimistic message for cleanup on dismiss/retry
                optimisticMessageId: optimisticMessage.id
              },
              ...buildStreamingResetState(conv.id, state.streamingConversationIds)
            }))
          } else {
            const errMessage = createErrorMessage(conv.id, errorMsg)
            set((state) => ({
              messages: [...state.messages, errMessage],
              ...buildStreamingResetState(conv.id, state.streamingConversationIds)
            }))
          }
        } else {
          set(buildStreamingResetState(null, get().streamingConversationIds))
        }
      }
    } catch (outerError) {
      // Unexpected error before IPC call (e.g., updateMode IPC fails, resetSafetyTimer errors)
      rendererLog.error('Failed to prepare message send:', outerError)
      set((state) => ({
        ...buildStreamingResetState(activeConversation.id, state.streamingConversationIds)
      }))
    } finally {
      clearTimeout(isSendingTimeout)
      set({ isSending: false })
    }
  },

  appendStreamChunk: (
    chunk: string,
    role?: 'specialist',
    taskId?: string,
    specialist?: string,
    requestId?: string
  ) => {
    appendStreamChunkAction(get, set, chunk, role, taskId, specialist, requestId)
  },

  handleKeepalive: (conversationId?: string) => {
    // Backend is alive — reset safety timer without processing any content.
    // Used when MCP tools block the SDK message loop for extended periods.
    // IMP-R5-1: Pass conversationId so the CORRECT conversation's timer is reset,
    // not the active one (which may have changed after a conv switch).
    internals.resetSafetyTimer(conversationId)
  },

  updateStreamingIdentity: (role, taskId?, specialist?) => {
    set((state) => ({
      streamingRole: role,
      streamingSpecialist: specialist ?? state.streamingSpecialist,
      streamingTaskId: taskId ?? state.streamingTaskId
    }))
  },

  // Note: No conversationId passed to recordChunkActivity — defaults to activeConversation.id.
  // This relies on the IPC routing guard at useAppIpcListeners.ts (bufferBackgroundChunk)
  // to ensure only foreground tool activities reach these actions.
  addToolActivity: (activity: ToolActivity) => {
    internals.resetSafetyTimer()
    internals.recordChunkActivity()  // STALL-DETECT-02: Tool activity is real activity
    internals.getOrCreateAccumulator().handleToolActivity(activity)
  },

  updateToolActivity: (activity: Partial<ToolActivity> & { toolName: string; id?: string }) => {
    internals.resetSafetyTimer()
    internals.recordChunkActivity()  // STALL-DETECT-02: Tool activity is real activity
    internals
      .getOrCreateAccumulator()
      .handleToolActivity(activity as Partial<ToolActivity> & { id: string; toolName: string })
  },

  finalizeStream: (messageId: string, taskId?: string, requestId?: string) => {
    finalizeStreamAction(get, set, messageId, taskId, requestId)
  },

  finalizeTurnBubble: (
    turnId: string,
    turnRole?: 'specialist',
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

  // MULTI-CHAT-04: Blocked-by banner actions
  switchToBlockingChat: async () => {
    const { blockedByBanner, selectConversation } = get()
    if (!blockedByBanner) return
    const targetConvId = blockedByBanner.blockedConvId
    const optimisticId = blockedByBanner.optimisticMessageId
    // MULTI-CHAT-06: Remove the unsent optimistic message before switching away
    set((state) => ({
      blockedByBanner: null,
      messages: optimisticId
        ? state.messages.filter((m) => m.id !== optimisticId)
        : state.messages
    }))
    await selectConversation(targetConvId)
  },

  stopBlockingChat: async () => {
    const { blockedByBanner, sendMessage } = get()
    if (!blockedByBanner) return
    const { blockedConvId, retryText, retryAttachments, optimisticMessageId } = blockedByBanner
    // MULTI-CHAT-06: Remove old optimistic message — sendMessage will create a fresh one on retry
    set((state) => ({
      blockedByBanner: null,
      messages: optimisticMessageId
        ? state.messages.filter((m) => m.id !== optimisticMessageId)
        : state.messages
    }))
    // Stop the blocking chat, then auto-retry the original message
    try {
      await window.api.stopGeneration(blockedConvId)
      // Small delay for the backend to settle before retrying
      await new Promise((r) => setTimeout(r, 300))
      await sendMessage(retryText, retryAttachments)
    } catch (err) {
      rendererLog.error('Failed to stop blocking chat and retry:', err)
      get().appendLocalMessage(
        '⚠️ Failed to stop the other chat and retry. Please try again manually.',
        { role: 'specialist' }
      )
    }
  },

  dismissBlockedBy: () => {
    const { blockedByBanner } = get()
    if (!blockedByBanner) return
    // MULTI-CHAT-06: Remove the optimistic user message that was never sent to backend
    const optimisticId = blockedByBanner.optimisticMessageId
    set((state) => ({
      blockedByBanner: null,
      messages: optimisticId
        ? state.messages.filter((m) => m.id !== optimisticId)
        : state.messages
    }))
  },

  continuePastTurnLimit: () => {
    const { activeConversation, isStreaming, isSending } = get()
    if (!activeConversation || isStreaming || isSending) return
    set({ turnLimitReached: null })
    void get().sendMessage('Continue where you left off. Do not repeat completed work.')
  },

  dismissTurnLimit: () => set({ turnLimitReached: null }),

  // STALL-DETECT-03: Dismiss stall detection banner
  dismissStallBanner: () => set({ streamStalledConversationId: null }),

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

    // MULTI-CHAT-06: Clean up per-conversation timers and stashed streaming state
    internals.clearSafetyTimer(activeConversation.id)

    // Remove conversation from state (it's been deleted in DB)
    const newConversations = conversations.filter((c) => c.id !== activeConversation.id)
    set((state) => {
      const streams = new Map(state.conversationStreams)
      streams.delete(activeConversation.id)
      // MULTI-CHAT-06: Remove completed conversation from streaming tracking set
      const newStreamingIds = new Set(state.streamingConversationIds)
      newStreamingIds.delete(activeConversation.id)
      return {
        conversations: newConversations,
        conversationStreams: streams,
        streamingConversationIds: newStreamingIds,
        activeConversation: null,
        messages: [],
        streamingContent: '',
        streamingSegments: [],
        // BUG-R5-1: Active conv is being completed and set to null — no foreground
        // stream remains. isStreaming: false is correct since activeConversation becomes null.
        isStreaming: false,
        toolActivities: [],
        // STALL-DETECT-05: Defense-in-depth — clear stall flag on conversation completion
        streamStalledConversationId: null,
        // GAP-R7-2: Clear remaining ephemeral state on conversation completion.
        // activeConversation: null guards most UI, but these prevent stale
        // state from leaking into the next conversation create/select.
        activeRequestId: null,
        streamingPhase: null,
        streamingSpecialist: null,
        streamingTaskId: null,
        pendingQuestions: null,
        pendingQuestionAction: null,
        pendingQuestionRequestId: null,
        compactSuggestion: null,
        budgetCapBanner: null,
        blockedByBanner: null,
        turnLimitReached: null,
        conversationState: { phase: 'idle' as const, from: null, event: null, conversationId: null }
      }
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
    // MULTI-CHAT-06: Clean up per-conversation timers and stashed streaming state
    internals.clearSafetyTimer(id)
    const { activeConversation, conversations } = get()
    const newConversations = conversations.filter((c) => c.id !== id)
    set((state) => {
      const streams = new Map(state.conversationStreams)
      streams.delete(id)
      // MULTI-CHAT-06: Remove closed conversation from streaming tracking set
      const newStreamingIds = new Set(state.streamingConversationIds)
      newStreamingIds.delete(id)
      return {
        conversations: newConversations,
        conversationStreams: streams,
        streamingConversationIds: newStreamingIds,
        // BUG-R5-1: isStreaming reflects the ACTIVE conversation only.
        // If closing active conv → false. If closing background conv → keep current.
        isStreaming: activeConversation?.id === id ? false : state.isStreaming,
        activeConversation: activeConversation?.id === id ? null : activeConversation,
        messages: activeConversation?.id === id ? [] : state.messages,
        // CONV-CLOSE-STREAMING-01: Clear streaming state to prevent stale isStreaming
        // lock and ghost streaming bubbles when a conversation is closed mid-stream.
        ...(activeConversation?.id === id
          ? {
              streamingContent: '',
              streamingSegments: [],
              activeRequestId: null,
              toolActivities: [],
              // STALL-DETECT-05: Defense-in-depth — clear stall flag alongside streaming state
              streamStalledConversationId: null,
              // CONV-CLOSE-ASKUSER-01: Clear pending questions when closing a conversation
              pendingQuestions: null,
              pendingQuestionAction: null,
              pendingQuestionRequestId: null,
              // GAP-R7-3: Clear remaining ephemeral state when closing active conv.
              streamingPhase: null,
              streamingSpecialist: null,
              streamingTaskId: null,
              compactSuggestion: null,
              budgetCapBanner: null,
              blockedByBanner: null,
              turnLimitReached: null,
              isSending: false,  // IMP-R9-1: Prevent locked input after close during send
              conversationState: { phase: 'idle' as const, from: null, event: null, conversationId: null }
            }
          : {})
      }
    })
  },

  // General chat question actions (ask_user tool)
  setPendingQuestions: (questions, action, requestId) => {
    // Flush any accumulated streaming content into a committed message
    // BEFORE showing the question card. This preserves chronological ordering:
    // the agent's pre-question text appears before the user's answer.
    // FLUSH-ORDER-01: Flush the accumulator BEFORE reading state — matches the
    // pattern in finalizeStreamAction/finalizeTurnBubbleAction. Without this,
    // unflushed SentenceBuffer content wouldn't be visible in the store yet.
    internals.flushAccumulator()

    const {
      streamingContent,
      streamingSegments,
      streamingRole,
      streamingSpecialist,
      activeConversation,
      toolActivities
    } = get()

    if (
      activeConversation &&
      (streamingContent || streamingSegments.length > 0 || toolActivities.length > 0)
    ) {
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
          id: `pre-question-${Date.now()}`,
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
          toolActivities: mergedTools.length > 0 ? mergedTools : undefined
        }

        set((state) => ({
          messages: [...state.messages, message],
          streamingContent: '',
          streamingSegments: [],
          toolActivities: []
        }))
      }

      internals.resetAccumulator()
    }

    set({
      pendingQuestions: questions,
      pendingQuestionAction: action ?? null,
      pendingQuestionRequestId: requestId ?? null
    })
  },

  submitQuestionAnswers: (answers) => {
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

    const responseText = lines.join('\n')
    const requestId = get().pendingQuestionRequestId
    set({ pendingQuestions: null, pendingQuestionAction: null, pendingQuestionRequestId: null })

    // Show the user's answer as a message bubble for immediate visual feedback
    get().appendLocalMessage(responseText, { role: 'user' })

    // If requestId is present (CLI/IPC bridge backend), route through the bridge
    // so the control-actions MCP server's askUserAndWaitForResponse promise resolves.
    if (requestId) {
      window.api.respondToAskUser({ requestId, response: responseText }).catch((err) => {
        console.error('[submitQuestionAnswers] Failed to send ask_user response:', err)
        get().appendLocalMessage(
          '⚠️ Failed to send your answer to the agent. Try sending it as a message.',
          { role: 'specialist' }
        )
      })
    } else {
      // SDK backend fallback — send as new message
      get().sendMessage(responseText)
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
      role: opts?.role ?? 'specialist',
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
            phase: 'specialist-responding' as ConversationPhase,
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
      streamingRole: 'specialist' as const,
      streamingSpecialist: null,
      streamingTaskId: null,
      isStreaming: false,
      isSending: false,  // GAP-R8-1: Prevent locked input after workspace switch during send
      streamingConversationIds: new Set<string>(),
      conversationStreams: new Map(),
      activeRequestId: null,
      streamingPhase: null,
      toolActivities: [],
      compactSuggestion: null,
      pendingQuestions: null,
      pendingQuestionAction: null,
      pendingQuestionRequestId: null,
      budgetCapBanner: null,
      blockedByBanner: null,
      turnLimitReached: null,
      sessionRecovery: null,
      autoModeSwitchPill: null,
      draftTexts: {},
      contextUsages: {},
      effortLevels: {},
      streamStalledConversationId: null,
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
