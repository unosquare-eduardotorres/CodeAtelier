/**
 * CLI Executor — /goal command builder, goalMode gating, and drain-logic tests.
 *
 * Covers:
 * - resolveEmptyTurnFailure: zero-NDJSON turns are failures, classified, abort-exempt
 * - buildGoalCommand: newline collapsing, 4,000-char truncation, empty → null, clear-alias guard
 * - goalMode gating: advisory → no /goal queued, enforce → queued
 * - Drain logic: trailing result consumed / timer path proceeds
 * - buildBuilderGoalCondition ID-cap (mpa-goal-conditions.ts)
 *
 * Pure logic: no filesystem, no network, no Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { buildGoalCommand, resolveEmptyTurnFailure, spawnSignatureSatisfies } from '../cli-executor'
import { buildBuilderGoalCondition } from '../mpa-goal-conditions'
import type { MpaPlanArtifact } from '../../../shared/mpa-types'

// ── resolveEmptyTurnFailure ──

describe('resolveEmptyTurnFailure — zero-NDJSON turns', () => {
  function input(overrides: Partial<Parameters<typeof resolveEmptyTurnFailure>[0]> = {}) {
    return {
      msgCount: 0,
      aborted: false,
      betasRejected: false,
      exitCode: 0,
      stderrError: null,
      ...overrides
    }
  }

  test('a turn that produced messages is never a failure', () => {
    assert.equal(resolveEmptyTurnFailure(input({ msgCount: 3 })), null)
  })

  // Regression: a clean exit with zero output used to fall through to
  // telemetry.finalize(), which promotes started → succeeded.
  test('zero messages with exit 0 → empty-exit failure', () => {
    const result = resolveEmptyTurnFailure(input())
    assert.equal(result?.reason, 'empty-exit')
    assert.match(result!.message, /CLI produced no output \(empty-exit, exit 0\)/)
  })

  test('zero messages with a non-zero exit → crash', () => {
    const result = resolveEmptyTurnFailure(input({ exitCode: 1 }))
    assert.equal(result?.reason, 'crash')
  })

  test('stderr carried the betas rejection → betas-rejected wins over exit code', () => {
    const result = resolveEmptyTurnFailure(input({ betasRejected: true, exitCode: 1 }))
    assert.equal(result?.reason, 'betas-rejected')
  })

  test('stderr detail is appended to the message', () => {
    const result = resolveEmptyTurnFailure(input({ stderrError: 'boom' }))
    assert.match(result!.message, /— boom$/)
  })

  test('null exit code is rendered rather than dropped', () => {
    const result = resolveEmptyTurnFailure(input({ exitCode: null }))
    assert.equal(result?.reason, 'empty-exit')
    assert.match(result!.message, /exit null/)
  })

  // Pressing Stop legitimately yields zero messages — that path must stay silent.
  test('zero messages after a deliberate abort → no failure', () => {
    assert.equal(resolveEmptyTurnFailure(input({ aborted: true })), null)
    assert.equal(resolveEmptyTurnFailure(input({ aborted: true, exitCode: 143 })), null)
  })
})

// ── buildGoalCommand ──

describe('buildGoalCommand — sanitization', () => {
  test('collapses newlines and whitespace to single spaces', () => {
    const result = buildGoalCommand('All\ntests\n\npass\t  cleanly')
    assert.equal(result, '/goal All tests pass cleanly')
  })

  test('trims leading and trailing whitespace', () => {
    const result = buildGoalCommand('  All tests pass  ')
    assert.equal(result, '/goal All tests pass')
  })

  test('collapses multiple spaces into one', () => {
    const result = buildGoalCommand('All   tests   pass')
    assert.equal(result, '/goal All tests pass')
  })
})

describe('buildGoalCommand — empty/null handling', () => {
  test('returns null for empty string', () => {
    assert.equal(buildGoalCommand(''), null)
  })

  test('returns null for whitespace-only string', () => {
    assert.equal(buildGoalCommand('   \n\t  '), null)
  })
})

describe('buildGoalCommand — clear-alias guard', () => {
  test('prefixes when condition starts with "clear"', () => {
    const result = buildGoalCommand('clear the cache and verify')
    assert.ok(result!.startsWith('/goal Condition: clear'))
  })

  test('prefixes when condition starts with "stop"', () => {
    const result = buildGoalCommand('stop after all tests pass')
    assert.ok(result!.startsWith('/goal Condition: stop'))
  })

  test('prefixes when condition starts with "off"', () => {
    const result = buildGoalCommand('off-by-one errors are fixed')
    assert.ok(result!.startsWith('/goal Condition: off'))
  })

  test('prefixes when condition starts with "reset"', () => {
    const result = buildGoalCommand('reset state before verification')
    assert.ok(result!.startsWith('/goal Condition: reset'))
  })

  test('prefixes when condition starts with "none"', () => {
    const result = buildGoalCommand('none of the tests fail')
    assert.ok(result!.startsWith('/goal Condition: none'))
  })

  test('prefixes when condition starts with "cancel"', () => {
    const result = buildGoalCommand('cancel-safe implementation complete')
    assert.ok(result!.startsWith('/goal Condition: cancel'))
  })

  test('case-insensitive alias matching', () => {
    const result = buildGoalCommand('CLEAR all build artifacts')
    assert.ok(result!.startsWith('/goal Condition: CLEAR'))
  })

  test('does NOT prefix when clear-alias appears mid-string', () => {
    const result = buildGoalCommand('All tests pass, clear and clean')
    assert.equal(result, '/goal All tests pass, clear and clean')
  })

  test('does NOT prefix normal conditions', () => {
    const result = buildGoalCommand('All tests pass and lint is clean')
    assert.equal(result, '/goal All tests pass and lint is clean')
  })
})

describe('buildGoalCommand — 4,000-char truncation', () => {
  test('passes through strings under 4,000 chars unchanged', () => {
    const condition = 'X'.repeat(3999)
    const result = buildGoalCommand(condition)
    // /goal prefix adds 6 chars
    assert.equal(result, `/goal ${condition}`)
  })

  test('truncates strings exceeding 4,000 chars', () => {
    const condition = 'Y'.repeat(5000)
    const result = buildGoalCommand(condition)
    // The condition text (after /goal prefix) should be capped at 4000 chars
    assert.ok(result!.startsWith('/goal '))
    const conditionPart = result!.slice('/goal '.length)
    assert.equal(conditionPart.length, 4000)
  })

  test('exactly 4,000 chars is NOT truncated', () => {
    const condition = 'Z'.repeat(4000)
    const result = buildGoalCommand(condition)
    const conditionPart = result!.slice('/goal '.length)
    assert.equal(conditionPart.length, 4000)
  })
})

describe('buildGoalCommand — combined scenarios', () => {
  test('newline collapsing + clear-alias guard', () => {
    const result = buildGoalCommand('clear\nthe\ncache')
    assert.equal(result, '/goal Condition: clear the cache')
  })

  test('newline collapsing + truncation on a huge multi-line string', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `Line ${i} is done`)
    const result = buildGoalCommand(lines.join('\n'))
    assert.ok(result!.length <= '/goal '.length + 4000)
  })
})

// ── goalMode gating logic (replicated from execute()) ──

describe('goalMode gating — replicated', () => {
  /**
   * Replicate the goalMode gating logic from CLIExecutor to verify
   * the branching behavior without spawning a real CLI process.
   */
  function simulateGoalQueueing(
    goal: string | undefined,
    goalMode: 'advisory' | 'enforce' | undefined
  ): { goalQueued: boolean; goalCmd: string | null } {
    const effectiveGoalMode = goalMode ?? 'advisory'
    const goalCmd = goal && effectiveGoalMode === 'enforce' ? buildGoalCommand(goal) : null
    return {
      goalQueued: goalCmd !== null,
      goalCmd
    }
  }

  test('advisory mode (default) → no /goal queued even with goal text', () => {
    const { goalQueued } = simulateGoalQueueing('All tests pass', undefined)
    assert.equal(goalQueued, false)
  })

  test('advisory mode (explicit) → no /goal queued', () => {
    const { goalQueued } = simulateGoalQueueing('All tests pass', 'advisory')
    assert.equal(goalQueued, false)
  })

  test('enforce mode → /goal queued', () => {
    const { goalQueued, goalCmd } = simulateGoalQueueing('All tests pass', 'enforce')
    assert.equal(goalQueued, true)
    assert.equal(goalCmd, '/goal All tests pass')
  })

  test('enforce mode with no goal → no /goal queued', () => {
    const { goalQueued } = simulateGoalQueueing(undefined, 'enforce')
    assert.equal(goalQueued, false)
  })

  test('enforce mode with empty goal → no /goal queued', () => {
    const { goalQueued } = simulateGoalQueueing('', 'enforce')
    assert.equal(goalQueued, false)
  })
})

