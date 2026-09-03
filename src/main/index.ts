// MUST be first: pins app.getName() before any import resolves a userData path.
// Reordering this below another import re-opens the store-flipping bug that
// presented as "the update wiped my workspaces and credentials".
import './app-identity'
import log, { dbLogger } from './logger'
import { startVitals, stopVitals, setVitalsProviders, vitalsLog } from './main-vitals'
import { openCodeExecutor } from './services/opencode-executor'
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
  crashReporter,
  powerMonitor
} from 'electron'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import os from 'node:os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import iconDefault from '../../resources/icon.png?asset'
import iconWin from '../../resources/icon-win.png?asset'
const icon = process.platform === 'win32' ? iconWin : iconDefault
import { getDatabase, closeDatabase } from './db'
import {
  agentSessionRepository,
  appPreferenceRepository,
  grillSessionRepository,
  workspaceRepository
} from './db/repositories'
// Direct module import — bugRepository is not re-exported from the barrel.
// Was a lazy require('./db/repositories/bug.repository'), which resolved to a
// non-existent path in packaged builds, so main-process bugs were never recorded.
import { bugRepository } from './db/repositories/bug.repository'
import { registerAllIpcHandlers } from './ipc'
import { chatAgentService, skillService } from './services'
import { memoryExtractionService } from './services/memory-extraction.service'
import { memoryEngineService } from './services/memory-engine.service'
import { memoryBootstrapService } from './services/memory-bootstrap.service'
import { autoUpdateService } from './services/auto-update.service'
import { runStartupRetention } from './services/startup-retention'
import { trackService, registerTrackBusyProbe } from './services/track.service'
import { lifecycleRegistry } from './services/conversation-lifecycle'
import { blueprintService } from './services/blueprint.service'
import { blueprintRepository } from './db/repositories/blueprint.repository'
import { landingService } from './services/landing.service'
import { grillAgentService } from './services/grill-agent.service'
import { grillPersistenceController } from './services/grill-persistence.controller'
import { auditAgentService } from './services/audit-agent.service'
import { mpaOrchestrationService } from './services/mpa-orchestration.service'
import { councilService } from './services/council.service'
import { blueprintPlanRevisionService } from './services/blueprint-plan-revision.service'
import { setupTrayMenu, teardownTrayMenu } from './tray-menu'

import { initFileWatcherHandler } from './services/file-watcher.handler'
import { fileWatcherService } from './services/file-watcher.service'
import { localEmbeddingProvider } from './services/local-embedding.provider'
import { cleanupStalePromptFiles } from './services/cli-executor'
import { openCodeConfigWriter } from './services/opencode-config-writer'
import { notificationService } from './services/notification.service'
import { backgroundTaskWatcherService } from './services/background-task-watcher.service'
import { memoryConsolidationService } from './services/memory-consolidation.service'

// Augment PATH to include Homebrew and npm global bin directories
// CRITICAL: Ensures child_process.spawn() can locate binaries like 'opencode',
// which the @opencode-ai/sdk needs to start its server locally
import {
  augmentOpenCodeCliPath,
  locateOpenCodeCli,
  resolveOpencodePath,
  ensureOpencodePathInEnv
} from '../shared/opencode-cli-path'

// Augment PATH before any services or child processes are initialized
augmentOpenCodeCliPath()

// Synchronously resolve and inject the OpenCode CLI binary path into PATH
// This MUST happen before any async code or services that might spawn processes
try {
  // Use npm-based resolution (more robust than hardcoded paths)
  const opencodePath = resolveOpencodePath()

  if (opencodePath) {
    ensureOpencodePathInEnv()
    log.info(`[OpenCode CLI] Resolved: ${opencodePath}. PATH updated.`)
  } else {
    log.warn(
      `[OpenCode CLI] WARNING: Could not find 'opencode' binary. Install with: npm install -g @opencode-ai/cli`
    )
  }
} catch (err: unknown) {
  log.error('[OpenCode CLI] Path resolution failed:', err)
}

