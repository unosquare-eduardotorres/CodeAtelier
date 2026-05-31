import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { hookEngine } from '../services/hook-engine.service'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

export function registerHooksIpc(): void {
  ipcMain.handle(IPC_CHANNELS.HOOKS_LIST, (event) => {
    validateSender(event)
    return hookEngine.getLoadedHooks()
  })

  ipcMain.handle(IPC_CHANNELS.HOOKS_RELOAD, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.HOOKS_RELOAD)
    const workspacePath = requireString(args, 'workspacePath', IPC_CHANNELS.HOOKS_RELOAD)
    await hookEngine.loadHooks(workspacePath)
    return hookEngine.getLoadedHooks()
  })
}
