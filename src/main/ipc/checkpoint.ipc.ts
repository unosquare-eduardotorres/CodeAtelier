import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { checkpointService } from '../services/checkpoint.service'
import { generalistService } from '../services'
import { validateSender } from './validate-sender'

export function registerCheckpointIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_LIST,
    (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('conversationId is required')
      return checkpointService.listCheckpoints(args.conversationId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_RESTORE,
    (event, args: { checkpointId: string }) => {
      validateSender(event)
      if (!args?.checkpointId) throw new Error('checkpointId is required')

      const workspacePath = generalistService.getWorkspacePath()
      if (!workspacePath) {
        throw new Error('No workspace path — generalist not started')
      }

      return checkpointService.restoreGitState(args.checkpointId, workspacePath)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_APPROVAL_RESPONSE,
    (event, args: { checkpointId: string; approved: boolean }) => {
      validateSender(event)
      if (!args?.checkpointId) throw new Error('checkpointId is required')
      checkpointService.resolveApproval(args.checkpointId, args.approved)
    }
  )
}
