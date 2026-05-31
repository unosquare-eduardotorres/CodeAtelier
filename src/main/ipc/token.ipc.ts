import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { agentSessionRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalNumber } from './validate-args'

export function registerTokenIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.TOKEN_GET_WORKSPACE_SUMMARY,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.TOKEN_GET_WORKSPACE_SUMMARY)
      const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.TOKEN_GET_WORKSPACE_SUMMARY)
      return agentSessionRepository.getTokenSummary(workspaceId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TOKEN_GET_CONVERSATION_SUMMARY,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.TOKEN_GET_CONVERSATION_SUMMARY)
      const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.TOKEN_GET_CONVERSATION_SUMMARY)
      return agentSessionRepository.getConversationTokenSummary(conversationId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TOKEN_GET_RECENT_SESSIONS,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.TOKEN_GET_RECENT_SESSIONS)
      const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.TOKEN_GET_RECENT_SESSIONS)
      const limit = optionalNumber(args, 'limit', IPC_CHANNELS.TOKEN_GET_RECENT_SESSIONS)
      return agentSessionRepository.getRecent(workspaceId, limit ?? 50)
    }
  )
}
