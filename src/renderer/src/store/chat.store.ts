import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { rendererLog } from '@renderer/utils/logger'
import { detectPlanIntent } from '@renderer/utils/plan-intent-detector'
import { SentenceBuffer } from '@renderer/utils/sentence-buffer'
import { useWorkspaceStore } from './workspace.store'
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
  private buffer: SentenceBuffer | null = null
  private storeGet: (() => ChatState) | null = null
  private storeSet: ((partial: Partial<ChatState>) => void) | null = null

  /** Bind the Zustand get/set refs — called once during store creation */
  bind(get: () => ChatState, set: (partial: Partial<ChatState>) => void): void {
    this.storeGet = get
    this.storeSet = set
  }

  getOrCreateBuffer(): SentenceBuffer {
    if (!this.buffer) {
      this.buffer = new SentenceBuffer((sentences: string) => {
        const current = this.storeGet?.()
        if (current) {
          this.storeSet?.({ streamingContent: current.streamingContent + sentences })
        }
      })
    }
    return this.buffer
  }

  resetBuffer(): void {
    this.buffer?.reset()
  }

  /** Flush whatever's currently buffered without creating a buffer if none exists. */
  flushBuffer(): void {
    this.buffer?.flush()
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
    personaSpecialistId?: string
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
  finalizeStream: (
    messageId: string,
    taskId?: string,
    requestId?: string
  ) => void
  finalizeTurnBubble: (turnId: string) => void
  addToolActivity: (activity: ToolActivity) => void
  updateToolActivity: (activity: Partial<ToolActivity> & { toolName: string }) => void

  // Slash command actions
  clearDisplay: () => void
  appendLocalMessage: (content: string) => void

  // Compact suggestion
  setCompactSuggestion: (
    data: { level: string; inputTokens: number; breakdown?: ContextUsageBreakdown } | null
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
  compactSuggestion: previousChatState?.compactSuggestion ?? null,
  grillSession: previousChatState?.grillSession ?? null,
  pendingQuestions: previousChatState?.pendingQuestions ?? null,
  pendingQuestionAction: previousChatState?.pendingQuestionAction ?? null,
  autoModeSwitchPill: null,
  sessionRecovery: null,
  conversationState: previousChatState?.conversationState ?? {
    phase: 'idle',
    from: null,
    event: null,
    conversationId: null
  },
  draftTexts: previousChatState?.draftTexts ?? {},
  contextUsages: previousChatState?.contextUsages ?? {},

  // Bind internals refs for safety timer + sentence buffer (runs once on store creation)
  ...(() => {
    internals.bind(get, set)
    return {}
  })(),

  loadConversations: async (workspaceId: string) => {
    try {
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
    personaSpecialistId?: string
  ) => {
    const conversation = await window.api.createConversation({
      workspaceId,
      mode,
      title,
      personaSpecialistId
    })
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      activeConversation: conversation,
      messages: [],
      streamingContent: '',
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
      grillSession: null,
      compactSuggestion: null,
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
    internals.flushBuffer()
    internals.resetBuffer()

    const { streamingContent, streamingRole, streamingSpecialist, activeConversation } = get()

    try {
      await window.api.stopGeneration()
    } catch (error) {
      rendererLog.error('Failed to stop generation:', error)
    }

    // Preserve partial streaming content as a message with a "stopped" suffix
    if (streamingContent && activeConversation) {
      const stoppedMessage: Message = {
        id: `stopped-${Date.now()}`,
        conversationId: activeConversation.id,
        role: streamingRole,
        ...(streamingRole === 'specialist' && streamingSpecialist
          ? { agentId: streamingSpecialist }
          : {}),
        contentMd: streamingContent + '\n\n---\n\n⏹ *Generation stopped by user.*',
        attachmentsJson: '[]',
        createdAt: new Date().toISOString()
      }
      set((state) => ({
        messages: [...state.messages, stoppedMessage],
        streamingContent: '',
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
        isStreaming: false,
        toolActivities: [],
        activeRequestId: null,
        conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
      }))
    } else {
      set({
        isStreaming: false,
        streamingContent: '',
        toolActivities: [],
        activeRequestId: null,
        conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
      })
    }
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
      toolActivities: [],
      // activeRequestId is set AFTER the backend returns — see below.
      // This prevents the mismatch where renderer and backend generate different IDs.
      activeRequestId: null
    }))

    // Reset sentence buffer for new message
    internals.resetBuffer()

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
      set({
        isStreaming: false,
        conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
      })
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

    // If task changed, flush old buffer and reset
    if (isNewTask) {
      internals.flushBuffer()
      internals.resetBuffer()
    }

    // Update streaming metadata (non-content state) immediately
    set((state) => ({
      isStreaming: true, // Ensure streaming bubble renders for specialist chunks
      streamingPhase: role === 'specialist' ? 'specialist-executing' : 'da-vinci-responding',
      streamingContent: isNewTask ? '' : state.streamingContent,
      streamingRole: role ?? state.streamingRole,
      streamingSpecialist: specialist ?? state.streamingSpecialist,
      streamingTaskId: taskId ?? state.streamingTaskId
    }))

    // Push chunk into sentence buffer (will auto-flush on sentence boundaries)
    internals.getOrCreateBuffer().append(chunk)
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
    set((state) => ({
      toolActivities: [...state.toolActivities, activity]
    }))
  },

  updateToolActivity: (activity: Partial<ToolActivity> & { toolName: string; id?: string }) => {
    // Reset safety timer — tool completed, backend is active
    internals.resetSafetyTimer()
    set((state) => {
      // Find matching activity — by ID first (reliable), then by toolName (legacy fallback)
      const activities = [...state.toolActivities]
      for (let i = activities.length - 1; i >= 0; i--) {
        const isMatch = activity.id
          ? activities[i].id === activity.id
          : activities[i].toolName === activity.toolName && activities[i].status === 'running'
        if (isMatch) {
          activities[i] = {
            ...activities[i],
            ...activity,
            // Preserve existing input if update doesn't provide one
            input: activity.input ?? activities[i].input,
            // If elapsedSeconds is provided but no explicit status change, keep current status
            status:
              activity.status ??
              (activity.elapsedSeconds !== undefined ? activities[i].status : 'completed'),
            // Preserve elapsedSeconds for progress display
            elapsedSeconds: activity.elapsedSeconds ?? activities[i].elapsedSeconds
          }
          break
        }
      }
      return { toolActivities: activities }
    })
  },

  finalizeStream: (messageId: string, taskId?: string, requestId?: string) => {
    // Force-flush any remaining buffered content before finalizing
    internals.flushBuffer()
    internals.resetBuffer()

    const activeRequestId = get().activeRequestId
    if (activeRequestId && requestId && requestId !== activeRequestId) return

    // Clear safety timer on normal stream completion (only on final complete, not per-task)
    if (!taskId) {
      internals.clearSafetyTimer()
    }

    const { streamingContent, streamingRole, streamingSpecialist, activeConversation } = get()

    // Guard: generalist's CHAT_MESSAGE_COMPLETE arrived while specialist is mid-stream.
    // Skip finalization so specialist content isn't captured under the wrong identity.
    if (!taskId && streamingRole === 'specialist' && streamingSpecialist) {
      rendererLog.info('[finalizeStream] Generalist complete during specialist streaming — skipping')
      return
    }

    if (streamingContent && activeConversation) {
      // Safety net: force-complete any tools still marked as "running" — ensures
      // no tool dots stay yellow/running after the stream ends, even if a tool_result was lost.
      const currentToolActivities = get().toolActivities.map((a) =>
        a.status === 'running' ? { ...a, status: 'completed' as const, completedAt: Date.now() } : a
      )
      const finalMessage: Message = {
        id: messageId,
        conversationId: activeConversation.id,
        role: streamingRole,
        // Attach specialist agentId so MessageBubble can resolve the correct identity
        ...(streamingRole === 'specialist' && streamingSpecialist
          ? { agentId: streamingSpecialist }
          : {}),
        contentMd: streamingContent,
        attachmentsJson: '[]',
        createdAt: new Date().toISOString(),
        toolActivities: currentToolActivities.length > 0 ? [...currentToolActivities] : undefined
      }

      set((state) => ({
        messages: [...state.messages, finalMessage],
        streamingContent: '',
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
      set({ streamingContent: '', streamingTaskId: null })
    } else if (activeConversation) {
      // No streaming content received — reload messages from DB
      // The backend saved a message (possibly an error or "No response received")
      window.api
        .getMessages({ conversationId: activeConversation.id })
        .then((dbMessages) => {
          // Guard: don't replace existing messages with empty DB result
          // This prevents data loss from DB lock contention or timing issues
          const currentMessages = get()?.messages ?? []
          set({
            messages: dbMessages.length > 0 ? dbMessages : currentMessages,
            streamingContent: '',
            isStreaming: false,
            activeRequestId: null,
            toolActivities: [],
            streamingTaskId: null
          })
        })
        .catch((error) => {
          rendererLog.error('Failed to reload messages after stream finalize:', error)
          set({
            streamingContent: '',
            isStreaming: false,
            activeRequestId: null,
            toolActivities: [],
            streamingTaskId: null
          })
        })
    } else {
      set({
        streamingContent: '',
        isStreaming: false,
        activeRequestId: null,
        toolActivities: [],
        streamingTaskId: null
      })
    }
  },

  finalizeTurnBubble: (turnId: string) => {
    const {
      streamingContent,
      streamingRole,
      streamingSpecialist,
      activeConversation,
      toolActivities
    } = get()

    // Nothing to finalize — agent went straight to tools without text
    if (!streamingContent && toolActivities.length === 0) return

    if (activeConversation) {
      const turnMessage: Message = {
        id: turnId,
        conversationId: activeConversation.id,
        role: streamingRole,
        ...(streamingRole === 'specialist' && streamingSpecialist
          ? { agentId: streamingSpecialist }
          : {}),
        contentMd: streamingContent,
        attachmentsJson: '[]',
        createdAt: new Date().toISOString(),
        // Snapshot current tool activities into this bubble
        toolActivities:
          toolActivities.length > 0
            ? toolActivities.map((a) => ({
                ...a,
                status: a.status === 'running' ? ('completed' as const) : a.status
              }))
            : undefined
      }

      set((state) => ({
        messages: [...state.messages, turnMessage],
        streamingContent: '', // Reset for next turn
        toolActivities: [], // Reset tools for next turn
        isStreaming: true // Stay in streaming mode
      }))
    }
  },

  clearAutoModeSwitchPill: () => set({ autoModeSwitchPill: null }),

  setSessionRecovery: (data) => set({ sessionRecovery: data }),

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
          window.api
            .swapToSpecialist({ workspaceId })
            .catch((err) => rendererLog.error('swapToSpecialist failed:', err))
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
    set({ messages: [], streamingContent: '', toolActivities: [] })
  },

  appendLocalMessage: (content: string) => {
    const { activeConversation } = get()
    if (!activeConversation) return

    const localMessage: Message = {
      id: `local-${Date.now()}`,
      conversationId: activeConversation.id,
      role: 'da-vinci',
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
    set({
      conversations: [],
      activeConversation: null,
      messages: [],
      streamingContent: '',
      streamingRole: 'da-vinci' as const,
      streamingSpecialist: null,
      isStreaming: false,
      activeRequestId: null,
      toolActivities: [],
      compactSuggestion: null,
      grillSession: null,
      pendingQuestions: null,
      pendingQuestionAction: null,
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
