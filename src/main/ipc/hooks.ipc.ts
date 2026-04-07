import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { hookEngine } from '../services/hook-engine.service'
import { validateSender } from './validate-sender'

export function registerHooksIpc(): void {
  ipcMain.handle(IPC_CHANNELS.HOOKS_LIST, (event) => {
    validateSender(event)
    return hookEngine.getLoadedHooks()
  })

  ipcMain.handle(
    IPC_CHANNELS.HOOKS_RELOAD,
    async (event, args: { workspacePath: string }) => {
      validateSender(event)
      if (!args?.workspacePath) throw new Error('workspacePath is required')
      await hookEngine.loadHooks(args.workspacePath)
      return hookEngine.getLoadedHooks()
    }
  )
}
