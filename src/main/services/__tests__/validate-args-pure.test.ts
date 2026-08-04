/**
 * Unit tests for IPC boundary validation utilities:
 *   - validate-args.ts  (0% → 100%)
 *   - safe-send.ts      (57% → 90%)
 *   - encrypt-settings-keys.ts (47% → 85%)
 *   - resolve-workspace-name.ts (0% → 100%)
 *
 * All targets are pure/nearly-pure functions used by every IPC handler.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ── validate-args.ts ─────────────────────────────────────────────────────────
import {
  requireObject,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  optionalNullableString,
  requireStringArray,
  requirePlainObject,
} from '../../ipc/validate-args'

describe('validate-args › requireObject', () => {
  test('accepts a plain object', () => {
    const obj = { a: 1 }
    assert.equal(requireObject(obj, 'ch'), obj)
  })

  test('rejects null', () => {
    assert.throws(() => requireObject(null, 'ch'), /expected an object.*null/)
  })

  test('rejects array', () => {
    assert.throws(() => requireObject([1, 2], 'ch'), /expected an object.*array/)
  })

  test('rejects string', () => {
    assert.throws(() => requireObject('hello', 'ch'), /expected an object.*string/)
  })

  test('rejects number', () => {
    assert.throws(() => requireObject(42, 'ch'), /expected an object.*number/)
  })

  test('rejects undefined', () => {
    assert.throws(() => requireObject(undefined, 'ch'), /expected an object.*undefined/)
  })

  test('rejects boolean', () => {
    assert.throws(() => requireObject(true, 'ch'), /expected an object.*boolean/)
  })

  test('includes channel name in error', () => {
    assert.throws(() => requireObject(null, 'my:channel'), /my:channel/)
  })
})

describe('validate-args › requireString', () => {
  test('accepts a non-empty string', () => {
    assert.equal(requireString({ name: 'hello' }, 'name', 'ch'), 'hello')
  })

  test('rejects empty string', () => {
    assert.throws(() => requireString({ name: '' }, 'name', 'ch'), /non-empty string/)
  })

  test('rejects missing field', () => {
    assert.throws(() => requireString({}, 'name', 'ch'), /non-empty string/)
  })

  test('rejects number type', () => {
    assert.throws(() => requireString({ name: 42 }, 'name', 'ch'), /non-empty string/)
  })

  test('rejects null value', () => {
    assert.throws(() => requireString({ name: null }, 'name', 'ch'), /non-empty string/)
  })

  test('includes field name in error', () => {
    assert.throws(() => requireString({}, 'myField', 'ch'), /myField/)
  })
})

describe('validate-args › optionalString', () => {
  test('returns string when present', () => {
    assert.equal(optionalString({ s: 'hello' }, 's', 'ch'), 'hello')
  })

  test('returns undefined when field is absent', () => {
    assert.equal(optionalString({}, 's', 'ch'), undefined)
  })

  test('returns undefined when value is undefined', () => {
    assert.equal(optionalString({ s: undefined }, 's', 'ch'), undefined)
  })

  test('throws when value is a number', () => {
    assert.throws(() => optionalString({ s: 42 }, 's', 'ch'), /must be a string/)
  })

  test('throws when value is boolean', () => {
    assert.throws(() => optionalString({ s: true }, 's', 'ch'), /must be a string/)
  })

  test('accepts empty string (no length check)', () => {
    assert.equal(optionalString({ s: '' }, 's', 'ch'), '')
  })
})

describe('validate-args › optionalNumber', () => {
  test('returns finite number when present', () => {
    assert.equal(optionalNumber({ n: 42 }, 'n', 'ch'), 42)
  })

  test('returns undefined when absent', () => {
    assert.equal(optionalNumber({}, 'n', 'ch'), undefined)
  })

  test('rejects NaN', () => {
    assert.throws(() => optionalNumber({ n: NaN }, 'n', 'ch'), /finite number/)
  })

  test('rejects Infinity', () => {
    assert.throws(() => optionalNumber({ n: Infinity }, 'n', 'ch'), /finite number/)
  })

  test('rejects -Infinity', () => {
    assert.throws(() => optionalNumber({ n: -Infinity }, 'n', 'ch'), /finite number/)
  })

  test('rejects string', () => {
    assert.throws(() => optionalNumber({ n: '42' }, 'n', 'ch'), /finite number/)
  })

  test('accepts zero', () => {
    assert.equal(optionalNumber({ n: 0 }, 'n', 'ch'), 0)
  })

  test('accepts negative numbers', () => {
    assert.equal(optionalNumber({ n: -3.14 }, 'n', 'ch'), -3.14)
  })
})

describe('validate-args › optionalBoolean', () => {
  test('returns true when present', () => {
    assert.equal(optionalBoolean({ b: true }, 'b', 'ch'), true)
  })

  test('returns false when present', () => {
    assert.equal(optionalBoolean({ b: false }, 'b', 'ch'), false)
  })

  test('returns undefined when absent', () => {
    assert.equal(optionalBoolean({}, 'b', 'ch'), undefined)
  })

  test('rejects truthy non-boolean (number 1)', () => {
    assert.throws(() => optionalBoolean({ b: 1 }, 'b', 'ch'), /must be a boolean/)
  })

  test('rejects string "true"', () => {
    assert.throws(() => optionalBoolean({ b: 'true' }, 'b', 'ch'), /must be a boolean/)
  })
})

describe('validate-args › optionalNullableString', () => {
  test('returns string when present', () => {
    assert.equal(optionalNullableString({ s: 'hello' }, 's', 'ch'), 'hello')
  })

  test('returns null when null', () => {
    assert.equal(optionalNullableString({ s: null }, 's', 'ch'), null)
  })

  test('returns undefined when absent', () => {
    assert.equal(optionalNullableString({}, 's', 'ch'), undefined)
  })

  test('throws when value is a number', () => {
    assert.throws(() => optionalNullableString({ s: 42 }, 's', 'ch'), /must be a string, null/)
  })
})

describe('validate-args › requireStringArray', () => {
  test('accepts valid string array', () => {
    assert.deepEqual(requireStringArray({ a: ['x', 'y'] }, 'a', 'ch'), ['x', 'y'])
  })

  test('rejects empty array', () => {
    assert.throws(() => requireStringArray({ a: [] }, 'a', 'ch'), /non-empty array/)
  })

  test('rejects mixed types (string + number)', () => {
    assert.throws(() => requireStringArray({ a: ['ok', 42] }, 'a', 'ch'), /a\[1\].*string/)
  })

  test('rejects non-array value', () => {
    assert.throws(() => requireStringArray({ a: 'not-array' }, 'a', 'ch'), /non-empty array/)
  })

  test('rejects missing field', () => {
    assert.throws(() => requireStringArray({}, 'a', 'ch'), /non-empty array/)
  })

  test('rejects null', () => {
    assert.throws(() => requireStringArray({ a: null }, 'a', 'ch'), /non-empty array/)
  })
})

describe('validate-args › requirePlainObject', () => {
  test('accepts plain object', () => {
    const val = { key: 'value' }
    assert.equal(requirePlainObject({ obj: val }, 'obj', 'ch'), val)
  })

  test('rejects array', () => {
    assert.throws(() => requirePlainObject({ obj: [1] }, 'obj', 'ch'), /plain object/)
  })

  test('rejects null', () => {
    assert.throws(() => requirePlainObject({ obj: null }, 'obj', 'ch'), /plain object/)
  })

  test('rejects undefined', () => {
    assert.throws(() => requirePlainObject({ obj: undefined }, 'obj', 'ch'), /plain object/)
  })

  test('accepts nested object', () => {
    const val = { nested: { deep: true } }
    assert.deepEqual(requirePlainObject({ obj: val }, 'obj', 'ch'), val)
  })

  test('rejects string', () => {
    assert.throws(() => requirePlainObject({ obj: 'str' }, 'obj', 'ch'), /plain object/)
  })
})

// ── safe-send.ts ─────────────────────────────────────────────────────────────
import { safeWindowSend } from '../../ipc/safe-send'

describe('safe-send › safeWindowSend', () => {
  test('returns true on successful send', () => {
    let sentChannel = ''
    let sentArgs: unknown[] = []
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (ch: string, ...args: unknown[]) => {
          sentChannel = ch
          sentArgs = args
        },
      },
    } as any
    const result = safeWindowSend(win, 'test:channel', { data: 1 })
    assert.equal(result, true)
    assert.equal(sentChannel, 'test:channel')
    assert.deepEqual(sentArgs, [{ data: 1 }])
  })

  test('returns false when window is destroyed', () => {
    const win = {
      isDestroyed: () => true,
      webContents: {
        send: () => {
          throw new Error('should not be called')
        },
      },
    } as any
    const result = safeWindowSend(win, 'test:channel')
    assert.equal(result, false)
  })

  test('returns false when send throws', () => {
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: () => {
          throw new Error('Object has been destroyed')
        },
      },
    } as any
    const result = safeWindowSend(win, 'test:channel')
    assert.equal(result, false)
  })

  test('passes multiple args through', () => {
    const passedArgs: unknown[][] = []
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (_ch: string, ...args: unknown[]) => {
          passedArgs.push(args)
        },
      },
    } as any
    safeWindowSend(win, 'ch', 'a', 'b', 'c')
    assert.deepEqual(passedArgs[0], ['a', 'b', 'c'])
  })
})

// ── encrypt-settings-keys.ts ─────────────────────────────────────────────────
import { encryptSettingsKeys, decryptSettingsKey } from '../../ipc/encrypt-settings-keys'

describe('encrypt-settings-keys › encryptSettingsKeys', () => {
  test('encrypts plaintext API key fields', () => {
    const input = { anthropicApiKey: 'sk-ant-123' }
    const result = encryptSettingsKeys(input)
    // The value should be different (base64-encoded encrypted)
    assert.notEqual(result.anthropicApiKey, 'sk-ant-123')
    assert.equal(result.anthropicApiKeyEncrypted, true)
  })

  test('does not mutate the input object', () => {
    const input = { anthropicApiKey: 'sk-ant-123' }
    encryptSettingsKeys(input)
    assert.equal(input.anthropicApiKey, 'sk-ant-123')
    assert.equal((input as any).anthropicApiKeyEncrypted, undefined)
  })

  test('skips already-encrypted fields', () => {
    const input = {
      anthropicApiKey: 'alreadyEncrypted==',
      anthropicApiKeyEncrypted: true,
    }
    const result = encryptSettingsKeys(input)
    assert.equal(result.anthropicApiKey, 'alreadyEncrypted==')
  })

  test('skips empty string values', () => {
    const input = { anthropicApiKey: '' }
    const result = encryptSettingsKeys(input)
    assert.equal(result.anthropicApiKey, '')
    assert.equal(result.anthropicApiKeyEncrypted, undefined)
  })

  test('skips non-string values', () => {
    const input = { anthropicApiKey: null }
    const result = encryptSettingsKeys(input)
    assert.equal(result.anthropicApiKey, null)
  })

  test('encrypts all three key fields', () => {
    const input = {
      anthropicApiKey: 'key1',
      openCodeApiKey: 'key2',
      localApiKey: 'key3',
    }
    const result = encryptSettingsKeys(input)
    assert.equal(result.anthropicApiKeyEncrypted, true)
    assert.equal(result.openCodeApiKeyEncrypted, true)
    assert.equal(result.localApiKeyEncrypted, true)
  })

  test('preserves non-key fields unchanged', () => {
    const input = {
      anthropicApiKey: 'sk-123',
      otherSetting: 'value',
      count: 42,
    }
    const result = encryptSettingsKeys(input)
    assert.equal(result.otherSetting, 'value')
    assert.equal(result.count, 42)
  })
})

describe('encrypt-settings-keys › decryptSettingsKey', () => {
  test('returns undefined for empty value', () => {
    assert.equal(decryptSettingsKey('', false), undefined)
  })

  test('returns undefined for null value', () => {
    assert.equal(decryptSettingsKey(null, false), undefined)
  })

  test('returns undefined for undefined value', () => {
    assert.equal(decryptSettingsKey(undefined, false), undefined)
  })

  test('returns plaintext when not encrypted (legacy)', () => {
    assert.equal(decryptSettingsKey('sk-ant-123', false), 'sk-ant-123')
  })

  test('returns plaintext when isEncrypted is undefined (legacy)', () => {
    assert.equal(decryptSettingsKey('sk-ant-123', undefined), 'sk-ant-123')
  })

  test('encrypt/decrypt round-trip preserves value', () => {
    const original = 'sk-ant-test-key-12345'
    const encrypted = encryptSettingsKeys({ anthropicApiKey: original })
    const decrypted = decryptSettingsKey(
      encrypted.anthropicApiKey as string,
      encrypted.anthropicApiKeyEncrypted as boolean
    )
    assert.equal(decrypted, original)
  })

  test('handles short plaintext value with encrypted flag (SEC-04b fallback)', () => {
    // Short non-base64 looks like plaintext — fallback returns it
    const result = decryptSettingsKey('sk-ant-123', true)
    assert.equal(result, 'sk-ant-123')
  })

  test('returns undefined for corrupt base64 with encrypted flag', () => {
    // Long base64-looking string that cannot be decrypted by our mock
    // (doesn't start with 'ENC:' once decoded)
    const corruptBase64 = Buffer.from('NOT_ENCRYPTED_DATA_THAT_IS_LONGER_THAN_100_CHARS_TO_AVOID_PLAINTEXT_FALLBACK_PATH_XXXXXXXXXXXXXXXXXXXXXXXXX').toString('base64')
    const result = decryptSettingsKey(corruptBase64, true)
    assert.equal(result, undefined)
  })
})

// ── resolve-workspace-name.ts ─────────────────────────────────────────────────
import { resolveWorkspaceName } from '../../ipc/resolve-workspace-name'

describe('resolve-workspace-name › resolveWorkspaceName', () => {
  test('returns first 8 chars as fallback when repository unavailable', () => {
    // The require('../db/repositories') will fail in test env — triggers catch
    const result = resolveWorkspaceName('abcdef0123456789')
    assert.equal(result, 'abcdef01')
  })

  test('returns first 8 chars for short ID', () => {
    const result = resolveWorkspaceName('1234')
    assert.equal(result, '1234')
  })

  test('always returns a string', () => {
    const result = resolveWorkspaceName('')
    assert.equal(typeof result, 'string')
  })
})