// ── Drain logic (replicated from execute()) ──

describe('Drain logic — replicated', () => {
  /**
   * Replicate the first-result-finalization + drain logic from CLIExecutor.
   * Verifies that:
   * 1. We always finalize on the FIRST result (no skipping)
   * 2. When goalWasQueued, we attempt to drain a trailing result
   */
  function simulateResultHandling(
    messages: Array<{ type: string }>,
    goalWasQueued: boolean
  ): {
    finalizedOnIndex: number
    drainAttempted: boolean
    drainedMessage: { type: string } | null
  } {
    let finalizedOnIndex = -1
    let drainAttempted = false
    let drainedMessage: { type: string } | null = null

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.type === 'result') {
        finalizedOnIndex = i
        // Simulate drain: if goalWasQueued, look for a trailing message
        if (goalWasQueued) {
          drainAttempted = true
          const nextIdx = i + 1
          if (nextIdx < messages.length) {
            drainedMessage = messages[nextIdx]
          }
        }
        break // Always break on first result
      }
    }
    return { finalizedOnIndex, drainAttempted, drainedMessage }
  }

  test('no goal → finalizes on first result, no drain attempted', () => {
    const messages = [
      { type: 'assistant' },
      { type: 'result' },
      { type: 'result' } // should not be reached
    ]
    const { finalizedOnIndex, drainAttempted } = simulateResultHandling(messages, false)
    assert.equal(finalizedOnIndex, 1) // 0-indexed: second message
    assert.equal(drainAttempted, false)
  })

  test('goal queued → finalizes on first result, drain attempted', () => {
    const messages = [
      { type: 'assistant' },
      { type: 'result' }, // finalize here
      { type: 'result' } // trailing — drained
    ]
    const { finalizedOnIndex, drainAttempted, drainedMessage } = simulateResultHandling(
      messages,
      true
    )
    assert.equal(finalizedOnIndex, 1) // First result
    assert.equal(drainAttempted, true)
    assert.deepEqual(drainedMessage, { type: 'result' }) // Trailing result consumed
  })

  test('goal queued but only one result → drain attempted, nothing to drain', () => {
    const messages = [
      { type: 'assistant' },
      { type: 'result' } // finalize here — no trailing
    ]
    const { finalizedOnIndex, drainAttempted, drainedMessage } = simulateResultHandling(
      messages,
      true
    )
    assert.equal(finalizedOnIndex, 1)
    assert.equal(drainAttempted, true)
    assert.equal(drainedMessage, null) // Timer would win
  })

  test('no results at all → finalizedOnIndex is -1', () => {
    const messages = [{ type: 'assistant' }, { type: 'assistant' }]
    const { finalizedOnIndex, drainAttempted } = simulateResultHandling(messages, false)
    assert.equal(finalizedOnIndex, -1)
    assert.equal(drainAttempted, false)
  })

  test('goal queued, non-result trailing message is still drained', () => {
    const messages = [
      { type: 'result' },
      { type: 'assistant' } // unexpected trailing — would be discarded with warning
    ]
    const { finalizedOnIndex, drainAttempted, drainedMessage } = simulateResultHandling(
      messages,
      true
    )
    assert.equal(finalizedOnIndex, 0)
    assert.equal(drainAttempted, true)
    assert.deepEqual(drainedMessage, { type: 'assistant' })
  })
})

