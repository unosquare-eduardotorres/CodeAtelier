/**
 * Unit tests for services/sandbox-config.ts — trivial config factory.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { createBuildModeSandbox } from '../sandbox-config'

describe('createBuildModeSandbox', () => {
  test('returns { enabled: false }', () => {
    const result = createBuildModeSandbox()
    assert.deepEqual(result, { enabled: false })
  })

  test('returns a fresh object each time (not shared reference)', () => {
    const a = createBuildModeSandbox()
    const b = createBuildModeSandbox()
    assert.notEqual(a, b)
    assert.deepEqual(a, b)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
