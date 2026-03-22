import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { BrainEntry } from '../../shared/types'
import { brainService } from '../services/brain.service'
import { validateSender } from './validate-sender'

export function registerBrainIpc(): void {
  // Get full brain context for display or prompt injection
  ipcMain.handle(IPC_CHANNELS.BRAIN_GET_CONTEXT, async (event, args: { workspacePath: string }) => {
    validateSender(event)
    if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
      throw new Error('Invalid workspace path')
    }
    return brainService.getContext(args.workspacePath)
  })

  // Get project state summary
  ipcMain.handle(IPC_CHANNELS.BRAIN_GET_STATE, async (event, args: { workspacePath: string }) => {
    validateSender(event)
    if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
      throw new Error('Invalid workspace path')
    }
    return brainService.getProjectState(args.workspacePath)
  })

  // Manually log a decision from the UI
  ipcMain.handle(
    IPC_CHANNELS.BRAIN_LOG_DECISION,
    async (event, args: { workspacePath: string; entry: BrainEntry }) => {
      validateSender(event)
      if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
        throw new Error('Invalid workspace path')
      }
      if (!args.entry || typeof args.entry.summary !== 'string') {
        throw new Error('Invalid brain entry')
      }
      brainService.logDecision(args.workspacePath, args.entry)
    }
  )
}
