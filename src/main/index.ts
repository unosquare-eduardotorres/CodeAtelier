import log, { dbLogger } from './logger'
import { app, shell, BrowserWindow, Menu, session, dialog, crashReporter } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getDatabase, closeDatabase } from './db'
import { registerAllIpcHandlers } from './ipc'
import { generalistService, orchestratorService, skillService } from './services'
import { agentRegistry } from './services/agent-registry'
import { memoryFeedService } from './services/memory-feed.service'
import { autoUpdateService } from './services/auto-update.service'

// Initialize electron-log for the main process
// Must happen before app.whenReady() for early error capture
log.initialize()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111827',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

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
      `Agent Studio failed to initialize its database. The application may not work correctly.\n\n${(error as Error).message}`
    )
  }

  // Initialize agent registry from YAML files (single source of truth)
  try {
    agentRegistry.loadFromDisk()
    agentRegistry.startWatching()
  } catch (error) {
    dbLogger.warn('Failed to initialize agent registry:', error)
  }

  // Register IPC handlers
  registerAllIpcHandlers(mainWindow)

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
    // Agent Studio does not use webviews — deny all
    webviewEvent.preventDefault()
  })
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.agent-studio')

  // Set dock icon on macOS (BrowserWindow icon option is ignored on macOS)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  // ── Crash reporter: captures GPU/renderer native crashes locally ──
  crashReporter.start({
    productName: 'Agent Studio',
    submitURL: '',
    uploadToServer: false
  })

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
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
          ]
        }
      })
    })
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let isQuitting = false
app.on('before-quit', async (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true

  // Cleanup skill service (cancel in-progress Opus calls, discard queue)
  try {
    await skillService.shutdown()
  } catch {
    // Ignore errors during shutdown
  }

  // Cleanup orchestrator
  try {
    await orchestratorService.stop()
  } catch {
    // Ignore errors during shutdown
  }

  // Cleanup generalist (long-lived interactive claude process)
  try {
    await generalistService.stop()
  } catch {
    // Ignore errors during shutdown
  }

  // Cleanup memory feed (cancel in-progress claude -p summarizer)
  try {
    memoryFeedService.shutdown()
  } catch {
    // Ignore errors during shutdown
  }

  // Stop watching agent YAML files
  agentRegistry.stopWatching()

  closeDatabase()
  app.quit()
})
