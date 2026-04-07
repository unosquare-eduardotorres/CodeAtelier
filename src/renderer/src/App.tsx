import { useEffect, useCallback } from 'react'
import { AppLayout } from '@renderer/components/layout'
import { PixelOfficeFullscreen } from '@renderer/components/pixel-office'
import { WelcomeModal, ToolApprovalModal, CheckpointApprovalModal, RateLimitBanner } from '@renderer/components/common'
import {
  useWorkspaceStore,
  useChatActions,
  useAgentStore,
  useUpdateStore,
  useMemoryStore,
  useDreamStore,
  useProfileStore
} from '@renderer/store'
import type { ConversationMode } from '../../shared/types'
import { rendererLog } from '@renderer/utils/logger'

// Check if this window was opened as a Pixel Office pop-out
const isPixelOfficePopout =
  new URLSearchParams(window.location.search).get('view') === 'pixel-office'

function App(): React.JSX.Element {
  // Workspace actions (stable refs — individual selectors prevent full-store re-renders)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces)
  const setAgentReady = useWorkspaceStore((s) => s.setAgentReady)

  // Chat actions (already uses useShallow internally)
  const {
    appendStreamChunk,
    updateStreamingIdentity,
    finalizeStream,
    finalizeTurnBubble,
    setHandoff,
    addToolActivity,
    updateToolActivity,
    updateTaskProgress,
    setDecomposedTasks,
    setCompactSuggestion,
    endGrillSession,
    setGrillQuestions,
    setPendingQuestions,
    setInvestigationReport
  } = useChatActions()

  // Agent actions
  const updateStatus = useAgentStore((s) => s.updateStatus)

  // Update actions
  const setAvailable = useUpdateStore((s) => s.setAvailable)
  const setNotAvailable = useUpdateStore((s) => s.setNotAvailable)
  const setDownloaded = useUpdateStore((s) => s.setDownloaded)
  const setProgress = useUpdateStore((s) => s.setProgress)
  const setError = useUpdateStore((s) => s.setError)

  // Memory & Dream actions
  const onMemoryFeedProgress = useMemoryStore((s) => s.onFeedProgress)
  const onDreamProgress = useDreamStore((s) => s.onProgress)

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
      // Handle turn boundaries — finalize current bubble and start a new one
      if (data.turnBoundary && data.turnId) {
        finalizeTurnBubble(data.turnId)
        return
      }
      if (data.chunk) {
        appendStreamChunk(
          data.chunk,
          data.role as 'generalist' | 'coordinator' | 'specialist',
          data.taskId,
          data.specialist
        )
      }
      // Update streaming identity even on tool-only chunks (empty text)
      // so the thinking indicator shows the correct agent name
      if (!data.chunk && data.role) {
        updateStreamingIdentity(
          data.role as 'generalist' | 'coordinator' | 'specialist',
          data.taskId,
          data.specialist
        )
      }
      if (data.toolActivity) {
        if (data.toolActivity.elapsedSeconds !== undefined && data.toolActivity.status === 'running') {
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
        setCompactSuggestion(data.compactNeeded)
      }
    })

    const unsubComplete = window.api.onMessageComplete((data) => {
      rendererLog.info(
        `[PIPELINE:renderer:message-complete] messageId=${data.messageId} taskId=${data.taskId ?? 'none'}`
      )
      finalizeStream(data.messageId, data.taskId)
    })

    const unsubHandoff = window.api.onHandoff((data) => {
      rendererLog.info(
        `[PIPELINE:renderer:handoff-received] specialists=${data.specialists?.join(',')}`
      )
      setHandoff({
        summary: data.summary,
        specialists: data.specialists,
        mode: data.mode as ConversationMode
      })
    })

    const unsubGrillComplete = window.api.onGrillComplete((data) => {
      endGrillSession(data.summary, data.proposedTasks)
    })

    const unsubGrillQuestion = window.api.onGrillQuestion((data) => {
      setGrillQuestions(data.questions)
    })

    const unsubAskQuestion = window.api.onAskQuestion((data) => {
      setPendingQuestions(data.questions)
    })

    const unsubTaskProgress = window.api.onTaskProgress((data) => {
      if (data.status === 'completed' || data.status === 'failed') {
        rendererLog.info(
          `[PIPELINE:renderer:task-${data.status}] taskId=${data.taskId}`
        )
      }
      updateTaskProgress(data)
    })

    const unsubBuildTasks = window.api.onBuildTasks((data) => {
      setDecomposedTasks(data.tasks)
    })

    const unsubInvestigationReport = window.api.onInvestigationReport((data) => {
      rendererLog.info(
        `[PIPELINE:renderer:investigation-report-received] taskId=${data.taskId} specialist=${data.specialist}`
      )
      setInvestigationReport(data)
    })

    const unsubReady = window.api.onAgentReady(() => {
      setAgentReady()
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
        model: data.model,
        complexityTier: data.complexityTier,
        activeMcpTools: data.activeMcpTools
      })
    })

    // Auto-update event listeners
    const unsubUpdateAvailable = window.api.onUpdateAvailable((info) => {
      setAvailable(info.version, info.releaseNotes)
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

    // Dream progress listener
    const unsubDreamProgress = window.api.onDreamProgress((progress) => {
      onDreamProgress(progress)
    })

    return () => {
      unsubChunk()
      unsubComplete()
      unsubHandoff()
      unsubGrillComplete()
      unsubGrillQuestion()
      unsubAskQuestion()
      unsubTaskProgress()
      unsubBuildTasks()
      unsubInvestigationReport()
      unsubReady()
      unsubAgent()
      unsubUpdateAvailable()
      unsubUpdateNotAvailable()
      unsubUpdateDownloaded()
      unsubUpdateProgress()
      unsubUpdateError()
      unsubMemoryFeed()
      unsubDreamProgress()
    }
  }, [
    loadProfile,
    loadWorkspaces,
    appendStreamChunk,
    updateStreamingIdentity,
    finalizeStream,
    setHandoff,
    updateTaskProgress,
    addToolActivity,
    updateToolActivity,
    updateStatus,
    setAgentReady,
    setCompactSuggestion,
    endGrillSession,
    setGrillQuestions,
    setPendingQuestions,
    setInvestigationReport,
    setAvailable,
    setNotAvailable,
    setDownloaded,
    setProgress,
    setError,
    onMemoryFeedProgress,
    onDreamProgress
  ])

  // Pop-out mode: render only the Pixel Office fullscreen
  if (isPixelOfficePopout) {
    return <PixelOfficeFullscreen />
  }

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
      <RateLimitBanner />
      <AppLayout />
      <ToolApprovalModal />
      <CheckpointApprovalModal />
    </>
  )
}

export default App
