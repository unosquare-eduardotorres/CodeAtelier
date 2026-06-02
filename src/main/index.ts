import log, { dbLogger } from './logger'
import {
  app,
  shell,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  session,
  dialog,
  crashReporter
} from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getDatabase, closeDatabase } from './db'
import { registerAllIpcHandlers } from './ipc'
import { chatAgentService, skillService } from './services'
import { memoryFeedService } from './services/memory-feed.service'
import { autoUpdateService } from './services/auto-update.service'
import { eventLoggerService } from './services/event-logger.service'
import { grillAgentService } from './services/grill-agent.service'
import { auditAgentService } from './services/audit-agent.service'
import { mpaOrchestrationService } from './services/mpa-orchestration.service'
import { councilService } from './services/council.service'

import { initFileWatcherHandler } from './services/file-watcher.handler'
import { fileWatcherService } from './services/file-watcher.service'
import { llamafileEmbeddingProvider } from './services/llamafile-embedding.service'
import { cleanupStalePromptFiles } from './services/cli-executor'

// Initialize electron-log for the main process
// Must happen before app.whenReady() for early error capture
log.initialize()

// Fix dock tooltip: Electron defaults to "Electron" in dev mode.
// Must be set before app.whenReady().
app.setName('Code Atelier')

// ── Process-level error safety net — never crash silently ──
process.on('uncaughtException', (error) => {
  log.error('[Process] Uncaught exception:', error)
  // Don't exit — let the app continue running if possible
  // The user may see degraded functionality but won't lose their work
  reportMainProcessBug(error, 'fatal')
})

process.on('unhandledRejection', (reason) => {
  log.error('[Process] Unhandled rejection:', reason)
  // Same safety — log but don't crash
  reportMainProcessBug(reason instanceof Error ? reason : new Error(String(reason)), 'error')
})

/** Report a main-process error to the bug tracker DB + notify renderer */
function reportMainProcessBug(error: Error, severity: 'error' | 'fatal'): void {
  try {
    // Lazy import to avoid circular deps during early bootstrap
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { bugRepository } = require('./db/repositories/bug.repository')

    // Parse source file/line from stack trace
    let sourceFile: string | undefined
    let sourceLine: number | undefined
    let sourceColumn: number | undefined
    if (error.stack) {
      const match = error.stack.match(/at .+\((.+):(\d+):(\d+)\)/)
      if (match) {
        sourceFile = match[1]
        sourceLine = parseInt(match[2], 10)
        sourceColumn = parseInt(match[3], 10)
      }
    }

    const result = bugRepository.upsertBug({
      process: 'main' as const,
      severity,
      errorMessage: error.message,
      stackTrace: error.stack,
      sourceFile,
      sourceLine,
      sourceColumn,
      appVersion: app.getVersion(),
      osInfo: `${process.platform} ${os.release()}`
    })

    if (result.isNew) {
      const bug = bugRepository.getById(result.bugId)
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send('bug:new', bug)
        } catch {
          // Window may be destroyed
        }
      }
    }
  } catch {
    // Bug tracker itself failed — don't crash the crash handler
    log.error('[BugTracker] Failed to report main process error to bug tracker')
  }
}

// Tracer / message-bus bridges were removed with the specialist-pool deletion
// (migration 66 onward): no multi-agent pipeline means no cross-agent trace
// spans or message-bus events to persist.

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null

