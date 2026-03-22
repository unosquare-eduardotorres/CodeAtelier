import { ipcMain, type BrowserWindow } from 'electron'
import { generalistService, orchestratorService } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type { AgentStatus } from '../../shared/types'
import { agentIpcLogger } from '../logger'
import { validateSender } from './validate-sender'

const log = agentIpcLogger

export function registerAgentIpc(mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUSES, async (event) => {
    validateSender(event)

    return [generalistService.getStatus(), orchestratorService.getStatus()]
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_STOP_ALL, async (event) => {
    validateSender(event)

    log.info('Stopping all agents...')

    const results: string[] = []

    // Stop orchestrator (ephemeral per-handoff process)
    try {
      if (orchestratorService.isRunning()) {
        await orchestratorService.stop()
        results.push('Orchestrator stopped')
      }
    } catch (error) {
      log.error('Failed to stop orchestrator:', error)
      results.push(`Orchestrator stop failed: ${(error as Error).message}`)
    }

    // Stop generalist (long-lived interactive process)
    try {
      if (generalistService.isRunning()) {
        await generalistService.stop()
        results.push('Generalist stopped')
      }
    } catch (error) {
      log.error('Failed to stop generalist:', error)
      results.push(`Generalist stop failed: ${(error as Error).message}`)
    }

    // Broadcast updated statuses to renderer
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_UPDATE, generalistService.getStatus())
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_UPDATE, orchestratorService.getStatus())

    log.info('Stop all results:', results)
    return results
  })

  // Forward status updates from both generalist and orchestrator
  generalistService.on('statusUpdate', (status: AgentStatus) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_UPDATE, status)
  })

  orchestratorService.on('statusUpdate', (status: AgentStatus) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_UPDATE, status)
  })
}
