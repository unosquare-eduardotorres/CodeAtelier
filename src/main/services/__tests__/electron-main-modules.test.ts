/**
 * main-vitals.ts + app-identity.ts + tray-menu.ts — real coverage.
 *
 * All three Electron main-process modules sat at 0%: nothing imported them.
 * These tests drive them under the electron stub — the vitals heartbeat with
 * injected gauges written to a real (temp) log file, the app-identity
 * name-pinning / e2e-redirect / legacy-store-adoption matrix, and the tray
 * menu template built from mocked repositories and services, including its
 * click handlers.
 *
 * NOTE: signal handling (SIGTERM etc.) is intentionally NOT exercised —
 * process-manager-server registers a module-scope SIGTERM → process.exit(0)
 * listener, and a synthetic process.emit would take the whole unified run
 * down with it.
 *
 * Run: tsx src/main/services/__tests__/electron-main-modules.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import {
  setupFullMock,
  getMockRepo,
  createSpy,
  mockService,
  unmockService
} from './setup-full-mock'

setupFullMock()

// ── app-identity ─────────────────────────────────────────────────────────────

const DB_FILE = 'code-atelier.db'

function freshElectronApp(): any {
  const electron = require('electron')
  electron.app.__resetPathOverrides()
  electron.app.isPackaged = false
  delete process.env.DEV_USE_PACKAGED_IDENTITY
  delete process.env.E2E_USER_DATA
  delete require.cache[require.resolve('../../app-identity')]
  return electron.app
}

describe('app-identity — name pinning', () => {
  test('a dev run pins the dev store name', async () => {
    await runExclusive(async () => {
      const app = freshElectronApp()
      require('../../app-identity')
      assert.equal(app.getName(), 'code-atelier')
    })
  })

  test('DEV_USE_PACKAGED_IDENTITY=1 adopts the packaged name', async () => {
    await runExclusive(async () => {
      const app = freshElectronApp()
      process.env.DEV_USE_PACKAGED_IDENTITY = '1'
      require('../../app-identity')
      assert.equal(app.getName(), 'Code Atelier')
    })
  })

  test('E2E_USER_DATA redirects userData before anything resolves paths', async () => {
    await runExclusive(async () => {
      const app = freshElectronApp()
      const e2eDir = mkdtempSync(join(tmpdir(), 'e2e-userdata-'))
      try {
        process.env.E2E_USER_DATA = e2eDir
        require('../../app-identity')
        assert.equal(app.getPath('userData'), e2eDir)
      } finally {
        rmSync(e2eDir, { recursive: true, force: true })
      }
    })
  })
})

describe('app-identity — legacy store adoption (packaged only)', () => {
  function legacyFixture(legacyNames: string[]): { appData: string; canonical: string } {
    const root = mkdtempSync(join(tmpdir(), 'app-identity-'))
    const appData = join(root, 'appData')
    const canonical = join(appData, 'Code Atelier')
    mkdirSync(canonical, { recursive: true })
    for (const name of legacyNames) {
      const dir = join(appData, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, DB_FILE), 'marker')
    }
    return { appData, canonical }
  }

  test('dev builds never adopt a legacy store', async () => {
    await runExclusive(async () => {
      const app = freshElectronApp()
      const { appData, canonical } = legacyFixture(['code-atelier'])
      try {
        app.setPath('appData', appData)
        app.setPath('userData', canonical)
        app.isPackaged = false
        require('../../app-identity')
        assert.equal(app.getPath('userData'), canonical, 'dev stays on the dev store')
      } finally {
        rmSync(appData, { recursive: true, force: true })
      }
    })
  })

  test('a packaged build with an empty canonical store adopts the single legacy one', async () => {
    await runExclusive(async () => {
      const app = freshElectronApp()
      const { appData, canonical } = legacyFixture(['code-atelier'])
      try {
        app.setPath('appData', appData)
        app.setPath('userData', canonical)
        app.isPackaged = true
        require('../../app-identity')
        assert.equal(app.getPath('userData'), join(appData, 'code-atelier'))
      } finally {
        rmSync(appData, { recursive: true, force: true })
      }
    })
  })

  test('a populated canonical store is kept', async () => {
    await runExclusive(async () => {
      const app = freshElectronApp()
      const { appData, canonical } = legacyFixture(['code-atelier'])
      try {
        writeFileSync(join(canonical, DB_FILE), 'marker')
        app.setPath('appData', appData)
        app.setPath('userData', canonical)
        app.isPackaged = true
        require('../../app-identity')
        assert.equal(app.getPath('userData'), canonical)
      } finally {
        rmSync(appData, { recursive: true, force: true })
      }
    })
  })

  test('two legacy stores are ambiguous — canonical kept', async () => {
    await runExclusive(async () => {
      const app = freshElectronApp()
      const { appData, canonical } = legacyFixture(['code-atelier', 'Electron'])
      try {
        app.setPath('appData', appData)
        app.setPath('userData', canonical)
        app.isPackaged = true
        require('../../app-identity')
        assert.equal(app.getPath('userData'), canonical)
      } finally {
        rmSync(appData, { recursive: true, force: true })
      }
    })
  })
})

// ── main-vitals ──────────────────────────────────────────────────────────────

describe('main-vitals — heartbeat', () => {
  test('providers land in the fsynced vitals log; stop halts the timer', async () => {
    await runExclusive(async () => {
      const electron = require('electron')
      electron.app.__resetPathOverrides()
      const logsDir = mkdtempSync(join(tmpdir(), 'vitals-logs-'))
      try {
        electron.app.setPath('logs', logsDir)
        delete require.cache[require.resolve('../../main-vitals')]
        const vitals = require('../../main-vitals')

        vitals.setVitalsProviders({
          activeOpenCodeSessions: () => 2,
          pendingRetryTimers: () => 1,
          childProcessCount: () => 3,
          blueprintPhases: () => 'ws1:build'
        })
        vitals.setFdCountProvider(() => 41)

        vitals.startVitals(15)
        await new Promise((resolve) => setTimeout(resolve, 60))
        vitals.stopVitals()

        const logPath = join(logsDir, 'vitals.log')
        assert.ok(existsSync(logPath), 'vitals log must exist')
        const content = readFileSync(logPath, 'utf-8')
        assert.ok(content.includes('rss='), content)
        assert.ok(content.includes('heapUsed='), content)
        assert.ok(content.includes('ocSessions=2'), content)
        assert.ok(content.includes('retryTimers=1'), content)
        assert.ok(content.includes('childProcs=3'), content)
        assert.ok(content.includes('fds=41'), content)
        assert.ok(content.includes('bp=ws1:build'), content)

        const lengthAfterStop = readFileSync(logPath, 'utf-8').length
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(readFileSync(logPath, 'utf-8').length, lengthAfterStop, 'no ticks after stop')
      } finally {
        rmSync(logsDir, { recursive: true, force: true })
      }
    })
  })
})

// ── tray-menu ────────────────────────────────────────────────────────────────

const chatAgentService = {
  getAllStatuses: createSpy(() => new Map([['ws-1', { status: 'streaming' }]]))
}
const trayMocks: Record<string, any> = {
  chatAgentService,
  blueprintService: { isRunning: createSpy(() => false) },
  mpaOrchestrationService: {
    isRunningForWorkspace: createSpy(() => false),
    isRunning: false
  },
  councilService: { isRunningForWorkspace: createSpy(() => false), isRunning: false },
  grillAgentService: { isRunningForWorkspace: createSpy(() => false) },
  auditAgentService: { isRunningForWorkspace: createSpy(() => false), isRunning: true }
}
// Individually-keyed mocks first; the broad './services' barrel key last so it
// cannot shadow the specific ones (substring matching, insertion order).
// Each mock must carry the module's NAMED export — a bare service object
// destructures to undefined and the try/catch handlers swallow the reads.
mockService('blueprint.service', { blueprintService: trayMocks.blueprintService })
mockService('mpa-orchestration.service', {
  mpaOrchestrationService: trayMocks.mpaOrchestrationService
})
mockService('council.service', { councilService: trayMocks.councilService })
mockService('grill-agent.service', { grillAgentService: trayMocks.grillAgentService })
mockService('audit-agent.service', { auditAgentService: trayMocks.auditAgentService })
mockService('./services', { chatAgentService })

const bugRepo = getMockRepo('bug')
const wsRepo = getMockRepo('workspace')

let trayMenu: any
let trayMenuError: unknown
try {
  trayMenu = require('../../tray-menu')
} catch (err) {
  trayMenuError = err
}

function fakeTray(): any {
  return {
    listeners: {} as Record<string, Array<(...args: unknown[]) => void>>,
    menus: [] as unknown[],
    on(event: string, handler: (...args: unknown[]) => void) {
      this.listeners[event] = this.listeners[event] ?? []
      this.listeners[event].push(handler)
    },
    setContextMenu(menu: unknown) {
      this.menus.push(menu)
    }
  }
}

function fakeWindow(): any {
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    destroyed: false,
    visible: true,
    isDestroyed() {
      return this.destroyed
    },
    isVisible() {
      return this.visible
    },
    show() {
      this.visible = true
    },
    focus() {
      /* focus is a display no-op under the stub */
    },
    webContents: {
      send(channel: string, payload: unknown) {
        sent.push({ channel, payload })
      }
    },
    sent
  }
}

