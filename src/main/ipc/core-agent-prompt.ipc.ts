import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { coreAgentPromptRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerCoreAgentPromptIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CORE_AGENT_PROMPT_LIST, (event) => {
    validateSender(event)
    return coreAgentPromptRepository.findAll()
  })

  ipcMain.handle(
    IPC_CHANNELS.CORE_AGENT_PROMPT_GET,
    (
      event,
      args: {
        agentRole: 'generalist' | 'orchestrator'
        mode: 'plan' | 'build'
      }
    ) => {
      validateSender(event)
      if (!args?.agentRole) throw new Error('agentRole is required')
      if (!args?.mode) throw new Error('mode is required')
      if (!['generalist', 'orchestrator'].includes(args.agentRole)) {
        throw new Error('agentRole must be "generalist" or "orchestrator"')
      }
      if (!['plan', 'build'].includes(args.mode)) {
        throw new Error('mode must be "plan" or "build"')
      }
      return coreAgentPromptRepository.findByRoleAndMode(args.agentRole, args.mode)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT,
    (
      event,
      args: {
        agentRole: 'generalist' | 'orchestrator'
        mode: 'plan' | 'build'
        promptText: string
      }
    ) => {
      validateSender(event)
      if (!args?.agentRole) throw new Error('agentRole is required')
      if (!args?.mode) throw new Error('mode is required')
      if (!args?.promptText?.trim()) throw new Error('promptText cannot be empty')
      if (!['generalist', 'orchestrator'].includes(args.agentRole)) {
        throw new Error('agentRole must be "generalist" or "orchestrator"')
      }
      if (!['plan', 'build'].includes(args.mode)) {
        throw new Error('mode must be "plan" or "build"')
      }
      return coreAgentPromptRepository.upsert(args.agentRole, args.mode, args.promptText)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CORE_AGENT_PROMPT_RESET,
    (
      event,
      args: {
        agentRole: 'generalist' | 'orchestrator'
        mode: 'plan' | 'build'
      }
    ) => {
      validateSender(event)
      if (!args?.agentRole) throw new Error('agentRole is required')
      if (!args?.mode) throw new Error('mode is required')
      if (!['generalist', 'orchestrator'].includes(args.agentRole)) {
        throw new Error('agentRole must be "generalist" or "orchestrator"')
      }
      if (!['plan', 'build'].includes(args.mode)) {
        throw new Error('mode must be "plan" or "build"')
      }
      return coreAgentPromptRepository.resetToDefault(args.agentRole, args.mode)
    }
  )
}
