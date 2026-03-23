import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { agentSessionRepository } from '../db/repositories'

export function registerTokenIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.TOKEN_GET_WORKSPACE_SUMMARY,
    (_event, args: { workspaceId: string }) => {
      if (!args?.workspaceId) throw new Error('workspaceId is required')
      return agentSessionRepository.getTokenSummary(args.workspaceId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TOKEN_GET_CONVERSATION_SUMMARY,
    (_event, args: { conversationId: string }) => {
      if (!args?.conversationId) throw new Error('conversationId is required')
      return agentSessionRepository.getConversationTokenSummary(args.conversationId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TOKEN_GET_RECENT_SESSIONS,
    (_event, args: { workspaceId: string; limit?: number }) => {
      if (!args?.workspaceId) throw new Error('workspaceId is required')
      return agentSessionRepository.getRecent(args.workspaceId, args.limit ?? 50)
    }
  )
}
