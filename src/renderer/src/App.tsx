import { useEffect, useCallback } from 'react'
import { AppLayout } from '@renderer/components/layout'
import { PixelOfficeFullscreen } from '@renderer/components/pixel-office'
import { WelcomeModal } from '@renderer/components/common'
import {
  useWorkspaceStore,
  useChatStore,
  useAgentStore,
  useUpdateStore,
  useMemoryStore,
  useDreamStore,
  useProfileStore
} from '@renderer/store'
import type { ConversationMode, TaskPlan } from '../../shared/types'

// Check if this window was opened as a Pixel Office pop-out
const isPixelOfficePopout =
  new URLSearchParams(window.location.search).get('view') === 'pixel-office'

function App(): React.JSX.Element {
  const { loadWorkspaces, setOrchestratorReady } = useWorkspaceStore()
  const {
    appendStreamChunk,
    finalizeStream,
    setHandoff,
    addToolActivity,
    updateToolActivity,
    setTaskPlan,
    updateTaskProgress,
    setCompactSuggestion,
    endGrillSession
  } = useChatStore()
  const { updateStatus } = useAgentStore()
  const { setAvailable, setNotAvailable, setDownloaded, setProgress, setError } = useUpdateStore()
  const { onFeedProgress: onMemoryFeedProgress } = useMemoryStore()
  const { onProgress: onDreamProgress } = useDreamStore()
  const {
    isLoading: isProfileLoading,
    hasCompletedWelcome,
    loadProfile,
    saveProfile
  } = useProfileStore()

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
      if (data.chunk) {
        appendStreamChunk(data.chunk, data.role as 'generalist' | 'coordinator')
      }
      if (data.toolActivity) {
        if (data.toolActivity.status === 'running') {
          addToolActivity({
            id: data.toolActivity.id,
            toolName: data.toolActivity.toolName,
            status: 'running',
            input: data.toolActivity.input,
            startedAt: data.toolActivity.startedAt ?? Date.now()
          })
        } else {
          updateToolActivity({
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
      finalizeStream(data.messageId)
    })

    const unsubHandoff = window.api.onHandoff((data) => {
      setHandoff({
        summary: data.summary,
        specialists: data.specialists,
        mode: data.mode as ConversationMode
      })
    })

    const unsubGrillComplete = window.api.onGrillComplete((data) => {
      endGrillSession(data.summary, data.proposedTasks)
    })

    const unsubTaskPlan = window.api.onTaskPlan((data) => {
      setTaskPlan(data as TaskPlan)
    })

    const unsubTaskProgress = window.api.onTaskProgress((data) => {
      updateTaskProgress(data)
    })

    const unsubReady = window.api.onOrchestratorReady(() => {
      setOrchestratorReady()
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
        elapsedMs: data.elapsedMs,
        tokenUsage: data.tokenUsage,
        model: data.model,
        complexityTier: data.complexityTier
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
      unsubTaskPlan()
      unsubTaskProgress()
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
    finalizeStream,
    setHandoff,
    setTaskPlan,
    updateTaskProgress,
    addToolActivity,
    updateToolActivity,
    updateStatus,
    setOrchestratorReady,
    setCompactSuggestion,
    endGrillSession,
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
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-text-muted">Loading...</span>
        </div>
      </div>
    )
  }

  // Show welcome modal on first launch
  if (!hasCompletedWelcome) {
    return <WelcomeModal onComplete={handleWelcomeComplete} />
  }

  return <AppLayout />
}

export default App
