/**
 * Tests for pure-logic functions extracted from conversation-crud.ipc.ts.
 *
 * Run: tsx src/main/ipc/__tests__/conversation-crud-handlers.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summary } from '../../services/__tests__/test-harness'
import {
  VALID_MODES,
  validateTitle,
  validateRenameTitle,
  validateMode,
  validateCommunicationTone
} from '../conversation-crud-handlers'

const CH = 'test:channel'

// ── VALID_MODES ──────────────────────────────────────────────────────────────

describe('VALID_MODES', () => {
  test('contains plan, build, danger', () => {
    assert.deepEqual([...VALID_MODES], ['plan', 'build', 'danger'])
  })
})

// ── validateTitle ────────────────────────────────────────────────────────────

describe('validateTitle', () => {
  test('accepts undefined title', () => {
    assert.equal(validateTitle(undefined, CH).valid, true)
  })

  test('accepts short title', () => {
    assert.equal(validateTitle('My Conversation', CH).valid, true)
  })

  test('accepts title at exactly 500 chars', () => {
    const title = 'a'.repeat(500)
    assert.equal(validateTitle(title, CH).valid, true)
  })

  test('rejects title over 500 chars', () => {
    const title = 'a'.repeat(501)
    const result = validateTitle(title, CH)
    assert.equal(result.valid, false)
    assert.ok(result.error?.includes('too long'))
    assert.ok(result.error?.includes('500'))
  })

  test('accepts empty string', () => {
    assert.equal(validateTitle('', CH).valid, true)
  })
})

// ── validateRenameTitle ──────────────────────────────────────────────────────

describe('validateRenameTitle', () => {
  test('accepts normal title', () => {
    assert.equal(validateRenameTitle('New Name', CH).valid, true)
  })

  test('rejects title over 500 chars', () => {
    const result = validateRenameTitle('a'.repeat(501), CH)
    assert.equal(result.valid, false)
    assert.ok(result.error?.includes('too long'))
  })

  test('rejects whitespace-only title', () => {
    const result = validateRenameTitle('   ', CH)
    assert.equal(result.valid, false)
    assert.ok(result.error?.includes('empty'))
  })

  test('rejects empty string', () => {
    const result = validateRenameTitle('', CH)
    assert.equal(result.valid, false)
    assert.ok(result.error?.includes('empty'))
  })

  test('accepts title with leading/trailing spaces (non-empty after trim)', () => {
    assert.equal(validateRenameTitle('  hello  ', CH).valid, true)
  })
})

// ── validateMode ─────────────────────────────────────────────────────────────

describe('validateMode', () => {
  test('accepts undefined mode', () => {
    assert.equal(validateMode(undefined, CH).valid, true)
  })

  test('accepts plan mode', () => {
    assert.equal(validateMode('plan', CH).valid, true)
  })

  test('accepts build mode', () => {
    assert.equal(validateMode('build', CH).valid, true)
  })

  test('accepts danger mode', () => {
    assert.equal(validateMode('danger', CH).valid, true)
  })

  test('rejects invalid mode', () => {
    const result = validateMode('yolo', CH)
    assert.equal(result.valid, false)
    assert.ok(result.error?.includes('mode'))
  })

  test('rejects empty string mode', () => {
    const result = validateMode('', CH)
    assert.equal(result.valid, false)
  })
})

// ── validateCommunicationTone ────────────────────────────────────────────────

describe('validateCommunicationTone', () => {
  test('accepts undefined', () => {
    assert.equal(validateCommunicationTone(undefined, CH).valid, true)
  })

  test('accepts null (use default)', () => {
    assert.equal(validateCommunicationTone(null, CH).valid, true)
  })

  test('accepts default tone', () => {
    assert.equal(validateCommunicationTone('default', CH).valid, true)
  })

  test('accepts calm tone', () => {
    assert.equal(validateCommunicationTone('calm', CH).valid, true)
  })

  test('accepts brutal tone', () => {
    assert.equal(validateCommunicationTone('brutal', CH).valid, true)
  })

  test('accepts optimistic tone', () => {
    assert.equal(validateCommunicationTone('optimistic', CH).valid, true)
  })

  test('accepts caveman tone', () => {
    assert.equal(validateCommunicationTone('caveman', CH).valid, true)
  })

  test('rejects invalid tone', () => {
    const result = validateCommunicationTone('sarcastic' as 'calm', CH)
    assert.equal(result.valid, false)
    assert.ok(result.error?.includes('tone'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
