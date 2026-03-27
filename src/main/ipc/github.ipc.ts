import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { githubService } from '../services/github.service'
import { validateSender } from './validate-sender'

export function registerGithubIpc(): void {
  // Validate + encrypt + store GitHub token
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_SAVE_TOKEN,
    async (event, args: { workspaceId: string; token: string }) => {
      validateSender(event)
      if (!args?.workspaceId || !args?.token) {
        throw new Error('Missing workspaceId or token')
      }
      return githubService.saveToken(args.workspaceId, args.token)
    }
  )

  // Validate token without storing
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_VALIDATE_TOKEN,
    async (event, args: { token: string }) => {
      validateSender(event)
      if (!args?.token) {
        throw new Error('Missing token')
      }
      return githubService.validateToken(args.token)
    }
  )

  // Get GitHub connection status for a workspace
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_STATUS,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) {
        throw new Error('Missing workspaceId')
      }
      return githubService.getStatus(args.workspaceId)
    }
  )

  // Remove GitHub token from a workspace
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_REMOVE_TOKEN,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) {
        throw new Error('Missing workspaceId')
      }
      githubService.removeToken(args.workspaceId)
    }
  )
}
