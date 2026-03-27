import path from 'node:path'
import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ActivationProgressEvent } from '../../shared/types'
import { workspaceDeployService } from '../services/workspace-deploy.service'
import { validateSender } from './validate-sender'

/** Allowed file patterns for workspace read/write — relative to workspace root */
const ALLOWED_FILE_PATTERNS = ['.claude/', 'CLAUDE.md', 'skills/']

/**
 * Validates that a file path is within the workspace boundary and matches
 * allowed patterns. Prevents arbitrary file read/write via IPC.
 */
function validateWorkspaceFilePath(filePath: string): void {
  const resolved = path.resolve(filePath)

  // The file must be within a directory that contains one of the allowed patterns
  const hasAllowedPattern = ALLOWED_FILE_PATTERNS.some((pattern) => {
    const sep = path.sep
    return resolved.includes(`${sep}${pattern.replace(/\//g, sep)}`)
  })

  if (!hasAllowedPattern) {
    throw new Error(
      `Access denied: file path must be within allowed workspace directories (.claude/, skills/, or CLAUDE.md). Got: ${filePath}`
    )
  }
}

export function registerWorkspaceDeployIpc(): void {
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SCAN_CLAUDE, (event, args: { workspacePath: string }) => {
    validateSender(event)
    return workspaceDeployService.scanWorkspaceClaude(args.workspacePath)
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_ACTIVATE_AGENTS,
    async (event, args: { workspacePath: string }) => {
      validateSender(event)
      const win = BrowserWindow.fromWebContents(event.sender)

      const onProgress = (progressEvent: ActivationProgressEvent): void => {
        win?.webContents.send(IPC_CHANNELS.WORKSPACE_ACTIVATION_PROGRESS, progressEvent)
      }

      return workspaceDeployService.activateAgents(args.workspacePath, onProgress)
    }
  )

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CANCEL_ACTIVATION, (event) => {
    validateSender(event)
    workspaceDeployService.shutdown()
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_CLEAN_ACTIVATION,
    (event, args: { workspacePath: string; removeClaudeMd?: boolean }) => {
      validateSender(event)
      workspaceDeployService.cleanActivation(args.workspacePath, args.removeClaudeMd)
    }
  )

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_READ_FILE, (event, args: { filePath: string }) => {
    validateSender(event)
    validateWorkspaceFilePath(args.filePath)
    return workspaceDeployService.readWorkspaceFile(args.filePath)
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_WRITE_FILE,
    (event, args: { filePath: string; content: string }) => {
      validateSender(event)
      validateWorkspaceFilePath(args.filePath)
      workspaceDeployService.writeWorkspaceFile(args.filePath, args.content)
    }
  )

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SCAN_SKILLS, (event, args: { workspacePath: string }) => {
    validateSender(event)
    return workspaceDeployService.scanWorkspaceSkills(args.workspacePath)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SCAN_AGENTS, (event, args: { workspacePath: string }) => {
    validateSender(event)
    return workspaceDeployService.scanWorkspaceAgents(args.workspacePath)
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_CONFIRM_CLAUDE_MD,
    (event, args: { workspacePath: string; content: string }) => {
      validateSender(event)
      workspaceDeployService.confirmClaudeMd(args.workspacePath, args.content)
    }
  )

  // ── Individual Agent/Skill Delete & Sync ──

  ipcMain.handle(
    IPC_CHANNELS.AGENT_DELETE_FROM_WORKSPACE,
    (event, args: { workspacePath: string; filename: string }) => {
      validateSender(event)
      workspaceDeployService.deleteAgentFromWorkspace(args.workspacePath, args.filename)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SYNC_TO_WORKSPACE,
    (event, args: { workspacePath: string; filename: string }) => {
      validateSender(event)
      workspaceDeployService.syncAgentToWorkspace(args.workspacePath, args.filename)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SKILL_DELETE_FROM_WORKSPACE,
    (event, args: { workspacePath: string; skillName: string }) => {
      validateSender(event)
      workspaceDeployService.deleteSkillFromWorkspace(args.workspacePath, args.skillName)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SKILL_SYNC_TO_WORKSPACE,
    (event, args: { workspacePath: string; skillName: string }) => {
      validateSender(event)
      workspaceDeployService.syncSkillToWorkspace(args.workspacePath, args.skillName)
    }
  )

  // ── Activate / Deactivate ──

  ipcMain.handle(
    IPC_CHANNELS.AGENT_ACTIVATE,
    (event, args: { workspacePath: string; agentName: string }) => {
      validateSender(event)
      workspaceDeployService.activateAgent(args.workspacePath, args.agentName)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.AGENT_DEACTIVATE,
    (event, args: { workspacePath: string; agentName: string }) => {
      validateSender(event)
      workspaceDeployService.deactivateAgent(args.workspacePath, args.agentName)
    }
  )

  // ── Bulk Delete All ──

  ipcMain.handle(IPC_CHANNELS.DELETE_ALL_AGENTS, (event, args: { workspacePath: string }) => {
    validateSender(event)
    workspaceDeployService.deleteAllAgents(args.workspacePath)
  })

  ipcMain.handle(IPC_CHANNELS.DELETE_ALL_SKILLS, (event, args: { workspacePath: string }) => {
    validateSender(event)
    workspaceDeployService.deleteAllSkills(args.workspacePath)
  })

  // ── Deploy All (inactive) ──

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_DEPLOY_ALL,
    async (event, args: { workspacePath: string }) => {
      validateSender(event)
      return workspaceDeployService.deployAllInactive(args.workspacePath)
    }
  )
}
