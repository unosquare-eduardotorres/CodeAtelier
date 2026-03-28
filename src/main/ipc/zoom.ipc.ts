import { ipcMain, type BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'

const MIN_ZOOM = 0.5
const MAX_ZOOM = 2.0
const ZOOM_STEP = 0.1

export function registerZoomIpc(mainWindow: BrowserWindow): void {
  const clamp = (val: number): number => {
    const snapped = Math.round(val / ZOOM_STEP) * ZOOM_STEP
    return Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, snapped)) * 100) / 100
  }

  const notifyRenderer = (factor: number): void => {
    mainWindow.webContents.send(IPC_CHANNELS.ZOOM_CHANGED, factor)
  }

  ipcMain.handle(IPC_CHANNELS.ZOOM_GET, () => {
    return clamp(mainWindow.webContents.getZoomFactor())
  })

  ipcMain.handle(IPC_CHANNELS.ZOOM_IN, () => {
    const current = mainWindow.webContents.getZoomFactor()
    const next = clamp(current + ZOOM_STEP)
    mainWindow.webContents.setZoomFactor(next)
    notifyRenderer(next)
    return next
  })

  ipcMain.handle(IPC_CHANNELS.ZOOM_OUT, () => {
    const current = mainWindow.webContents.getZoomFactor()
    const next = clamp(current - ZOOM_STEP)
    mainWindow.webContents.setZoomFactor(next)
    notifyRenderer(next)
    return next
  })

  ipcMain.handle(IPC_CHANNELS.ZOOM_RESET, () => {
    mainWindow.webContents.setZoomFactor(1.0)
    notifyRenderer(1.0)
    return 1.0
  })

  ipcMain.handle(IPC_CHANNELS.ZOOM_SET, (_event, factor: number) => {
    const clamped = clamp(factor)
    mainWindow.webContents.setZoomFactor(clamped)
    notifyRenderer(clamped)
    return clamped
  })

  // Sync UI when zoom changes via native menu (⌘+, ⌘-, ⌘0) or trackpad pinch
  mainWindow.webContents.on('zoom-changed', () => {
    const factor = mainWindow.webContents.getZoomFactor()
    notifyRenderer(clamp(factor))
  })

  log.info('[Zoom] IPC handlers registered')
}
