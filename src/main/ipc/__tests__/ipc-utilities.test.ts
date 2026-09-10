/**
 * Tests for IPC utility modules: context-usage-level, tool-error-reporter.
 *
 * Run: tsx src/main/ipc/__tests__/ipc-utilities.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { setupFullMock, getMockRepo } from '../../services/__tests__/setup-full-mock'
import { resolveContextLevel } from '../context-usage-level'

// ── resolveContextLevel — large window (> 200K) ─────────────────────────────

describe('resolveContextLevel — large window (1M)', () => {
  const LARGE = 1_000_000

  test('< 48% → green / excellent', () => {
    const result = resolveContextLevel(47, LARGE)
    assert.equal(result.level, 'green')
    assert.equal(result.qualityLevel, 'excellent')
  })

  test('exactly 48% → yellow / good (at warn threshold)', () => {
    const result = resolveContextLevel(48, LARGE)
    assert.equal(result.level, 'yellow')
    assert.equal(result.qualityLevel, 'good')
  })

  test('59% → yellow / good', () => {
    const result = resolveContextLevel(59, LARGE)
    assert.equal(result.level, 'yellow')
    assert.equal(result.qualityLevel, 'good')
  })

  test('exactly 60% → red / moderate (at suggest threshold)', () => {
    const result = resolveContextLevel(60, LARGE)
    assert.equal(result.level, 'red')
    assert.equal(result.qualityLevel, 'moderate')
  })

  test('74% → red / moderate', () => {
    const result = resolveContextLevel(74, LARGE)
    assert.equal(result.level, 'red')
    assert.equal(result.qualityLevel, 'moderate')
  })

  test('exactly 75% → critical / low (at auto-compact threshold)', () => {
    const result = resolveContextLevel(75, LARGE)
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
  test('200K and 200001 classify identically — bands are window-independent', () => {
    assert.deepEqual(resolveContextLevel(48, 200_000), resolveContextLevel(48, 200_001))
    assert.equal(resolveContextLevel(48, 200_001).level, 'yellow') // uniform warn: 48%
  })

  test('the window argument does not affect any band', () => {
    for (const pct of [0, 47, 48, 59, 60, 74, 75, 99]) {
      assert.deepEqual(resolveContextLevel(pct, 128_000), resolveContextLevel(pct, 1_000_000))
    }
  })
})

// ── reportToolError ──────────────────────────────────────────────────────────
//
// `formatToolErrorMessage` no longer exists — the formatting (first-line
// extraction + SDK-tool prefix) now lives inside reportToolError, which writes
// the bug row via bugRepository.upsertBug. The full-mock bug repo captures it.
// The harness starts async tests concurrently, so each test reads its own
// slice of the shared spy log rather than relying on a beforeEach reset.

setupFullMock()

// Fresh module instance so it binds to the db-mock's CURRENT bug repository —
// an earlier file in the unified run may have reset or replaced the shared
// stub objects after this module was first cached.
delete require.cache[require.resolve('../tool-error-reporter')]
const { reportToolError } = require('../tool-error-reporter')
const bugRepo = getMockRepo('bug')

/**
 * Hermetic capture: replace upsertBug with our own collector for the duration
 * of one test. Earlier files can leave their own spy installed on the shared
 * stub object; reading its callCount would count (or miss) THEIR calls.
 */
let captured: any[] = []
let priorUpsert: any
function installCollector(): void {
  captured = []
  priorUpsert = bugRepo.upsertBug
  bugRepo.upsertBug = (input: any) => {
    captured.push(input)
    return { isNew: true, bugId: 'bug-1' }
  }
}
function restoreCollector(): void {
  bugRepo.upsertBug = priorUpsert
}

