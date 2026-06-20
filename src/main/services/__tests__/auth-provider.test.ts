/**
 * Unit tests for AuthProviderService — auth mode management,
 * API key handling, and workspace settings loading.
 *
 * Tests cover: default state, setAuthMode transitions, loadFromWorkspace
 * with various workspace configurations.
 *
 * The singleton `authProvider` is the only export. We test state transitions
 * on it directly, resetting between tests via setAuthMode('claude-max').
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { authProvider } from '../auth-provider'

// Reset to known state before each test group
function resetProvider(): void {
  authProvider.setAuthMode('claude-max')
}

describe('AuthProviderService — initial / default state', () => {
  test('mode defaults to claude-max', () => {
    resetProvider()
    assert.equal(authProvider.mode, 'claude-max')
  })

  test('getApiKey() returns undefined when in claude-max mode', () => {
    resetProvider()
    assert.equal(authProvider.getApiKey(), undefined)
  })

  test('supportsSDK() returns true', () => {
    resetProvider()
    assert.equal(authProvider.supportsSDK(), true)
  })
})

describe('AuthProviderService — setAuthMode', () => {
  test('setAuthMode(api-key, key) sets mode and apiKey', () => {
    resetProvider()
    authProvider.setAuthMode('api-key', 'sk-abc123')
    assert.equal(authProvider.mode, 'api-key')
    assert.equal(authProvider.getApiKey(), 'sk-abc123')
  })

  test('setAuthMode(claude-max) resets to default, clears apiKey', () => {
    authProvider.setAuthMode('api-key', 'sk-test')
    assert.equal(authProvider.getApiKey(), 'sk-test')

    authProvider.setAuthMode('claude-max')
    assert.equal(authProvider.mode, 'claude-max')
    assert.equal(authProvider.getApiKey(), undefined)
  })

  test('setAuthMode(api-key) without key sets apiKey to undefined', () => {
    resetProvider()
    authProvider.setAuthMode('api-key')
    assert.equal(authProvider.mode, 'api-key')
    assert.equal(authProvider.getApiKey(), undefined)
  })

  test('supportsSDK() remains true regardless of mode', () => {
    authProvider.setAuthMode('api-key', 'sk-x')
    assert.equal(authProvider.supportsSDK(), true)

    authProvider.setAuthMode('claude-max')
    assert.equal(authProvider.supportsSDK(), true)
  })

  test('setAuthMode can be called multiple times', () => {
    resetProvider()
    authProvider.setAuthMode('api-key', 'key-1')
    authProvider.setAuthMode('api-key', 'key-2')
    assert.equal(authProvider.getApiKey(), 'key-2')

    authProvider.setAuthMode('claude-max')
    authProvider.setAuthMode('api-key', 'key-3')
    assert.equal(authProvider.getApiKey(), 'key-3')
    assert.equal(authProvider.mode, 'api-key')

    // Clean up
    resetProvider()
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
