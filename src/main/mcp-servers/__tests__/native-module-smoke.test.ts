/**
 * Smoke test: verify that checkNativeModuleCompat() correctly detects
 * the better-sqlite3 native module state under the test runner's Node.
 *
 * Also pins the MCP standalone shim's activation guard — see the second
 * describe block.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test, describe, summaryAsync } from './../../services/__tests__/test-harness'
import { checkNativeModuleCompat } from '../native-module-check'
import { MCP_STANDALONE_SHIM } from '../standalone-shim'

describe('native module compatibility check', () => {
  test('checkNativeModuleCompat returns ok for N-API module', () => {
    const result = checkNativeModuleCompat()
    // With N-API (v13), the prebuilt binary should always load under system Node
    assert.ok(result.ok, `Expected ok but got error: ${result.error}`)
  })

  test('checkNativeModuleCompat returns a plain object with ok boolean', () => {
    const result = checkNativeModuleCompat()
    assert.equal(typeof result, 'object')
    assert.equal(typeof result.ok, 'boolean')
  })

  test('checkNativeModuleCompat result has no nativeBinding field (N-API)', () => {
    const result = checkNativeModuleCompat()
    assert.ok(!('nativeBinding' in result), 'N-API modules should not need binding override')
  })
})

// ── MCP standalone shim guard ───────────────────────────────────────────

/**
 * Run the shim in a child process that *fakes* being an Electron runtime, so
 * the assertion needs neither the Electron binary nor a packaged build.
 */
function probeShim(env: NodeJS.ProcessEnv): {
  hasApp: boolean
  userData?: string
  logScope?: string
} {
  const script = [
    "Object.defineProperty(process.versions, 'electron', { value: '99.0.0', configurable: true });",
    MCP_STANDALONE_SHIM,
    'var out = {};',
    "try { var e = require('electron'); out.hasApp = !!(e && e.app && typeof e.app.getPath === 'function'); if (out.hasApp) out.userData = e.app.getPath('userData'); } catch (err) { out.hasApp = false; }",
    "try { out.logScope = typeof require('electron-log/main').scope('x').info; } catch (err) { out.logScope = 'threw'; }",
    'console.log(JSON.stringify(out));'
  ].join('\n')

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DB_PATH: '/tmp/shim-probe-userdata',
    ...env
  }
  if (!env.ELECTRON_RUN_AS_NODE) delete childEnv.ELECTRON_RUN_AS_NODE

  const stdout = execFileSync(process.execPath, ['-e', script], {
    env: childEnv,
    encoding: 'utf8'
  })
  return JSON.parse(stdout.trim().split('\n').pop() as string)
}

describe('MCP standalone shim', () => {
  test('installs under ELECTRON_RUN_AS_NODE even though versions.electron is set', () => {
    const out = probeShim({ ELECTRON_RUN_AS_NODE: '1' })
    assert.ok(out.hasApp, 'shim must mock `electron` when running as the app binary in Node mode')
    assert.equal(out.userData, '/tmp/shim-probe-userdata', 'app.getPath must resolve to DB_PATH')
    assert.equal(out.logScope, 'function', '`electron-log/main` must be mocked, not resolved')
  })

  test('stays out of the way in a real Electron main process', () => {
    const out = probeShim({})
    assert.equal(out.hasApp, false, 'shim must not intercept require() in the main process')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
