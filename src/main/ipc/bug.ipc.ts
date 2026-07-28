import { ipcMain, BrowserWindow, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { bugRepository } from '../db/repositories/bug.repository'
import type { CreateBugInput, BugFilters } from '../db/repositories/bug.repository'
import { validateSender } from './validate-sender'
import { safeWindowSend } from './safe-send'
import { requireObject, requireString } from './validate-args'
import { writeFile } from 'node:fs/promises'

export function registerBugIpc(mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.BUG_REPORT, (event, rawArgs: unknown) => {
    validateSender(event)
    const input = requireObject(rawArgs, IPC_CHANNELS.BUG_REPORT)
    requireString(input, 'errorMessage', IPC_CHANNELS.BUG_REPORT)
    requireString(input, 'process', IPC_CHANNELS.BUG_REPORT)
    requireString(input, 'appVersion', IPC_CHANNELS.BUG_REPORT)

    const result = bugRepository.upsertBug(input as unknown as CreateBugInput)

    if (result.isNew) {
      // Notify all renderer windows about the new bug
      const bug = bugRepository.getById(result.bugId)
      for (const win of BrowserWindow.getAllWindows()) {
        safeWindowSend(win, IPC_CHANNELS.BUG_NEW, bug)
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

  ipcMain.handle(IPC_CHANNELS.BUG_EXPORT_MARKDOWN, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BUG_EXPORT_MARKDOWN)
    const markdown = requireString(args, 'markdown', IPC_CHANNELS.BUG_EXPORT_MARKDOWN)
    const defaultFilename = (args.defaultFilename as string) ?? 'bug-report.md'

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Bug Report',
      defaultPath: defaultFilename,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (canceled || !filePath) return
    await writeFile(filePath, markdown, 'utf-8')
  })
}
