import log from 'electron-log/main'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'

const elicitLog = log.scope('Elicitation')

const ELICITATION_TIMEOUT_MS = 120_000 // 2 minutes for OAuth flows

interface PendingElicitation {
  resolve: (result: {
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, unknown>
  }) => void
  serverName: string
  mode?: string
}

export class ElicitationService {
  private pendingElicitations = new Map<string, PendingElicitation>()

  /**
   * Handle an elicitation request from an MCP server.
   * Sends IPC to renderer, waits for user response.
   */
  async handleElicitation(request: {
    serverName: string
    message: string
    mode?: 'form' | 'url'
    url?: string
    elicitationId?: string
    requestedSchema?: Record<string, unknown>
  }): Promise<{
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, unknown>
  }> {
    const requestId =
      request.elicitationId ??
      `elicit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    return new Promise((resolve) => {
      this.pendingElicitations.set(requestId, {
        resolve,
        serverName: request.serverName,
        mode: request.mode
      })

      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send(IPC_CHANNELS.SDK_ELICITATION_REQUEST, {
          requestId,
          serverName: request.serverName,
          message: request.message,
          mode: request.mode ?? 'url',
          url: request.url,
          requestedSchema: request.requestedSchema
        })
      } else {
        elicitLog.warn('No window for elicitation — auto-declining')
        this.pendingElicitations.delete(requestId)
        resolve({ action: 'decline' })
        return
      }

      // Auto-decline after timeout
      setTimeout(() => {
        if (this.pendingElicitations.has(requestId)) {
          elicitLog.warn(`Elicitation timed out for ${request.serverName}`)
          this.resolveElicitation(requestId, { action: 'decline' })
        }
      }, ELICITATION_TIMEOUT_MS)
    })
  }

  resolveElicitation(
    requestId: string,
    result: {
      action: 'accept' | 'decline' | 'cancel'
      content?: Record<string, unknown>
    }
  ): void {
    const pending = this.pendingElicitations.get(requestId)
    if (!pending) return
    this.pendingElicitations.delete(requestId)
    pending.resolve(result)
  }
}

export const elicitationService = new ElicitationService()