// Initialize electron-log for the main process
// Must happen before app.whenReady() for early error capture
log.initialize()

// Asynchronously verify OpenCode CLI is available (for diagnostics)
locateOpenCodeCli()
  .then((result: any) => {
    if (result.available) {
      log.info(
        `[OpenCode CLI] Verified at ${result.path} (${result.source}), version: ${result.version || 'unknown'}`
      )
    } else {
      log.warn(`[OpenCode CLI] ${result.error}`)
    }
  })
  .catch((err: unknown) => {
    log.error('[OpenCode CLI] Location check failed:', err)
  })

// App name (and therefore the userData directory) is pinned in ./app-identity,
// imported first so it cannot lose a race with the logger or the DB module.

// ── Single-instance lock: prevent multiple instances opening the same DB ──
// Two Electron processes writing to the same SQLite file (5+ GB) cause
// WAL checkpoint deadlocks and data corruption. Standard Electron pattern.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Focus existing window when user tries to open a second instance
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

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
  } catch (reportError) {
    // Bug tracker itself failed — don't crash the crash handler.
    // Log the underlying cause: a bare message here made a MODULE_NOT_FOUND
    // from the old lazy require() indistinguishable from a real DB failure.
    log.error(
      '[BugTracker] Failed to report main process error to bug tracker:',
      reportError,
      '| original error:',
      error.message
    )
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

// Hoisted: used by the MACOS-DOCK close interceptor inside createWindow()
// and the before-quit handler below.
let isQuitting = false

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

  // ELECTRON-01: Null out mainWindow reference when the window is closed
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // MACOS-DOCK: On macOS, intercept the close button to hide-to-dock instead of
  // destroying the window. This prevents `window-all-closed` from firing and
  // quitting the app while background work (e2e tests, blueprints, etc.) is running.
  // The actual quit is triggered via Cmd+Q / menu → Quit / app.quit().
  if (process.platform === 'darwin') {
    mainWindow.on('close', (event) => {
      if (!isQuitting) {
        event.preventDefault()
        mainWindow?.hide()
      }
    })
  }

  const splashStartTime = Date.now()
  const MINIMUM_SPLASH_DURATION = 3000 // 3s minimum for brand feel

  // ELECTRON-02: Track timers for cleanup — use event-driven splash dismissal
  let splashTimer: ReturnType<typeof setTimeout> | undefined
  let safetyTimer: ReturnType<typeof setTimeout> | undefined

  const dismissSplash = (): void => {
    if (splashTimer) {
      clearTimeout(splashTimer)
      splashTimer = undefined
    }
    if (safetyTimer) {
      clearTimeout(safetyTimer)
      safetyTimer = undefined
    }
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy()
      splashWindow = null
    }
  }

  mainWindow.on('ready-to-show', () => {
    const elapsed = Date.now() - splashStartTime
    const remaining = Math.max(0, MINIMUM_SPLASH_DURATION - elapsed)

    splashTimer = setTimeout(() => {
      mainWindow?.show()
      dismissSplash()
    }, remaining)
  })

  // Safety timeout: if main window fails to load within 15s, show it anyway
  safetyTimer = setTimeout(() => {
    dismissSplash()
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
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

  // ── Renderer crash/hang observability ──
  // Without these handlers, a renderer crash or freeze is completely silent.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error(`[Renderer] Process gone — reason: ${details.reason}, exitCode: ${details.exitCode}`)
    // Write renderer crash info to vitals for crash-diagnosis
    vitalsLog.error(
      `[RENDERER-GONE] reason=${details.reason} exitCode=${details.exitCode} detail="" rss_mb=${Math.round(process.memoryUsage().rss / 1024 / 1024)}`
    )
    // If the renderer died (not a clean exit), attempt to reload the window
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      log.info('[Renderer] Attempting to reload window after crash')
      mainWindow.webContents.reload()
    }
  })

  mainWindow.webContents.on('unresponsive', () => {
    log.warn('[Renderer] Window became unresponsive (possible V8 wedge or long JS task)')
  })

  mainWindow.webContents.on('responsive', () => {
    log.info('[Renderer] Window became responsive again')
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

  // Clean up stale sessions left over from a previous app crash/quit
  try {
    const staleAgents = agentSessionRepository.terminateStale()
    if (staleAgents > 0) {
      log.info(`[Startup] Terminated ${staleAgents} stale agent session(s) from previous run`)
    }
    const staleGrills = grillSessionRepository.terminateStale()
    if (staleGrills > 0) {
      log.info(`[Startup] Recovered ${staleGrills} stale grill session(s) from previous run`)
    }
    // Session IDs are preserved across restarts — the CLI will attempt
    // --resume on the next message. If the server-side session expired,
    // handleSessionRecovery detects the error, clears the stale ID,
    // and retries with DB-backed context injection.
  } catch (error) {
    log.warn('[Startup] Failed to clean up stale sessions (non-critical):', error)
  }

  // Reclaim worktrees left behind by a crash.
  //
  // Teardown is two-step (mark 'removing' → git worktree remove → delete row),
  // so a hard quit in the middle leaves either a tombstone row or a row whose
  // directory is already gone. Both pin a branch that no chat can then claim,
  // so this runs before any conversation gets a chance to ask for one.
  void trackService
    .pruneOrphans()
    .then((reclaimed) => {
      if (reclaimed > 0) {
        log.info(`[Startup] Reclaimed ${reclaimed} orphaned worktree(s) from previous run`)
      }
      // Then the idle policy. Ordered after pruning because a missing directory
      // is the reaper's skip case and the pruner's job, so running it first
      // means the reaper only ever looks at trees that really exist.
      return trackService.reapIdle()
    })
    .then((reaped) => {
      if (reaped > 0) {
        log.info(`[Startup] Reclaimed ${reaped} idle clean worktree(s) — no uncommitted work lost`)
      }
    })
    .catch((error) => {
      log.warn('[Startup] Worktree pruning failed (non-critical):', error)
    })

  // Handing a branch from a chat to a blueprint (or back) must be refused while
  // the current owner is mid-turn — otherwise a second writer is pointed at a
  // directory the first is still writing into. `transferOwner` cannot ask the
  // services that know: blueprint.service already reaches back into
  // track.service through blueprint-track, so importing it there would close an
  // import cycle. The probes are registered here instead, at the root, where
  // importing both is already free.
  registerTrackBusyProbe('chat', (conversationId) =>
    lifecycleRegistry.isStreaming(conversationId) ? 'it is streaming a reply right now' : null
  )
  registerTrackBusyProbe('blueprint', (blueprintId) => {
    const workspaceId = blueprintRepository.findById(blueprintId)?.workspaceId
    if (!workspaceId) return null
    // Scoped to THIS blueprint rather than `isRunning(workspaceId)`: the latter
    // is true whenever any blueprint in the workspace is running, which would
    // refuse handoffs that have nothing to do with the running one.
    return blueprintService.getActiveBlueprintId(workspaceId) === blueprintId
      ? 'its pipeline is still running'
      : null
  })

  // Boot is not the only moment worktrees go idle. Without a timer the retention
  // policy silently becomes "whenever you restart the app", so a long-lived
  // session accumulates trees indefinitely no matter how untouched they are.
  trackService.startIdleReaper()

  // Landed branches accumulate the same way idle worktrees do — branch-per-chat
  // plus branch-per-blueprint leaves hundreds of merged `chat/*` and
  // `blueprint/*` refs behind over a few months. Only tracks whose work has
  // already reached the mainline AND whose tree is clean are collected.
  void landingService
    .gcAllWorkspaces()
    .catch((error) => log.warn('[Startup] Branch GC failed (non-critical):', error))
  landingService.startBranchGc()

  // Prune old events, usage and blueprint telemetry to prevent unbounded DB
  // growth. Extracted so it is reachable from a test and so one divergent table
  // cannot cancel the prunes that follow it — see startup-retention.ts.
  runStartupRetention()

  // Initialize notification service with main window + load preference
  notificationService.setMainWindow(mainWindow)
  try {
    const prefs = appPreferenceRepository.getAppPreferences()
    notificationService.setEnabled(prefs.notificationsEnabled)
  } catch (error) {
    // Non-fatal — default to enabled. Logged because a silent failure here is
    // exactly what made "notifications off" silently revert on every launch.
    log.warn('[Notifications] Failed to load saved preference, defaulting to enabled:', error)
  }

  // Register IPC handlers
  registerAllIpcHandlers(mainWindow)

  // Initialize file watcher handler — connects fs.watch events to Code Graph + Semantic Search
  initFileWatcherHandler()

  // Watch detached background processes so their exit can notify + wake the agent
  backgroundTaskWatcherService.setMainWindow(mainWindow)
  backgroundTaskWatcherService.start()

  // Initialize auto-updater (production only — dev uses electron-vite HMR)
  if (!is.dev) {
    autoUpdateService.init(mainWindow)
    // Check for updates shortly after launch to avoid blocking startup
    setTimeout(() => autoUpdateService.checkForUpdates(), 5000)
    // ...then keep checking: a session left open for hours must still notice a
    // release published after launch.
    autoUpdateService.startPeriodicChecks()
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

  // ── Memory Engine: decay sweep at app launch (throttled to max 1/24h) ──
  try {
    memoryEngineService.runDecaySweepIfDue()
  } catch (e) {
    log.debug('Memory decay sweep error (non-fatal):', e)
  }

  // ── Feed Brain: demote crash-orphaned runs to `paused` so they resume ──
  // A force-quit leaves rows claiming to be `running` with no process behind
  // them; without this they would block new runs forever.
  try {
    memoryBootstrapService.recoverOrphanedRuns()
  } catch (e) {
    log.debug('Bootstrap orphan recovery error (non-fatal):', e)
  }

  // ── Memory Consolidation: idle job starts when a workspace is opened ──
  // (wired in workspace.ipc.ts handleWorkspaceOpen — not at app launch,
  //  because there's no real workspace ID until the user opens one)

  // ── Embedding: auto-load model at startup (delayed, non-fatal) ──
  // Configure against the last-opened workspace first — the facade defaults to
  // the oMLX backend, which can never succeed on Windows.
  setTimeout(async () => {
    try {
      const [lastWorkspace] = workspaceRepository.findAll() // ORDER BY last_opened_at DESC
      if (lastWorkspace) localEmbeddingProvider.configureForWorkspace(lastWorkspace.id)
      const ready = await localEmbeddingProvider.ensureEmbeddingReady()
      log.info(
        `Startup embedding probe: ready=${ready} model=${localEmbeddingProvider.activeModelName || '(none)'}`
      )
    } catch (e) {
      log.info('Startup embedding auto-load failed (non-fatal):', e)
    }
  }, 5000)

  // ── Prompt Optimizer: pre-warm CLI session (delayed, non-fatal) ──
  setTimeout(() => {
    import('./services/prompt-optimizer.service').then(({ promptOptimizerService }) =>
      promptOptimizerService
        .warmup()
        .catch((e) => log.debug('Prompt optimizer warmup (non-fatal):', e))
    )
  }, 8_000)

  // ── Code Atelier: Force dark mode always ──
  nativeTheme.themeSource = 'dark'

  // Set dock icon on macOS (dev only — packaged app uses bundle icon.icns)
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    app.dock.setIcon(icon)
  }

  // ── macOS Tray Icon (CA monogram) ──
  if (process.platform === 'darwin') {
    const trayIconPath = join(__dirname, '../../resources/trayTemplate@2x.png')
    const trayIcon = nativeImage.createFromPath(trayIconPath)
    trayIcon.setTemplateImage(true)
    const tray = new Tray(trayIcon)
    tray.setToolTip('Code Atelier')
    // Wire up context menu with live app state
    setupTrayMenu(tray, () => mainWindow)
    // Keep reference to prevent GC
    ;(app as unknown as Record<string, unknown>)._tray = tray
  }

  // ── Crash reporter: captures GPU/renderer native crashes locally ──
  crashReporter.start({
    productName: 'Code Atelier',
    submitURL: '',
    uploadToServer: false
  })

  // ── Vitals heartbeat: diagnoses abrupt deaths (Force Quit / kill / volume loss)
  // that leave no crash report, minidump, or graceful-shutdown trace. Writes an
  // fsync'd "last alive" line + memory/session/retry gauges to logs/vitals.log. ──
  setVitalsProviders({
    activeOpenCodeSessions: () => openCodeExecutor.getVitals().activeSessions,
    pendingRetryTimers: () => openCodeExecutor.getVitals().retriesInFlight,
    // P2: current blueprint phase per active workspace — makes crash triage
    // direct (v1.0.89 self-kill happened at the tasks→review transition).
    blueprintPhases: () => {
      try {
        return blueprintService.getActiveBlueprintPhases()
      } catch {
        return ''
      }
    },
    childProcessCount: () => {
      // pgrep is Unix-only — on Windows it doesn't exist and every 5s spawn
      // attempt adds overhead that accumulates into main-thread stalls.
      if (process.platform === 'win32') return 0
      try {
        const output = execSync('pgrep -c -P $ || true', {
          encoding: 'utf-8',
          timeout: 500
        }).trim()
        return parseInt(output, 10) || 0
      } catch {
        return 0
      }
    }
  })
  const vitalsInterval = process.platform === 'win32' ? 15_000 : 5_000
  startVitals(vitalsInterval)

  // ── Power management: pause background work during sleep, restart on wake ──
  // Without this, all accumulated timer callbacks fire in a burst after wake,
  // colliding with stale file handles and database connections. On Windows,
  // fs.watch events batch during sleep and trigger simultaneous reindexFiles()
  // + consolidation writes that compete for the SQLite write lock.
  //
  // We snapshot watcher state before stopping so we can restart after wake.
  // fileWatcherService.stopAll() closes fs.watch handles and clears all state,
  // so we need to preserve {workspaceId, workspacePath, options} to recreate them.
  let suspendedWatchers: {
    workspaceId: string
    workspacePath: string
    codeGraphEnabled: boolean
    semanticSearchEnabled: boolean
  }[] = []
  let suspendedConsolidationWorkspace: string | null = null

  powerMonitor.on('suspend', () => {
    log.info('[Power] System suspending — pausing vitals, file watchers, consolidation')
    stopVitals()

    // Snapshot active watchers before stopping them
    suspendedWatchers = fileWatcherService.getActiveWatchers()
    fileWatcherService.stopAll()

    // Snapshot consolidation workspace before stopping
    suspendedConsolidationWorkspace = memoryConsolidationService.boundWorkspaceId
    memoryConsolidationService.stopIdleJob()
  })
  powerMonitor.on('resume', () => {
    log.info('[Power] System resumed — restarting background services after stabilisation delay')
    // Delay restart to let disk, network, and file handles stabilise after wake.
    setTimeout(() => {
      startVitals(vitalsInterval)

      // Restart file watchers for previously-active workspaces
      for (const w of suspendedWatchers) {
        try {
          fileWatcherService.start(w.workspaceId, w.workspacePath, {
            codeGraphEnabled: w.codeGraphEnabled,
            semanticSearchEnabled: w.semanticSearchEnabled
          })
        } catch (e) {
          log.warn(`[Power] Failed to restart file watcher for ${w.workspaceId}:`, e)
        }
      }
      suspendedWatchers = []

      // Restart consolidation for previously-active workspace
      if (suspendedConsolidationWorkspace) {
        try {
          memoryConsolidationService.startIdleJob(suspendedConsolidationWorkspace)
        } catch (e) {
          log.warn('[Power] Failed to restart consolidation:', e)
        }
        suspendedConsolidationWorkspace = null
      }
    }, 3000)
  })

  // On Windows, `before-quit` does NOT fire during system shutdown/restart/signoff
  // (electron/electron#9613, confirmed platform/windows bug). The `shutdown` event
  // from powerMonitor DOES fire in that scenario (Electron 15+). Run a best-effort
  // TRUNCATE checkpoint so the WAL file doesn't persist across reboots.
  // closeDatabase() is idempotent (checks `if (db)` before acting), so calling it
  // from both here and `before-quit` is safe.
  powerMonitor.on('shutdown', () => {
    log.info('[Power] System shutdown detected — running best-effort WAL checkpoint')
    try {
      closeDatabase()
    } catch {
      // Best-effort — process is about to die anyway
    }
  })

  // ── Startup cleanup: remove stale system-prompt temp files from prior crashes ──
  cleanupStalePromptFiles()

  // GLM-P2: opencode.json holds a plaintext provider API key. A crash or force-quit
  // skips disposal, so sweep anything a previous process left behind. Must run before
  // any session writes its config.
  openCodeConfigWriter.sweepStaleConfigs()

  // ── OpenCode CLI: Verify resolution at startup and log to BUGS section if failed ──
  try {
    const reResolved = resolveOpencodePath()
    if (!reResolved) {
      // Resolution failed - log to bug tracker
      bugRepository.upsertBug({
        process: 'main' as const,
        severity: 'error',
        errorMessage: 'Failed to resolve OpenCode CLI path at startup',
        stackTrace: new Error('OpenCode CLI resolution failed').stack,
        sourceFile: __filename,
        sourceLine: -1,
        sourceColumn: -1,
        appVersion: app.getVersion(),
        osInfo: `${process.platform} ${os.release()}`
      })
    } else {
      log.info(`[OpenCode CLI] Startup verification: Resolved at ${reResolved}`)
      ensureOpencodePathInEnv()
    }
  } catch (error) {
    // Log resolution failure to bug tracker
    try {
      bugRepository.upsertBug({
        process: 'main' as const,
        severity: 'error',
        errorMessage: `OpenCode CLI resolution failed: ${(error as Error).message}`,
        stackTrace: (error as Error).stack,
        sourceFile: __filename,
        sourceLine: -1,
        sourceColumn: -1,
        appVersion: app.getVersion(),
        osInfo: `${process.platform} ${os.release()}`
      })
    } catch (reportError) {
      // Don't crash the crash handler — but never fail silently.
      log.error('[BugTracker] Failed to record OpenCode CLI resolution failure:', reportError)
    }
  }

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
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show() // re-show the hide-to-dock window
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS, the hide-to-dock interceptor (MACOS-DOCK) prevents the last window
  // from being destroyed, so this event should only fire on non-macOS platforms.
  // If it fires on macOS, something bypassed the interceptor — quit cleanly.
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  teardownTrayMenu()

  // E2E-GUARD: If an E2E test run is in progress, cancel it before shutdown.
  // No blocking wait needed — recoverOrphanedRuns() + the runner's finally block
  // already finalize an interrupted run on next launch.
  try {
    const { e2eRunnerService } = await import('./services/e2e-testing/e2e-runner.service')
    if (e2eRunnerService.isRunning()) {
      log.warn('[before-quit] E2E test run in progress — cancelling before shutdown')
      e2eRunnerService.cancel()
    }
  } catch (e) {
    log.debug('[before-quit] E2E runner check failed (non-fatal):', e)
  }

  // QUIT-FAILSAFE: Unconditional 5s failsafe — even if the cleanup below throws
  // or a wedged renderer never acks window-close, the process WILL terminate.
  const failsafe = setTimeout(() => {
    log.warn('[before-quit] Failsafe triggered — force-exiting after 5s')
    app.exit(1)
  }, 5000)
  failsafe.unref()

  // Run all cleanup under a 4s timeout (must finish before the 5s failsafe).
  // Each shutdown is individually try/caught so one failure doesn't block others.
  const cleanup = async (): Promise<void> => {
    // Stop the vitals heartbeat first so a clean quit is distinguishable from a
    // hard kill in vitals.log (a graceful exit ends with an EXIT line, not a
    // silently truncated heartbeat).
    stopVitals()

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

    // GRILL-SHUTDOWN-01: Flush pending grill persistence buffers and clear timers
    // before DB closes. Without this, scheduled flush timers fire after DB closes.
    try {
      grillPersistenceController.clearTracking()
    } catch (e) {
      log.debug('Grill persistence cleanup error (expected during quit):', e)
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

    // Cleanup blueprint plan-revision turns (clears the in-flight guard so a
    // turn interrupted by quit cannot leave the gate locked on next launch)
    try {
      await blueprintPlanRevisionService.shutdown()
    } catch (e) {
      log.debug('Blueprint plan-revision shutdown error (expected during quit):', e)
    }

    // Cleanup memory feed (cancel in-progress claude -p summarizer)
    try {
      memoryExtractionService.shutdown()
    } catch (e) {
      log.debug('Memory feed shutdown error (expected during quit):', e)
    }

    // Stop all file watchers for Code Graph / Semantic Search
    fileWatcherService.stopAll()

    // Reset the oMLX embedding provider state on quit
    try {
      localEmbeddingProvider.dispose()
    } catch (e) {
      log.debug('oMLX embedding dispose error (expected during quit):', e)
    }

    // GLM-P2: Remove opencode.json files still on disk — they carry a plaintext
    // provider API key. Per-session dispose() only covers the normal stop path.
    try {
      openCodeConfigWriter.disposeAll()
    } catch (e) {
      log.debug('OpenCode config dispose error (expected during quit):', e)
    }

    // Stop the periodic worktree reaper before anything else touches the DB
    try {
      trackService.stopIdleReaper()
      landingService.stopBranchGc()
    } catch (e) {
      log.debug('Track maintenance stop error (expected during quit):', e)
    }

    // Stop polling background processes (the processes themselves are detached
    // and intentionally survive the app — they stay listed on next launch)
    try {
      backgroundTaskWatcherService.stop()
    } catch (e) {
      log.debug('Background task watcher stop error (expected during quit):', e)
    }

    // Release the loopback port used to serve cloud-drive update feeds
    try {
      await autoUpdateService.dispose()
    } catch (e) {
      log.debug('Auto-update dispose error (expected during quit):', e)
    }

    // Close database last — WAL checkpoint must happen while the process is alive
    closeDatabase()
  }

  // Race the cleanup against a 4s timeout (defense-in-depth; the 5s failsafe
  // is the hard backstop if Promise.race itself somehow hangs).
  try {
    await Promise.race([
      cleanup(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 4000)
        t.unref()
      })
    ])
  } catch (e) {
    log.warn('[before-quit] Cleanup threw:', e)
  }

  // Outside cleanup() on purpose: cleanup is raced against the 4s timeout above,
  // so a slow shutdown (live sessions still winding down) would fall through to
  // app.exit(0) and skip the install entirely. Synchronous — the 5s failsafe
  // still has headroom. Re-entry is safe: `isQuitting` is already true, so a
  // before-quit triggered by quitAndInstall() returns immediately.
  autoUpdateService.installOnQuitIfReady()

  // Force-exit: app.exit(0) terminates all child processes (renderer, GPU,
  // utility) immediately — bypasses the cooperative window-close ack that
  // can strand the process when the renderer is wedged.
  clearTimeout(failsafe)
  app.exit(0)
})
