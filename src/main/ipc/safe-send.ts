/**
 * safe-send.ts — Shared utility for guarded IPC sends.
 *
 * All IPC event listeners (outside `ipcMain.handle` scope) that call
 * `mainWindow.webContents.send()` must use this wrapper. Electron will
 * throw an unhandled exception if the window is destroyed during send.
 *
 * ROUTER-01 / IPC-SEND-01 audit fix.
 */

import type { BrowserWindow } from 'electron'
import log from 'electron-log'

const ipcLog = log.scope('safe-send')

/**
 * Send an IPC message to the renderer with isDestroyed() + try-catch guard.
 * Returns `true` if the send succeeded, `false` if the window was destroyed
 * or an error occurred.
 */
export function safeWindowSend(
  win: BrowserWindow,
  channel: string,
  ...args: unknown[]
): boolean {
  try {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
      return true
    }
  } catch (err) {
    ipcLog.warn(`[safeWindowSend] Failed to send ${channel}:`, err)
  }
  return false
}
