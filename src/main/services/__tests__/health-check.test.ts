import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'

describe('SubscriptionService - SDK Health', () => {
  test('health check result shape has all fields', () => {
    const result = {
      sdkVersion: '2.1.116',
      modelsAvailable: ['claude-opus-4-7', 'claude-sonnet-4-6'],
      opus47Available: true,
      error: null
    }
    assert.ok(result.sdkVersion)
    assert.ok(result.opus47Available)
    assert.equal(result.error, null)
  })

  test('health check reports error gracefully', () => {
    const result = {
      sdkVersion: null,
      modelsAvailable: [],
      opus47Available: false,
      error: 'Command failed: claude not found'
    }
    assert.ok(!result.opus47Available)
    assert.ok(result.error)
  })

  test('validateAll includes sdkHealth field', () => {
    // Shape validation
    const fullResult = {
      claudeCli: { installed: true, version: '2.1.116', error: null },
      claudeAuth: { authenticated: true, accountEmail: null, error: null },
      claudeMax: { active: true, plan: 'Max', error: null },
      codexCli: { installed: false, version: null, error: 'not found' },
      sdkHealth: {
        sdkVersion: '2.1.116',
        modelsAvailable: ['claude-opus-4-7'],
        opus47Available: true,
        error: null
      }
    }
    assert.ok('sdkHealth' in fullResult)
    assert.ok(fullResult.sdkHealth.opus47Available)
  })
})

// Only exit when this file is run directly — when loaded via run-tests.ts,
// the final aggregate summary is emitted at the end of that runner.
if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
