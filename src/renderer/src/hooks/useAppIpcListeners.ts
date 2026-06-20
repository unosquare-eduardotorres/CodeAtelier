/**
 * Custom hook encapsulating all App-level IPC event listeners.
 * Extracted from App.tsx to reduce component cyclomatic complexity.
 */
import { useEffect } from 'react'
import {
  useChatStore,
  useChatActions,
  useAgentStore,
  useWorkspaceStore,
  useUpdateStore,
  useMemoryStore
} from '@renderer/store'
import { useTodoStore } from '@renderer/store/todo.store'
import { useDiagnosticsStore } from '@renderer/store/diagnostics.store'
import { useHookLifecycleStore } from '@renderer/store/hook-lifecycle.store'
import type { ContextUsageBreakdown, ConversationPhase, ToolActivity } from '../../../shared/types'
import { rendererLog } from '@renderer/utils/logger'

// ── Guard helpers ──

function isBackgroundConversation(
  activeConvId: string | undefined,
  dataConvId: string | undefined
): boolean {
  return !!activeConvId && !!dataConvId && dataConvId !== activeConvId
}

function cleanupStreamingConversation(conversationId: string): void {
  useChatStore.setState((state) => {
    if (!state.streamingConversationIds.has(conversationId)) return state
    const newSet = new Set(state.streamingConversationIds)
    newSet.delete(conversationId)
    return { streamingConversationIds: newSet }
  })
}

// ── Chunk handler helpers ──

function handleToolActivityChunk(
  toolActivity: Record<string, unknown>,
  addToolActivity: (a: ToolActivity) => void,
  updateToolActivity: (a: Partial<ToolActivity> & { toolName: string }) => void
): void {
  const ta = toolActivity as unknown as ToolActivity & { elapsedSeconds?: number }
  if (ta.elapsedSeconds !== undefined && ta.status === 'running') {
    updateToolActivity({ id: ta.id, toolName: ta.toolName, elapsedSeconds: ta.elapsedSeconds })
  } else if (ta.status === 'running') {
    addToolActivity({ ...ta, status: 'running', startedAt: ta.startedAt ?? Date.now() } as ToolActivity)
  } else {
    updateToolActivity({ ...ta, completedAt: ta.completedAt ?? Date.now() } as ToolActivity & { id: string })
  }
}

function handleCompactNeeded(
  compactNeeded: { level: string; inputTokens?: number; conversationId?: string; breakdown?: ContextUsageBreakdown; isLocalProvider?: boolean },
  conversationId: string | undefined,
  setCompactSuggestion: (s: { level: string; inputTokens: number; breakdown?: ContextUsageBreakdown; isLocalProvider?: boolean } | null) => void,
  loadContextUsage: (convId: string) => Promise<void>
): void {
  if (compactNeeded.level === 'compacted') {
    setCompactSuggestion(null)
    if (conversationId) void loadContextUsage(conversationId)
  } else if (compactNeeded.level === 'auto-compact-pending' || compactNeeded.level === 'warning') {
    setCompactSuggestion(null)
  } else {
    setCompactSuggestion(compactNeeded as { level: string; inputTokens: number; breakdown?: ContextUsageBreakdown; isLocalProvider?: boolean })
  }
}

function handleTodoUpdate(
  todoUpdate: { action: string; text: string; index?: number },
  conversationId: string
): void {
  const { addTodo, completeTodo, removeTodo, updateTodo } = useTodoStore.getState()
  switch (todoUpdate.action) {
    case 'add': addTodo(conversationId, todoUpdate.text, todoUpdate.index); break
    case 'complete': completeTodo(conversationId, todoUpdate.text, todoUpdate.index); break
    case 'remove': removeTodo(conversationId, todoUpdate.text, todoUpdate.index); break
    case 'update': updateTodo(conversationId, todoUpdate.text, todoUpdate.index); break
  }
}

function handleContextUsageUpdate(
  update: { inputTokens: number; contextWindowSize: number; percentage: number; cacheHitRate: number },
  conversationId: string | undefined
): void {
  if (!conversationId) return
  const { inputTokens, contextWindowSize, percentage, cacheHitRate } = update
  const effectiveQualityWindow = Math.min(Math.round(contextWindowSize * 0.5), 500_000)
  const qualityPct = Math.round((inputTokens / effectiveQualityWindow) * 100)
  const level = qualityPct > 80 ? 'critical' : qualityPct > 60 ? 'red' : qualityPct > 40 ? 'yellow' : 'green'
  useChatStore.setState((state) => ({
    contextUsages: {
      ...state.contextUsages,
      [conversationId]: {
        ...state.contextUsages[conversationId],
        conversationId, inputTokens, contextWindowSize, percentage, cacheHitRate,
        level: level as 'green' | 'yellow' | 'red' | 'critical'
      }
    }
  }))
}

