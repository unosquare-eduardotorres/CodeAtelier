import { useEffect } from 'react'
import { AppLayout } from '@renderer/components/layout'
import { PixelOfficeFullscreen } from '@renderer/components/pixel-office'
import { useWorkspaceStore, useChatStore, useAgentStore } from '@renderer/store'
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

  useEffect(() => {
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
        tokenUsage: data.tokenUsage
      })
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
    }
  }, [
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
    endGrillSession
  ])

  // Pop-out mode: render only the Pixel Office fullscreen
  if (isPixelOfficePopout) {
    return <PixelOfficeFullscreen />
  }

  return <AppLayout />
}

export default App
