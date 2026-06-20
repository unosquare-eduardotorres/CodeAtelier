/**
 * Unit tests for DescriptionCacheService.makeKey — verifying the service's
 * own key generation matches the extracted handler and is deterministic.
 *
 * The existing description-cache.test.ts uses a mock class; this tests the
 * actual service singleton's makeKey method (pure crypto, no DB).
 *
 * Phase 4F — 6 tests.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { descriptionCache } from '../description-cache.service'
import { makeDescriptionKey } from '../description-cache-handlers'

describe('DescriptionCacheService.makeKey', () => {
  test('deterministic — same inputs produce same key', () => {
    const key1 = descriptionCache.makeKey('src/auth.ts', 'validate', 'function validate() {}')
    const key2 = descriptionCache.makeKey('src/auth.ts', 'validate', 'function validate() {}')
    assert.equal(key1, key2)
  })

  test('different file paths produce different keys', () => {
    const key1 = descriptionCache.makeKey('src/auth.ts', 'fn', 'body')
    const key2 = descriptionCache.makeKey('src/user.ts', 'fn', 'body')
    assert.notEqual(key1, key2)
  })

  test('different symbol names produce different keys', () => {
    const key1 = descriptionCache.makeKey('src/auth.ts', 'validate', 'body')
    const key2 = descriptionCache.makeKey('src/auth.ts', 'login', 'body')
    assert.notEqual(key1, key2)
  })

  test('different bodies produce different keys', () => {
    const key1 = descriptionCache.makeKey('src/auth.ts', 'fn', 'body-v1')
    const key2 = descriptionCache.makeKey('src/auth.ts', 'fn', 'body-v2')
    assert.notEqual(key1, key2)
  })

  test('returns 64-char hex SHA-256', () => {
    const key = descriptionCache.makeKey('file.ts', 'sym', 'body')
    assert.ok(/^[a-f0-9]{64}$/.test(key), `Expected 64-char hex, got: ${key}`)
  })

  test('matches makeDescriptionKey from handlers module', () => {
    const serviceKey = descriptionCache.makeKey('src/auth.ts', 'validate', 'code')
    const handlerKey = makeDescriptionKey('src/auth.ts', 'validate', 'code')
    assert.equal(serviceKey, handlerKey, 'Service and handler should produce identical keys')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
