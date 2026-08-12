import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { rendererLog } from '@renderer/utils/logger'
import { detectPlanIntent, detectComplexTask } from '@renderer/utils/plan-intent-detector'
import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'
import { useWorkspaceStore } from './workspace.store'
import { useTodoStore } from './todo.store'
import { usePlanExecutionStore } from './plan-execution.store'
import type { PhaseStatus } from './plan-execution.store'
import {
  streamingInternals as internals,
  appendStreamChunkAction,
  finalizeStreamAction,
  finalizeTurnBubbleAction,
  flushStreamingIntoMessage
} from './chat-streaming.actions'
import {
  buildStreamingResetState,
  mergeChatSegments,
  createStoppedMessage,
  createOptimisticUserMessage,
  createErrorMessage,
  parseBlockedByError,
  emptyStreamState,
  reconcileStopState,
  reconcileBootStreamingState,
  partitionStreamsForWorkspaceSwitch
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
  PendingPermission,
  PermissionOutcome,
  ThinkingEffort,
  ToolActivity
} from '../../../shared/types'
import {
  PERMISSION_CANCELLED_MESSAGE,
  PERMISSION_TIMEOUT_MESSAGE
} from '../../../shared/permission-messages'

/**
 * An inline tool-permission prompt and what the user did with it.
 *
 * The card deliberately survives its own resolution: it flips to "waiting" and
 * is only cleared when the stream actually moves again (finalizeStream). A
 * broken approval therefore reads as a card stuck on "waiting" rather than as
 * an empty chat.
 */
export interface PendingToolPermission {
  permission: PendingPermission
  decision: 'pending' | 'approved' | 'denied'
}

// ChatStreamingInternals + internals singleton are in ./chat-streaming.actions.ts

// Re-export for consumers that import from chat.store
export type { PerConversationStreamState } from './chat-action-utils'

export interface ChatState {
  conversations: Conversation[]
  activeConversation: Conversation | null
  /**
   * All messages for the active conversation, including hidden (auto-sent) ones.
   * Consumers that display or count messages for the user MUST filter with `!m.hidden`.
   * Hidden messages are kept because plan detection and LLM context reconstruction need them.
   */
  messages: Message[]
  streamingContent: string
  streamingRole: 'specialist'
  streamingSpecialist: string | null
  streamingTaskId: string | null
  isStreaming: boolean
  /** SEND-RACE-02: Per-conversation send mutex — replaces the global isSending boolean.
   *  Tracks which conversations have an IPC send in-flight. Phase 2 ready. */
  sendingConversationIds: Set<string>
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

  /** Inline tool-permission prompt for the active conversation (null = none). */
  pendingToolPermission: PendingToolPermission | null

  /** Retry offer after a permission died with its turn (null = none). */
  permissionRetry: { conversationId: string; retryText: string } | null

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
    sourceAuditRunId?: string,
    branchName?: string,
    autoBranch?: boolean,
    /** Take the branch from its current holder — explicit user confirmation only. */
    takeover?: boolean
  ) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  updateMode: (mode: ConversationMode) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  stopGeneration: () => Promise<void>
  sendMessage: (
    text: string,
    attachments?: string[],
    options?: { hidden?: boolean; skipOptimizer?: boolean }
  ) => Promise<void>
  appendStreamChunk: (
    conversationId: string,
    chunk: string,
    role?: 'specialist',
    taskId?: string,
    specialist?: string,
    requestId?: string
  ) => void
  /** Reset safety timer without processing content — used by keepalive signals from backend. */
  handleKeepalive: (conversationId?: string) => void
  updateStreamingIdentity: (role: 'specialist', taskId?: string, specialist?: string) => void
  finalizeStream: (
    conversationId: string,
    messageId: string,
    taskId?: string,
    requestId?: string
  ) => void
  finalizeTurnBubble: (turnId: string, turnRole?: 'specialist', turnSpecialist?: string) => void
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

  // Inline tool permission actions
  setPendingToolPermission: (permission: PendingPermission) => void
  /**
   * A permission reached a terminal state elsewhere (the modal was clicked, the
   * turn was torn down, the CLI died). Marks the inline receipt on a decision
   * and clears it otherwise, so it never sits on "waiting for the agent to
   * continue…" for a turn that no longer exists.
   */
  resolvePermissionExternally: (data: {
    permissionId: string
    conversationId?: string
    outcome: PermissionOutcome
  }) => void

  /**
   * Re-send the last user message after a permission died with its turn. Retry
   * cannot mean "re-approve": the CLI child that owed the tool result is gone
   * and the requestId is meaningless, so this is a NEW turn.
   */
  retryAfterPermission: () => Promise<void>
  dismissPermissionRetry: () => void

  // Auto mode switch pill (e.g., build → plan on investigation prompts)
  autoModeSwitchPill: { from: ConversationMode; to: ConversationMode } | null
  clearAutoModeSwitchPill: () => void

  // /complete and /close actions
  completeConversation: (
    branchName: string,
    commitMessage: string,
    description: string,
    baseBranch?: string
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
    /** Preserve hidden/skipOptimizer so retry replays them */
    retryOptions?: { hidden?: boolean; skipOptimizer?: boolean }
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

  /**
   * BOOT-REHYDRATE: adopt streams main is already running. The renderer can
   * restart on its own (crash auto-reload, RewindDialog reload) while main and
   * its streams survive — without this the boot state claims nothing is running.
   */
  rehydrateStreamingState: () => Promise<void>

  /**
   * Workspace switch — clear the previous workspace's view state WITHOUT
   * dropping conversations that are still streaming in the background.
   * Mirrors blueprint.store's resetForWorkspaceSwitch.
   */
  resetForWorkspaceSwitch: () => void

  reset: () => void
}

