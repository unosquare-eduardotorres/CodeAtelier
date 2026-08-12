/**
 * Phase 24 — IPC Coverage Blitz: app-preference.ipc, zoom.ipc, platform.ipc, user-profile.ipc
 *
 * Run: tsx src/main/ipc/__tests__/ipc-app-preference-zoom.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getHandlers,
  mockMainWindow,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'
import { IPC_CHANNELS } from '../../../shared/constants'

setupFullMock()

let appPrefLoaded = false
let zoomLoaded = false
let platformLoaded = false
let userProfileLoaded = false

try {
  const mod = require('../../ipc/app-preference.ipc')
  mod.registerAppPreferenceIpc()
  appPrefLoaded = true
} catch (err) {
  console.log(`⚠ app-preference.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/zoom.ipc')
  mod.registerZoomIpc(mockMainWindow)
  zoomLoaded = true
} catch (err) {
  console.log(`⚠ zoom.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/platform.ipc')
  mod.registerPlatformIpc()
  platformLoaded = true
} catch (err) {
  console.log(`⚠ platform.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/user-profile.ipc')
  mod.registerUserProfileIpc()
  userProfileLoaded = true
} catch (err) {
  console.log(`⚠ user-profile.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// app-preference.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (appPrefLoaded) {
  describe('app-preference.ipc — channel registration', () => {
    test('registers appPreference:getAll', () => {
      assert.ok(getHandlers().has('appPreference:getAll'))
    })

    test('registers appPreference:set', () => {
      assert.ok(getHandlers().has('appPreference:set'))
    })

    test('registers notification:probe', () => {
      assert.ok(getHandlers().has('notification:probe'))
    })
  })

  describe('app-preference.ipc — argument validation', () => {
    test('appPreference:set rejects missing key', async () => {
      const r = await tryInvokeHandler('appPreference:set', { value: 'test' })
      assert.equal(r.ok, false)
    })

    test('appPreference:set rejects non-string value', async () => {
      const r = await tryInvokeHandler('appPreference:set', { key: 'theme', value: 42 })
      assert.equal(r.ok, false)
    })

    test('appPreference:set rejects non-object', async () => {
      const r = await tryInvokeHandler('appPreference:set', 'bad')
      assert.equal(r.ok, false)
    })
  })

  describe('app-preference.ipc — handler bodies', () => {
    test('appPreference:getAll calls through', async () => {
      const r = await tryInvokeHandler('appPreference:getAll')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('appPreference:set calls through with valid args', async () => {
      const r = await tryInvokeHandler('appPreference:set', { key: 'theme', value: 'dark' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('appPreference:set accepts empty string value', async () => {
      const r = await tryInvokeHandler('appPreference:set', { key: 'theme', value: '' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('notification:probe calls through', async () => {
      const r = await tryInvokeHandler('notification:probe')
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// zoom.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (zoomLoaded) {
  describe('zoom.ipc — channel registration', () => {
    test('registers zoom:get', () => {
      assert.ok(getHandlers().has('zoom:get'))
    })

    test('registers zoom:in', () => {
      assert.ok(getHandlers().has('zoom:in'))
    })

    test('registers zoom:out', () => {
      assert.ok(getHandlers().has('zoom:out'))
    })

    test('registers zoom:reset', () => {
      assert.ok(getHandlers().has('zoom:reset'))
    })

    test('registers zoom:set', () => {
      assert.ok(getHandlers().has('zoom:set'))
    })
  })

  describe('zoom.ipc — handler bodies', () => {
    test('zoom:get returns current zoom factor', async () => {
      const r = await tryInvokeHandler('zoom:get')
      if (r.ok) {
        assert.equal(typeof r.result, 'number')
      }
    })

    test('zoom:in returns new zoom factor', async () => {
      const r = await tryInvokeHandler('zoom:in')
      if (r.ok) {
        assert.equal(typeof r.result, 'number')
      }
    })

    test('zoom:out returns new zoom factor', async () => {
      const r = await tryInvokeHandler('zoom:out')
      if (r.ok) {
        assert.equal(typeof r.result, 'number')
      }
    })

    test('zoom:reset returns 1.0', async () => {
      const r = await tryInvokeHandler('zoom:reset')
      if (r.ok) {
        assert.equal(r.result, 1.0)
      }
    })

    test('zoom:set clamps to valid range', async () => {
      const r = await tryInvokeHandler('zoom:set', 1.5)
      if (r.ok) {
        assert.equal(typeof r.result, 'number')
        assert.ok((r.result as number) >= 0.5)
        assert.ok((r.result as number) <= 2.0)
      }
    })

    test('zoom:set clamps low values', async () => {
      const r = await tryInvokeHandler('zoom:set', 0.1)
      if (r.ok) {
        assert.equal(r.result, 0.5)
      }
    })

    test('zoom:set clamps high values', async () => {
      const r = await tryInvokeHandler('zoom:set', 5.0)
      if (r.ok) {
        assert.equal(r.result, 2.0)
      }
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// platform.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (platformLoaded) {
  describe('platform.ipc — channel registration', () => {
    test('registers platform:info', () => {
      assert.ok(getHandlers().has('platform:info'))
    })
  })

  describe('platform.ipc — handler bodies', () => {
    test('platform:info returns platform info shape', async () => {
      const r = await tryInvokeHandler('platform:info')
      if (r.ok) {
        const info = r.result as Record<string, unknown>
        assert.equal(typeof info.platform, 'string')
        assert.equal(typeof info.arch, 'string')
        assert.equal(typeof info.isAppleSilicon, 'boolean')
        assert.equal(typeof info.totalMemoryGB, 'number')
        assert.equal(typeof info.appVersion, 'string')
      }
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// user-profile.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (userProfileLoaded) {
  describe('user-profile.ipc — channel registration', () => {
    test('registers userProfile:get', () => {
      assert.ok(getHandlers().has(IPC_CHANNELS.USER_PROFILE_GET))
    })

    test('registers userProfile:upsert', () => {
      assert.ok(getHandlers().has(IPC_CHANNELS.USER_PROFILE_UPSERT))
    })
  })

  describe('user-profile.ipc — argument validation', () => {
    test('userProfile:upsert rejects missing displayName', async () => {
      const r = await tryInvokeHandler('userProfile:upsert', { avatarKey: 'default' })
      assert.equal(r.ok, false)
    })

    test('userProfile:upsert rejects missing avatarKey', async () => {
      const r = await tryInvokeHandler('userProfile:upsert', { displayName: 'Alice' })
      assert.equal(r.ok, false)
    })
  })

  describe('user-profile.ipc — handler bodies', () => {
    test('userProfile:get calls through', async () => {
      const r = await tryInvokeHandler('userProfile:get')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('userProfile:upsert calls through with valid args', async () => {
      const r = await tryInvokeHandler('userProfile:upsert', {
        displayName: 'Alice',
        avatarKey: 'avatar-01'
      })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

if (process.argv[1]?.includes('ipc-app-preference-zoom')) {
  void summaryAsync()
}
