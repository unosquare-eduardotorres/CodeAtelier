/**
 * Smoke test: verify that checkNativeModuleCompat() correctly detects
 * the better-sqlite3 native module state under the test runner's Node.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './../../services/__tests__/test-harness'
import { checkNativeModuleCompat } from '../native-module-check'

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

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