// ── Message chunk dispatcher ──

type ChunkActions = Pick<ReturnType<typeof useChatActions>,
  'appendStreamChunk' | 'updateStreamingIdentity' | 'finalizeTurnBubble' |
  'addToolActivity' | 'updateToolActivity' | 'setCompactSuggestion' |
  'setBudgetCapBanner' | 'setThinkingLabel' | 'loadContextUsage'>

function processMessageChunk<D extends { conversationId: string }>(
  data: D,
  actions: ChunkActions
): void {
  const d = data as unknown as Record<string, unknown>
  const conversationId = data.conversationId

  if (d.turnBoundary && d.turnId) {
    actions.finalizeTurnBubble(
      d.turnId as string,
      d.role as 'da-vinci' | 'specialist',
      d.specialist as string | undefined
    )
    return
  }
  if (d.chunk) {
    actions.appendStreamChunk(
      d.chunk as string,
      d.role as 'da-vinci' | 'specialist',
      d.taskId as string | undefined,
      d.specialist as string | undefined,
      d.requestId as string | undefined,
      conversationId
    )
  }
  if (!d.chunk && d.role) {
    actions.updateStreamingIdentity(
      d.role as 'da-vinci' | 'specialist',
      d.taskId as string | undefined,
      d.specialist as string | undefined
    )
  }
  if (d.toolActivity) {
    handleToolActivityChunk(
      d.toolActivity as Record<string, unknown>,
      actions.addToolActivity,
      actions.updateToolActivity
    )
  }
  if (d.compactNeeded) {
    handleCompactNeeded(
      d.compactNeeded as { level: string },
      conversationId,
      actions.setCompactSuggestion,
      actions.loadContextUsage
    )
  }
  if (d.budgetCapReached) {
    const cap = d.budgetCapReached as { message: string; canContinue: boolean }
    actions.setBudgetCapBanner({
      conversationId,
      message: cap.message,
      canContinue: cap.canContinue
    })
  }
  if (d.todoUpdate) {
    handleTodoUpdate(
      d.todoUpdate as { action: string; text: string; index?: number },
      conversationId
    )
  }
  if (d.contextUsageUpdate) {
    handleContextUsageUpdate(
      d.contextUsageUpdate as { inputTokens: number; contextWindowSize: number; percentage: number; cacheHitRate: number },
      conversationId
    )
  }
  if (d.thinkingLabel) {
    actions.setThinkingLabel(d.thinkingLabel as string)
  }
}

// ── Main hook ──

