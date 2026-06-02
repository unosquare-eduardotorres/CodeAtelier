import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { coreAgentAliasRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalNullableString } from './validate-args'

export function registerCoreAgentAliasIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CORE_AGENT_LIST, (event) => {
    validateSender(event)
    return coreAgentAliasRepository.findAll()
  })

  ipcMain.handle(IPC_CHANNELS.CORE_AGENT_UPSERT, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CORE_AGENT_UPSERT)
    const agentRole = requireString(args, 'agentRole', IPC_CHANNELS.CORE_AGENT_UPSERT)
    if (agentRole !== 'da-vinci') {
      throw new Error(`${IPC_CHANNELS.CORE_AGENT_UPSERT}: agentRole must be "da-vinci"`)
    }
    const alias = optionalNullableString(args, 'alias', IPC_CHANNELS.CORE_AGENT_UPSERT)
    const avatarKey = optionalNullableString(args, 'avatarKey', IPC_CHANNELS.CORE_AGENT_UPSERT)
    return coreAgentAliasRepository.upsert(
      agentRole,
      alias?.trim() || null,
      avatarKey?.trim() || null
    )
  })
}
