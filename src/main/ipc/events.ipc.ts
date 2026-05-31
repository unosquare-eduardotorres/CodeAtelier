import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { eventRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString, optionalNumber } from './validate-args'

export function registerEventsIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.EVENTS_GET_RECENT,
    (event, rawArgs?: unknown) => {
      validateSender(event)
      // args is optional — no workspace filter returns all events
      if (!rawArgs) return eventRepository.getRecent(200)
      const args = requireObject(rawArgs, IPC_CHANNELS.EVENTS_GET_RECENT)
      const workspaceId = optionalString(args, 'workspaceId', IPC_CHANNELS.EVENTS_GET_RECENT)
      const limit = optionalNumber(args, 'limit', IPC_CHANNELS.EVENTS_GET_RECENT) ?? 200
      if (workspaceId) {
        return eventRepository.getRecentByWorkspace(workspaceId, limit)
      }
      return eventRepository.getRecent(limit)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.EVENTS_GET_BY_CONVERSATION,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.EVENTS_GET_BY_CONVERSATION)
      const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.EVENTS_GET_BY_CONVERSATION)
      const limit = optionalNumber(args, 'limit', IPC_CHANNELS.EVENTS_GET_BY_CONVERSATION) ?? 100
      return eventRepository.findByConversation(conversationId, limit)
    }
  )
}