// ── buildBuilderGoalCondition ID-cap ──

describe('buildBuilderGoalCondition — ID capping', () => {
  function makePlan(count: number): MpaPlanArtifact {
    return {
      goalType: 'feature',
      summary: 'Test plan',
      items: Array.from({ length: count }, (_, i) => ({
        id: `P${i + 1}`,
        title: `Task ${i + 1}`,
        description: `Description ${i + 1}`,
        files: [`src/file${i + 1}.ts`],
        scope: 'backend' as const,
        dependsOn: [],
        includesTests: false
      })),
      risks: [],
      existingPatterns: []
    }
  }

  test('3 items → all IDs listed', () => {
    const condition = buildBuilderGoalCondition(makePlan(3))
    assert.ok(condition.includes('P1'))
    assert.ok(condition.includes('P2'))
    assert.ok(condition.includes('P3'))
    assert.ok(!condition.includes('… and'))
  })

  test('40 items → all IDs listed (boundary)', () => {
    const condition = buildBuilderGoalCondition(makePlan(40))
    assert.ok(condition.includes('P1'))
    assert.ok(condition.includes('P40'))
    assert.ok(!condition.includes('… and'))
  })

  test('41 items → first 40 listed + truncation suffix', () => {
    const condition = buildBuilderGoalCondition(makePlan(41))
    assert.ok(condition.includes('P1'))
    assert.ok(condition.includes('P40'))
    assert.ok(condition.includes('… and 1 more'))
    assert.ok(!condition.includes('P41'))
  })

  test('100 items → first 40 listed + "60 more"', () => {
    const condition = buildBuilderGoalCondition(makePlan(100))
    assert.ok(condition.includes('P40'))
    assert.ok(condition.includes('… and 60 more'))
    assert.ok(!condition.includes('P41'))
  })
})

