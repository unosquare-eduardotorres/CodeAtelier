import { useEffect } from 'react'
import {
  useChatStore,
  useChatActions,
  useWorkspaceStore,
  useAgentStore,
  useUpdateStore,
  useMemoryStore,
  useProfileStore,
  useAppPreferenceActions
} from '@renderer/store'
import type { ConversationPhase, ToolActivity } from '../../../shared/types'
import { rendererLog } from '@renderer/utils/logger'
import { useTodoStore } from '@renderer/store/todo.store'
import { useDiagnosticsStore } from '@renderer/store/diagnostics.store'
import { useHookLifecycleStore } from '@renderer/store/hook-lifecycle.store'
import { usePlanExecutionStore } from '@renderer/store/plan-execution.store'
import { streamingInternals } from '@renderer/store/chat-streaming.actions'

// ─── Type Aliases ─────────────────────────────────────────

type ChatActions = ReturnType<typeof useChatActions>

// ─── Pure Helpers ─────────────────────────────────────────

/** Derive context quality bucket from quality-window percentage. */
function getContextQualityLevel(qualityPct: number): 'green' | 'yellow' | 'red' | 'critical' {
  if (qualityPct > 80) return 'critical'
  if (qualityPct > 60) return 'red'
  if (qualityPct > 40) return 'yellow'
  return 'green'
}

/** Remove a conversation from the streaming tracking set (shared by complete + state-change). */
function removeStreamingConversation(conversationId: string): void {
  useChatStore.setState((state) => {
    if (!state.streamingConversationIds.has(conversationId)) return state
    const newSet = new Set(state.streamingConversationIds)
    newSet.delete(conversationId)
    return {
      streamingConversationIds: newSet,
      // BUG-R5-1: isStreaming reflects the ACTIVE conversation only.
      // A background stream completing shouldn't unlock/lock the active conv's input.
      isStreaming: state.activeConversation?.id ? newSet.has(state.activeConversation.id) : false
    }
  })
}

/**
 * BUG-R9-1: Buffer an ask_user event for a background conversation.
 * Without this, background ask_user events are dropped and the user
 * sees a stuck stream with no question card when switching back.
 * selectConversation restores pendingQuestions from the stash.
 */
function bufferBackgroundAskUser(
  conversationId: string,
  data: Parameters<Parameters<Window['api']['onAskQuestion']>[0]>[0]
): void {
  useChatStore.setState((state) => {
    const streams = new Map(state.conversationStreams)
    const existing = streams.get(conversationId) ?? {
      streamingContent: '',
      streamingSegments: [],
      streamingRole: 'specialist' as const,
      streamingSpecialist: null,
      streamingTaskId: null,
      streamingPhase: null,
      activeRequestId: null,
      isStreaming: true,
      toolActivities: [],
      pendingQuestions: null,
      pendingQuestionAction: null,
      pendingQuestionRequestId: null
    }

    streams.set(conversationId, {
      ...existing,
      pendingQuestions: data.questions,
      pendingQuestionAction: data.action ?? null,
      pendingQuestionRequestId: data.requestId ?? null
    })

    return { conversationStreams: streams }
  })
}

/**
 * MULTI-CHAT-06: Buffer a chunk for a background (non-active) conversation.
 * Appends text content and tool activity to the conversation's stashed state
 * so it's available when the user switches back.
 */
function bufferBackgroundChunk(
  data: Parameters<Parameters<Window['api']['onMessageChunk']>[0]>[0]
): void {
  const convId = data.conversationId
  if (!convId) return

  useChatStore.setState((state) => {
    const streams = new Map(state.conversationStreams)
    const existing = streams.get(convId) ?? {
      streamingContent: '',
      streamingSegments: [],
      streamingRole: 'specialist' as const,
      streamingSpecialist: null,
      streamingTaskId: null,
      streamingPhase: null,
      activeRequestId: null,
      isStreaming: true,
      toolActivities: [],
      pendingQuestions: null,
      pendingQuestionAction: null,
      pendingQuestionRequestId: null
    }

    // Append text chunk
    const updatedContent = data.chunk
      ? existing.streamingContent + data.chunk
      : existing.streamingContent

    // Update tool activity
    let updatedTools = existing.toolActivities
    if (data.toolActivity) {
      const ta = data.toolActivity
      const idx = updatedTools.findIndex((t) => t.id === ta.id)
      if (idx >= 0) {
        updatedTools = [...updatedTools]
        updatedTools[idx] = { ...updatedTools[idx], ...ta }
      } else {
        updatedTools = [...updatedTools, ta as ToolActivity]
      }
    }

    streams.set(convId, {
      ...existing,
      streamingContent: updatedContent,
      streamingRole: (data.role as 'specialist') ?? existing.streamingRole,
      streamingSpecialist: data.specialist ?? existing.streamingSpecialist,
      streamingTaskId: data.taskId ?? existing.streamingTaskId,
      activeRequestId: data.requestId ?? existing.activeRequestId,
      isStreaming: true,
      toolActivities: updatedTools
    })

    return { conversationStreams: streams }
  })
}

