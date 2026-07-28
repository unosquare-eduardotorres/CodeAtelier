import { Menu, Tray, BrowserWindow, app } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import { chatAgentService } from './services'
import { auditAgentService } from './services/audit-agent.service'
import { grillAgentService } from './services/grill-agent.service'
import { mpaOrchestrationService } from './services/mpa-orchestration.service'
import { councilService } from './services/council.service'
import { blueprintService } from './services/blueprint.service'
import { workspaceRepository } from './db/repositories/workspace.repository'
import { bugRepository } from './db/repositories/bug.repository'

let refreshTimer: ReturnType<typeof setInterval> | null = null

export function setupTrayMenu(
  tray: Tray,
  getMainWindow: () => BrowserWindow | null
): void {
  // Single-click = show/focus window (macOS convention)
  tray.on('click', () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    if (win.isVisible()) {
      win.focus()
    } else {
      win.show()
      win.focus()
    }
  })

  // Build initial menu + refresh on interval
  const rebuild = (): void => {
    tray.setContextMenu(buildMenu(getMainWindow))
  }
  rebuild()
  refreshTimer = setInterval(rebuild, 5_000)
}

export function teardownTrayMenu(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

// ── Menu Builder ──────────────────────────────────────────────────────

function buildMenu(getMainWindow: () => BrowserWindow | null): Menu {
  const template: MenuItemConstructorOptions[] = []

  // ── App title (disabled label) ──
  template.push({ label: 'Code Atelier', enabled: false })
  template.push({ type: 'separator' })

  // ── Bug count ──
  const bugCount = getBugCount()
  if (bugCount > 0) {
    template.push({
      label: `🐛  ${bugCount} bug${bugCount !== 1 ? 's' : ''} unresolved`,
      click: () => showAndNavigate(getMainWindow, 'bugs')
    })
    template.push({ type: 'separator' })
  }

  // ── Workspaces submenu ──
  const workspaces = getWorkspaces()
  if (workspaces.length > 0) {
    const workspaceItems: MenuItemConstructorOptions[] = workspaces
      .slice(0, 8)
      .map((ws) => {
        const status = getWorkspaceStatusLabel(ws.id)
        return {
          label: `${ws.name}${status ? `  —  ${status}` : ''}`,
          click: () => showAndNavigate(getMainWindow, 'workspace', ws.id)
        }
      })
    template.push({ label: 'Workspaces', submenu: workspaceItems })
    template.push({ type: 'separator' })
  }

  // ── Running tasks (informational) ──
  const taskLines = getRunningTaskLines()
  if (taskLines.length > 0) {
    for (const line of taskLines) {
      template.push({ label: line, enabled: false })
    }
    template.push({ type: 'separator' })
  }

  // ── Actions ──
  template.push({
    label: 'Show Window',
    accelerator: 'Command+1',
    click: () => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return
      win.show()
      win.focus()
    }
  })
  template.push({ type: 'separator' })
  template.push({
    label: 'Quit Code Atelier',
    accelerator: 'Command+Q',
    click: () => app.quit()
  })

  return Menu.buildFromTemplate(template)
}

// ── Helpers ───────────────────────────────────────────────────────────

function getBugCount(): number {
  try {
    return bugRepository.getUnresolvedCount()
  } catch {
    return 0
  }
}

function getWorkspaces(): { id: string; name: string }[] {
  try {
    return workspaceRepository.findAll()
  } catch {
    return []
  }
}

function getWorkspaceStatusLabel(workspaceId: string): string {
  try {
    // Chat — check all workspace sessions
    const chatStatuses = chatAgentService.getAllStatuses()
    const chat = chatStatuses.get(workspaceId)
    if (chat && chat.status !== 'idle' && chat.status !== 'completed' && chat.status !== 'failed') {
      return 'Chat: running'
    }

    // Blueprint
    if (blueprintService.isRunning(workspaceId)) return 'Blueprint: running'

    // MPA (goal orchestration)
    if (mpaOrchestrationService.isRunningForWorkspace(workspaceId)) return 'Goal: running'

    // Council
    if (councilService.isRunningForWorkspace(workspaceId)) return 'Council: running'

    // Grill (evaluation)
    if (grillAgentService.isRunningForWorkspace(workspaceId)) return 'Grill: running'

    // Audit
    if (auditAgentService.isRunningForWorkspace(workspaceId)) return 'Audit: running'
  } catch {
    // Graceful fallback — service may not be initialized yet
  }

  return ''
}

function getRunningTaskLines(): string[] {
  const lines: string[] = []
  try {
    if (auditAgentService.isRunning) lines.push('⏳  Audit running...')
    if (mpaOrchestrationService.isRunning) lines.push('⏳  Goal pipeline running...')
    if (councilService.isRunning) lines.push('⏳  Council running...')
    if (grillAgentService.isRunning) lines.push('⏳  Grill running...')
  } catch {
    // Graceful fallback
  }
  return lines
}

function showAndNavigate(
  getMainWindow: () => BrowserWindow | null,
  view: string,
  workspaceId?: string
): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()
  // Send IPC to renderer to navigate
  win.webContents.send(IPC_CHANNELS.TRAY_NAVIGATE, { view, workspaceId })
}
