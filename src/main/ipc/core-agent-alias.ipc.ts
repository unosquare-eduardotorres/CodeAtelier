import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { coreAgentAliasRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerCoreAgentAliasIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CORE_AGENT_LIST, (event) => {
    validateSender(event)
    return coreAgentAliasRepository.findAll()
  })

  ipcMain.handle(
    IPC_CHANNELS.CORE_AGENT_UPSERT,
    (
      event,
      args: {
        agentRole: 'da-vinci'
        alias: string | null
        avatarKey: string | null
      }
    ) => {
      validateSender(event)
      if (!args?.agentRole) throw new Error('agentRole is required')
      if (args.agentRole !== 'da-vinci') {
        throw new Error('agentRole must be "da-vinci"')
      }
      return coreAgentAliasRepository.upsert(
        args.agentRole,
        args.alias?.trim() || null,
        args.avatarKey?.trim() || null
      )
    }
  )
}
