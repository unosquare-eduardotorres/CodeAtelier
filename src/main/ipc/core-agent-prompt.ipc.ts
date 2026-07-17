import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { coreAgentPromptRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

export function registerCoreAgentPromptIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CORE_AGENT_PROMPT_LIST, (event) => {
    validateSender(event)
    return coreAgentPromptRepository.findAll()
  })

  ipcMain.handle(IPC_CHANNELS.CORE_AGENT_PROMPT_GET, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CORE_AGENT_PROMPT_GET)
    const agentRole = requireString(args, 'agentRole', IPC_CHANNELS.CORE_AGENT_PROMPT_GET)
    const mode = requireString(args, 'mode', IPC_CHANNELS.CORE_AGENT_PROMPT_GET)
    if (agentRole !== 'specialist') {
      throw new Error(`${IPC_CHANNELS.CORE_AGENT_PROMPT_GET}: agentRole must be "specialist"`)
    }
    if (mode !== 'plan' && mode !== 'build' && mode !== 'danger') {
      throw new Error(
        `${IPC_CHANNELS.CORE_AGENT_PROMPT_GET}: mode must be "plan", "build", or "danger"`
      )
    }
    return coreAgentPromptRepository.findByRoleAndMode(agentRole, mode)
  })

  ipcMain.handle(IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT)
    const agentRole = requireString(args, 'agentRole', IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT)
    const mode = requireString(args, 'mode', IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT)
    const promptText = requireString(args, 'promptText', IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT)
    if (agentRole !== 'specialist') {
      throw new Error(`${IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT}: agentRole must be "specialist"`)
    }
    if (mode !== 'plan' && mode !== 'build' && mode !== 'danger') {
      throw new Error(
        `${IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT}: mode must be "plan", "build", or "danger"`
      )
    }
    return coreAgentPromptRepository.upsert(agentRole, mode, promptText)
  })

  ipcMain.handle(IPC_CHANNELS.CORE_AGENT_PROMPT_RESET, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CORE_AGENT_PROMPT_RESET)
    const agentRole = requireString(args, 'agentRole', IPC_CHANNELS.CORE_AGENT_PROMPT_RESET)
    const mode = requireString(args, 'mode', IPC_CHANNELS.CORE_AGENT_PROMPT_RESET)
    if (agentRole !== 'specialist') {
      throw new Error(`${IPC_CHANNELS.CORE_AGENT_PROMPT_RESET}: agentRole must be "specialist"`)
    }
    if (mode !== 'plan' && mode !== 'build' && mode !== 'danger') {
      throw new Error(
        `${IPC_CHANNELS.CORE_AGENT_PROMPT_RESET}: mode must be "plan", "build", or "danger"`
      )
    }
    return coreAgentPromptRepository.resetToDefault(agentRole, mode)
  })
}
