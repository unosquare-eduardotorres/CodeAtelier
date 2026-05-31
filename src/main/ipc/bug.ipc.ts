import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { bugRepository } from '../db/repositories/bug.repository'
import type { CreateBugInput, BugFilters } from '../db/repositories/bug.repository'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

export function registerBugIpc(_mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.BUG_REPORT, (event, rawArgs: unknown) => {
    validateSender(event)
    const input = requireObject(rawArgs, IPC_CHANNELS.BUG_REPORT) as CreateBugInput
    requireString(input as Record<string, unknown>, 'errorMessage', IPC_CHANNELS.BUG_REPORT)
    requireString(input as Record<string, unknown>, 'process', IPC_CHANNELS.BUG_REPORT)
    requireString(input as Record<string, unknown>, 'appVersion', IPC_CHANNELS.BUG_REPORT)

    const result = bugRepository.upsertBug(input)

    if (result.isNew) {
      // Notify all renderer windows about the new bug
      const bug = bugRepository.getById(result.bugId)
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC_CHANNELS.BUG_NEW, bug)
      }
    }

    return result
  })

  ipcMain.handle(IPC_CHANNELS.BUG_LIST, (event, filters?: BugFilters) => {
    validateSender(event)
    return bugRepository.getAll(filters)
  })

  ipcMain.handle(IPC_CHANNELS.BUG_GET, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BUG_GET)
    const id = requireString(args, 'id', IPC_CHANNELS.BUG_GET)
    return bugRepository.getById(id)
  })

  ipcMain.handle(IPC_CHANNELS.BUG_RESOLVE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BUG_RESOLVE)
    const id = requireString(args, 'id', IPC_CHANNELS.BUG_RESOLVE)
    bugRepository.markResolved(id)
  })

  ipcMain.handle(IPC_CHANNELS.BUG_UNRESOLVE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BUG_UNRESOLVE)
    const id = requireString(args, 'id', IPC_CHANNELS.BUG_UNRESOLVE)
    bugRepository.markUnresolved(id)
  })

  ipcMain.handle(IPC_CHANNELS.BUG_DELETE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BUG_DELETE)
    const id = requireString(args, 'id', IPC_CHANNELS.BUG_DELETE)
    bugRepository.deleteBug(id)
  })

  ipcMain.handle(IPC_CHANNELS.BUG_UPDATE_NOTE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BUG_UPDATE_NOTE)
    const id = requireString(args, 'id', IPC_CHANNELS.BUG_UPDATE_NOTE)
    bugRepository.updateNote(id, (args.note as string) ?? '')
  })

  ipcMain.handle(IPC_CHANNELS.BUG_COUNT, (event) => {
    validateSender(event)
    return bugRepository.getUnresolvedCount()
  })
}
