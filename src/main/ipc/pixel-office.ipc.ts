import { BrowserWindow, ipcMain, dialog, app } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'

let popoutWindow: BrowserWindow | null = null

/** Path to the persisted office layout file in app data */
function getLayoutPath(): string {
  return join(app.getPath('userData'), 'pixel-office-layout.json')
}

export function registerPixelOfficeHandlers(): void {
  // ── Layout persistence ──
  ipcMain.handle(
    IPC_CHANNELS.PIXEL_OFFICE_SAVE_LAYOUT,
    async (event, args: { layout: string }) => {
      validateSender(event)
      try {
        const layoutPath = getLayoutPath()
        await mkdir(join(layoutPath, '..'), { recursive: true })
        await writeFile(layoutPath, args.layout, 'utf-8')
        return { success: true }
      } catch (err) {
        log.error('Failed to save office layout:', err)
        throw new Error('Failed to save office layout')
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.PIXEL_OFFICE_LOAD_LAYOUT, async (event) => {
    validateSender(event)
    try {
      const layoutPath = getLayoutPath()
      const data = await readFile(layoutPath, 'utf-8')
      return { layout: data }
    } catch {
      // No saved layout — return null so renderer uses default
      return { layout: null }
    }
  })

  ipcMain.handle(IPC_CHANNELS.PIXEL_OFFICE_EXPORT_LAYOUT, async (event, args: { layout: string }) => {
    validateSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window found')

    const result = await dialog.showSaveDialog(win, {
      title: 'Export Office Layout',
      defaultPath: 'office-layout.json',
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    })

    if (result.canceled || !result.filePath) return { success: false }

    try {
      await writeFile(result.filePath, args.layout, 'utf-8')
      return { success: true, path: result.filePath }
    } catch (err) {
      log.error('Failed to export office layout:', err)
      throw new Error('Failed to export office layout')
    }
  })

  ipcMain.handle(IPC_CHANNELS.PIXEL_OFFICE_IMPORT_LAYOUT, async (event) => {
    validateSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window found')

    const result = await dialog.showOpenDialog(win, {
      title: 'Import Office Layout',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) return { layout: null }

    try {
      const data = await readFile(result.filePaths[0], 'utf-8')
      // Basic validation — ensure it's valid JSON with expected fields
      const parsed = JSON.parse(data)
      if (!parsed.version || !Array.isArray(parsed.tiles)) {
        throw new Error('Invalid layout format')
      }
      return { layout: data }
    } catch (err) {
      log.error('Failed to import office layout:', err)
      throw new Error('Failed to import office layout: invalid file format')
    }
  })

  // ── Popout window ──
  ipcMain.handle(IPC_CHANNELS.PIXEL_OFFICE_POPOUT, (event) => {
    validateSender(event)

    // If already open, focus it
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.focus()
      return
    }

    popoutWindow = new BrowserWindow({
      width: 900,
      height: 600,
      minWidth: 600,
      minHeight: 400,
      title: 'Pixel Office — Code Atelier',
      backgroundColor: '#0a0a1a',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true
      }
    })

    popoutWindow.on('ready-to-show', () => {
      popoutWindow?.show()
    })

    // Load the same renderer URL with a query param
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      popoutWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?view=pixel-office`)
    } else {
      popoutWindow.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { view: 'pixel-office' }
      })
    }

    popoutWindow.on('closed', () => {
      popoutWindow = null
    })
  })
}
