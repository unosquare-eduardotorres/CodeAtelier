import { useEffect } from 'react'
import { AppLayout } from '@renderer/components/layout'
import { useWorkspaceStore, useChatStore, useAgentStore } from '@renderer/store'
import type { ConversationMode } from '../../shared/types'

function App(): React.JSX.Element {
  const { loadWorkspaces, setOrchestratorReady } = useWorkspaceStore()
  const { appendStreamChunk, finalizeStream, setHandoff, addToolActivity, updateToolActivity } = useChatStore()
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
            startedAt: data.toolActivity.startedAt ?? Date.now()
          })
        } else {
          updateToolActivity({
            toolName: data.toolActivity.toolName,
            status: data.toolActivity.status,
            completedAt: data.toolActivity.completedAt ?? Date.now()
          })
        }
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
      unsubReady()
      unsubAgent()
    }
  }, [loadWorkspaces, appendStreamChunk, finalizeStream, setHandoff, addToolActivity, updateToolActivity, updateStatus, setOrchestratorReady])

  return <AppLayout />
}

export default App
