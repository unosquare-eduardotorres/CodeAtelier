import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { mainLogger } from '../logger'
import { chatAgentService } from '../services'
import { validateSender } from './validate-sender'

const log = mainLogger

export function registerAgentLifecycleIpc(mainWindow: BrowserWindow): void {
  let startingWorkspace: string | null = null // guard against double-start (React strict mode)

  ipcMain.handle(IPC_CHANNELS.AGENT_START, async (event, workspacePath: string) => {
    validateSender(event)

    if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) {
      throw new Error('Invalid workspace path')
    }

    // Skip if already starting for this workspace
    if (startingWorkspace === workspacePath) {
      log.info('Agent already starting for:', workspacePath, '— skipping')
      return
    }

    // Already running for this workspace — re-send ready event so the renderer
    // transitions out of 'starting' state (fixes Home → re-select same workspace)
    if (chatAgentService.isRunning() && chatAgentService.getWorkspacePath() === workspacePath) {
      log.info(
        'Chat agent already running for:',
        workspacePath,
        '— re-sending ready (role=' + chatAgentService.getActiveRole() + ')'
      )
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_READY)
      return
    }

    startingWorkspace = workspacePath
    try {
      // Start the chat agent (SDK session) — picks Da Vinci or the workspace's
      // Project Specialist depending on build_status. No process spawned.
      await chatAgentService.start(workspacePath)
      log.info(
        'Chat agent ready (SDK mode) for:',
        workspacePath,
        '— role=' + chatAgentService.getActiveRole()
      )
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_READY)
    } catch (error) {
      log.error('Failed to start services:', error)
      throw error
    } finally {
      startingWorkspace = null
    }
  })
}
