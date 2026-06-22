/**
 * Tests for IPC utility modules: context-usage-level, tool-error-reporter.
 *
 * Run: tsx src/main/ipc/__tests__/ipc-utilities.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summary } from '../../services/__tests__/test-harness'
import { resolveContextLevel } from '../context-usage-level'
const { formatToolErrorMessage } = require('../tool-error-reporter') as any

// ── resolveContextLevel — large window (> 200K) ─────────────────────────────

describe('resolveContextLevel — large window (1M)', () => {
  const LARGE = 1_000_000

  test('< 56% → green / excellent', () => {
    const result = resolveContextLevel(55, LARGE)
    assert.equal(result.level, 'green')
    assert.equal(result.qualityLevel, 'excellent')
  })

  test('exactly 56% → yellow / good (at warn threshold)', () => {
    const result = resolveContextLevel(56, LARGE)
    assert.equal(result.level, 'yellow')
    assert.equal(result.qualityLevel, 'good')
  })

  test('69% → yellow / good', () => {
    const result = resolveContextLevel(69, LARGE)
    assert.equal(result.level, 'yellow')
    assert.equal(result.qualityLevel, 'good')
  })

  test('exactly 70% → red / moderate (at suggest threshold)', () => {
    const result = resolveContextLevel(70, LARGE)
    assert.equal(result.level, 'red')
    assert.equal(result.qualityLevel, 'moderate')
  })

  test('84% → red / moderate', () => {
    const result = resolveContextLevel(84, LARGE)
    assert.equal(result.level, 'red')
    assert.equal(result.qualityLevel, 'moderate')
  })

  test('exactly 85% → critical / low (at auto-compact threshold)', () => {
    const result = resolveContextLevel(85, LARGE)
    assert.equal(result.level, 'critical')
    assert.equal(result.qualityLevel, 'low')
  })

  test('99% → critical / low', () => {
    const result = resolveContextLevel(99, LARGE)
    assert.equal(result.level, 'critical')
    assert.equal(result.qualityLevel, 'low')
  })

  test('0% → green / excellent', () => {
    const result = resolveContextLevel(0, LARGE)
    assert.equal(result.level, 'green')
    assert.equal(result.qualityLevel, 'excellent')
  })
})

// ── resolveContextLevel — small window (≤ 200K) ─────────────────────────────

describe('resolveContextLevel — small window (128K)', () => {
  const SMALL = 128_000

  test('< 48% → green / excellent', () => {
    const result = resolveContextLevel(47, SMALL)
    assert.equal(result.level, 'green')
    assert.equal(result.qualityLevel, 'excellent')
  })

  test('exactly 48% → yellow / good (at warn threshold)', () => {
    const result = resolveContextLevel(48, SMALL)
    assert.equal(result.level, 'yellow')
    assert.equal(result.qualityLevel, 'good')
  })

  test('59% → yellow / good', () => {
    const result = resolveContextLevel(59, SMALL)
    assert.equal(result.level, 'yellow')
    assert.equal(result.qualityLevel, 'good')
  })

  test('exactly 60% → red / moderate (at suggest threshold)', () => {
    const result = resolveContextLevel(60, SMALL)
    assert.equal(result.level, 'red')
    assert.equal(result.qualityLevel, 'moderate')
  })

  test('74% → red / moderate', () => {
    const result = resolveContextLevel(74, SMALL)
    assert.equal(result.level, 'red')
    assert.equal(result.qualityLevel, 'moderate')
  })

  test('exactly 75% → critical / low (at auto-compact threshold)', () => {
    const result = resolveContextLevel(75, SMALL)
    assert.equal(result.level, 'critical')
    assert.equal(result.qualityLevel, 'low')
  })
})

// ── resolveContextLevel — boundary (200K window) ────────────────────────────

describe('resolveContextLevel — 200K window boundary', () => {
  test('200K is classified as small', () => {
    const result = resolveContextLevel(48, 200_000)
    assert.equal(result.level, 'yellow') // small threshold: 48%
  })

  test('200001 is classified as large', () => {
    const result = resolveContextLevel(48, 200_001)
    assert.equal(result.level, 'green') // large threshold: 56%
  })
})

// ── formatToolErrorMessage ───────────────────────────────────────────────────

describe('formatToolErrorMessage', () => {
  test('SDK built-in tool gets "Tool error" prefix', () => {
    const msg = formatToolErrorMessage('Read', 'Permission denied\nstack trace here')
    assert.ok(msg.startsWith('Tool error:'))
    assert.ok(msg.includes('Read'))
    assert.ok(msg.includes('Permission denied'))
    assert.ok(!msg.includes('MCP'))
  })

  test('MCP tool gets "MCP tool error" prefix', () => {
    const msg = formatToolErrorMessage('code_graph__FindSymbol', 'Index not ready\nretry later')
    assert.ok(msg.startsWith('MCP tool error:'))
    assert.ok(msg.includes('code_graph__FindSymbol'))
    assert.ok(msg.includes('Index not ready'))
  })

  test('extracts first line only', () => {
    const msg = formatToolErrorMessage('Bash', 'Line 1\nLine 2\nLine 3')
    assert.ok(msg.includes('Line 1'))
    assert.ok(!msg.includes('Line 2'))
    assert.ok(!msg.includes('Line 3'))
  })

  test('handles empty error content', () => {
    const msg = formatToolErrorMessage('Write', '')
    assert.ok(msg.includes('Write'))
    // Empty first line → 'Unknown error' fallback (empty string trimmed → '')
  })

  test('handles all SDK built-in tools', () => {
    for (const tool of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']) {
      const msg = formatToolErrorMessage(tool, 'test error')
      assert.ok(msg.startsWith('Tool error:'), `${tool} should get Tool error prefix`)
    }
  })

  test('trims whitespace from first line', () => {
    const msg = formatToolErrorMessage('Read', '  spaces around  \nmore text')
    assert.ok(msg.includes('spaces around'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
