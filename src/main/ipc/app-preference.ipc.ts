import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { appPreferenceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

export function registerAppPreferenceIpc(): void {
  ipcMain.handle(IPC_CHANNELS.APP_PREFERENCE_GET_ALL, async (event) => {
    validateSender(event)
    return appPreferenceRepository.getAppPreferences()
  })

  ipcMain.handle(
    IPC_CHANNELS.APP_PREFERENCE_SET,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.APP_PREFERENCE_SET
      const args = requireObject(rawArgs, ch)
      const key = requireString(args, 'key', ch)
      // value can be an empty string, so just check type
      const value = args.value
      if (typeof value !== 'string') {
        throw new Error(`${ch}: field 'value' must be a string`)
      }

      appPreferenceRepository.set(key, value)
    }
  )
}