describe('reportToolError', () => {
  test('SDK built-in tool gets "Tool error" prefix', () => {
    installCollector()
    try {
      reportToolError('Read', 'Permission denied\nstack trace here', { agentType: 'grill' })
      assert.equal(captured.length, 1)
      const input = captured[0]
      assert.ok(input.errorMessage.startsWith('Tool error:'), input.errorMessage)
      assert.ok(input.errorMessage.includes('Read'))
      assert.ok(input.errorMessage.includes('Permission denied'))
      assert.ok(!input.errorMessage.includes('MCP'))
    } finally {
      restoreCollector()
    }
  })

  test('MCP tool gets "MCP tool error" prefix', () => {
    installCollector()
    try {
      reportToolError('code_graph__FindSymbol', 'Index not ready\nretry later', {
        agentType: 'audit'
      })
      assert.equal(captured.length, 1)
      const input = captured[0]
      assert.ok(input.errorMessage.startsWith('MCP tool error:'), input.errorMessage)
      assert.ok(input.errorMessage.includes('code_graph__FindSymbol'))
      assert.ok(input.errorMessage.includes('Index not ready'))
    } finally {
      restoreCollector()
    }
  })

  test('extracts first line only; stackTrace keeps the whole content', () => {
    installCollector()
    try {
      reportToolError('Bash', 'Line 1\nLine 2\nLine 3', { agentType: 'grill' })
      const input = captured[0]
      assert.ok(input.errorMessage.includes('Line 1'))
      assert.ok(!input.errorMessage.includes('Line 2'))
      assert.ok(input.stackTrace.includes('Line 3'))
    } finally {
      restoreCollector()
    }
  })

  test('handles empty error content', () => {
    installCollector()
    try {
      reportToolError('Write', '', { agentType: 'grill' })
      assert.equal(captured.length, 1)
      const input = captured[0]
      assert.ok(input.errorMessage.includes('Write'))
      // Empty first line is not nullish, so no 'Unknown error' text is added.
      assert.ok(!input.errorMessage.includes('Unknown error'))
    } finally {
      restoreCollector()
    }
  })

  test('handles all SDK built-in tools', () => {
    installCollector()
    try {
      for (const tool of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']) {
        reportToolError(tool, 'test error', { agentType: 'grill' })
        const input = captured[captured.length - 1]
        assert.ok(
          input.errorMessage.startsWith('Tool error:'),
          `${tool} should get Tool error prefix`
        )
      }
    } finally {
      restoreCollector()
    }
  })

  test('trims whitespace from first line', () => {
    installCollector()
    try {
      reportToolError('Read', '  spaces around  \nmore text', { agentType: 'grill' })
      const input = captured[0]
      assert.ok(input.errorMessage.includes('spaces around'))
      assert.ok(!input.errorMessage.includes('  spaces'))
    } finally {
      restoreCollector()
    }
  })

  test('context fields reach the bug row', () => {
    installCollector()
    try {
      reportToolError('Read', 'boom', {
        agentType: 'council',
        workspaceId: 'ws-9',
        agentId: 'agent-7'
      })
      const input = captured[0]
      assert.equal(input.componentName, 'council')
      assert.equal(input.workspaceId, 'ws-9')
      assert.equal(input.agentId, 'agent-7')
    } finally {
      restoreCollector()
    }
  })

  test('suppresses expected Bash safety-guard rejections', () => {
    installCollector()
    try {
      reportToolError('Bash', 'Blocked: rm -rf /', { agentType: 'grill' })
      assert.equal(captured.length, 0, 'Blocked: Bash rejections are not bugs')
    } finally {
      restoreCollector()
    }
  })

  test('suppresses expected CLI permission/interaction errors', () => {
    installCollector()
    try {
      const suppressed = [
        'Tool bash has been denied',
        'permission denied by timeout',
        'Do you want to proceed?',
        'command requires approval',
        'File has been modified since read',
        'Skill is not enabled'
      ]
      for (const content of suppressed) {
        reportToolError('Read', content, { agentType: 'grill' })
        assert.equal(captured.length, 0, `should suppress: ${content}`)
      }
    } finally {
      restoreCollector()
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