function createSplashWindow(): void {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 320,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: '#0F1517',
    center: true,
    skipTaskbar: true,
    icon,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Load splash HTML — in dev from renderer URL base, in prod from file
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    splashWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/splash.html`)
  } else {
    splashWindow.loadFile(join(__dirname, '../renderer/splash.html'))
  }

  splashWindow.once('ready-to-show', () => {
    splashWindow?.show()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0F1517',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  const splashStartTime = Date.now()
  const MINIMUM_SPLASH_DURATION = 3000 // 3s minimum for brand feel

  mainWindow.on('ready-to-show', () => {
    const elapsed = Date.now() - splashStartTime
    const remaining = Math.max(0, MINIMUM_SPLASH_DURATION - elapsed)

    setTimeout(() => {
      mainWindow?.show()
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.destroy()
        splashWindow = null
      }
    }, remaining)
  })

  // Safety timeout: if main window fails to load within 15s, show it anyway
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy()
      splashWindow = null
    }
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show()
    }
  }, 15000)

  // ── Security: Validate URLs before opening externally (#2) ──
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
        shell.openExternal(url)
      }
    } catch {
      // Invalid URL, ignore
    }
    return { action: 'deny' }
  })

  // ── Security: Block navigation to untrusted origins (#3) ──
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // In dev mode, allow HMR navigation
    if (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? '')) {
      return
    }
    // Block all other navigation — open external links in browser
    event.preventDefault()
    try {
      const parsed = new URL(url)
      if (['https:', 'http:'].includes(parsed.protocol)) {
        shell.openExternal(url)
      }
    } catch {
      // Invalid URL, ignore
    }
  })

  // ── Initialize database with error handling (#14) ──
  try {
    getDatabase()
  } catch (error) {
    dbLogger.error('Failed to initialize database:', error)
    dialog.showErrorBox(
      'Database Error',
      `Code Atelier failed to initialize its database. The application may not work correctly.\n\n${(error as Error).message}`
    )
  }

  // Clean up stale "running" sessions left over from a previous app crash/quit
  try {
    const { agentSessionRepository } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./db/repositories') as typeof import('./db/repositories')
    const staleCount = agentSessionRepository.terminateStale()
    if (staleCount > 0) {
      log.info(`[Startup] Terminated ${staleCount} stale agent session(s) from previous run`)
    }
  } catch (error) {
    log.warn('[Startup] Failed to clean up stale sessions (non-critical):', error)
  }

  // Prune old events to prevent unbounded DB growth
  try {
    eventLoggerService.prune(30)
  } catch (error) {
    dbLogger.debug('Event pruning on startup failed (non-critical):', error)
  }

  // Register IPC handlers
  registerAllIpcHandlers(mainWindow)

  // Initialize file watcher handler — connects fs.watch events to Code Graph + Semantic Search
  initFileWatcherHandler()

  // Initialize auto-updater (production only — dev uses electron-vite HMR)
  if (!is.dev) {
    autoUpdateService.init(mainWindow)
    // Check for updates shortly after launch to avoid blocking startup
    setTimeout(() => autoUpdateService.checkForUpdates(), 5000)
  }

  // HMR for renderer based on electron-vite cli.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── Security: Minimal production menu — preserves standard keyboard shortcuts ──
if (!is.dev) {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    ...(isMac
      ? [
          {
            label: 'Window',
            submenu: [{ role: 'minimize' as const }, { role: 'zoom' as const }]
          }
        ]
      : [])
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── Security: Validate webview creation — deny all webviews ──
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (webviewEvent, webPreferences) => {
    // Strip any preload scripts from webview
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    // Code Atelier does not use webviews — deny all
    webviewEvent.preventDefault()
  })
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.code-atelier')

  // ── Code Atelier: Force dark mode always ──
  nativeTheme.themeSource = 'dark'

  // Set dock icon on macOS (BrowserWindow icon option is ignored on macOS)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  // ── macOS Tray Icon (Code Atelier diamond sigil) ──
  if (process.platform === 'darwin') {
    const trayIconPath = join(__dirname, '../../resources/trayTemplate@2x.png')
    const trayIcon = nativeImage.createFromPath(trayIconPath)
    trayIcon.setTemplateImage(true)
    const tray = new Tray(trayIcon)
    tray.setToolTip('Code Atelier')
    // Keep reference to prevent GC
    ;(app as unknown as Record<string, unknown>)._tray = tray
  }

  // ── Crash reporter: captures GPU/renderer native crashes locally ──
  crashReporter.start({
    productName: 'Code Atelier',
    submitURL: '',
    uploadToServer: false
  })

  // ── Startup cleanup: remove stale system-prompt temp files from prior crashes ──
  cleanupStalePromptFiles()

  // ── Security: Restrict web permissions (#7) ──
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions: string[] = ['notifications', 'media']
    callback(allowedPermissions.includes(permission))
  })

  // ── Security: Set CSP via session headers (#8) ──
  // In dev mode, Vite HMR requires 'unsafe-eval', 'unsafe-inline', and ws: connections
  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file: https://cdn.jsdelivr.net; font-src 'self'; connect-src 'self'"
          ]
        }
      })
    })
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createSplashWindow()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Quit on all platforms — including macOS.
  // Code Atelier runs background CLI processes that should be cleaned up
  // via the before-quit handler rather than lingering in the dock.
  app.quit()
})

let isQuitting = false
app.on('before-quit', async (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true

  // Cleanup skill service (cancel in-progress Opus calls, discard queue)
  try {
    await skillService.shutdown()
  } catch (e) {
    log.debug('Skill service shutdown error (expected during quit):', e)
  }

  // Cleanup ALL running workspace sessions (multi-session concurrent support)
  try {
    await chatAgentService.stopAll()
  } catch (e) {
    log.debug('Chat session shutdown error (expected during quit):', e)
  }

  // Cleanup grill evaluations
  try {
    await grillAgentService.shutdown()
  } catch (e) {
    log.debug('Grill shutdown error (expected during quit):', e)
  }

  // Cleanup audit operations
  try {
    await auditAgentService.shutdown()
  } catch (e) {
    log.debug('Audit shutdown error (expected during quit):', e)
  }

  // Cleanup MPA pipelines
  try {
    await mpaOrchestrationService.shutdown()
  } catch (e) {
    log.debug('MPA shutdown error (expected during quit):', e)
  }

  // Cleanup council evaluations
  try {
    await councilService.shutdown()
  } catch (e) {
    log.debug('Council shutdown error (expected during quit):', e)
  }

  // Cleanup memory feed (cancel in-progress claude -p summarizer)
  try {
    memoryFeedService.shutdown()
  } catch (e) {
    log.debug('Memory feed shutdown error (expected during quit):', e)
  }

  // Stop all file watchers for Code Graph / Semantic Search
  fileWatcherService.stopAll()

  // Kill the llamafile embedding sidecar so it doesn't orphan after quit
  try {
    llamafileEmbeddingProvider.dispose()
  } catch (e) {
    log.debug('Llamafile embedding dispose error (expected during quit):', e)
  }

  closeDatabase()
  app.quit()
})
