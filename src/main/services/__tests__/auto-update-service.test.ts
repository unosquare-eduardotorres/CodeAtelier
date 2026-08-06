/**
 * Tests for AutoUpdateService's polling + install behaviour.
 *
 * Three real symptoms are pinned here:
 *   1. An app open for hours never noticed a release published after launch —
 *      the only check was a single setTimeout 5s into startup.
 *   2. "It installs when you quit" never happened: autoInstallOnAppQuit hangs off
 *      the 'quit' event, and before-quit ends in app.exit(0), which never emits it.
 *      That hook is BaseUpdater-only, so the explicit install is Windows/Linux-only:
 *      on macOS quitAndInstall() would relaunch the app the user just quit.
 *   3. Windows showed the NSIS installer UI because quitAndInstall() was called
 *      with no arguments instead of (silent, forceRunAfter).
 *
 * Run: tsx src/main/services/__tests__/auto-update-service.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupFullMock, mockService, mockMainWindow, evictFromCache } from './setup-full-mock'

setupFullMock()

// ── electron-updater double ────────────────────────────────────────────────

interface UpdaterCall {
  method: string
  args: unknown[]
}

const autoUpdaterMock = {
  logger: null as unknown,
  autoDownload: true,
  autoInstallOnAppQuit: false,
  disableDifferentialDownload: false,
  handlers: new Map<string, (payload?: unknown) => void>(),
  calls: [] as UpdaterCall[],
  /** Set to throw from quitAndInstall, to prove install-on-quit stays non-fatal. */
  quitAndInstallThrows: false,

  on(event: string, fn: (payload?: unknown) => void) {
    this.handlers.set(event, fn)
    return this
  },
  setFeedURL(config: unknown): void {
    this.calls.push({ method: 'setFeedURL', args: [config] })
  },
  checkForUpdates(): Promise<null> {
    this.calls.push({ method: 'checkForUpdates', args: [] })
    return Promise.resolve(null)
  },
  downloadUpdate(): Promise<string[]> {
    this.calls.push({ method: 'downloadUpdate', args: [] })
    return Promise.resolve([])
  },
  quitAndInstall(...args: unknown[]): void {
    this.calls.push({ method: 'quitAndInstall', args })
    if (this.quitAndInstallThrows) throw new Error('installer spawn failed')
  },

  // Test helpers
  emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.(payload)
  },
  callsTo(method: string): UpdaterCall[] {
    return this.calls.filter((c) => c.method === method)
  },
  reset(): void {
    this.calls.length = 0
    this.quitAndInstallThrows = false
  }
}

mockService('electron-updater', { autoUpdater: autoUpdaterMock })
mockService('update-feed-server', {
  startUpdateFeedServer: async () => ({
    url: 'http://127.0.0.1:0/',
    close: async () => {}
  })
})

// Must be required AFTER the mocks above are registered.
// An earlier file in the shared run caches this service bound to the REAL
// electron-updater, so the double registered above would never be used and
// init() would construct a MacUpdater against the stub `app`, throwing at load.
evictFromCache('auto-update.service')
const { autoUpdateService } = require('../auto-update.service')
const electronMock = require('./__electron_mock.cjs')

/** Reach into private state — this service exposes no setters by design. */
const internals = autoUpdateService as unknown as {
  checkTimer: unknown
  lastCheckAt: number
  updateDownloaded: boolean
  downloadInFlight: boolean
  maybeCheck: () => void
  checkForUpdates: (userInitiated?: boolean) => void
}

const MINUTE = 60_000

/** Run `fn` as if the app were on `platform`, restoring the real value after. */
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

/** Replace checkForUpdates with a counter for the duration of one assertion. */
function withCheckSpy(fn: (getCount: () => number) => void): void {
  const original = autoUpdateService.checkForUpdates
  let count = 0
  autoUpdateService.checkForUpdates = (): void => {
    count += 1
  }
  try {
    fn(() => count)
  } finally {
    autoUpdateService.checkForUpdates = original
  }
}

autoUpdateService.init(mockMainWindow)

