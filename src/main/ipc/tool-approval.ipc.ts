import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ToolApprovalMode } from '../services/tool-approval.service'
import { toolApprovalService } from '../services/tool-approval.service'

export function registerToolApprovalIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.TOOL_APPROVAL_RESPONSE,
    (_event, requestId: string, approved: boolean) => {
      toolApprovalService.resolveApproval(requestId, approved)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TOOL_APPROVAL_SET_MODE,
    (_event, mode: ToolApprovalMode) => {
      toolApprovalService.setSessionMode(mode)
    }
  )

  ipcMain.handle(IPC_CHANNELS.TOOL_APPROVAL_GET_MODE, () => {
    return toolApprovalService.getSessionMode()
  })
}
