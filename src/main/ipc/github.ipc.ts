import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { githubService } from '../services/github.service'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

export function registerGithubIpc(): void {
  // Validate + encrypt + store GitHub token
  ipcMain.handle(IPC_CHANNELS.GITHUB_SAVE_TOKEN, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.GITHUB_SAVE_TOKEN)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.GITHUB_SAVE_TOKEN)
    const token = requireString(args, 'token', IPC_CHANNELS.GITHUB_SAVE_TOKEN)
    return githubService.saveToken(workspaceId, token)
  })

  // Validate token without storing
  ipcMain.handle(IPC_CHANNELS.GITHUB_VALIDATE_TOKEN, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.GITHUB_VALIDATE_TOKEN)
    const token = requireString(args, 'token', IPC_CHANNELS.GITHUB_VALIDATE_TOKEN)
    return githubService.validateToken(token)
  })

  // Get GitHub connection status for a workspace
  ipcMain.handle(IPC_CHANNELS.GITHUB_GET_STATUS, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.GITHUB_GET_STATUS)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.GITHUB_GET_STATUS)
    return githubService.getStatus(workspaceId)
  })

  // Remove GitHub token from a workspace
  ipcMain.handle(IPC_CHANNELS.GITHUB_REMOVE_TOKEN, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.GITHUB_REMOVE_TOKEN)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.GITHUB_REMOVE_TOKEN)
    githubService.removeToken(workspaceId)
  })
}