describe('auto-update.service — background polling', () => {
  test('start_is_idempotent_and_attaches_one_resume_listener', () => {
    electronMock.__powerMonitorMock.reset()
    autoUpdateService.startPeriodicChecks()
    autoUpdateService.startPeriodicChecks()

    assert.ok(internals.checkTimer, 'expected a poll timer to be running')
    // A second start must not double the wake-up checks.
    assert.equal(electronMock.__powerMonitorMock.listenerCount('resume'), 1)
  })

  test('wake_from_sleep_triggers_a_catch_up_check', () => {
    internals.downloadInFlight = false
    internals.updateDownloaded = false
    internals.lastCheckAt = 0

    withCheckSpy((getCount) => {
      electronMock.__powerMonitorMock.emit('resume')
      assert.equal(getCount(), 1)
    })
  })

  test('background_check_is_skipped_while_a_download_is_in_flight', () => {
    internals.downloadInFlight = true
    internals.updateDownloaded = false
    internals.lastCheckAt = 0

    withCheckSpy((getCount) => {
      internals.maybeCheck()
      assert.equal(getCount(), 0)
    })
    internals.downloadInFlight = false
  })

  test('background_check_is_skipped_once_an_artifact_is_downloaded', () => {
    internals.downloadInFlight = false
    internals.updateDownloaded = true
    internals.lastCheckAt = 0

    withCheckSpy((getCount) => {
      internals.maybeCheck()
      assert.equal(getCount(), 0)
    })
    internals.updateDownloaded = false
  })

  test('background_check_respects_the_minimum_gap', () => {
    internals.downloadInFlight = false
    internals.updateDownloaded = false

    // A check one minute ago — the resume handler must not re-hit the feed.
    internals.lastCheckAt = Date.now() - MINUTE
    withCheckSpy((getCount) => {
      internals.maybeCheck()
      assert.equal(getCount(), 0)
    })

    // Past the 15-minute floor — now it runs.
    internals.lastCheckAt = Date.now() - 16 * MINUTE
    withCheckSpy((getCount) => {
      internals.maybeCheck()
      assert.equal(getCount(), 1)
    })
  })

  test('checkForUpdates_records_when_it_ran_so_the_gap_can_be_measured', () => {
    internals.lastCheckAt = 0
    autoUpdateService.checkForUpdates(false)
    assert.ok(internals.lastCheckAt > 0, 'expected lastCheckAt to be stamped')
  })

  test('dispose_stops_polling_and_detaches_the_resume_listener', async () => {
    await autoUpdateService.dispose()
    assert.equal(internals.checkTimer, null)
    assert.equal(electronMock.__powerMonitorMock.listenerCount('resume'), 0)
  })
})

describe('auto-update.service — install', () => {
  test('installUpdate_asks_for_a_silent_install_and_a_relaunch', () => {
    autoUpdaterMock.reset()
    autoUpdateService.installUpdate()

    const calls = autoUpdaterMock.callsTo('quitAndInstall')
    assert.equal(calls.length, 1)
    // (isSilent, isForceRunAfter) — bare quitAndInstall() showed the NSIS UI.
    assert.deepEqual(calls[0].args, [true, true])
  })

  test('install_on_quit_does_nothing_when_no_artifact_is_downloaded', () => {
    autoUpdaterMock.reset()
    internals.updateDownloaded = false

    withPlatform('win32', () => autoUpdateService.installOnQuitIfReady())
    assert.equal(autoUpdaterMock.callsTo('quitAndInstall').length, 0)
  })

  test('a_downloaded_update_installs_on_quit_without_relaunching', () => {
    autoUpdaterMock.reset()
    autoUpdaterMock.emit('update-downloaded', { version: '1.0.66' })

    withPlatform('win32', () => autoUpdateService.installOnQuitIfReady())
    const calls = autoUpdaterMock.callsTo('quitAndInstall')
    assert.equal(calls.length, 1)
    // The user asked to quit, not to restart — no force-run-after.
    assert.deepEqual(calls[0].args, [true, false])
  })

  test('macos_leaves_the_install_to_squirrel_instead_of_relaunching', () => {
    autoUpdaterMock.reset()
    internals.updateDownloaded = true

    withPlatform('darwin', () => autoUpdateService.installOnQuitIfReady())
    // MacUpdater ignores (isSilent, isForceRunAfter) and follows
    // autoRunAppAfterInstall — calling it here would reopen the app the user
    // just quit. autoInstallOnAppQuit already staged the update with Squirrel.
    assert.equal(autoUpdaterMock.callsTo('quitAndInstall').length, 0)
  })

  test('a_failing_install_on_quit_never_blocks_shutdown', () => {
    autoUpdaterMock.reset()
    autoUpdaterMock.quitAndInstallThrows = true
    internals.updateDownloaded = true

    assert.doesNotThrow(() => withPlatform('win32', () => autoUpdateService.installOnQuitIfReady()))
    autoUpdaterMock.reset()
  })
})

if (process.argv[1]?.includes('auto-update-service')) {
  void summaryAsync()
}
