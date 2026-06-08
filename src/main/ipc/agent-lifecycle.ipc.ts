import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { mainLogger } from '../logger'
import { chatAgentService } from '../services'
import { chatStreamService } from '../services/chat-stream.service'
import { validateSender } from './validate-sender'
import { workspaceRepository } from '../db/repositories'

const log = mainLogger

export function registerAgentLifecycleIpc(mainWindow: BrowserWindow): void {
  let startingWorkspace: string | null = null // guard against double-start (React strict mode)

  /**
   * AGENT_START — start or re-activate a session for a workspace.
   *
   * Accepts either a workspacePath string (backward compat) or an object
   * { workspaceId, workspacePath }. Does NOT kill sessions for other workspaces.
   */
  ipcMain.handle(
    IPC_CHANNELS.AGENT_START,
    async (event, args: string | { workspaceId: string; workspacePath: string }) => {
      validateSender(event)

      // Normalize args — support both old (string) and new (object) shapes
      let workspaceId: string
      let workspacePath: string

      if (typeof args === 'string') {
        // Backward compat: resolve workspaceId from path
        workspacePath = args
        const workspace = workspaceRepository.findByPath(workspacePath)
        workspaceId = workspace?.id ?? workspacePath
      } else {
        workspaceId = args.workspaceId
        workspacePath = args.workspacePath
      }

      if (!workspacePath || workspacePath.trim().length === 0) {
        throw new Error('Invalid workspace path')
      }

      // Skip if already starting for this workspace
      if (startingWorkspace === workspacePath) {
        log.info('Agent already starting for:', workspacePath, '— skipping')
        return
      }

      // Already running for this workspace — re-send ready event so the renderer
      // transitions out of 'starting' state (fixes Home → re-select same workspace,
      // HMR double-mounts, and auto-open refreshes that would otherwise abort an active stream)
      if (chatAgentService.hasSessionForWorkspace(workspaceId)) {
        log.info(
          'Chat agent already running for workspace:',
          workspaceId,
          '— re-sending ready (role=' + chatAgentService.getActiveRole() + ')'
        )
        // Force-reset any stuck streaming state from the previous workspace
        chatStreamService.forceResetIfStuck()
        chatAgentService.setActiveWorkspace(workspaceId)
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_READY, { workspaceId })
        return
      }

      startingWorkspace = workspacePath
      try {
        // Force-reset any stuck streaming state before starting a new workspace session
        chatStreamService.forceResetIfStuck()
        // Start a NEW session for this workspace (does NOT kill existing sessions)
        await chatAgentService.startForWorkspace(workspaceId, workspacePath)
        log.info(
          'Chat agent ready for workspace:',
          workspaceId,
          '— role=' + chatAgentService.getActiveRole()
        )
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_READY, { workspaceId })
      } catch (error) {
        log.error('Failed to start services:', error)
        throw error
      } finally {
        startingWorkspace = null
      }
    }
  )

  /**
   * WORKSPACE_ALL_STATUSES — get statuses of all running workspace sessions.
   */
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_ALL_STATUSES, async (event) => {
    validateSender(event)

    const statuses: Record<string, unknown> = {}
    for (const [wsId, status] of chatAgentService.getAllStatuses()) {
      statuses[wsId] = status
    }
    // TODO Phase 3: merge grill, audit, MPA statuses
    return statuses
  })
}
