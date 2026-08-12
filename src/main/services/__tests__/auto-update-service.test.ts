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
 *   4. On macOS "Restart now" did nothing for the first ~20s: MacUpdater emits
 *      'update-downloaded' when its proxy binds, long before Squirrel has staged
 *      anything, and quitAndInstall() is a no-op until it has. Every wasted click
 *      also left another listener behind, so the queued quitAndInstall() calls
 *      later raced into competing ShipIt processes (App Still Running Error).
 *   5. On macOS "Restart now" armed the install and then did nothing forever:
 *      MacUpdater.quitAndInstall() closes its proxy, delegates to the native
 *      updater and returns — the app kept running, and because installRequested
 *      is a latch, every later click was swallowed as a duplicate.
 *
 * Run: tsx src/main/services/__tests__/auto-update-service.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  setupFullMock,
  mockService,
  mockMainWindow,
  evictFromCache,
  sentEvents
} from './setup-full-mock'

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
  squirrelStaged: boolean
  installRequested: boolean
  readyAnnounced: boolean
  downloadedVersion: string | null
  installTimer: unknown
  maybeCheck: () => void
  checkForUpdates: (userInitiated?: boolean) => void
  onInstallStalled: () => void
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

/** Count app.quit() calls for the duration of one assertion. */
function withQuitSpy(fn: (getCount: () => number) => void): void {
  const original = electronMock.app.quit
  let count = 0
  electronMock.app.quit = (): void => {
    count += 1
  }
  try {
    fn(() => count)
  } finally {
    electronMock.app.quit = original
  }
}

/** Bring a darwin install cycle to the point where quitAndInstall() would act. */
function stageDarwinUpdate(): void {
  initAs('darwin')
  withPlatform('darwin', () => {
    autoUpdaterMock.emit('update-downloaded', { version: '1.0.75' })
    electronMock.__autoUpdaterMock.emit('update-downloaded')
  })
  autoUpdaterMock.reset()
  sentEvents.length = 0
}

/**
 * Re-run init() as if the app had launched on `platform`, with a fresh
 * install cycle. The service is a singleton and its staging state is sticky by
 * design (an install happens once per run), so each case starts from zero.
 */
function initAs(platform: NodeJS.Platform): void {
  electronMock.__autoUpdaterMock.reset()
  autoUpdaterMock.reset()
  sentEvents.length = 0
  internals.squirrelStaged = false
  internals.installRequested = false
  internals.readyAnnounced = false
  internals.updateDownloaded = false
  internals.downloadedVersion = null
  withPlatform(platform, () => autoUpdateService.init(mockMainWindow))
}

/** Channels sent to the renderer since the last initAs(). */
function channelsSent(): string[] {
  return sentEvents.map((e) => e.channel)
}

/**
 * Run `fn` with setTimeout stubbed, returning a trigger for the scheduled
 * callback — the staging watchdog is 120s, which no test can wait for.
 */
