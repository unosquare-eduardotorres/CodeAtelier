/**
 * Unit tests for the description-cache.service.ts pure functions.
 * Tests key generation, get/set round-trip, and invalidation.
 *
 * Note: These tests use an in-memory mock since the real service
 * depends on Electron's app.getPath which is unavailable in test context.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, describe } from './test-harness'

// ── Key generation (pure function — testable without Electron) ──

function makeKey(filePath: string, symbolName: string, body: string): string {
  return createHash('sha256')
    .update(filePath + symbolName + body)
    .digest('hex')
}

describe('makeKey', () => {
  test('produces deterministic key', () => {
    const key1 = makeKey('src/auth.ts', 'validate', 'code body')
    const key2 = makeKey('src/auth.ts', 'validate', 'code body')
    assert.equal(key1, key2)
  })

  test('different bodies produce different keys', () => {
    const key1 = makeKey('src/auth.ts', 'validate', 'code body v1')
    const key2 = makeKey('src/auth.ts', 'validate', 'code body v2')
    assert.notEqual(key1, key2)
  })

  test('different files produce different keys', () => {
    const key1 = makeKey('src/auth.ts', 'validate', 'code')
    const key2 = makeKey('src/user.ts', 'validate', 'code')
    assert.notEqual(key1, key2)
  })

  test('different symbols produce different keys', () => {
    const key1 = makeKey('src/auth.ts', 'validate', 'code')
    const key2 = makeKey('src/auth.ts', 'login', 'code')
    assert.notEqual(key1, key2)
  })

  test('key is a valid hex string', () => {
    const key = makeKey('file.ts', 'symbol', 'body')
    assert.ok(/^[a-f0-9]{64}$/.test(key), `Expected 64-char hex, got: ${key}`)
  })
})

// ── In-memory cache simulation (tests cache logic without SQLite) ──

class MockDescriptionCache {
  private store = new Map<
    string,
    { description: string; model: string; filePath: string; symbolName: string }
  >()

  makeKey(filePath: string, symbolName: string, body: string): string {
    return createHash('sha256')
      .update(filePath + symbolName + body)
      .digest('hex')
  }

  get(key: string): string | null {
    return this.store.get(key)?.description ?? null
  }

  set(key: string, description: string, model: string, filePath: string, symbolName: string): void {
    this.store.set(key, { description, model, filePath, symbolName })
  }

  invalidateFile(filePath: string): number {
    let count = 0
    for (const [key, entry] of this.store) {
      if (entry.filePath === filePath) {
        this.store.delete(key)
        count++
      }
    }
    return count
  }

  getCount(): number {
    return this.store.size
  }
}

describe('DescriptionCache (mock)', () => {
  test('get returns null for missing key', () => {
    const cache = new MockDescriptionCache()
    assert.equal(cache.get('nonexistent'), null)
  })

  test('get/set round-trip', () => {
    const cache = new MockDescriptionCache()
    const key = cache.makeKey('src/auth.ts', 'validate', 'code body')
    cache.set(key, 'Validates JWT tokens', 'haiku', 'src/auth.ts', 'validate')

    const result = cache.get(key)
    assert.equal(result, 'Validates JWT tokens')
  })

  test('set overwrites existing entry', () => {
    const cache = new MockDescriptionCache()
    const key = cache.makeKey('src/auth.ts', 'validate', 'code body')
    cache.set(key, 'Old description', 'haiku', 'src/auth.ts', 'validate')
    cache.set(key, 'New description', 'haiku', 'src/auth.ts', 'validate')

    assert.equal(cache.get(key), 'New description')
    assert.equal(cache.getCount(), 1)
  })

  test('invalidateFile removes correct entries', () => {
    const cache = new MockDescriptionCache()
    const key1 = cache.makeKey('src/auth.ts', 'validate', 'body1')
    const key2 = cache.makeKey('src/auth.ts', 'login', 'body2')
    const key3 = cache.makeKey('src/user.ts', 'getUser', 'body3')

    cache.set(key1, 'desc1', 'haiku', 'src/auth.ts', 'validate')
    cache.set(key2, 'desc2', 'haiku', 'src/auth.ts', 'login')
    cache.set(key3, 'desc3', 'haiku', 'src/user.ts', 'getUser')

    const removed = cache.invalidateFile('src/auth.ts')
    assert.equal(removed, 2)
    assert.equal(cache.getCount(), 1)
    assert.equal(cache.get(key3), 'desc3')
    assert.equal(cache.get(key1), null)
  })

  test('invalidateFile returns 0 for unknown file', () => {
    const cache = new MockDescriptionCache()
    assert.equal(cache.invalidateFile('nonexistent.ts'), 0)
  })

  test('getCount tracks entries', () => {
    const cache = new MockDescriptionCache()
    assert.equal(cache.getCount(), 0)

    cache.set('k1', 'd1', 'm', 'f', 's')
    assert.equal(cache.getCount(), 1)

    cache.set('k2', 'd2', 'm', 'f', 's')
    assert.equal(cache.getCount(), 2)
  })
})

// Report handled by test runner
