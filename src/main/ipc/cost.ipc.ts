import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { costTrackerService } from '../services/cost-tracker.service'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

export function registerCostIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.COST_GET_WORKSPACE_SUMMARY,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.COST_GET_WORKSPACE_SUMMARY)
      const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.COST_GET_WORKSPACE_SUMMARY)
      return costTrackerService.getWorkspaceCostSummary(workspaceId)
    }
  )

  ipcMain.handle(IPC_CHANNELS.COST_GET_CONVERSATION, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.COST_GET_CONVERSATION)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.COST_GET_CONVERSATION)
    return costTrackerService.getConversationCostCents(conversationId)
  })

  ipcMain.handle(
    IPC_CHANNELS.COST_GET_WORKSPACE_CONVERSATIONS,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.COST_GET_WORKSPACE_CONVERSATIONS)
      const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.COST_GET_WORKSPACE_CONVERSATIONS)
      return costTrackerService.getWorkspaceConversationCosts(workspaceId)
    }
  )

  ipcMain.handle(IPC_CHANNELS.COST_CHECK_BUDGET, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.COST_CHECK_BUDGET)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.COST_CHECK_BUDGET)
    return costTrackerService.checkBudget(workspaceId)
  })
}
