import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { bugRepository } from '../db/repositories/bug.repository'
import type { CreateBugInput, BugFilters } from '../db/repositories/bug.repository'
import { validateSender } from './validate-sender'

export function registerBugIpc(_mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.BUG_REPORT, (event, input: CreateBugInput) => {
    validateSender(event)
    if (!input?.errorMessage) throw new Error('errorMessage is required')
    if (!input?.process) throw new Error('process is required')
    if (!input?.appVersion) throw new Error('appVersion is required')

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

  ipcMain.handle(IPC_CHANNELS.BUG_GET, (event, args: { id: string }) => {
    validateSender(event)
    if (!args?.id) throw new Error('id is required')
    return bugRepository.getById(args.id)
  })

  ipcMain.handle(IPC_CHANNELS.BUG_RESOLVE, (event, args: { id: string }) => {
    validateSender(event)
    if (!args?.id) throw new Error('id is required')
    bugRepository.markResolved(args.id)
  })

  ipcMain.handle(IPC_CHANNELS.BUG_UNRESOLVE, (event, args: { id: string }) => {
    validateSender(event)
    if (!args?.id) throw new Error('id is required')
    bugRepository.markUnresolved(args.id)
  })

  ipcMain.handle(IPC_CHANNELS.BUG_DELETE, (event, args: { id: string }) => {
    validateSender(event)
    if (!args?.id) throw new Error('id is required')
    bugRepository.deleteBug(args.id)
  })

  ipcMain.handle(IPC_CHANNELS.BUG_UPDATE_NOTE, (event, args: { id: string; note: string }) => {
    validateSender(event)
    if (!args?.id) throw new Error('id is required')
    bugRepository.updateNote(args.id, args.note ?? '')
  })

  ipcMain.handle(IPC_CHANNELS.BUG_COUNT, (event) => {
    validateSender(event)
    return bugRepository.getUnresolvedCount()
  })
}
