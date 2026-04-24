import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ToolApprovalMode } from '../services/tool-approval.service'
import { toolApprovalService } from '../services/tool-approval.service'
import { validateSender } from './validate-sender'

export function registerToolApprovalIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.TOOL_APPROVAL_RESPONSE,
    (event, requestId: string, approved: boolean) => {
      validateSender(event)
      toolApprovalService.resolveApproval(requestId, approved)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TOOL_APPROVAL_SET_MODE,
    (event, mode: ToolApprovalMode) => {
      validateSender(event)
      toolApprovalService.setSessionMode(mode)
    }
  )

  ipcMain.handle(IPC_CHANNELS.TOOL_APPROVAL_GET_MODE, (event) => {
    validateSender(event)
    return toolApprovalService.getSessionMode()
  })
}