/** Route a tool-activity chunk to the correct add/update action. */
function processToolActivity(
  ta: {
    id: string
    toolName: string
    status: 'running' | 'completed' | 'error'
    startedAt?: number
    completedAt?: number
    elapsedSeconds?: number
  },
  addToolActivity: ChatActions['addToolActivity'],
  updateToolActivity: ChatActions['updateToolActivity']
): void {
  if (ta.elapsedSeconds !== undefined && ta.status === 'running') {
    updateToolActivity({ id: ta.id, toolName: ta.toolName, elapsedSeconds: ta.elapsedSeconds })
  } else if (ta.status === 'running') {
    addToolActivity({
      ...ta,
      status: 'running',
      startedAt: ta.startedAt ?? Date.now()
    } as ToolActivity)
  } else {
    updateToolActivity({ ...ta, completedAt: ta.completedAt ?? Date.now() })
  }
}

/** Dispatch a todo CRUD action to the todo store. */
function processTodoUpdate(
  conversationId: string,
  todoUpdate: { action: 'add' | 'complete' | 'remove' | 'update'; text: string; index?: number }
): void {
  const { addTodo, completeTodo, removeTodo, updateTodo } = useTodoStore.getState()
  switch (todoUpdate.action) {
    case 'add':
      addTodo(conversationId, todoUpdate.text, todoUpdate.index)
      break
    case 'complete':
      completeTodo(conversationId, todoUpdate.text, todoUpdate.index)
      break
    case 'remove':
      removeTodo(conversationId, todoUpdate.text, todoUpdate.index)
      break
    case 'update':
      updateTodo(conversationId, todoUpdate.text, todoUpdate.index)
      break
  }
}

/** Push live context-usage metrics into the chat store. */
function processContextUsageUpdate(
  conversationId: string,
  update: {
    inputTokens: number
    contextWindowSize: number
    percentage: number
    cacheHitRate?: number
  }
): void {
  const effectiveQualityWindow = Math.min(Math.round(update.contextWindowSize * 0.5), 500_000)
  const qualityPct = Math.round((update.inputTokens / effectiveQualityWindow) * 100)
  const level = getContextQualityLevel(qualityPct)

  useChatStore.setState((state) => ({
    contextUsages: {
      ...state.contextUsages,
      [conversationId]: {
        ...state.contextUsages[conversationId],
        conversationId,
        inputTokens: update.inputTokens,
        contextWindowSize: update.contextWindowSize,
        percentage: update.percentage,
        cacheHitRate: update.cacheHitRate,
        level
      }
    }
  }))
}

// ─── Compound IPC Handlers ────────────────────────────────

