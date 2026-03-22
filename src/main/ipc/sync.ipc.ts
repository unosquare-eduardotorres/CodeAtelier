import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { agentSyncService } from '../services/agent-sync.service'

export function registerSyncIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SYNC_COMPUTE_DIFF, (_event, args: { workspacePath: string }) => {
    return agentSyncService.computeDiff(args.workspacePath)
  })

  ipcMain.handle(
    IPC_CHANNELS.SYNC_APPLY,
    (_event, args: { workspacePath: string; skipRemoved?: boolean }) => {
      return agentSyncService.applySync(args.workspacePath, {
        skipRemoved: args.skipRemoved
      })
    }
  )
}
