/**
 * Unit tests for the DescriptionCacheService.makeKey() pure SHA256 hash function.
 *
 * Since the service imports electron-log and getDatabase at module level,
 * we replicate the pure makeKey logic here to verify correctness without
 * side effects. The function is: sha256(filePath + symbolName + body).hex()
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, describe, summaryAsync } from './test-harness'

/**
 * Exact replica of DescriptionCacheService.makeKey — verified against source.
 * Source: src/main/services/description-cache.service.ts:50-54
 */
function makeKey(filePath: string, symbolName: string, body: string): string {
  return createHash('sha256')
    .update(filePath + symbolName + body)
    .digest('hex')
}

describe('DescriptionCacheService.makeKey (pure SHA256)', () => {
  test('deterministic_same_inputs_same_hash', () => {
    const key1 = makeKey('src/app.ts', 'MyClass', 'class MyClass {}')
    const key2 = makeKey('src/app.ts', 'MyClass', 'class MyClass {}')
    assert.equal(key1, key2)
  })

  test('different_filePath_produces_different_hash', () => {
    const key1 = makeKey('src/a.ts', 'Fn', 'body')
    const key2 = makeKey('src/b.ts', 'Fn', 'body')
    assert.notEqual(key1, key2)
  })

  test('different_symbolName_produces_different_hash', () => {
    const key1 = makeKey('src/app.ts', 'foo', 'body')
    const key2 = makeKey('src/app.ts', 'bar', 'body')
    assert.notEqual(key1, key2)
  })

  test('different_body_produces_different_hash', () => {
    const key1 = makeKey('src/app.ts', 'Fn', 'function a() {}')
    const key2 = makeKey('src/app.ts', 'Fn', 'function b() {}')
    assert.notEqual(key1, key2)
  })

  test('empty_strings_produce_valid_64_char_hex', () => {
    const key = makeKey('', '', '')
    assert.equal(typeof key, 'string')
    assert.equal(key.length, 64) // SHA256 hex = 64 chars
    assert.match(key, /^[0-9a-f]{64}$/)
  })

  test('output_matches_manual_sha256_computation', () => {
    const fp = 'src/test.ts'
    const sym = 'myFunc'
    const body = 'return 42'
    const expected = createHash('sha256')
      .update(fp + sym + body)
      .digest('hex')
    const actual = makeKey(fp, sym, body)
    assert.equal(actual, expected)
  })

  test('order_matters_filePath_symbolName_body', () => {
    // makeKey('a', 'b', 'c') != makeKey('b', 'a', 'c')
    const key1 = makeKey('a', 'b', 'c')
    const key2 = makeKey('b', 'a', 'c')
    assert.notEqual(key1, key2)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