/** Process a single message chunk from the IPC stream. */
function handleMessageChunk(
  data: Parameters<Parameters<Window['api']['onMessageChunk']>[0]>[0],
  actions: ChatActions
): void {
  if (data.keepalive) {
    // IMP-R5-1: Pass conversationId so the CORRECT conversation's safety timer
    // is reset, not the currently active one (which may differ after a conv switch).
    actions.handleKeepalive(data.conversationId)
    return
  }

  // CHUNK-LEAK-01: Always drop chunks when no active conversation (null guard
  // was previously bypassed when activeConvId was null, leaking stale chunks).
  const activeConvId = useChatStore.getState().activeConversation?.id

  // Phase progress and todo updates are conversation-scoped in separate stores,
  // so they should be processed regardless of which conversation is active.
  if (data.todoUpdate) {
    processTodoUpdate(data.conversationId, data.todoUpdate)
  }
  if (data.phaseProgress) {
    const { updatePhase } = usePlanExecutionStore.getState()
    updatePhase(data.conversationId, {
      phaseId: data.phaseProgress.phaseId,
      phaseTitle: data.phaseProgress.phaseTitle,
      status: data.phaseProgress.status,
      totalPhases: data.phaseProgress.totalPhases,
      message: data.phaseProgress.message
    })
  }

  // GAP-R5-2: Buffer background chunks BEFORE the null guard so they aren't
  // dropped during the brief transition window when activeConversation is null.
  // MULTI-CHAT-06: Route chunks for background conversations to the stashed
  // stream state instead of dropping them. This ensures accumulated content
  // is preserved when the user switches back to a background conversation.
  if (data.conversationId && data.conversationId !== activeConvId) {
    bufferBackgroundChunk(data)
    return
  }
  if (!activeConvId) return

  if (data.turnBoundary && data.turnId) {
    actions.finalizeTurnBubble(
      data.turnId,
      data.role as 'specialist',
      (data as Record<string, unknown>).specialist as string | undefined
    )
    return
  }

  if (data.chunk) {
    actions.appendStreamChunk(
      data.chunk,
      data.role as 'specialist',
      data.taskId,
      data.specialist,
      data.requestId
    )
  }
  if (!data.chunk && data.role) {
    actions.updateStreamingIdentity(
      data.role as 'specialist',
      data.taskId,
      data.specialist
    )
  }

  if (data.toolActivity) {
    processToolActivity(data.toolActivity, actions.addToolActivity, actions.updateToolActivity)
    // File-based inference fallback for plan phase tracking
    // The full ToolActivity includes filePath/operationType but the stream chunk type is narrow
    const ta = data.toolActivity as Record<string, unknown>
    const filePath = ta.filePath as string | undefined
    const opType = ta.operationType as string | undefined
    if (filePath) {
      const { inferPhaseFromFile, markFileTouched } = usePlanExecutionStore.getState()
      inferPhaseFromFile(data.conversationId, filePath)
      // Only mark file as touched for write/edit operations (not reads)
      if (opType === 'write' || opType === 'edit') {
        markFileTouched(data.conversationId, filePath)
      }
    }
  }

  if (data.compactNeeded) {
    if (data.compactNeeded.level === 'compacted') {
      actions.setCompactSuggestion(null)
      if (data.conversationId) {
        void actions.loadContextUsage(data.conversationId)
      }
    } else if (
      data.compactNeeded.level === 'auto-compact-pending' ||
      data.compactNeeded.level === 'warning'
    ) {
      actions.setCompactSuggestion(null)
    } else {
      actions.setCompactSuggestion(data.compactNeeded)
    }
  }

  if (data.budgetCapReached) {
    actions.setBudgetCapBanner({
      conversationId: data.conversationId,
      message: data.budgetCapReached.message,
      canContinue: data.budgetCapReached.canContinue
    })
  }

  // todoUpdate and phaseProgress already processed above the background guard

  if (data.turnLimit) {
    useChatStore.setState({ turnLimitReached: data.turnLimit })
  }

  if (data.contextUsageUpdate) {
    const convId = data.conversationId
    if (convId) {
      processContextUsageUpdate(convId, data.contextUsageUpdate)
    }
  }
}

