import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { agentSyncService } from '../services/agent-sync.service'
import { validateSender } from './validate-sender'

export function registerSyncIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SYNC_COMPUTE_DIFF, (event, args: { workspacePath: string }) => {
    validateSender(event)
    return agentSyncService.computeDiff(args.workspacePath)
  })

  ipcMain.handle(
    IPC_CHANNELS.SYNC_APPLY,
    (event, args: { workspacePath: string; skipRemoved?: boolean }) => {
      validateSender(event)
      return agentSyncService.applySync(args.workspacePath, {
        skipRemoved: args.skipRemoved
      })
    }
  )
}
