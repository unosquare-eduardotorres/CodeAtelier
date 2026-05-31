import { useEffect, useCallback } from 'react'
import { useBugCapture } from '@renderer/hooks/useBugCapture'
import { AppLayout } from '@renderer/components/layout'
import {
  WelcomeModal,
  CheckpointApprovalModal,
  ElicitationModal,
  UpdateAvailableModal
} from '@renderer/components/common'
import {
  useWorkspaceStore,
  useChatStore,
  useChatActions,
  useAgentStore,
  useUpdateStore,
  useMemoryStore,
  useProfileStore
} from '@renderer/store'
import type { ConversationPhase } from '../../shared/types'
import { rendererLog } from '@renderer/utils/logger'
import { useTodoStore } from '@renderer/store/todo.store'
import { useDiagnosticsStore } from '@renderer/store/diagnostics.store'
import { useHookLifecycleStore } from '@renderer/store/hook-lifecycle.store'
import { useTheme } from '@renderer/hooks/useTheme'

function App(): React.JSX.Element {
  // Apply active theme (data-theme attribute on <html>)
  useTheme()

  // Global error capture → bug tracker
  useBugCapture()

  // Workspace actions (stable refs — individual selectors prevent full-store re-renders)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces)
  const setAgentReady = useWorkspaceStore((s) => s.setAgentReady)

  // Chat actions (already uses useShallow internally)
  const {
    appendStreamChunk,
    handleKeepalive,
    updateStreamingIdentity,
    finalizeStream,
    finalizeTurnBubble,
    addToolActivity,
    updateToolActivity,
    setCompactSuggestion,
    setBudgetCapBanner,
    setPendingQuestions,
    setConversationState,
    loadContextUsage
  } = useChatActions()

  // Agent actions
  const updateStatus = useAgentStore((s) => s.updateStatus)

  // Update actions
  const setAvailable = useUpdateStore((s) => s.setAvailable)
  const setNotAvailable = useUpdateStore((s) => s.setNotAvailable)
  const setDownloaded = useUpdateStore((s) => s.setDownloaded)
  const setProgress = useUpdateStore((s) => s.setProgress)
  const setError = useUpdateStore((s) => s.setError)

  // Memory actions
  const onMemoryFeedProgress = useMemoryStore((s) => s.onFeedProgress)

  // Profile state + actions
  const isProfileLoading = useProfileStore((s) => s.isLoading)
  const hasCompletedWelcome = useProfileStore((s) => s.hasCompletedWelcome)
  const loadProfile = useProfileStore((s) => s.loadProfile)
  const saveProfile = useProfileStore((s) => s.saveProfile)

  const handleWelcomeComplete = useCallback(
    async (displayName: string, avatarKey: string) => {
      await saveProfile(displayName, avatarKey)
    },
    [saveProfile]
  )

  useEffect(() => {
    // Load user profile on mount
    loadProfile()
    // Load workspaces on mount
    loadWorkspaces()

    // Set up IPC event listeners for streaming
    const unsubChunk = window.api.onMessageChunk((data) => {
      // Keepalive — backend is alive during long MCP tool execution, reset safety timer
      if (data.keepalive) {
        handleKeepalive()
        return
      }

      // Ignore chunks for non-active conversation
      const activeConvId = useChatStore.getState().activeConversation?.id
      if (activeConvId && data.conversationId !== activeConvId) {
        return
      }

      // Handle turn boundaries — finalize current bubble and start a new one
      if (data.turnBoundary && data.turnId) {
        finalizeTurnBubble(
          data.turnId,
          data.role as 'da-vinci' | 'specialist',
          (data as Record<string, unknown>).specialist as string | undefined
        )
        return
      }
      if (data.chunk) {
        appendStreamChunk(
          data.chunk,
          data.role as 'da-vinci' | 'specialist',
          data.taskId,
          data.specialist,
          data.requestId
        )
      }
      // Update streaming identity even on tool-only chunks (empty text)
      // so the thinking indicator shows the correct agent name
      if (!data.chunk && data.role) {
        updateStreamingIdentity(
          data.role as 'da-vinci' | 'specialist',
          data.taskId,
          data.specialist
        )
      }
      if (data.toolActivity) {
        if (
          data.toolActivity.elapsedSeconds !== undefined &&
          data.toolActivity.status === 'running'
        ) {
          // Progress update — update elapsed time without changing status
          updateToolActivity({
            id: data.toolActivity.id,
            toolName: data.toolActivity.toolName,
            elapsedSeconds: data.toolActivity.elapsedSeconds
          })
        } else if (data.toolActivity.status === 'running') {
          addToolActivity({
            id: data.toolActivity.id,
            toolName: data.toolActivity.toolName,
            status: 'running',
            input: data.toolActivity.input,
            startedAt: data.toolActivity.startedAt ?? Date.now()
          })
        } else {
          updateToolActivity({
            id: data.toolActivity.id,
            toolName: data.toolActivity.toolName,
            status: data.toolActivity.status,
            input: data.toolActivity.input,
            completedAt: data.toolActivity.completedAt ?? Date.now()
          })
        }
      }
      if (data.compactNeeded) {
        if (data.compactNeeded.level === 'compacted') {
          // Auto-compaction completed — refresh context usage silently.
          // Clear any stale compact suggestion that was showing pre-compaction data.
          setCompactSuggestion(null)
          if (data.conversationId) {
            void loadContextUsage(data.conversationId)
          }
        } else if (
          data.compactNeeded.level === 'auto-compact-pending' ||
          data.compactNeeded.level === 'warning'
        ) {
          // Auto-compact pending: SDK will handle on next turn — don't alarm.
          // Warning: early heads-up — just update badge, no modal needed.
          setCompactSuggestion(null)
        } else {
          setCompactSuggestion(data.compactNeeded)
        }
      }
      if (data.budgetCapReached) {
        setBudgetCapBanner({
          conversationId: data.conversationId,
          message: data.budgetCapReached.message,
          canContinue: data.budgetCapReached.canContinue
        })
      }
      if (data.todoUpdate) {
        const { addTodo, completeTodo, removeTodo, updateTodo } = useTodoStore.getState()
        const convId = data.conversationId
        switch (data.todoUpdate.action) {
          case 'add':
            addTodo(convId, data.todoUpdate.text, data.todoUpdate.index)
            break
          case 'complete':
            completeTodo(convId, data.todoUpdate.text, data.todoUpdate.index)
            break
          case 'remove':
            removeTodo(convId, data.todoUpdate.text, data.todoUpdate.index)
            break
          case 'update':
            updateTodo(convId, data.todoUpdate.text, data.todoUpdate.index)
            break
        }
      }
      if (data.contextUsageUpdate) {
        // Live context badge update during streaming — push token counts
        // so the badge refreshes every turn instead of only on completion.
        const convId = data.conversationId
        if (convId) {
          const { inputTokens, contextWindowSize, percentage, cacheHitRate } = data.contextUsageUpdate
          const effectiveQualityWindow = Math.min(Math.round(contextWindowSize * 0.5), 500_000)
          const qualityPct = Math.round((inputTokens / effectiveQualityWindow) * 100)
          const level =
            qualityPct > 80
              ? 'critical'
              : qualityPct > 60
                ? 'red'
                : qualityPct > 40
                  ? 'yellow'
                  : 'green'
          useChatStore.setState((state) => ({
            contextUsages: {
              ...state.contextUsages,
              [convId]: {
                ...state.contextUsages[convId],
                conversationId: convId,
                inputTokens,
                contextWindowSize,
                percentage,
                cacheHitRate,
                level: level as 'green' | 'yellow' | 'red' | 'critical'
              }
            }
          }))
        }
      }
    })

    const unsubComplete = window.api.onMessageComplete((data) => {
      const activeConvId = useChatStore.getState().activeConversation?.id

      // Always clean up per-conversation streaming tracking — even for non-active conversations.
      // Without this, streamingConversationIds leaks entries for background completions.
      if (!data.taskId) {
        // Only remove on final complete (not per-task intermediate completes)
        useChatStore.setState((state) => {
          if (!state.streamingConversationIds.has(data.conversationId)) return state
          const newSet = new Set(state.streamingConversationIds)
          newSet.delete(data.conversationId)
          return { streamingConversationIds: newSet }
        })
      }

      // Only finalize UI (message merge, isStreaming toggle) for active conversation
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
    })

    const unsubAskQuestion = window.api.onAskQuestion((data) => {
      setPendingQuestions(data.questions, data.action, data.requestId)
    })

    const unsubReady = window.api.onAgentReady((_data) => {
      setAgentReady() // Still works for active workspace, backward compat
    })

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
        model: data.model,
        complexityTier: data.complexityTier,
        activeMcpTools: data.activeMcpTools
      })
    })

    // Auto-update event listeners
    const unsubUpdateAvailable = window.api.onUpdateAvailable((info) => {
      setAvailable(info.version, info.releaseNotes, info.releaseDate)
    })
    const unsubUpdateNotAvailable = window.api.onUpdateNotAvailable(() => {
      setNotAvailable()
    })
    const unsubUpdateDownloaded = window.api.onUpdateDownloaded((info) => {
      setDownloaded(info.version)
    })
    const unsubUpdateProgress = window.api.onUpdateProgress((progress) => {
      setProgress(progress.percent)
    })
    const unsubUpdateError = window.api.onUpdateError((message) => {
      setError(message)
    })

    // Memory feed progress listener
    const unsubMemoryFeed = window.api.onMemoryFeedProgress((progress) => {
      onMemoryFeedProgress(progress)
    })

    // N3: LSP diagnostics from OpenCode's compiler/linter
    const unsubLspDiagnostics = window.api.onLspDiagnostics((data) => {
      if (data.conversationId && data.diagnostics) {
        useDiagnosticsStore.getState().setDiagnostics(data.conversationId, data.diagnostics)
      }
    })

    // N5: Hook lifecycle events — track active hook execution
    const unsubHookLifecycle = window.api.onHookLifecycle((data) => {
      useHookLifecycleStore.getState().onHookEvent(data)
    })

    // Conversation state machine mirror — keep renderer in sync with backend state
    const unsubStateChange = window.api.onStateChange((data) => {
      const activeConvId = useChatStore.getState().activeConversation?.id

      // Always process idle transitions for per-conversation streaming bookkeeping
      if (data.to === 'idle' && data.conversationId) {
        useChatStore.setState((state) => {
          if (!state.streamingConversationIds.has(data.conversationId!)) return state
          const newSet = new Set(state.streamingConversationIds)
          newSet.delete(data.conversationId!)
          return { streamingConversationIds: newSet }
        })
      }

      // Guard: only update conversationState for active conversation
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
    })

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
    appendStreamChunk,
    handleKeepalive,
    updateStreamingIdentity,
    finalizeStream,
    addToolActivity,
    updateToolActivity,
    updateStatus,
    setAgentReady,
    setCompactSuggestion,
    setBudgetCapBanner,
    setPendingQuestions,
    setAvailable,
    setNotAvailable,
    setDownloaded,
    setProgress,
    setError,
    onMemoryFeedProgress,
    finalizeTurnBubble,
    setConversationState,
    loadContextUsage
  ])

  // Brief loading state while profile loads
  if (isProfileLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-base">
        <div className="flex flex-col items-center gap-4">
          <div
            className="w-10 h-10 border border-primary/30 rounded animate-pulse"
            style={{ transform: 'rotate(45deg)' }}
          >
            <div className="w-full h-full border border-primary/10 rounded m-0.5" />
          </div>
          <span className="text-sm text-text-muted tracking-widest">Loading...</span>
        </div>
      </div>
    )
  }

  // Show welcome modal on first launch
  if (!hasCompletedWelcome) {
    return <WelcomeModal onComplete={handleWelcomeComplete} />
  }

  return (
    <>
      <AppLayout />
      <CheckpointApprovalModal />
      <ElicitationModal />
      <UpdateAvailableModal />
    </>
  )
}

export default App