/** Handle stream completion — clean up tracking and finalize UI. */
function handleMessageComplete(
  data: Parameters<Parameters<Window['api']['onMessageComplete']>[0]>[0],
  finalizeStream: ChatActions['finalizeStream']
): void {
  if (!data.taskId) {
    removeStreamingConversation(data.conversationId)
  }

  const activeConvId = useChatStore.getState().activeConversation?.id
  // BUG-R6-1: Guard on data.conversationId, not activeConvId.
  // When activeConvId is undefined (no active conv), the old three-way AND
  // guard fell through to finalizeStream, leaking stash entries.
  if (data.conversationId && data.conversationId !== activeConvId) {
    // STALL-DETECT-06: Clear orphaned stall timer for the completed background conversation.
    // Without this, the timer fires after completion and may flag a false stall.
    streamingInternals.clearStallTimer(data.conversationId)
    // MULTI-CHAT-06: Clean up the stashed stream state for background completion.
    // The completed message is in the DB — remove the stash so the user sees
    // fresh DB messages when switching back (not stale streaming state).
    useChatStore.setState((state) => {
      const streams = new Map(state.conversationStreams)
      streams.delete(data.conversationId)
      return { conversationStreams: streams }
    })
    rendererLog.info(
      `[finalizeStream] Tracked completion for background conversation ${data.conversationId}`
    )
    return
  }
  rendererLog.info(
    `[PIPELINE:renderer:message-complete] messageId=${data.messageId} taskId=${data.taskId ?? 'none'}`
  )
  finalizeStream(data.messageId, data.taskId, data.requestId)

  // Auto-clear completed plan executions after 30s so the user sees the final state
  const exec = usePlanExecutionStore.getState().executions[data.conversationId]
  if (exec) {
    const allDone = exec.phases.every(
      (p) => p.status === 'completed' || p.status === 'skipped' || p.status === 'failed'
    )
    if (allDone) {
      setTimeout(() => {
        usePlanExecutionStore.getState().clearExecution(data.conversationId)
      }, 30_000)
    }
  }
}

/** Mirror backend state-machine transitions to the renderer. */
function handleStateChange(
  data: Parameters<Parameters<Window['api']['onStateChange']>[0]>[0],
  setConversationState: ChatActions['setConversationState']
): void {
  if (data.to === 'idle' && data.conversationId) {
    const convId = data.conversationId
    // Clean up stall + safety timers for this conversation — prevents harmless-but-wasteful
    // setTimeouts firing after the backend has already transitioned to idle.
    streamingInternals.clearSafetyTimer(convId)
    // MULTI-CHAT-06: Coalesce streaming set + stash cleanup into a single setState
    // to avoid double render cycles. Also derives isStreaming from the updated set.
    useChatStore.setState((state) => {
      const hadStreaming = state.streamingConversationIds.has(convId)
      const hadStreams = state.conversationStreams.has(convId)
      if (!hadStreaming && !hadStreams) return state

      const newStreamingIds = new Set(state.streamingConversationIds)
      newStreamingIds.delete(convId)
      const streams = new Map(state.conversationStreams)
      streams.delete(convId)

      return {
        streamingConversationIds: newStreamingIds,
        // BUG-R5-1: isStreaming reflects the ACTIVE conversation only.
        isStreaming: state.activeConversation?.id ? newStreamingIds.has(state.activeConversation.id) : false,
        conversationStreams: streams
      }
    })
  }

  const activeConvId = useChatStore.getState().activeConversation?.id
  // IMP-R5-2: Remove three-way AND — when no active conv, background state changes
  // leak through to setConversationState. Same pattern as BUG-R5-2.
  if (data.conversationId && data.conversationId !== activeConvId) {
    rendererLog.info(
      `[StateMachine:renderer] background transition ${data.from} → ${data.to} (conv=${data.conversationId}, active=${activeConvId})`
    )
    return
  }
  rendererLog.info(`[StateMachine:renderer] ${data.from} → ${data.to} (event=${data.event})`)
  setConversationState({
    phase: data.to as ConversationPhase | 'idle' | 'error' | 'stopped',
    from: data.from,
    event: data.event,
    conversationId: data.conversationId
  })
}

// ─── Hook ─────────────────────────────────────────────────

/**
 * Sets up all IPC event listeners for the App shell —
 * message streaming, agent status, auto-update, memory feed,
 * LSP diagnostics, hook lifecycle, and state machine mirror.
 *
 * Extracted from App to reduce component complexity.
 */
