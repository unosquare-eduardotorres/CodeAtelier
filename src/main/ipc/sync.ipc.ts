import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { agentSyncService } from '../services/agent-sync.service'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalBoolean } from './validate-args'

export function registerSyncIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SYNC_COMPUTE_DIFF, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.SYNC_COMPUTE_DIFF)
    const workspacePath = requireString(args, 'workspacePath', IPC_CHANNELS.SYNC_COMPUTE_DIFF)
    return agentSyncService.computeDiff(workspacePath)
  })

  ipcMain.handle(IPC_CHANNELS.SYNC_APPLY, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.SYNC_APPLY)
    const workspacePath = requireString(args, 'workspacePath', IPC_CHANNELS.SYNC_APPLY)
    const skipRemoved = optionalBoolean(args, 'skipRemoved', IPC_CHANNELS.SYNC_APPLY)
    return agentSyncService.applySync(workspacePath, { skipRemoved })
  })
}
