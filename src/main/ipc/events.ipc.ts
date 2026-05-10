import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { eventRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerEventsIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.EVENTS_GET_RECENT,
    (event, args?: { workspaceId?: string; limit?: number }) => {
      validateSender(event)
      if (args?.workspaceId) {
        return eventRepository.getRecentByWorkspace(args.workspaceId, args?.limit ?? 200)
      }
      return eventRepository.getRecent(args?.limit ?? 200)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.EVENTS_GET_BY_CONVERSATION,
    (event, args: { conversationId: string; limit?: number }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('conversationId is required')
      return eventRepository.findByConversation(args.conversationId, args.limit ?? 100)
    }
  )
}
