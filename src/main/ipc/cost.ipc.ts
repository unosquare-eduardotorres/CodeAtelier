import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { costTrackerService } from '../services/cost-tracker.service'
import { validateSender } from './validate-sender'

export function registerCostIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.COST_GET_WORKSPACE_SUMMARY,
    (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('workspaceId is required')
      return costTrackerService.getWorkspaceCostSummary(args.workspaceId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COST_CHECK_BUDGET,
    (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('workspaceId is required')
      return costTrackerService.checkBudget(args.workspaceId)
    }
  )
}
