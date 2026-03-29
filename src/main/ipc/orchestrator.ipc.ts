import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { mainLogger } from '../logger'
import { generalistService, orchestratorService } from '../services'
import { validateSender } from './validate-sender'

const log = mainLogger

export function registerOrchestratorIpc(mainWindow: BrowserWindow): void {
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

    // Already running for this workspace — re-send ready event so the renderer
    // transitions out of 'starting' state (fixes Home → re-select same workspace)
    if (generalistService.isRunning() && generalistService.getWorkspacePath() === workspacePath) {
      log.info('Generalist already running for:', workspacePath, '— re-sending ready')
      mainWindow.webContents.send(IPC_CHANNELS.ORCHESTRATOR_READY)
      return
    }

    startingWorkspace = workspacePath
    try {
      // Start generalist (SDK session) — initializes workspace context, no process spawned
      await generalistService.start(workspacePath)
      log.info('Generalist initialized for:', workspacePath)

      // SDK-based generalist is ready immediately after start() — no process spawn needed.
      // Notify the renderer right away so the chat UI is shown.
      log.info('Generalist ready (SDK mode) for:', workspacePath)
      mainWindow.webContents.send(IPC_CHANNELS.ORCHESTRATOR_READY)

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
