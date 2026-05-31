import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { repoService } from '../services/repo.service'
import { workspaceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

export function registerRepoIpc(): void {
  // Initialize a git repo at the workspace path
  ipcMain.handle(IPC_CHANNELS.REPO_INIT, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_INIT)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.REPO_INIT)

    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    await repoService.initRepo(workspace.repoPath)

    // Update workspace record
    const settings = workspaceRepository.getSettings(workspaceId)
    workspaceRepository.updateSettings(workspaceId, { ...settings })
  })

  // Set or update the origin remote URL
  ipcMain.handle(
    IPC_CHANNELS.REPO_SET_REMOTE,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.REPO_SET_REMOTE)
      const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.REPO_SET_REMOTE)
      const remoteUrl = requireString(args, 'remoteUrl', IPC_CHANNELS.REPO_SET_REMOTE)

      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      await repoService.setRemote(workspace.repoPath, remoteUrl)
    }
  )

  // Get repo info (isRepo, hasRemote, remoteUrl, currentBranch)
  ipcMain.handle(IPC_CHANNELS.REPO_GET_INFO, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.REPO_GET_INFO)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.REPO_GET_INFO)

    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    return repoService.getRepoInfo(workspace.repoPath)
  })
}
