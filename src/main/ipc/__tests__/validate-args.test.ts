/**
 * validate-args.ts tests — cover every type-narrowing helper used by
 * session.ipc.ts (and other IPC modules that adopt them).
 *
 * These helpers guard the main-process boundary from malformed renderer
 * payloads, so their rejection behaviour must be precise: each failure needs
 * to include the channel name and the offending field so an error bubbling
 * to the renderer is self-describing.
 *
 * Run: tsx src/main/ipc/__tests__/validate-args.test.ts
 */

import assert from 'node:assert/strict'
import {
  requireObject,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  optionalNullableString
} from '../validate-args'
import { test, describe, summary } from '../../services/__tests__/test-harness'

const CHANNEL = 'session:test'

describe('requireObject', () => {
  test('accepts plain objects', () => {
    const obj = requireObject({ a: 1 }, CHANNEL)
    assert.deepEqual(obj, { a: 1 })
  })

  test('rejects null', () => {
    assert.throws(() => requireObject(null, CHANNEL), /expected an object argument, got null/)
  })

  test('rejects undefined', () => {
    assert.throws(
      () => requireObject(undefined, CHANNEL),
      /expected an object argument, got undefined/
    )
  })

  test('rejects arrays', () => {
    assert.throws(() => requireObject([], CHANNEL), /expected an object argument, got array/)
  })

  test('rejects primitives', () => {
    assert.throws(() => requireObject('hi', CHANNEL), /expected an object argument, got string/)
    assert.throws(() => requireObject(42, CHANNEL), /expected an object argument, got number/)
    assert.throws(() => requireObject(true, CHANNEL), /expected an object argument, got boolean/)
  })

  test('includes channel name in error message', () => {
    assert.throws(() => requireObject(null, 'my:custom:channel'), /my:custom:channel/)
  })
})

describe('requireString', () => {
  test('returns the string value when present', () => {
    const result = requireString({ name: 'hello' }, 'name', CHANNEL)
    assert.equal(result, 'hello')
  })

  test('rejects missing field', () => {
    assert.throws(
      () => requireString({}, 'name', CHANNEL),
      /field 'name' must be a non-empty string/
    )
  })

  test('rejects empty string', () => {
    assert.throws(
      () => requireString({ name: '' }, 'name', CHANNEL),
      /field 'name' must be a non-empty string/
    )
  })

  test('rejects non-string types', () => {
    assert.throws(() => requireString({ name: 42 }, 'name', CHANNEL))
    assert.throws(() => requireString({ name: null }, 'name', CHANNEL))
    assert.throws(() => requireString({ name: undefined }, 'name', CHANNEL))
    assert.throws(() => requireString({ name: {} }, 'name', CHANNEL))
  })
})

describe('optionalString', () => {
  test('returns undefined when field is absent', () => {
    assert.equal(optionalString({}, 'dir', CHANNEL), undefined)
  })

  test('returns undefined when field is explicitly undefined', () => {
    assert.equal(optionalString({ dir: undefined }, 'dir', CHANNEL), undefined)
  })

  test('returns the string when present', () => {
    assert.equal(optionalString({ dir: '/tmp' }, 'dir', CHANNEL), '/tmp')
  })

  test('allows empty string (contrast with requireString)', () => {
    assert.equal(optionalString({ dir: '' }, 'dir', CHANNEL), '')
  })

  test('rejects non-string, non-undefined values', () => {
    assert.throws(() => optionalString({ dir: null }, 'dir', CHANNEL))
    assert.throws(() => optionalString({ dir: 42 }, 'dir', CHANNEL))
    assert.throws(() => optionalString({ dir: [] }, 'dir', CHANNEL))
  })
})

describe('optionalNumber', () => {
  test('returns undefined when absent', () => {
    assert.equal(optionalNumber({}, 'limit', CHANNEL), undefined)
  })

  test('returns the number when present', () => {
    assert.equal(optionalNumber({ limit: 10 }, 'limit', CHANNEL), 10)
  })

  test('accepts zero', () => {
    assert.equal(optionalNumber({ offset: 0 }, 'offset', CHANNEL), 0)
  })

  test('accepts negative numbers', () => {
    assert.equal(optionalNumber({ offset: -5 }, 'offset', CHANNEL), -5)
  })

  test('rejects NaN', () => {
    assert.throws(() => optionalNumber({ limit: Number.NaN }, 'limit', CHANNEL))
  })

  test('rejects Infinity', () => {
    assert.throws(() => optionalNumber({ limit: Number.POSITIVE_INFINITY }, 'limit', CHANNEL))
  })

  test('rejects strings that look like numbers', () => {
    assert.throws(() => optionalNumber({ limit: '10' }, 'limit', CHANNEL))
  })
})

describe('optionalBoolean', () => {
  test('returns undefined when absent', () => {
    assert.equal(optionalBoolean({}, 'flag', CHANNEL), undefined)
  })

  test('returns true / false verbatim', () => {
    assert.equal(optionalBoolean({ flag: true }, 'flag', CHANNEL), true)
    assert.equal(optionalBoolean({ flag: false }, 'flag', CHANNEL), false)
  })

  test('rejects truthy non-boolean values', () => {
    assert.throws(() => optionalBoolean({ flag: 1 }, 'flag', CHANNEL))
    assert.throws(() => optionalBoolean({ flag: 'true' }, 'flag', CHANNEL))
    assert.throws(() => optionalBoolean({ flag: 'false' }, 'flag', CHANNEL))
    assert.throws(() => optionalBoolean({ flag: null }, 'flag', CHANNEL))
  })
})

describe('optionalNullableString', () => {
  test('returns undefined when absent', () => {
    assert.equal(optionalNullableString({}, 'tag', CHANNEL), undefined)
  })

  test('returns null when explicitly null', () => {
    assert.equal(optionalNullableString({ tag: null }, 'tag', CHANNEL), null)
  })

  test('returns the string when present', () => {
    assert.equal(optionalNullableString({ tag: 'important' }, 'tag', CHANNEL), 'important')
  })

  test('allows empty string', () => {
    assert.equal(optionalNullableString({ tag: '' }, 'tag', CHANNEL), '')
  })

  test('rejects non-string, non-null, non-undefined values', () => {
    assert.throws(() => optionalNullableString({ tag: 42 }, 'tag', CHANNEL))
    assert.throws(() => optionalNullableString({ tag: true }, 'tag', CHANNEL))
    assert.throws(() => optionalNullableString({ tag: {} }, 'tag', CHANNEL))
  })
})

describe('error messages include channel + field', () => {
  test('requireString', () => {
    assert.throws(
      () => requireString({}, 'sessionId', 'session:getInfo'),
      (err) => {
        const msg = (err as Error).message
        return msg.includes('session:getInfo') && msg.includes('sessionId')
      }
    )
  })

  test('optionalNumber', () => {
    assert.throws(
      () => optionalNumber({ limit: 'x' }, 'limit', 'session:list'),
      (err) => {
        const msg = (err as Error).message
        return msg.includes('session:list') && msg.includes('limit')
      }
    )
  })
})

// When run directly, print summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
