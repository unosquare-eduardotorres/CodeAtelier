import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { bugCouncilService } from '../services/bug-council.service'
import { validateSender } from './validate-sender'

export function registerBugCouncilIpc(): void {
  ipcMain.handle(IPC_CHANNELS.BUG_COUNCIL_GET_SESSION, (event, args: { sessionId: string }) => {
    validateSender(event)
    if (!args?.sessionId) throw new Error('sessionId is required')
    return bugCouncilService.getSession(args.sessionId)
  })

  ipcMain.handle(
    IPC_CHANNELS.BUG_COUNCIL_LIST_SESSIONS,
    (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('conversationId is required')
      return bugCouncilService.listSessions(args.conversationId)
    }
  )
}
