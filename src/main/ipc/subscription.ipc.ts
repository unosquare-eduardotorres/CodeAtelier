import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { subscriptionService } from '../services/subscription.service'
import { locateOpenCodeCli } from '../../shared/opencode-cli-path'
import { validateSender } from './validate-sender'

export function registerSubscriptionIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_VALIDATE_ALL, async (event) => {
    validateSender(event)
    return subscriptionService.validateAll()
  })

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_CHECK_CLAUDE_CLI, async (event) => {
    validateSender(event)
    return subscriptionService.checkClaudeCli()
  })

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_CHECK_OPENCODE_CLI, async (event) => {
    validateSender(event)
    return locateOpenCodeCli()
  })

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_AUTO_CONFIGURE, async (event) => {
    validateSender(event)
    return subscriptionService.autoConfigureClaude()
  })
}
