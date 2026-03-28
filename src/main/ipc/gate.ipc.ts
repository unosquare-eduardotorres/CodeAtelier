import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { gateResultRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerGateIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.GATE_RESULTS_GET,
    (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('conversationId is required')
      return gateResultRepository.findByConversation(args.conversationId)
    }
  )
}
