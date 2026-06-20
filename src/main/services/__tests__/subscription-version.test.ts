/**
 * Tests for SubscriptionService version-related public methods:
 * - supportsGoal()
 * - getCliVersion()
 *
 * These validate the integration between the public API and the extracted
 * isVersionBelow function. Uses `(instance as any).cachedCliVersion` to
 * control state without requiring actual CLI execution.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { subscriptionService } from '../subscription.service'

// Save and restore original state to avoid cross-test pollution
const originalVersion = (subscriptionService as any).cachedCliVersion

function setVersion(v: string | null) {
  ;(subscriptionService as any).cachedCliVersion = v
}

function cleanup() {
  ;(subscriptionService as any).cachedCliVersion = originalVersion
}

// ── getCliVersion ──

describe('SubscriptionService.getCliVersion', () => {
  test('returns null initially (no cached version)', () => {
    setVersion(null)
    assert.equal(subscriptionService.getCliVersion(), null)
    cleanup()
  })

  test('returns cached value after set', () => {
    setVersion('2.1.200')
    assert.equal(subscriptionService.getCliVersion(), '2.1.200')
    cleanup()
  })
})

// ── supportsGoal ──

describe('SubscriptionService.supportsGoal', () => {
  test('no cached version → false', () => {
    setVersion(null)
    assert.equal(subscriptionService.supportsGoal(), false)
    cleanup()
  })

  test('version ≥ 2.1.139 → true', () => {
    setVersion('2.1.200')
    assert.equal(subscriptionService.supportsGoal(), true)
    cleanup()
  })

  test('version exactly 2.1.139 → true (equal is not below)', () => {
    setVersion('2.1.139')
    assert.equal(subscriptionService.supportsGoal(), true)
    cleanup()
  })

  test('version < 2.1.139 → false', () => {
    setVersion('2.1.100')
    assert.equal(subscriptionService.supportsGoal(), false)
    cleanup()
  })

  test('version 2.0.999 → false (minor version below)', () => {
    setVersion('2.0.999')
    assert.equal(subscriptionService.supportsGoal(), false)
    cleanup()
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
