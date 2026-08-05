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
import type { ConversationPhase, ContextUsageLevel, ToolActivity } from '../../../shared/types'
import { COMPACTION_RATIOS } from '../../../shared/constants'
import { rendererLog } from '@renderer/utils/logger'
import { useTodoStore } from '@renderer/store/todo.store'
import { useDiagnosticsStore } from '@renderer/store/diagnostics.store'
import { useHookLifecycleStore } from '@renderer/store/hook-lifecycle.store'
import { usePlanExecutionStore } from '@renderer/store/plan-execution.store'
import { streamingInternals } from '@renderer/store/chat-streaming.actions'
import { ChunkConsumer } from './useChunkConsumer'

// ─── Type Aliases ─────────────────────────────────────────

type ChatActions = ReturnType<typeof useChatActions>

// ─── Pure Helpers ─────────────────────────────────────────


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

/** Replace the full todo list for a conversation (TodoWrite snapshot, CLI backend). */
function processTodoSync(
  conversationId: string,
  todoSync: Array<{ text: string; completed: boolean; index: number }>
): void {
  useTodoStore.getState().setTodos(conversationId, todoSync)
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
  // Use the same algorithm as resolveContextLevel (context-usage-level.ts)
  const pct = update.percentage
  const level: ContextUsageLevel =
    pct >= COMPACTION_RATIOS.auto * 100 ? 'critical'
    : pct >= COMPACTION_RATIOS.suggest * 100 ? 'red'
    : pct >= COMPACTION_RATIOS.warn * 100 ? 'yellow'
    : 'green'

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
type MessageChunkPayload = Parameters<Parameters<Window['api']['onMessageChunk']>[0]>[0]

function handleMessageChunk(
  data: MessageChunkPayload,
  actions: ChatActions
): void {
  if (data.keepalive) {
    // IMP-R5-1: Pass conversationId so the CORRECT conversation's safety timer
    // is reset, not the currently active one (which may differ after a conv switch).
    actions.handleKeepalive(data.conversationId)
    return
  }

  const activeConvId = useChatStore.getState().activeConversation?.id
  const isActive = data.conversationId === activeConvId

  // Cross-store updates: conversation-scoped in separate stores,
  // processed regardless of which conversation is active.
  if (data.todoUpdate) {
    processTodoUpdate(data.conversationId, data.todoUpdate)
  }
  if (data.todoSync) {
    processTodoSync(data.conversationId, data.todoSync)
  }
  if (data.phaseProgress) {
    const { updatePhase, updateTask } = usePlanExecutionStore.getState()
    updatePhase(data.conversationId, {
      phaseId: data.phaseProgress.phaseId,
      phaseTitle: data.phaseProgress.phaseTitle,
      status: data.phaseProgress.status,
      totalPhases: data.phaseProgress.totalPhases,
      message: data.phaseProgress.message
    })

    if (data.phaseProgress.taskId && data.phaseProgress.taskStatus) {
      updateTask(data.conversationId, {
        phaseId: data.phaseProgress.phaseId,
        taskId: data.phaseProgress.taskId,
        title: data.phaseProgress.taskTitle ?? data.phaseProgress.taskId,
        status: data.phaseProgress.taskStatus
      })
    }
  }

  // PER-CONV-ACCUM: Turn boundaries only apply to the active conversation
  if (isActive && data.turnBoundary && data.turnId) {
    actions.finalizeTurnBubble(
      data.turnId,
      data.role as 'specialist',
      (data as Record<string, unknown>).specialist as string | undefined
    )
    return
  }

  // PER-CONV-ACCUM: ALL streaming chunks route through appendStreamChunk with
  // explicit conversationId — no separate bufferBackgroundChunk path.
  if (data.chunk) {
    actions.appendStreamChunk(
      data.conversationId,
      data.chunk,
      data.role as 'specialist',
      data.taskId,
      data.specialist,
      data.requestId
    )
  }
  if (!data.chunk && data.role && isActive) {
    actions.updateStreamingIdentity(
      data.role as 'specialist',
      data.taskId,
      data.specialist
    )
  }

  // PER-CONV-ACCUM: Tool activities for the active conversation go through the
  // store actions (which route to the active accumulator and update globals).
  // For background conversations, route directly through the per-conversation
  // accumulator so tool progress isn't lost when the user switches back.
  if (data.toolActivity) {
    if (isActive) {
      processToolActivity(data.toolActivity, actions.addToolActivity, actions.updateToolActivity)
      const ta = data.toolActivity as Record<string, unknown>
      const filePath = ta.filePath as string | undefined
      const opType = ta.operationType as string | undefined
      if (filePath) {
        const { inferPhaseFromFile, markFileTouched } = usePlanExecutionStore.getState()
        inferPhaseFromFile(data.conversationId, filePath)
        if (opType === 'write' || opType === 'edit') {
          markFileTouched(data.conversationId, filePath)
        }
      }
    } else {
      // Background tool activity — route through per-conv accumulator directly
      streamingInternals
        .getOrCreateAccumulatorFor(data.conversationId)
        .handleToolActivity(data.toolActivity as { id: string; toolName: string } & Record<string, unknown>)
      streamingInternals.recordChunkActivity(data.conversationId)
    }
  }

  // Non-streaming payloads still require active-conv guard
  if (!isActive) return

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
  const isActive = data.conversationId === activeConvId

  // STALL-DETECT-06: Clear orphaned stall timer for the completed conversation.
  if (!data.taskId) {
    streamingInternals.clearStallTimer(data.conversationId)
  }

  // PER-CONV-ACCUM: finalizeStreamAction now handles both active and background
  // conversations via the conversationId parameter. Background completions clean
  // up the buffer; active completions also update globals and append messages.
  if (!isActive && !data.taskId) {
    rendererLog.info(
      `[finalizeStream] Tracked completion for background conversation ${data.conversationId}`
    )
  } else {
    rendererLog.info(
      `[PIPELINE:renderer:message-complete] messageId=${data.messageId} taskId=${data.taskId ?? 'none'}`
    )
  }
  finalizeStream(data.conversationId, data.messageId, data.taskId, data.requestId)

  // Transition completed plan executions to read-only mode after 30s
  const exec = usePlanExecutionStore.getState().executions[data.conversationId]
  if (exec && !exec.completedAt) {
    const allDone = exec.phases.every(
      (p) => p.status === 'completed' || p.status === 'skipped' || p.status === 'failed'
    )
    if (allDone) {
      // Extract memories from completed plan execution (fire-and-forget).
      // Gated on exec.planId — an execution with no DB-persisted plan means
      // savePlan never ran for this turn (e.g. emit_plan fired without a
      // resolvable workspace/conversation), so its phase/task data has no
      // durable backing and would record unverifiable counts into memory.
      const workspace = useWorkspaceStore.getState().activeWorkspace
      if (workspace?.id && workspace.repoPath && exec.planId) {
        const failedCount = exec.phases.filter(p => p.status === 'failed').length
        const overallStatus: 'completed' | 'partial' | 'failed' =
          failedCount === exec.phases.length ? 'failed'
            : failedCount > 0 ? 'partial'
            : 'completed'

        window.api.memorySavePlanExecution({
          workspaceId: workspace.id,
          workspacePath: workspace.repoPath,
          conversationId: data.conversationId,
          planTitle: exec.planTitle,
          planGoal: exec.planGoal,
          status: overallStatus,
          phases: exec.phases.map(p => ({
            phaseTitle: p.phaseTitle,
            status: p.status,
            touchedFiles: p.touchedFiles,
            tasks: p.tasks.map(t => ({ title: t.title, status: t.status }))
          })),
          durationMs: Date.now() - exec.startedAt
        }).catch(err => {
          rendererLog.warn('[PlanMemory] Failed to enqueue plan memory extraction:', err)
        })
      }

      // Transition to read-only after 30s
      setTimeout(() => {
        usePlanExecutionStore.getState().completeExecution(data.conversationId)
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
    // PER-CONV-ACCUM: Remove from streaming tracking set and mark buffer as non-streaming,
    // but do NOT delete the buffer — it stays warm for switch-back projection.
    useChatStore.setState((state) => {
      const hadStreaming = state.streamingConversationIds.has(convId)
      if (!hadStreaming) return state

      const newStreamingIds = new Set(state.streamingConversationIds)
      newStreamingIds.delete(convId)

      // Mark the buffer as non-streaming (keep content for switch-back)
      const streams = new Map(state.conversationStreams)
      const existing = streams.get(convId)
      if (existing) {
        streams.set(convId, { ...existing, isStreaming: false })
      }

      return {
        streamingConversationIds: newStreamingIds,
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

    // IPC-BACKPRESSURE: Frame-aligned chunk consumer batches IPC messages
    // and processes them once per animation frame (~16ms at 60fps).
    // This prevents React render queue overload during fast streaming.
    const consumer = new ChunkConsumer((batch) => {
      for (const data of batch) handleMessageChunk(data as MessageChunkPayload, chatActions)
    })
    const unsubChunk = window.api.onMessageChunk((data) =>
      consumer.push(data)
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
    const unsubUpdateNotAvailable = window.api.onUpdateNotAvailable((info) =>
      setNotAvailable(info.currentVersion)
    )
    const unsubUpdateDownloaded = window.api.onUpdateDownloaded((info) =>
      setDownloaded(info.version)
    )
    const unsubUpdateProgress = window.api.onUpdateProgress((progress) =>
      setProgress(
        progress.percent,
        progress.bytesPerSecond,
        progress.transferred,
        progress.total
      )
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
      consumer.destroy()
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
