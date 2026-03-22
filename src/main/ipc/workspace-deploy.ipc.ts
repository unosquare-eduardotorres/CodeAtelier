import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ActivationProgressEvent } from '../../shared/types'
import { workspaceDeployService } from '../services/workspace-deploy.service'

export function registerWorkspaceDeployIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SCAN_CLAUDE,
    (_event, args: { workspacePath: string }) => {
      return workspaceDeployService.scanWorkspaceClaude(args.workspacePath)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_ACTIVATE_AGENTS,
    async (event, args: { workspacePath: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)

      const onProgress = (progressEvent: ActivationProgressEvent): void => {
        win?.webContents.send(IPC_CHANNELS.WORKSPACE_ACTIVATION_PROGRESS, progressEvent)
      }

      return workspaceDeployService.activateAgents(args.workspacePath, onProgress)
    }
  )

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CANCEL_ACTIVATION, () => {
    workspaceDeployService.shutdown()
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_READ_FILE,
    (_event, args: { filePath: string }) => {
      return workspaceDeployService.readWorkspaceFile(args.filePath)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_WRITE_FILE,
    (_event, args: { filePath: string; content: string }) => {
      workspaceDeployService.writeWorkspaceFile(args.filePath, args.content)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SCAN_SKILLS,
    (_event, args: { workspacePath: string }) => {
      return workspaceDeployService.scanWorkspaceSkills(args.workspacePath)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SCAN_AGENTS,
    (_event, args: { workspacePath: string }) => {
      return workspaceDeployService.scanWorkspaceAgents(args.workspacePath)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_CONFIRM_CLAUDE_MD,
    (_event, args: { workspacePath: string; content: string }) => {
      workspaceDeployService.confirmClaudeMd(args.workspacePath, args.content)
    }
  )
}