// SWITCH-GENERATION: Monotonic counter for selectConversation de-duplication.
// Each call captures the current value; after every await, if it has changed
// another selectConversation superseded this one → bail immediately.
let switchGeneration = 0

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
  sendingConversationIds: new Set<string>(),
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
  pendingToolPermission: previousChatState?.pendingToolPermission ?? null,
  permissionRetry: null,
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
    // GAP-A-FIX: Coordinate with selectConversation / createConversation via switchGeneration.
    // Without this, a rapid workspace switch (A→B→A) or a selectConversation during
    // the getConversations IPC can cause stale data to overwrite the current state,
    // clobbering conversationStreams or showing the wrong conversation list.
    const myGeneration = ++switchGeneration
    try {
      // Detect workspace switch — clear stale chat state from previous workspace.
      // Without this, activeConversation + messages from the old workspace leak
      // into the new workspace's ChatPanel until the user explicitly selects a
      // conversation (or creates one).
      const { activeConversation } = get()
      if (activeConversation && activeConversation.workspaceId !== workspaceId) {
        // BACKGROUND-CHAT-01: view-state-only reset — a conversation still
        // streaming in the previous workspace keeps its buffer and indicators.
        get().resetForWorkspaceSwitch()
      }

      const conversations = await window.api.getConversations({ workspaceId })
      // GAP-A-FIX: Bail if a selectConversation, createConversation, or another
      // loadConversations superseded this one while we awaited the IPC round-trip.
      if (switchGeneration !== myGeneration) return
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
        // BACKGROUND-CHAT-01: conversationStreams is NOT cleared here — background
        // streams from another workspace must keep accumulating. Finished entries
        // are dropped by resetForWorkspaceSwitch().
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
    sourceAuditRunId?: string,
    branchName?: string,
    autoBranch?: boolean,
    takeover?: boolean
  ) => {
    // BUG-A-FIX: Coordinate with selectConversation via switchGeneration.
    // Without this, a rapid selectConversation during the async createConversation
    // IPC causes a brief flash of the wrong conversation.
    const myGeneration = ++switchGeneration
    const conversation = await window.api.createConversation({
      workspaceId,
      mode,
      title,
      personaSpecialistId,
      llmProvider,
      routingOverrides,
      mcpOverrides,
      communicationTone,
      sourceAuditRunId,
      branchName,
      autoBranch,
      takeover
    })
    // BUG-A-FIX: Bail if a selectConversation (or another createConversation)
    // superseded this one while we awaited the IPC round-trip.
    if (switchGeneration !== myGeneration) return
    // PER-CONV-ACCUM: No stash needed — per-conversation buffers are always warm.
    // Just flush the previous conversation's accumulator so its buffer has the latest content.
    const prevConvId = get().activeConversation?.id
    if (prevConvId) {
      internals.flushAccumulator(prevConvId)
    }
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

    // SWITCH-GENERATION: Capture a monotonic counter so we can detect if a
    // newer selectConversation call superseded this one after any await.
    const myGeneration = ++switchGeneration

    // MSG-RELOAD-01: Bump generation so any in-flight DB reload from a previous
    // conversation is discarded instead of overwriting this conversation's messages.
    internals.bumpGeneration()
    // PER-CONV-ACCUM: No stash/restore needed — per-conversation buffers are always warm.
    // Just flush the previous conversation's accumulator so its buffer has the latest content.
    const prevConvId = get().activeConversation?.id
    if (prevConvId && prevConvId !== id) {
      internals.flushAccumulator(prevConvId)
    }

    const messages = await window.api.getMessages({ conversationId: id })

    // SWITCH-GENERATION: Bail if another selectConversation landed while we awaited.
    if (switchGeneration !== myGeneration) return

    // PER-CONV-ACCUM: Read from the always-warm per-conversation buffer
    const buffer = get().conversationStreams.get(id)
    const hasBufferedStreaming = buffer?.isStreaming ?? false

    // Query backend for authoritative streaming state
    let isConversationStillStreaming = hasBufferedStreaming
    let restoredRequestId: string | null = buffer?.activeRequestId ?? null
    try {
      const backendState = await window.api.getStreamingState()
      const convStream = backendState.streams?.find((s) => s.conversationId === id)
      // BUG-R7-1: Backend is authoritative when query succeeds
      isConversationStillStreaming = !!convStream
      if (convStream) {
        restoredRequestId = convStream.requestId
      }
    } catch {
      // If backend query fails, use buffer state as fallback
    }

    // SWITCH-GENERATION: Bail if superseded during getStreamingState.
    if (switchGeneration !== myGeneration) return

    // PER-CONV-ACCUM: Project from always-warm buffer (or empty if no buffer)
    const restored = isConversationStillStreaming && buffer ? buffer : emptyStreamState()
    // BUG-R8-1: Detect re-selection (selecting the already-active conversation)
    const isReselection = get().activeConversation?.id === id

    set((state) => ({
      activeConversation: conversation,
      messages,
      // PER-CONV-ACCUM: Do NOT delete the buffer on switch-to — it stays warm.
      // Chunks arriving during the async gap were written to the buffer, not lost.
      // Project buffer → globals
      streamingContent: isConversationStillStreaming ? restored.streamingContent : '',
      streamingSegments: isConversationStillStreaming ? restored.streamingSegments : [],
      streamingRole: restored.streamingRole,
      streamingSpecialist: restored.streamingSpecialist,
      streamingTaskId: restored.streamingTaskId,
      streamingPhase: restored.streamingPhase,
      toolActivities: isConversationStillStreaming ? restored.toolActivities : [],
      isStreaming: isConversationStillStreaming,
      activeRequestId: isConversationStillStreaming ? restoredRequestId : null,
      // Clear ephemeral UI state from previous conversation
      compactSuggestion: null,
      budgetCapBanner: null,
      blockedByBanner: null,
      turnLimitReached: null,
      permissionRetry: null,
      streamStalledConversationId: null,
      // The inline permission card belongs to one conversation — keep it only
      // when that conversation is the one being shown.
      pendingToolPermission:
        state.pendingToolPermission?.permission.conversationId === id
          ? state.pendingToolPermission
          : null,
      pendingQuestions: isConversationStillStreaming
        ? (restored.pendingQuestions ?? (isReselection ? state.pendingQuestions : null))
        : null,
      pendingQuestionAction: isConversationStillStreaming
        ? (restored.pendingQuestionAction ?? (isReselection ? state.pendingQuestionAction : null))
        : null,
      pendingQuestionRequestId: isConversationStillStreaming
        ? (restored.pendingQuestionRequestId ??
          (isReselection ? state.pendingQuestionRequestId : null))
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
    }))

    // CLI mode sync is deferred — will happen automatically on next message send
    // No need to restart the CLI process just because the user switched conversations

    // Branch-per-conversation: switch git branch if conversation has one
    if (conversation.branchName) {
      try {
        const result = await window.api.switchBranch({ conversationId: id })
        if (switchGeneration !== myGeneration) return
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

    // SWITCH-GENERATION: Bail if superseded during branch switch
    if (switchGeneration !== myGeneration) return

    // Load persisted todos for the selected conversation
    try {
      const persistedTodos = await window.api.getTodos({ conversationId: id })
      if (switchGeneration !== myGeneration) return
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
    } catch {
      /* non-critical — todos are ephemeral fallback */
    }

    // SWITCH-GENERATION: Bail if superseded during todo load
    if (switchGeneration !== myGeneration) return

    // Load persisted phase progress for the selected conversation
    try {
      const phaseData = await window.api.getPhaseProgress({ conversationId: id })
      if (switchGeneration !== myGeneration) return
      if (phaseData && phaseData.progress.length > 0) {
        const { startExecution, updatePhase, updateTask, markFileTouched } =
          usePlanExecutionStore.getState()
        startExecution(id, {
          planId: phaseData.planId,
          title: phaseData.planTitle,
          planGoal: phaseData.planGoal,
          phases: phaseData.phases,
          phaseFiles: phaseData.phaseFiles
        })
        for (const p of phaseData.progress) {
          updatePhase(id, {
            phaseId: p.phaseId,
            phaseTitle:
              phaseData.phases.find((ph) => ph.id === p.phaseId)?.title ?? `Phase ${p.phaseId}`,
            status: p.status as PhaseStatus['status'],
            totalPhases: phaseData.phases.length
          })
          // Hydrate touchedFiles from persisted data
          if (p.touchedFiles && p.touchedFiles.length > 0) {
            for (const file of p.touchedFiles) {
              markFileTouched(id, file)
            }
          }
          // Hydrate task progress from persisted data
          if (p.tasks && p.tasks.length > 0) {
            for (const t of p.tasks) {
              updateTask(id, {
                phaseId: p.phaseId,
                taskId: t.taskId,
                title: t.title,
                status: t.status as 'pending' | 'running' | 'complete' | 'failed' | 'skipped'
              })
            }
          }
        }
      }
    } catch {
      /* non-critical */
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
    // Flush the active conversation's accumulator before stopping
    const activeConvId = get().activeConversation?.id
    internals.flushAccumulator(activeConvId)

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

      // WEDGE-ESCALATION: Stop only unwinds a stream that is actually running.
      // When the busy state outlived its stream, stop is a no-op and main keeps
      // rejecting sends with "already being processed" — leaving the user with
      // no way out short of restarting. If main still reports this chat busy
      // after a stop, escalate to the explicit force-release.
      if (activeConversation?.id) {
        const state = await window.api.getStreamingState().catch(() => null)
        const stillBusy = state?.streams?.some((s) => s.conversationId === activeConversation.id)
        if (stillBusy) {
          rendererLog.warn(
            `[STOP-ESCALATE] main still reports ${activeConversation.id.slice(0, 12)} busy after stop — force-releasing`
          )
          await window.api.forceReleaseConversation(activeConversation.id)
        }
      }
    } catch (error) {
      rendererLog.error('Failed to stop generation:', error)
    }

    // GAP-B-FIX: Bail if the user switched conversations during the stopGeneration
    // IPC round-trip. Without this, the "⏹ Stopped" message gets appended to the
    // wrong conversation's message list (a phantom message that corrects on DB reload).
    if (activeConversation?.id !== get().activeConversation?.id) return

    // PER-CONV-ACCUM helper: clean up the conversation buffer alongside globals
    const cleanupBuffer = (
      state: ChatState
    ): { conversationStreams: Map<string, PerConversationStreamState> } => {
      if (!activeConversation) return { conversationStreams: state.conversationStreams }
      const streams = new Map(state.conversationStreams)
      streams.delete(activeConversation.id)
      return { conversationStreams: streams }
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
        ...cleanupBuffer(state),
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
        ...cleanupBuffer(state),
        pendingQuestions: null,
        pendingQuestionAction: null,
        pendingQuestionRequestId: null
      }))
    } else {
      set({
        ...buildStreamingResetState(null, get().streamingConversationIds),
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
    internals.resetAccumulator(activeConvId)

    // WEDGE-RECOVERY: Stop must always be able to un-stick the input — see
    // reconcileStopState for the rule (and its tests).
    const reconciled = await reconcileStopState(
      () => window.api.getStreamingState(),
      () => get().sendingConversationIds,
      activeConvId,
      (error) => rendererLog.warn('[stopGeneration] Streaming-state reconcile failed:', error)
    )
    if (reconciled) set(reconciled)

    // WEDGE-FIX: Stop is the user's escape hatch and must never be conditional
    // on main agreeing. The reconcile above declines whenever main still reports
    // this conversation busy (or the query failed) — exactly the wedged case the
    // user is trying to escape. CHAT_FORCE_RELEASE above already force-releases
    // main's lock, so the renderer flag follows unconditionally.
    if (activeConvId) {
      const stillSending = get().sendingConversationIds
      if (stillSending.has(activeConvId)) {
        const released = new Set(stillSending)
        released.delete(activeConvId)
        set({ sendingConversationIds: released })
      }
    }
  },

  sendMessage: async (
    text: string,
    attachments?: string[],
    options?: { hidden?: boolean; skipOptimizer?: boolean }
  ) => {
    const {
      activeConversation,
      updateMode,
      isStreaming: alreadyStreaming,
      sendingConversationIds
    } = get()
    // SEND-RACE-02: Per-conversation send guard. Prevents rapid double-clicks from
    // bypassing the isStreaming check (stale React closure). Phase 2 ready:
    // only blocks sends on the SAME conversation, not globally.
    if (
      !activeConversation ||
      alreadyStreaming ||
      sendingConversationIds.has(activeConversation.id)
    )
      return
    set({
      sendingConversationIds: new Set([...sendingConversationIds, activeConversation.id]),
      // SEND-ASKUSER-01: Clear stale pending questions so the card doesn't persist alongside new stream
      pendingQuestions: null,
      pendingQuestionAction: null,
      pendingQuestionRequestId: null
    })

    // SEND-SAFETY-TIMEOUT: Auto-reset sendingConversationIds if it stays set for >30s
    // (covers IPC hangs or missed resets from unexpected errors).
    //
    // SEND-SAFETY-RECONCILE: clearing blind desyncs the renderer from main —
    // main's own gate (streamingLocks + state machine) releases no earlier than
    // its 5-min inactivity timer, and keepalive ticks keep resetting that while
    // a stream is nominally alive. Re-enabling the composer at 30s therefore
    // just produces "A message is already being processed" rejections. Only
    // release once main confirms it is idle; otherwise leave the flag set —
    // MessageInput keeps the Stop button visible while `isSending` is true,
    // which is the escape hatch (CHAT_STOP force-releases main's lock).
    const convId = activeConversation.id
    const isSendingTimeout = setTimeout(() => {
      void (async () => {
        if (!get().sendingConversationIds.has(convId)) return
        const reconciled = await reconcileStopState(
          () => window.api.getStreamingState(),
          () => get().sendingConversationIds,
          convId,
          (error) => rendererLog.warn('[SEND-SAFETY] reconcile failed:', error)
        )
        if (reconciled) {
          rendererLog.warn(
            `[SEND-SAFETY] stuck for 30s and main is idle — releasing ${convId.slice(0, 12)}`
          )
          set(reconciled)
        } else {
          rendererLog.warn(
            `[SEND-SAFETY] stuck for 30s but main still streaming — keeping ${convId.slice(0, 12)} disabled (Stop available)`
          )
        }
      })()
    }, 30_000)

    // GAP-C-FIX: Capture switchGeneration so we can detect if selectConversation
    // fires during the async updateMode() gap below.
    const myGeneration = switchGeneration

    try {
      // MSG-RELOAD-01: Bump generation so any in-flight DB reload is discarded
      internals.bumpGeneration()

      // Auto-detect plan intent in build mode → switch to plan
      if (
        activeConversation.mode === 'build' &&
        (detectPlanIntent(text) || detectComplexTask(text))
      ) {
        await updateMode('plan')
        // GAP-C-FIX: Bail if selectConversation (or createConversation) fired during
        // updateMode. Without this, streamingConversationIds would contain the wrong
        // conversation ID and the sidebar streaming badge would appear on the old conv.
        if (switchGeneration !== myGeneration) return
      }

      const isHidden = options?.hidden === true
      const optimisticMessage = isHidden
        ? null
        : createOptimisticUserMessage(activeConversation.id, text, attachments)

      set((state) => ({
        // MULTI-CHAT-06: Remove stale optimistic message from a previous blocked-by attempt
        // before appending the new one (edge case: blocking conv finishes naturally, user re-sends)
        messages: optimisticMessage
          ? [
              ...state.messages.filter((m) => m.id !== state.blockedByBanner?.optimisticMessageId),
              optimisticMessage
            ]
          : state.messages.filter((m) => m.id !== state.blockedByBanner?.optimisticMessageId),
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
        streamingConversationIds: new Set([
          ...state.streamingConversationIds,
          activeConversation.id
        ])
      }))

      // Reset segment accumulator for new message
      internals.resetAccumulator(activeConversation.id)

      // Safety: force-reset if streaming state gets stuck (e.g., process dies without emitting complete)
      internals.resetSafetyTimer(activeConversation.id)

      try {
        const result = await window.api.sendMessage({
          conversationId: activeConversation.id,
          text,
          attachments,
          skipOptimizer: options?.skipOptimizer,
          hidden: options?.hidden
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
                retryOptions: options,
                // MULTI-CHAT-06: Track optimistic message for cleanup on dismiss/retry
                optimisticMessageId: optimisticMessage?.id
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
      const remaining = new Set(get().sendingConversationIds)
      remaining.delete(convId)
      set({ sendingConversationIds: remaining })
    }
  },

  appendStreamChunk: (
    conversationId: string,
    chunk: string,
    role?: 'specialist',
    taskId?: string,
    specialist?: string,
    requestId?: string
  ) => {
    appendStreamChunkAction(get, set, conversationId, chunk, role, taskId, specialist, requestId)
  },

  handleKeepalive: (conversationId?: string) => {
    // Backend is alive — reset safety timer without processing any content.
    // Used when MCP tools block the SDK message loop for extended periods.
    // IMP-R5-1: Pass conversationId so the CORRECT conversation's timer is reset,
    // not the active one (which may have changed after a conv switch).
    internals.resetSafetyTimer(conversationId)
  },

  updateStreamingIdentity: (role, taskId?, specialist?) => {
    const convId = get().activeConversation?.id
    set((state) => {
      const update: Partial<ChatState> = {
        streamingRole: role,
        streamingSpecialist: specialist ?? state.streamingSpecialist,
        streamingTaskId: taskId ?? state.streamingTaskId
      }
      // Also update the per-conversation buffer if it exists
      if (convId) {
        const streams = new Map(state.conversationStreams)
        const existing = streams.get(convId)
        if (existing) {
          streams.set(convId, {
            ...existing,
            streamingRole: role,
            streamingSpecialist: specialist ?? existing.streamingSpecialist,
            streamingTaskId: taskId ?? existing.streamingTaskId
          })
          update.conversationStreams = streams
        }
      }
      return update
    })
  },

  // PER-CONV-ACCUM: Tool activities are always for the active conversation.
  // Background tool activities are routed directly through the per-conv accumulator
  // in useAppIpcListeners.ts, never through these store actions.
  addToolActivity: (activity: ToolActivity) => {
    const convId = get().activeConversation?.id
    if (!convId) return // No active conversation — nothing to attach tool activity to
    internals.resetSafetyTimer(convId)
    internals.recordChunkActivity(convId) // STALL-DETECT-02: Tool activity is real activity
    internals.getOrCreateAccumulatorFor(convId).handleToolActivity(activity)
  },

  updateToolActivity: (activity: Partial<ToolActivity> & { toolName: string; id?: string }) => {
    const convId = get().activeConversation?.id
    if (!convId) return // No active conversation — nothing to update
    internals.resetSafetyTimer(convId)
    internals.recordChunkActivity(convId) // STALL-DETECT-02: Tool activity is real activity
    internals
      .getOrCreateAccumulatorFor(convId)
      .handleToolActivity(activity as Partial<ToolActivity> & { id: string; toolName: string })
  },

  finalizeStream: (
    conversationId: string,
    messageId: string,
    taskId?: string,
    requestId?: string
  ) => {
    finalizeStreamAction(get, set, conversationId, messageId, taskId, requestId)
  },

  finalizeTurnBubble: (turnId: string, turnRole?: 'specialist', turnSpecialist?: string) => {
    finalizeTurnBubbleAction(get, set, turnId, turnRole, turnSpecialist)
  },

  clearAutoModeSwitchPill: () => set({ autoModeSwitchPill: null }),

  setSessionRecovery: (data) => set({ sessionRecovery: data }),

  setBudgetCapBanner: (data) => set({ budgetCapBanner: data }),

  continuePastBudgetCap: async () => {
    const { budgetCapBanner, activeConversation, isStreaming, sendingConversationIds } = get()
    if (
      !budgetCapBanner ||
      !activeConversation ||
      isStreaming ||
      sendingConversationIds.has(activeConversation.id)
    )
      return
    set({ budgetCapBanner: null })
    void get().sendMessage('Continue where you left off.', undefined, {
      hidden: true,
      skipOptimizer: true
    })
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
      messages: optimisticId ? state.messages.filter((m) => m.id !== optimisticId) : state.messages
    }))
    await selectConversation(targetConvId)
  },

  stopBlockingChat: async () => {
    const { blockedByBanner, sendMessage } = get()
    if (!blockedByBanner) return
    // GAP-E-FIX: Capture target conversation before async gaps
    const targetConvId = get().activeConversation?.id
    const { blockedConvId, retryText, retryAttachments, retryOptions, optimisticMessageId } =
      blockedByBanner
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
      // GAP-E-FIX: Bail if user switched conversations during stop+settle
      if (targetConvId !== get().activeConversation?.id) return
      await sendMessage(retryText, retryAttachments, retryOptions)
    } catch (err) {
      rendererLog.error('Failed to stop blocking chat and retry:', err)
      // GAP-E-FIX: Only show error if still on the target conversation
      if (get().activeConversation?.id === targetConvId) {
        get().appendLocalMessage(
          '⚠️ Failed to stop the other chat and retry. Please try again manually.',
          { role: 'specialist' }
        )
      }
    }
  },

  dismissBlockedBy: () => {
    const { blockedByBanner } = get()
    if (!blockedByBanner) return
    // MULTI-CHAT-06: Remove the optimistic user message that was never sent to backend
    const optimisticId = blockedByBanner.optimisticMessageId
    set((state) => ({
      blockedByBanner: null,
      messages: optimisticId ? state.messages.filter((m) => m.id !== optimisticId) : state.messages
    }))
  },

  continuePastTurnLimit: () => {
    const { activeConversation, isStreaming, sendingConversationIds } = get()
    if (!activeConversation || isStreaming || sendingConversationIds.has(activeConversation.id))
      return
    set({ turnLimitReached: null })
    void get().sendMessage(
      'Continue where you left off. Do not repeat completed work.',
      undefined,
      { hidden: true, skipOptimizer: true }
    )
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

  completeConversation: async (
    branchName: string,
    commitMessage: string,
    description: string,
    baseBranch?: string
  ) => {
    const { activeConversation, conversations } = get()
    if (!activeConversation) throw new Error('No active conversation')

    const result = await window.api.completeConversation({
      conversationId: activeConversation.id,
      branchName,
      commitMessage,
      description,
      baseBranch
    })

    // PER-CONV-ACCUM: Clean up per-conversation accumulator, timers, and buffer
    internals.resetAccumulator(activeConversation.id)
    internals.clearSafetyTimer(activeConversation.id)

    // GAP-F-FIX: Check if user switched conversations during the git operation.
    // Always remove the completed conv from the list and clean up its streams,
    // but only null activeConversation/clear ephemeral state if still viewing it.
    const stillOnCompletedConv = get().activeConversation?.id === activeConversation.id

    // Remove conversation from state (it's been deleted in DB)
    const newConversations = conversations.filter((c) => c.id !== activeConversation.id)
    set((state) => {
      const streams = new Map(state.conversationStreams)
      streams.delete(activeConversation.id)
      // MULTI-CHAT-06: Remove completed conversation from streaming tracking set
      const newStreamingIds = new Set(state.streamingConversationIds)
      newStreamingIds.delete(activeConversation.id)

      // Always clean up the completed conversation from lists
      const baseUpdate = {
        conversations: newConversations,
        conversationStreams: streams,
        streamingConversationIds: newStreamingIds
      }

      // GAP-F-FIX: Only clear active conversation state if user hasn't switched away
      if (!stillOnCompletedConv) return baseUpdate

      return {
        ...baseUpdate,
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
    // PER-CONV-ACCUM: Clean up per-conversation accumulator, timers, and buffer
    internals.resetAccumulator(id)
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
              sendingConversationIds: new Set<string>(), // IMP-R9-1: Prevent locked input after close during send
              conversationState: {
                phase: 'idle' as const,
                from: null,
                event: null,
                conversationId: null
              }
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
    flushStreamingIntoMessage(get, set, 'pre-question')

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

  setPendingToolPermission: (permission) => {
    // Same ordering rule as the question card — commit the agent's pre-permission
    // text so the card renders below it, not above it.
    flushStreamingIntoMessage(get, set, 'pre-permission')
    set({ pendingToolPermission: { permission, decision: 'pending' } })
  },

  resolvePermissionExternally: ({ permissionId, conversationId, outcome }) => {
    const pending = get().pendingToolPermission
    const matchesCard = pending?.permission.id === permissionId

    if (outcome === 'approved' || outcome === 'denied') {
      // The modal decided; the card becomes the receipt. PERM-INLINE-01 in
      // finalizeStream clears it once the turn actually moves.
      if (matchesCard && pending) set({ pendingToolPermission: { ...pending, decision: outcome } })
      return
    }

    if (matchesCard) set({ pendingToolPermission: null })

    // Unanswered: say so in the transcript and offer a retry. Scoped to the
    // conversation that raised it so a background workspace cannot write into
    // the chat currently on screen.
    const activeId = get().activeConversation?.id
    if (!activeId) return
    if (conversationId && conversationId !== activeId && !matchesCard) return

    get().appendLocalMessage(
      outcome === 'timedout' ? PERMISSION_TIMEOUT_MESSAGE : PERMISSION_CANCELLED_MESSAGE
    )

    const lastUserText = [...get().messages].reverse().find((m) => m.role === 'user')?.contentMd
    if (lastUserText) {
      set({ permissionRetry: { conversationId: activeId, retryText: lastUserText } })
    }
  },

  retryAfterPermission: async () => {
    const retry = get().permissionRetry
    if (!retry) return
    set({ permissionRetry: null })
    // Guard against a conversation switch between click and send.
    if (get().activeConversation?.id !== retry.conversationId) return
    await get().sendMessage(retry.retryText)
  },

  dismissPermissionRetry: () => set({ permissionRetry: null }),

  setCompactSuggestion: (data) => set({ compactSuggestion: data }),

  clearDisplay: () => {
    set({
      messages: [],
      streamingContent: '',
      streamingSegments: [],
      toolActivities: [],
      pendingToolPermission: null
    })
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

  rehydrateStreamingState: async () => {
    let backendStreams: Array<{ conversationId: string; requestId: string }>
    try {
      const backendState = await window.api.getStreamingState()
      backendStreams = backendState.streams ?? []
    } catch (error) {
      // Same rule as reconcileStopState: never act on a failed query — the
      // local state is the only state we have.
      rendererLog.warn('[BOOT-REHYDRATE] Streaming-state query failed:', error)
      return
    }

    const patch = reconcileBootStreamingState(backendStreams, {
      streamingConversationIds: get().streamingConversationIds,
      conversationStreams: get().conversationStreams,
      activeConversationId: get().activeConversation?.id ?? null
    })
    if (!patch) return

    rendererLog.info(
      `[BOOT-REHYDRATE] Adopted ${backendStreams.length} stream(s) still running in main`
    )
    set(patch)
  },

  resetForWorkspaceSwitch: () => {
    // Flush the outgoing conversation's accumulator so its buffer holds the
    // latest chunks before we stop projecting it to the globals.
    const activeId = get().activeConversation?.id
    if (activeId) internals.flushAccumulator(activeId)

    const state = get()
    const { kept: keptStreams, dropped } = partitionStreamsForWorkspaceSwitch(
      state.conversationStreams
    )
    // Only finished conversations lose their accumulator + safety timer.
    for (const conversationId of dropped) {
      internals.resetAccumulator(conversationId)
      internals.clearSafetyTimer(conversationId)
    }

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
      sendingConversationIds: new Set(
        [...state.sendingConversationIds].filter((id) => keptStreams.has(id))
      ),
      streamingConversationIds: new Set(
        [...state.streamingConversationIds].filter((id) => keptStreams.has(id))
      ),
      conversationStreams: keptStreams,
      activeRequestId: null,
      streamingPhase: null,
      toolActivities: [],
      compactSuggestion: null,
      pendingQuestions: null,
      pendingQuestionAction: null,
      pendingQuestionRequestId: null,
      pendingToolPermission: null,
      permissionRetry: null,
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
      sendingConversationIds: new Set<string>(), // GAP-R8-1: Prevent locked input after workspace switch during send
      streamingConversationIds: new Set<string>(),
      conversationStreams: new Map(),
      activeRequestId: null,
      streamingPhase: null,
      toolActivities: [],
      compactSuggestion: null,
      pendingQuestions: null,
      pendingQuestionAction: null,
      pendingQuestionRequestId: null,
      pendingToolPermission: null,
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
  | 'rehydrateStreamingState'
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
      setEffort: s.setEffort,
      rehydrateStreamingState: s.rehydrateStreamingState
    }))
  )

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.chatStoreState = useChatStore.getState()
  })
}
