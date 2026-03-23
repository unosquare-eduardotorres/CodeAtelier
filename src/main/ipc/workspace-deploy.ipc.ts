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
    IPC_CHANNELS.WORKSPACE_CLEAN_ACTIVATION,
    (_event, args: { workspacePath: string; removeClaudeMd?: boolean }) => {
      workspaceDeployService.cleanActivation(args.workspacePath, args.removeClaudeMd)
    }
  )

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

  // ── Individual Agent/Skill Delete & Sync ──

  ipcMain.handle(
    IPC_CHANNELS.AGENT_DELETE_FROM_WORKSPACE,
    (_event, args: { workspacePath: string; filename: string }) => {
      workspaceDeployService.deleteAgentFromWorkspace(args.workspacePath, args.filename)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SYNC_TO_WORKSPACE,
    (_event, args: { workspacePath: string; filename: string }) => {
      workspaceDeployService.syncAgentToWorkspace(args.workspacePath, args.filename)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SKILL_DELETE_FROM_WORKSPACE,
    (_event, args: { workspacePath: string; skillName: string }) => {
      workspaceDeployService.deleteSkillFromWorkspace(args.workspacePath, args.skillName)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SKILL_SYNC_TO_WORKSPACE,
    (_event, args: { workspacePath: string; skillName: string }) => {
      workspaceDeployService.syncSkillToWorkspace(args.workspacePath, args.skillName)
    }
  )

  // ── Activate / Deactivate ──

  ipcMain.handle(
    IPC_CHANNELS.AGENT_ACTIVATE,
    (_event, args: { workspacePath: string; agentName: string }) => {
      workspaceDeployService.activateAgent(args.workspacePath, args.agentName)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.AGENT_DEACTIVATE,
    (_event, args: { workspacePath: string; agentName: string }) => {
      workspaceDeployService.deactivateAgent(args.workspacePath, args.agentName)
    }
  )

  // ── Bulk Delete All ──

  ipcMain.handle(
    IPC_CHANNELS.DELETE_ALL_AGENTS,
    (_event, args: { workspacePath: string }) => {
      workspaceDeployService.deleteAllAgents(args.workspacePath)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.DELETE_ALL_SKILLS,
    (_event, args: { workspacePath: string }) => {
      workspaceDeployService.deleteAllSkills(args.workspacePath)
    }
  )

  // ── Deploy All (inactive) ──

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_DEPLOY_ALL,
    async (_event, args: { workspacePath: string }) => {
      return workspaceDeployService.deployAllInactive(args.workspacePath)
    }
  )
}