export function useAppIpcListeners(): void {
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces)
  const setAgentReady = useWorkspaceStore((s) => s.setAgentReady)
  const chatActions = useChatActions()
  const updateStatus = useAgentStore((s) => s.updateStatus)
  const setAvailable = useUpdateStore((s) => s.setAvailable)
  const setNotAvailable = useUpdateStore((s) => s.setNotAvailable)
  const setDownloaded = useUpdateStore((s) => s.setDownloaded)
  const setProgress = useUpdateStore((s) => s.setProgress)
  const setError = useUpdateStore((s) => s.setError)
  const onMemoryFeedProgress = useMemoryStore((s) => s.onFeedProgress)
  const loadProfile = useProfileStore((s) => s.loadProfile)
  const { loadPreferences } = useAppPreferenceActions()

  useEffect(() => {
    loadProfile()
    loadWorkspaces()
    loadPreferences()

    const unsubChunk = window.api.onMessageChunk((data) =>
      handleMessageChunk(data, chatActions)
    )
    const unsubComplete = window.api.onMessageComplete((data) =>
      handleMessageComplete(data, chatActions.finalizeStream)
    )
    const unsubAskQuestion = window.api.onAskQuestion((data) => {
      // MULTI-CHAT-01: Only show ask-user cards for the active conversation.
      // Without this guard, an ask_user from conversation A appears in conversation B.
      const activeConvId = useChatStore.getState().activeConversation?.id
      // BUG-R5-2: Remove three-way AND — when activeConvId is undefined (post-deletion),
      // background ask-user cards leak through. Same fix as R3's ElicitationModal guard.
      if (data.conversationId && data.conversationId !== activeConvId) {
        // BUG-R9-1: Stash background ask_user instead of dropping it.
        // When the user switches to this conversation, selectConversation
        // restores pendingQuestions from the stash.
        rendererLog.info(
          `[askQuestion] Stashing for background conversation ${data.conversationId}`
        )
        bufferBackgroundAskUser(data.conversationId, data)
        return
      }
      chatActions.setPendingQuestions(data.questions, data.action, data.requestId)
    })
    const unsubReady = window.api.onAgentReady(() => setAgentReady())
    const unsubAgent = window.api.onAgentStatusUpdate((data) => {
      updateStatus({
        agentId: data.agentId,
        agentType: data.agentType,
        status: data.status as
          | 'idle'
          | 'thinking'
          | 'writing'
          | 'reviewing'
          | 'completed'
          | 'failed',
        currentTask: data.currentTask,
        elapsedMs: data.elapsedMs,
        tokenUsage: data.tokenUsage,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        contextTokens: data.contextTokens,
        model: data.model,
        complexityTier: data.complexityTier,
        activeMcpTools: data.activeMcpTools
      })
    })
    const unsubUpdateAvailable = window.api.onUpdateAvailable((info) =>
      setAvailable(info.version, info.releaseNotes, info.releaseDate)
    )
    const unsubUpdateNotAvailable = window.api.onUpdateNotAvailable(() => setNotAvailable())
    const unsubUpdateDownloaded = window.api.onUpdateDownloaded((info) =>
      setDownloaded(info.version)
    )
    const unsubUpdateProgress = window.api.onUpdateProgress((progress) =>
      setProgress(progress.percent)
    )
    const unsubUpdateError = window.api.onUpdateError((message) => setError(message))
    const unsubMemoryFeed = window.api.onMemoryFeedProgress((progress) =>
      onMemoryFeedProgress(progress)
    )
    const unsubLspDiagnostics = window.api.onLspDiagnostics((data) => {
      if (data.conversationId && data.diagnostics) {
        useDiagnosticsStore.getState().setDiagnostics(data.conversationId, data.diagnostics)
      }
    })
    const unsubHookLifecycle = window.api.onHookLifecycle((data) => {
      useHookLifecycleStore.getState().onHookEvent(data)
    })
    const unsubStateChange = window.api.onStateChange((data) =>
      handleStateChange(data, chatActions.setConversationState)
    )

    return () => {
      unsubChunk()
      unsubComplete()
      unsubAskQuestion()
      unsubReady()
      unsubAgent()
      unsubUpdateAvailable()
      unsubUpdateNotAvailable()
      unsubUpdateDownloaded()
      unsubUpdateProgress()
      unsubUpdateError()
      unsubMemoryFeed()
      unsubLspDiagnostics()
      unsubHookLifecycle()
      unsubStateChange()
    }
  }, [
    loadProfile,
    loadWorkspaces,
    loadPreferences,
    chatActions,
    updateStatus,
    setAgentReady,
    setAvailable,
    setNotAvailable,
    setDownloaded,
    setProgress,
    setError,
    onMemoryFeedProgress
  ])
}
