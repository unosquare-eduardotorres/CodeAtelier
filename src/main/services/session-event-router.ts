/**
 * SessionEventRouter — single point of IPC dispatch for multi-workspace sessions.
 *
 * Intercepts session events and forwards them to the renderer with workspaceId
 * tagging. Ensures all IPC payloads carry the workspace context so the renderer
 * can route events to the correct UI components (active workspace chat panel,
 * background status indicators, or cross-workspace permission toasts).
 */

import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  PendingPermission
} from '../../shared/types'

export interface TaggedEvent {
  workspaceId: string
  [key: string]: unknown
}

export class SessionEventRouter {
  private mainWindow: BrowserWindow

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
  }

  /** Send a tagged event to the renderer on any IPC channel. */
  send(channel: string, payload: TaggedEvent): void {
    this.mainWindow.webContents.send(channel, payload)
  }

  /** Send a permission/blocking event from a background workspace. */
  sendPermissionRequest(permission: PendingPermission): void {
    this.send(IPC_CHANNELS.PERMISSION_REQUEST, {
      workspaceId: permission.workspaceId,
      ...permission
    })
  }

}

// ── Singleton ──

let _sessionEventRouter: SessionEventRouter | null = null

export function initSessionEventRouter(mainWindow: BrowserWindow): void {
  _sessionEventRouter = new SessionEventRouter(mainWindow)
}

export function getSessionEventRouter(): SessionEventRouter {
  if (!_sessionEventRouter) {
    throw new Error('SessionEventRouter not initialized — call initSessionEventRouter() first')
  }
  return _sessionEventRouter
}