describe('tray-menu', () => {
  test('module loads and builds a menu from repo + service state', async () => {
    await runExclusive(async () => {
      assert.equal(trayMenuError, undefined, `tray-menu failed to load: ${trayMenuError}`)
      bugRepo.getUnresolvedCount = createSpy(() => 2)
      wsRepo.findAll = createSpy(() => [
        { id: 'ws-1', name: 'Demo' },
        { id: 'ws-2', name: 'Shop' }
      ])

      const electron = require('electron')
      const tray = fakeTray()
      const win = fakeWindow()
      trayMenu.setupTrayMenu(tray, () => win)

      assert.ok(tray.menus.length >= 1, 'initial menu built')
      const template = electron.Menu.__getLastTemplate()
      const labels = template.map((item: any) => item.label)
      assert.ok(
        labels.some((l: string) => l?.includes('2 bugs')),
        labels.join(' | ')
      )
      assert.ok(labels.includes('Workspaces'), labels.join(' | '))
      assert.ok(labels.includes('Show Window'), labels.join(' | '))
      assert.ok(labels.includes('Quit Code Atelier'), labels.join(' | '))

      // Workspace rows carry the running-status label (chat streaming on ws-1)
      const workspacesItem = template.find((item: any) => item.label === 'Workspaces')
      const wsLabels = workspacesItem.submenu.map((i: any) => i.label)
      assert.ok(
        wsLabels.some((l: string) => l.includes('Chat: running')),
        wsLabels.join(' | ')
      )

      // The audit service is "running" globally → informational line present
      assert.ok(
        labels.some((l: string) => l?.includes('Audit running')),
        labels.join(' | ')
      )

      // Clicking the bug row shows the window and navigates
      const bugItem = template.find((item: any) => item.label?.includes('bugs'))
      bugItem.click()
      assert.equal(win.sent.length, 1)
      assert.equal(win.sent[0].payload.view, 'bugs')

      // Single-click shows a hidden window
      win.visible = false
      tray.listeners['click'][0]()
      assert.equal(win.visible, true)

      trayMenu.teardownTrayMenu()
    })
  })

  test('a destroyed main window makes clicks no-ops', async () => {
    await runExclusive(async () => {
      bugRepo.getUnresolvedCount = createSpy(() => 1)
      wsRepo.findAll = createSpy(() => [])
      const electron = require('electron')
      const tray = fakeTray()
      const win = fakeWindow()
      win.destroyed = true
      trayMenu.setupTrayMenu(tray, () => win)
      const template = electron.Menu.__getLastTemplate()
      const bugItem = template.find((item: any) => item.label?.includes('bug'))
      bugItem.click()
      assert.equal(win.sent.length, 0, 'destroyed window receives nothing')
      tray.listeners['click'][0]()
      trayMenu.teardownTrayMenu()
    })
  })
})

describe('electron-main-modules — cleanup', () => {
  test('mocks unregistered, app state reset', async () => {
    await runExclusive(async () => {
      unmockService('blueprint.service')
      unmockService('mpa-orchestration.service')
      unmockService('council.service')
      unmockService('grill-agent.service')
      unmockService('audit-agent.service')
      unmockService('./services')
      const electron = require('electron')
      electron.app.__resetPathOverrides()
      electron.app.isPackaged = false
      delete process.env.DEV_USE_PACKAGED_IDENTITY
      delete process.env.E2E_USER_DATA
      assert.ok(true)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
