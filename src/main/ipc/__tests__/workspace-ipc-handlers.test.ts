/**
 * Tests for pure-logic functions extracted from workspace.ipc.ts.
 *
 * Run: tsx src/main/ipc/__tests__/workspace-ipc-handlers.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summary } from '../../services/__tests__/test-harness'
import {
  validateWorkspaceName,
  mergeWorkspaceSettings,
  detectLlmProviderChange,
  validateAuthMode
} from '../workspace-ipc-handlers'

const CH = 'test:channel'

// ── validateWorkspaceName ────────────────────────────────────────────────────

describe('validateWorkspaceName', () => {
  test('accepts normal name', () => {
    assert.equal(validateWorkspaceName('My Project', CH).valid, true)
  })

  test('accepts name at exactly 255 chars', () => {
    assert.equal(validateWorkspaceName('a'.repeat(255), CH).valid, true)
  })

  test('rejects name over 255 chars', () => {
    const result = validateWorkspaceName('a'.repeat(256), CH)
    assert.equal(result.valid, false)
    assert.ok(result.error?.includes('too long'))
    assert.ok(result.error?.includes('255'))
  })

  test('accepts empty name (repo basename used as fallback)', () => {
    assert.equal(validateWorkspaceName('', CH).valid, true)
  })
})

// ── mergeWorkspaceSettings ───────────────────────────────────────────────────

describe('mergeWorkspaceSettings', () => {
  test('merges updates over existing', () => {
    const existing = { a: 1, b: 2 } as Record<string, unknown>
    const updates = { b: 3, c: 4 }
    const merged = mergeWorkspaceSettings(existing, updates)
    assert.deepEqual(merged, { a: 1, b: 3, c: 4 })
  })

  test('preserves existing fields not in updates', () => {
    const existing = { a: 1, b: 2, c: 3 } as Record<string, unknown>
    const updates = { b: 99 }
    const merged = mergeWorkspaceSettings(existing, updates)
    assert.equal(merged.a, 1)
    assert.equal(merged.c, 3)
    assert.equal(merged.b, 99)
  })

  test('empty updates returns copy of existing', () => {
    const existing = { x: 42 } as Record<string, unknown>
    const merged = mergeWorkspaceSettings(existing, {})
    assert.deepEqual(merged, { x: 42 })
    assert.notEqual(merged, existing) // should be a new object
  })

  test('empty existing adopts all updates', () => {
    const merged = mergeWorkspaceSettings({}, { a: 1 })
    assert.deepEqual(merged, { a: 1 })
  })
})

// ── detectLlmProviderChange ──────────────────────────────────────────────────

describe('detectLlmProviderChange', () => {
  test('detects change from claude to openai-compatible', () => {
    const result = detectLlmProviderChange(
      { llmProvider: 'claude' },
      { llmProvider: 'openai-compatible' }
    )
    assert.equal(result.changed, true)
    assert.equal(result.oldProvider, 'claude')
    assert.equal(result.newProvider, 'openai-compatible')
  })

  test('no change when both same', () => {
    const result = detectLlmProviderChange(
      { llmProvider: 'claude' },
      { llmProvider: 'claude' }
    )
    assert.equal(result.changed, false)
  })

  test('defaults to claude when field missing', () => {
    const result = detectLlmProviderChange({}, {})
    assert.equal(result.changed, false)
    assert.equal(result.oldProvider, 'claude')
    assert.equal(result.newProvider, 'claude')
  })

  test('detects change when old is missing (default) and new is explicit', () => {
    const result = detectLlmProviderChange({}, { llmProvider: 'openai-compatible' })
    assert.equal(result.changed, true)
    assert.equal(result.oldProvider, 'claude')
    assert.equal(result.newProvider, 'openai-compatible')
  })

  test('no change from undefined to claude (both default)', () => {
    const result = detectLlmProviderChange(
      { llmProvider: undefined },
      { llmProvider: 'claude' }
    )
    assert.equal(result.changed, false)
  })
})

// ── validateAuthMode ─────────────────────────────────────────────────────────

describe('validateAuthMode', () => {
  test('accepts claude-max', () => {
    assert.equal(validateAuthMode('claude-max', CH).valid, true)
  })

  test('accepts api-key', () => {
    assert.equal(validateAuthMode('api-key', CH).valid, true)
  })

  test('rejects invalid mode', () => {
    const result = validateAuthMode('oauth', CH)
    assert.equal(result.valid, false)
    assert.ok(result.error?.includes('authMode'))
  })

  test('rejects empty string', () => {
    assert.equal(validateAuthMode('', CH).valid, false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
