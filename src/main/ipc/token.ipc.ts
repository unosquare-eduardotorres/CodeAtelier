import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { agentSessionRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerTokenIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.TOKEN_GET_WORKSPACE_SUMMARY,
    (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('workspaceId is required')
      return agentSessionRepository.getTokenSummary(args.workspaceId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TOKEN_GET_CONVERSATION_SUMMARY,
    (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('conversationId is required')
      return agentSessionRepository.getConversationTokenSummary(args.conversationId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TOKEN_GET_RECENT_SESSIONS,
    (event, args: { workspaceId: string; limit?: number }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('workspaceId is required')
      return agentSessionRepository.getRecent(args.workspaceId, args.limit ?? 50)
    }
  )
}
