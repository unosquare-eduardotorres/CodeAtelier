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
    return { streamingConversationIds: newSet }
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
    actions.handleKeepalive()
    return
  }

  const activeConvId = useChatStore.getState().activeConversation?.id
  if (activeConvId && data.conversationId !== activeConvId) return

  if (data.turnBoundary && data.turnId) {
    actions.finalizeTurnBubble(
      data.turnId,
      data.role as 'da-vinci' | 'specialist',
      (data as Record<string, unknown>).specialist as string | undefined
    )
    return
  }

  if (data.chunk) {
    actions.appendStreamChunk(
      data.chunk,
      data.role as 'da-vinci' | 'specialist',
      data.taskId,
      data.specialist,
      data.requestId
    )
  }
  if (!data.chunk && data.role) {
    actions.updateStreamingIdentity(
      data.role as 'da-vinci' | 'specialist',
      data.taskId,
      data.specialist
    )
  }

  if (data.toolActivity) {
    processToolActivity(data.toolActivity, actions.addToolActivity, actions.updateToolActivity)
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

  if (data.todoUpdate) {
    processTodoUpdate(data.conversationId, data.todoUpdate)
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
  if (activeConvId && data.conversationId !== activeConvId) {
    rendererLog.info(
      `[finalizeStream] Tracked completion for background conversation ${data.conversationId}`
    )
    return
  }
  rendererLog.info(
    `[PIPELINE:renderer:message-complete] messageId=${data.messageId} taskId=${data.taskId ?? 'none'}`
  )
  finalizeStream(data.messageId, data.taskId, data.requestId)
}

/** Mirror backend state-machine transitions to the renderer. */
function handleStateChange(
  data: Parameters<Parameters<Window['api']['onStateChange']>[0]>[0],
  setConversationState: ChatActions['setConversationState']
): void {
  if (data.to === 'idle' && data.conversationId) {
    removeStreamingConversation(data.conversationId)
  }

  const activeConvId = useChatStore.getState().activeConversation?.id
  if (activeConvId && data.conversationId && data.conversationId !== activeConvId) {
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