function captureTimeout(fn: () => void): () => void {
  const original = globalThis.setTimeout
  let captured: (() => void) | null = null
  ;(globalThis as unknown as { setTimeout: unknown }).setTimeout = (cb: () => void): unknown => {
    captured = cb
    return { unref: (): void => {} }
  }
  try {
    fn()
  } finally {
    globalThis.setTimeout = original
  }
  return () => captured?.()
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
    initAs('win32')
    withPlatform('win32', () => autoUpdateService.installUpdate())

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
    initAs('win32')

    withPlatform('win32', () => {
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.66' })
      autoUpdateService.installOnQuitIfReady()
    })
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

describe('auto-update.service — macOS staging gate', () => {
  test('darwin_does_not_send_UPDATE_DOWNLOADED_until_staged', () => {
    initAs('darwin')
    withPlatform('darwin', () => autoUpdaterMock.emit('update-downloaded', { version: '1.0.72' }))

    // MacUpdater is only telling us its proxy bound — the modal must say
    // "Preparing", not "Ready to Install".
    assert.deepEqual(channelsSent(), ['update:staging'])

    withPlatform('darwin', () => electronMock.__autoUpdaterMock.emit('update-downloaded'))
    assert.deepEqual(channelsSent(), ['update:staging', 'update:downloaded'])
    assert.deepEqual(sentEvents[1].data, { version: '1.0.72' })
  })

  test('non_darwin_sends_UPDATE_DOWNLOADED_immediately', () => {
    initAs('win32')
    withPlatform('win32', () => autoUpdaterMock.emit('update-downloaded', { version: '1.0.72' }))

    // Windows has no staging step — delaying the announcement here would be a
    // regression, not a fix.
    assert.deepEqual(channelsSent(), ['update:downloaded'])
  })

  test('darwin_install_before_staging_does_not_call_quitAndInstall', () => {
    initAs('darwin')
    withPlatform('darwin', () => {
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.72' })
      autoUpdateService.installUpdate()
    })

    // The bug: quitAndInstall() here is a documented no-op, and the listener it
    // leaves behind is what later collided with itself.
    assert.equal(autoUpdaterMock.callsTo('quitAndInstall').length, 0)
  })

  test('darwin_staging_completion_dispatches_the_deferred_install', () => {
    initAs('darwin')
    withPlatform('darwin', () => {
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.72' })
      autoUpdateService.installUpdate()
      electronMock.__autoUpdaterMock.emit('update-downloaded')
    })

    const calls = autoUpdaterMock.callsTo('quitAndInstall')
    assert.equal(calls.length, 1, 'the deferred click must fire exactly once')
    assert.deepEqual(calls[0].args, [true, true])
  })

  test('duplicate_installUpdate_calls_produce_one_quitAndInstall', () => {
    initAs('darwin')
    withPlatform('darwin', () => {
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.72' })
      // Five impatient clicks — the exact shape that spawned competing ShipIt
      // processes and ended in "App Still Running Error".
      for (let i = 0; i < 5; i++) autoUpdateService.installUpdate()
      electronMock.__autoUpdaterMock.emit('update-downloaded')
      autoUpdateService.installUpdate()
    })

    assert.equal(autoUpdaterMock.callsTo('quitAndInstall').length, 1)
  })

  test('squirrel_error_re_arms_and_announces_ready', () => {
    initAs('darwin')
    withPlatform('darwin', () => {
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.72' })
      autoUpdateService.installUpdate()
      electronMock.__autoUpdaterMock.emit('error', new Error('staging refused'))
    })

    // Staging failed, so the deferred click is dropped rather than dispatched
    // into a broken install — but the user must get a working button back.
    assert.equal(autoUpdaterMock.callsTo('quitAndInstall').length, 0)
    assert.deepEqual(channelsSent(), ['update:staging', 'update:downloaded'])

    withPlatform('darwin', () => autoUpdateService.installUpdate())
    assert.equal(autoUpdaterMock.callsTo('quitAndInstall').length, 1)
  })

  test('staging_timeout_announces_ready', () => {
    initAs('darwin')
    const fireWatchdog = captureTimeout(() =>
      withPlatform('darwin', () => autoUpdaterMock.emit('update-downloaded', { version: '1.0.72' }))
    )
    assert.deepEqual(channelsSent(), ['update:staging'])

    withPlatform('darwin', () => fireWatchdog())
    // Never leave the modal stuck on "Preparing" — degraded beats unusable.
    assert.deepEqual(channelsSent(), ['update:staging', 'update:downloaded'])

    withPlatform('darwin', () => autoUpdateService.installUpdate())
    assert.equal(autoUpdaterMock.callsTo('quitAndInstall').length, 1)
  })
})

describe('auto-update.service — the install must actually end the process', () => {
  test('darwin_install_quits_the_app', () => {
    stageDarwinUpdate()

    withQuitSpy((getQuits) => {
      withPlatform('darwin', () => autoUpdateService.installUpdate())
      // MacUpdater returns to a still-running app: ShipIt only swaps the bundle
      // once this PID dies, so quitting is the install.
      assert.equal(getQuits(), 1, 'expected exactly one app.quit()')
    })
  })

  test('darwin_install_still_arms_the_relaunch', () => {
    stageDarwinUpdate()

    withQuitSpy(() => withPlatform('darwin', () => autoUpdateService.installUpdate()))
    const calls = autoUpdaterMock.callsTo('quitAndInstall')
    // The native call is the only thing that sets launchAfterInstallation —
    // dropping it would guarantee the app never comes back.
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, [true, true])
  })

  test('win32_install_leaves_termination_to_the_updater', () => {
    initAs('win32')

    withQuitSpy((getQuits) => {
      withPlatform('win32', () => autoUpdateService.installUpdate())
      // BaseUpdater spawns the installer and quits itself — a second quit here
      // would race that spawn.
      assert.equal(getQuits(), 0)
    })
  })

  test('a_stalled_install_releases_the_latch_and_tells_the_renderer', () => {
    stageDarwinUpdate()
    withQuitSpy(() => withPlatform('darwin', () => autoUpdateService.installUpdate()))
    assert.equal(internals.installRequested, true)

    internals.onInstallStalled()

    assert.equal(internals.installRequested, false, 'the latch must not outlive the attempt')
    assert.deepEqual(channelsSent(), ['update:installFailed'])
    // Not update:error — that flips the modal to 'error' and removes the button.
    assert.match(String(sentEvents[0].data), /Quit and reopen/)
  })

  test('restart_works_again_after_a_stalled_install', () => {
    stageDarwinUpdate()

    withQuitSpy(() => {
      withPlatform('darwin', () => autoUpdateService.installUpdate())
      internals.onInstallStalled()
      withPlatform('darwin', () => autoUpdateService.installUpdate())
    })

    // The bug: one dead click disabled Restart for the rest of the session,
    // because installRequested was a latch nothing but process death could clear.
    assert.equal(autoUpdaterMock.callsTo('quitAndInstall').length, 2)
  })
})

if (process.argv[1]?.includes('auto-update-service')) {
  void summaryAsync()
}
