import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { appPreferenceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerAppPreferenceIpc(): void {
  ipcMain.handle(IPC_CHANNELS.APP_PREFERENCE_GET_ALL, async (event) => {
    validateSender(event)
    return appPreferenceRepository.getAppPreferences()
  })

  ipcMain.handle(
    IPC_CHANNELS.APP_PREFERENCE_SET,
    async (event, args: { key: string; value: string }) => {
      validateSender(event)

      if (!args || typeof args.key !== 'string' || args.key.trim().length === 0) {
        throw new Error('Invalid preference key')
      }
      if (typeof args.value !== 'string') {
        throw new Error('Invalid preference value')
      }

      appPreferenceRepository.set(args.key, args.value)
    }
  )
}
