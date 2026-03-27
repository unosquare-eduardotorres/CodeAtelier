import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { userProfileRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerUserProfileIpc(): void {
  ipcMain.handle(IPC_CHANNELS.USER_PROFILE_GET, (event) => {
    validateSender(event)
    return userProfileRepository.getProfile()
  })

  ipcMain.handle(
    IPC_CHANNELS.USER_PROFILE_UPSERT,
    (event, args: { displayName: string; avatarKey: string }) => {
      validateSender(event)
      if (!args?.displayName?.trim()) throw new Error('displayName is required')
      if (!args?.avatarKey?.trim()) throw new Error('avatarKey is required')
      return userProfileRepository.upsertProfile(args.displayName.trim(), args.avatarKey.trim())
    }
  )
}
