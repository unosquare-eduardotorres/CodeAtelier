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

    // Stop generalist (long-lived interactive process)
    try {
      if (chatAgentService.isRunning()) {
        await chatAgentService.stop()
        results.push('Generalist stopped')
      }
    } catch (error) {
      log.error('Failed to stop generalist:', error)
      results.push(`Generalist stop failed: ${(error as Error).message}`)
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

  // Forward status updates from generalist
  chatAgentService.on('statusUpdate', (status: AgentStatus) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_UPDATE, status)
  })
}