export function useAppIpcListeners(): void {
  const setAgentReady = useWorkspaceStore((s) => s.setAgentReady)
  const {
    appendStreamChunk, handleKeepalive, updateStreamingIdentity,
    finalizeStream, finalizeTurnBubble, addToolActivity, updateToolActivity,
    setCompactSuggestion, setBudgetCapBanner, setPendingQuestions,
    setConversationState, loadContextUsage, setThinkingLabel
  } = useChatActions()
  const updateStatus = useAgentStore((s) => s.updateStatus)
  const setAvailable = useUpdateStore((s) => s.setAvailable)
  const setNotAvailable = useUpdateStore((s) => s.setNotAvailable)
  const setDownloaded = useUpdateStore((s) => s.setDownloaded)
  const setProgress = useUpdateStore((s) => s.setProgress)
  const setError = useUpdateStore((s) => s.setError)
  const onMemoryFeedProgress = useMemoryStore((s) => s.onFeedProgress)

  useEffect(() => {
    const chunkActions: ChunkActions = {
      appendStreamChunk, updateStreamingIdentity, finalizeTurnBubble,
      addToolActivity, updateToolActivity, setCompactSuggestion,
      setBudgetCapBanner, setThinkingLabel, loadContextUsage
    }

    const unsubChunk = window.api.onMessageChunk((data) => {
      if (data.keepalive) { handleKeepalive(); return }
      const activeConvId = useChatStore.getState().activeConversation?.id
      if (isBackgroundConversation(activeConvId, data.conversationId)) return
      processMessageChunk(data, chunkActions)
    })

    const unsubComplete = window.api.onMessageComplete((data) => {
      if (!data.taskId) cleanupStreamingConversation(data.conversationId)
      const activeConvId = useChatStore.getState().activeConversation?.id
      if (isBackgroundConversation(activeConvId, data.conversationId)) {
        rendererLog.info(`[finalizeStream] Tracked completion for background conversation ${data.conversationId}`)
        return
      }
      rendererLog.info(`[PIPELINE:renderer:message-complete] messageId=${data.messageId} taskId=${data.taskId ?? 'none'}`)
      finalizeStream(data.messageId, data.taskId, data.requestId)
    })

    const unsubAskQuestion = window.api.onAskQuestion((data) => {
      setPendingQuestions(data.questions, data.action, data.requestId)
    })
    const unsubReady = window.api.onAgentReady(() => setAgentReady())
    const unsubAgent = window.api.onAgentStatusUpdate((data) => {
      updateStatus({
        agentId: data.agentId, agentType: data.agentType,
        status: data.status as 'idle' | 'thinking' | 'writing' | 'reviewing' | 'completed' | 'failed',
        currentTask: data.currentTask, elapsedMs: data.elapsedMs,
        tokenUsage: data.tokenUsage, inputTokens: data.inputTokens,
        outputTokens: data.outputTokens, contextTokens: data.contextTokens,
        model: data.model, complexityTier: data.complexityTier,
        activeMcpTools: data.activeMcpTools
      })
    })

    const unsubUpdateAvailable = window.api.onUpdateAvailable((info) => setAvailable(info.version, info.releaseNotes, info.releaseDate))
    const unsubUpdateNotAvailable = window.api.onUpdateNotAvailable(() => setNotAvailable())
    const unsubUpdateDownloaded = window.api.onUpdateDownloaded((info) => setDownloaded(info.version))
    const unsubUpdateProgress = window.api.onUpdateProgress((progress) => setProgress(progress.percent))
    const unsubUpdateError = window.api.onUpdateError((message) => setError(message))
    const unsubMemoryFeed = window.api.onMemoryFeedProgress((progress) => onMemoryFeedProgress(progress))
    const unsubLspDiagnostics = window.api.onLspDiagnostics((data) => {
      if (data.conversationId && data.diagnostics) {
        useDiagnosticsStore.getState().setDiagnostics(data.conversationId, data.diagnostics)
      }
    })
    const unsubHookLifecycle = window.api.onHookLifecycle((data) => {
      useHookLifecycleStore.getState().onHookEvent(data)
    })

    const unsubStateChange = window.api.onStateChange((data) => {
      if (data.to === 'idle' && data.conversationId) {
        cleanupStreamingConversation(data.conversationId)
      }
      const activeConvId = useChatStore.getState().activeConversation?.id
      if (isBackgroundConversation(activeConvId, data.conversationId)) {
        rendererLog.info(`[StateMachine:renderer] background transition ${data.from} → ${data.to} (conv=${data.conversationId}, active=${activeConvId})`)
        return
      }
      rendererLog.info(`[StateMachine:renderer] ${data.from} → ${data.to} (event=${data.event})`)
      setConversationState({
        phase: data.to as ConversationPhase | 'idle' | 'error' | 'stopped',
        from: data.from, event: data.event, conversationId: data.conversationId
      })
    })

    return () => {
      unsubChunk(); unsubComplete(); unsubAskQuestion(); unsubReady(); unsubAgent()
      unsubUpdateAvailable(); unsubUpdateNotAvailable(); unsubUpdateDownloaded()
      unsubUpdateProgress(); unsubUpdateError(); unsubMemoryFeed()
      unsubLspDiagnostics(); unsubHookLifecycle(); unsubStateChange()
    }
  }, [
    appendStreamChunk, handleKeepalive, updateStreamingIdentity,
    finalizeStream, finalizeTurnBubble, addToolActivity, updateToolActivity,
    updateStatus, setAgentReady, setCompactSuggestion, setBudgetCapBanner,
    setPendingQuestions, setAvailable, setNotAvailable, setDownloaded,
    setProgress, setError, onMemoryFeedProgress, setConversationState, loadContextUsage,
    setThinkingLabel
  ])
}