// ── spawnSignatureSatisfies ──

// Regression: --max-turns/--effort/--model are baked into argv at spawn, so a
// turn served over stdin silently inherits them. A maxTurns:1 recovery nudge
// respawned the shared process and capped the whole session at one turn.
describe('spawnSignatureSatisfies — argv-baked flag reuse', () => {
  const desired = { model: 'claude-sonnet-4-6', maxTurns: 200, effort: 'high' }

  test('no live process → cannot be reused', () => {
    assert.equal(spawnSignatureSatisfies(null, desired), false)
  })

  test('exact match → reusable', () => {
    assert.equal(spawnSignatureSatisfies({ ...desired }, desired), true)
  })

  test('maxTurns differs → not reusable', () => {
    assert.equal(spawnSignatureSatisfies({ ...desired, maxTurns: 1 }, desired), false)
  })

  test('effort differs → not reusable', () => {
    assert.equal(spawnSignatureSatisfies({ ...desired, effort: 'low' }, desired), false)
  })

  test('model differs → not reusable', () => {
    assert.equal(spawnSignatureSatisfies({ ...desired, model: 'claude-opus-4-8' }, desired), false)
  })

  // `undefined` means "no constraint" — a caller that legitimately omits a field
  // must not force a spurious respawn (and a full MCP reconnection).
  test('undefined desired fields are ignored even when the live process has a value', () => {
    assert.equal(spawnSignatureSatisfies({ ...desired }, {}), true)
    assert.equal(
      spawnSignatureSatisfies({ ...desired }, { model: 'claude-sonnet-4-6' }),
      true,
      'declaring only the model must not compare maxTurns/effort'
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
