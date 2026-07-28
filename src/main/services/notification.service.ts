/**
 * NotificationService — central OS notification dispatcher.
 *
 * Single source of truth for all notifications (OS + in-app). Determines the
 * delivery channel based on window focus state:
 *
 *   Focused          → in-app toast only
 *   Visible, !focused → in-app toast + dock bounce
 *   Hidden/minimized → OS notification + dock bounce
 *
 * Handles rate-limiting, notification grouping, memory management for native
 * Notification objects, and click-to-navigate back into the correct workspace.
 *
 * macOS system sounds are used — no custom audio files required.
 */

import { Notification, app, type BrowserWindow, type NotificationConstructorOptions } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { safeWindowSend } from '../ipc/safe-send'
import type { CompletionNotification } from '../../shared/types'

const nLog = log.scope('notifications')

// ── macOS System Sound Map (no custom audio files needed) ──────────────────
const SOUND_MAP: Record<string, string> = {
  needs_input: 'Glass', // attention-grabbing, gentle chime
  completed: 'Purr', // subtle success vibration
  failed: 'Basso' // low error tone
}

// ── Notification Grouping ─────────────────────────────────────────────────
const GROUP_MAP: Record<string, string> = {
  chat: 'code-atelier-chat',
  grill: 'code-atelier-grill',
  audit: 'code-atelier-audit',
  mpa: 'code-atelier-mpa',
  blueprint: 'code-atelier-blueprint',
  council: 'code-atelier-council'
}

// ── Service Labels ────────────────────────────────────────────────────────
const SERVICE_LABELS: Record<string, string> = {
  chat: 'Chat',
  grill: 'Grill Me',
  audit: 'Audit',
  mpa: 'Multi-Phase Agent',
  blueprint: 'Blueprint',
  council: 'Council'
}

const STATUS_LABELS: Record<string, string> = {
  completed: '✓ Complete',
  failed: '✗ Failed',
  needs_input: '⏸ Needs Your Input'
}

// ── Rate Limiting ─────────────────────────────────────────────────────────
const MIN_INTERVAL_MS = 3000 // No more than 1 notification per 3s per service

export class NotificationService {
  private mainWindow: BrowserWindow | null = null
  private enabled = true
  private lastNotifyTime = new Map<string, number>()
  private activeNotifications: Notification[] = []
  private readonly MAX_ACTIVE = 20

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Fire a test notification to check macOS actually delivers it.
   * Returns 'granted' | 'denied' | 'unsupported'.
   *
   * On macOS Ventura+, unsigned/non-notarized apps silently fail to show
   * native notifications — Notification.isSupported() returns true but
   * .show() is a no-op. This probe detects that scenario.
   */
  async probeNotificationSupport(): Promise<'granted' | 'denied' | 'unsupported'> {
    if (!Notification.isSupported()) return 'unsupported'
    if (process.platform !== 'darwin') return 'granted' // Windows/Linux don't have this issue

    return new Promise((resolve) => {
      const test = new Notification({ title: '', silent: true })
      let resolved = false

      test.on('show', () => {
        if (!resolved) {
          resolved = true
          test.close()
          resolve('granted')
        }
      })
      test.on('failed', () => {
        if (!resolved) {
          resolved = true
          resolve('denied')
        }
      })
      // Timeout fallback — if neither fires in 2s, assume denied
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          resolve('denied')
        }
      }, 2000)

      test.show()
    })
  }

  /**
   * Single dispatch point — determines delivery channel based on window state.
   * All IPC files should call this instead of safeWindowSend(COMPLETION_NOTIFICATION).
   */
  dispatch(notification: CompletionNotification): void {
    if (!this.enabled) return
    if (this.isRateLimited(notification.service)) return

    const win = this.mainWindow
    const isWindowVisible = win != null && !win.isDestroyed() && win.isVisible()
    const isWindowFocused = isWindowVisible && win!.isFocused()

    if (isWindowFocused) {
      // Window focused → in-app toast only (no OS notification)
      this.sendInAppToast(notification)
    } else if (isWindowVisible) {
      // Visible but not focused → in-app toast + dock bounce
      this.sendInAppToast(notification)
      this.dockBounce(notification)
    } else {
      // Hidden or minimized → OS notification + dock bounce
      this.showOSNotification(notification)
      this.dockBounce(notification)
    }

    this.lastNotifyTime.set(notification.service, Date.now())
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private isRateLimited(service: string): boolean {
    const last = this.lastNotifyTime.get(service)
    return !!last && Date.now() - last < MIN_INTERVAL_MS
  }

  private sendInAppToast(notification: CompletionNotification): void {
    const win = this.mainWindow
    if (win && !win.isDestroyed()) {
      safeWindowSend(win, IPC_CHANNELS.COMPLETION_NOTIFICATION, notification)
    }
  }

  private showOSNotification(notification: CompletionNotification): void {
    if (!Notification.isSupported()) {
      nLog.warn('OS notifications not supported — falling back to in-app')
      this.sendInAppToast(notification)
      return
    }

    const title = this.buildTitle(notification)
    const soundName = SOUND_MAP[notification.status] ?? undefined

    const notifOpts: NotificationConstructorOptions = {
      title,
      body:
        process.platform === 'darwin'
          ? notification.summary
          : `${notification.workspaceName} — ${notification.summary}`,
      silent: !soundName
    }

    // Platform-specific options
    if (process.platform === 'darwin') {
      notifOpts.subtitle = notification.workspaceName
      notifOpts.sound = soundName // macOS system sounds
    } else {
      // urgency — @platform linux,win32
      notifOpts.urgency = notification.status === 'needs_input' ? 'critical' : 'normal'
    }
    // Notification grouping — @platform darwin,win32 (no-op on Linux)
    if (GROUP_MAP[notification.service]) {
      notifOpts.groupId = GROUP_MAP[notification.service]
    }

    const osNotification = new Notification(notifOpts)

    osNotification.on('click', () => {
      this.handleNotificationClick(notification)
    })

    osNotification.on('failed', (_event, error) => {
      nLog.warn(`OS notification failed (likely unsigned build): ${error}`)
      // Fallback: send in-app toast
      this.sendInAppToast(notification)
    })

    osNotification.on('close', () => {
      this.activeNotifications = this.activeNotifications.filter((n) => n !== osNotification)
    })

    // Bounded active list to prevent memory leaks
    if (this.activeNotifications.length >= this.MAX_ACTIVE) {
      const oldest = this.activeNotifications.shift()
      oldest?.close()
    }
    this.activeNotifications.push(osNotification)

    osNotification.show()
  }

  private dockBounce(notification: CompletionNotification): void {
    if (process.platform !== 'darwin' || !app.dock) return

    const bounceType = notification.status === 'needs_input' ? 'critical' : 'informational'
    app.dock.bounce(bounceType)
  }

  private handleNotificationClick(notification: CompletionNotification): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return

    // Restore and focus window
    if (!win.isVisible()) win.show()
    if (win.isMinimized()) win.restore()
    win.focus()

    // Send navigation instruction to renderer
    safeWindowSend(win, IPC_CHANNELS.NOTIFICATION_NAVIGATE, {
      workspaceId: notification.workspaceId,
      targetPage: notification.targetPage ?? notification.service,
      entityId: notification.entityId
    })
  }

  private buildTitle(notification: CompletionNotification): string {
    const label = SERVICE_LABELS[notification.service] ?? notification.service
    const statusLabel = STATUS_LABELS[notification.status] ?? notification.status
    return `${label} — ${statusLabel}`
  }
}

// Singleton
export const notificationService = new NotificationService()
