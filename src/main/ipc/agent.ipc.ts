import { ipcMain, type BrowserWindow } from 'electron'
import { chatAgentService } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type { AgentStatus } from '../../shared/types'
import { agentIpcLogger } from '../logger'
import { validateSender } from './validate-sender'

const log = agentIpcLogger

export function registerAgentIpc(mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUSES, async (event) => {
    validateSender(event)

    return [chatAgentService.getStatus()]
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_STOP_ALL, async (event) => {
    validateSender(event)

    log.info('Stopping all agents...')

    const results: string[] = []

    // Stop ALL workspace sessions (not just active)
    try {
      const sessionCount = chatAgentService.activeSessionCount
      if (sessionCount > 0) {
        await chatAgentService.stopAll()
        results.push(`${sessionCount} session(s) stopped`)
      }
    } catch (error) {
      log.error('Failed to stop sessions:', error)
      results.push(`Session stop failed: ${(error as Error).message}`)
    }

    // Broadcast updated statuses to renderer
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_UPDATE, chatAgentService.getStatus())

    log.info('Stop all results:', results)
    return results
  })

  // Strategy M: Cache efficiency metrics for dashboard
  ipcMain.handle(IPC_CHANNELS.AGENT_CACHE_EFFICIENCY, async (event) => {
    validateSender(event)
    return chatAgentService.getCacheEfficiency()
  })

  // Forward status updates from active workspace session
  chatAgentService.on('statusUpdate', (status: AgentStatus) => {
    // Tag with workspaceId for multi-workspace routing
    const workspaceId = chatAgentService.activeWorkspaceId
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_UPDATE, {
      ...status,
      workspaceId: workspaceId ?? undefined
    })
  })

  // Forward workspace-tagged status updates (from any workspace, not just active)
  // Single merged listener — forwards IPC AND detects completion/failure transitions
  const previousStatuses = new Map<string, string>()

  chatAgentService.on('statusUpdate:ws', (workspaceId: string, status: AgentStatus) => {
    // Forward to renderer
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_UPDATE, {
      ...status,
      workspaceId
    })

    // Track for completion detection
    const prevStatus = previousStatuses.get(workspaceId)
    previousStatuses.set(workspaceId, status.status)

    // Only send completion notifications for background workspaces
    if (workspaceId === chatAgentService.activeWorkspaceId) return

    // Detect transitions to completed or failed
    if (
      (status.status === 'completed' || status.status === 'failed') &&
      prevStatus !== status.status
    ) {
      // Resolve workspace name
      let workspaceName = workspaceId.slice(0, 8)
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load avoids db/repositories circular dependency
        const { workspaceRepository } = require('../db/repositories')
        const ws = workspaceRepository.findById(workspaceId)
        if (ws) workspaceName = ws.name
      } catch {
        /* non-fatal */
      }

      mainWindow.webContents.send(IPC_CHANNELS.COMPLETION_NOTIFICATION, {
        workspaceId,
        workspaceName,
        service: 'chat',
        status: status.status,
        summary:
          status.status === 'completed'
            ? 'Chat session completed'
            : `Chat session failed: ${status.currentTask ?? 'unknown error'}`
      })
    }
  })
}
