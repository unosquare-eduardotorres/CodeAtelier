import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { userProfileRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

export function registerUserProfileIpc(): void {
  ipcMain.handle(IPC_CHANNELS.USER_PROFILE_GET, (event) => {
    validateSender(event)
    return userProfileRepository.getProfile()
  })

  ipcMain.handle(IPC_CHANNELS.USER_PROFILE_UPSERT, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.USER_PROFILE_UPSERT)
    const displayName = requireString(args, 'displayName', IPC_CHANNELS.USER_PROFILE_UPSERT)
    const avatarKey = requireString(args, 'avatarKey', IPC_CHANNELS.USER_PROFILE_UPSERT)
    return userProfileRepository.upsertProfile(displayName.trim(), avatarKey.trim())
  })
}
