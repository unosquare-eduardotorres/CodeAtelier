import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'

let popoutWindow: BrowserWindow | null = null

export function registerPixelOfficeHandlers(): void {
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
