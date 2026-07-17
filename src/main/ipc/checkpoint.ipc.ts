import { ipcMain } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { checkpointService } from '../services/checkpoint.service'
import { chatAgentService } from '../services'
import { messageRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalBoolean } from './validate-args'

const cpLog = log.scope('checkpoint-ipc')

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
      throw new Error('No workspace path — agent not started')
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
      throw new Error('No workspace path — agent not started')
    }

    // 1) Restore git state
    const gitResult = checkpointService.restoreGitState(checkpointId, workspacePath)
    if (!gitResult.success) {
      return { success: false, message: gitResult.message, messagesRemoved: 0 }
    }

    // 2) Truncate messages after checkpoint timestamp
    // ATOM-04: If message truncation fails, log the error but don't leave
    // the user in an inconsistent state — git was already restored.
    const checkpoints = checkpointService.listCheckpoints(conversationId)
    const checkpoint = checkpoints.find((c) => c.id === checkpointId)
    let messagesRemoved = 0
    if (checkpoint) {
      try {
        messagesRemoved = messageRepository.truncateAfterTimestamp(
          conversationId,
          checkpoint.createdAt
        )
      } catch (err) {
        cpLog.error(
          `[checkpoint:rewind] Message truncation failed after git restore (checkpoint=${checkpointId}):`,
          err
        )
        return {
          success: false,
          message: `Git state restored but message truncation failed: ${(err as Error).message}`,
          messagesRemoved: 0
        }
      }
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
