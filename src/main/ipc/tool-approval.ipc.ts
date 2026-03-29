import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { toolApprovalService } from '../services/tool-approval.service'

export function registerToolApprovalIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.TOOL_APPROVAL_RESPONSE,
    (_event, requestId: string, approved: boolean) => {
      toolApprovalService.resolveApproval(requestId, approved)
    }
  )
}
