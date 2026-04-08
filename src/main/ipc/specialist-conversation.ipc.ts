import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { conversationSpecialistRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerSpecialistConversationIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_GET_CONVERSATION_SPECIALISTS,
    async (event, args: { conversationId: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }

      return conversationSpecialistRepository.findByConversation(args.conversationId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_ADD_CONVERSATION_SPECIALIST,
    async (event, args: { conversationId: string; specialistId: string }) => {
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

      conversationSpecialistRepository.upsert(args.conversationId, args.specialistId, {
        isActive: true
      })
      return conversationSpecialistRepository.findByConversationAndSpecialist(
        args.conversationId,
        args.specialistId
      )
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_REMOVE_CONVERSATION_SPECIALIST,
    async (event, args: { conversationId: string; specialistId: string }) => {
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

      conversationSpecialistRepository.remove(args.conversationId, args.specialistId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_REPLACE_CONVERSATION_SPECIALISTS,
    async (event, args: { conversationId: string; specialistIds: string[] }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }
      if (!Array.isArray(args.specialistIds)) {
        throw new Error('Invalid specialist IDs')
      }
      if (args.specialistIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
        throw new Error('Invalid specialist IDs')
      }

      return conversationSpecialistRepository.replaceConversationSpecialists(
        args.conversationId,
        args.specialistIds
      )
    }
  )
}
