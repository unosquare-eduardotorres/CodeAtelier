import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { checkpointService } from '../services/checkpoint.service'
import { chatAgentService } from '../services'
import { messageRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalBoolean } from './validate-args'

export function registerCheckpointIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_LIST, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CHECKPOINT_LIST)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CHECKPOINT_LIST)
    return checkpointService.listCheckpoints(conversationId)
  })

  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_RESTORE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CHECKPOINT_RESTORE)
    const checkpointId = requireString(args, 'checkpointId', IPC_CHANNELS.CHECKPOINT_RESTORE)

    const workspacePath = chatAgentService.getWorkspacePath()
    if (!workspacePath) {
      throw new Error('No workspace path — generalist not started')
    }

    return checkpointService.restoreGitState(checkpointId, workspacePath)
  })

  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_REWIND, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CHECKPOINT_REWIND)
    const checkpointId = requireString(args, 'checkpointId', IPC_CHANNELS.CHECKPOINT_REWIND)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CHECKPOINT_REWIND)

    const workspacePath = chatAgentService.getWorkspacePath()
    if (!workspacePath) {
      throw new Error('No workspace path — generalist not started')
    }

    // 1) Restore git state
    const gitResult = checkpointService.restoreGitState(checkpointId, workspacePath)
    if (!gitResult.success) {
      return { success: false, message: gitResult.message, messagesRemoved: 0 }
    }

    // 2) Truncate messages after checkpoint timestamp
    const checkpoints = checkpointService.listCheckpoints(conversationId)
    const checkpoint = checkpoints.find((c) => c.id === checkpointId)
    let messagesRemoved = 0
    if (checkpoint) {
      messagesRemoved = messageRepository.truncateAfterTimestamp(
        conversationId,
        checkpoint.createdAt
      )
    }

    return {
      success: true,
      message: `${gitResult.message}. Removed ${messagesRemoved} message(s).`,
      messagesRemoved
    }
  })

  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_APPROVAL_RESPONSE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CHECKPOINT_APPROVAL_RESPONSE)
    const checkpointId = requireString(
      args,
      'checkpointId',
      IPC_CHANNELS.CHECKPOINT_APPROVAL_RESPONSE
    )
    const approved =
      optionalBoolean(args, 'approved', IPC_CHANNELS.CHECKPOINT_APPROVAL_RESPONSE) ?? false
    checkpointService.resolveApproval(checkpointId, approved)
  })
}
