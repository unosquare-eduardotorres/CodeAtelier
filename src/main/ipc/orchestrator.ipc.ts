import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { mainLogger } from '../logger'
import { generalistService, orchestratorService } from '../services'
import { validateSender } from './validate-sender'

const log = mainLogger

export function registerOrchestratorIpc(): void {
  let startingWorkspace: string | null = null // guard against double-start (React strict mode)

  ipcMain.handle(IPC_CHANNELS.ORCHESTRATOR_START, async (event, workspacePath: string) => {
    validateSender(event)

    if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) {
      throw new Error('Invalid workspace path')
    }

    // Skip if already starting for this workspace
    if (startingWorkspace === workspacePath) {
      log.info('Orchestrator already starting for:', workspacePath, '— skipping')
      return
    }

    // Skip if already running for this workspace
    if (generalistService.isRunning() && generalistService.getWorkspacePath() === workspacePath) {
      log.info('Generalist already running for:', workspacePath, '— skipping')
      return
    }

    startingWorkspace = workspacePath
    try {
      // Start generalist (long-lived interactive session) — returns immediately (non-blocking)
      await generalistService.start(workspacePath)
      log.info('Generalist spawned for:', workspacePath)

      // With --input-format stream-json, the CLI is ready to receive messages immediately
      // after spawn — no need to wait for the system init event (which only arrives after
      // the first stdin message). Notify the renderer right away so the chat UI is shown.
      log.info('Generalist ready (stream-json mode) for:', workspacePath)
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send(IPC_CHANNELS.ORCHESTRATOR_READY)
      }

      // Pre-initialize orchestrator workspace path (no process spawned yet)
      await orchestratorService.start(workspacePath)
      log.info('Orchestrator initialized for:', workspacePath)
    } catch (error) {
      log.error('Failed to start services:', error)
      throw error
    } finally {
      startingWorkspace = null
    }
  })
}
