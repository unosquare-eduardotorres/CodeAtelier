import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import {
  specialistConversationHistoryRepository,
  type SpecialistConversationHistoryAction
} from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerSpecialistConversationHistoryIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_GET_CONVERSATION_HISTORY,
    async (event, args: { conversationId: string; limit?: number }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }
      if (
        typeof args.limit !== 'undefined' &&
        (!Number.isFinite(args.limit) || !Number.isInteger(args.limit) || args.limit <= 0)
      ) {
        throw new Error('Invalid history limit')
      }

      return specialistConversationHistoryRepository.findByConversation(
        args.conversationId,
        args.limit
      )
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_ADD_CONVERSATION_HISTORY_ENTRY,
    async (
      event,
      args: {
        conversationId: string
        specialistId: string
        action: SpecialistConversationHistoryAction
      }
    ) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }
      if (!args || typeof args.specialistId !== 'string' || args.specialistId.trim().length === 0) {
        throw new Error('Invalid specialist ID')
      }
      if (args.action !== 'activated' && args.action !== 'deactivated') {
        throw new Error('Invalid conversation history action')
      }

      return specialistConversationHistoryRepository.create(
        args.conversationId,
        args.specialistId,
        args.action
      )
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_CLEAR_CONVERSATION_HISTORY,
    async (event, args: { conversationId: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }

      specialistConversationHistoryRepository.clearByConversation(args.conversationId)
    }
  )
}
