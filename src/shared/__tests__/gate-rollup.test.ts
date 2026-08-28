/**
 * Ledger rollup + outcome mapping tests (M8.4) — `summarizeLedger` and
 * `blueprintOutcome` in src/shared/gate-types.ts.
 *
 * Pure functions; no mocks needed.
 *
 * Run: tsx src/shared/__tests__/gate-rollup.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'

import { summarizeLedger, blueprintOutcome, type UnverifiedItem } from '../gate-types'

// ── summarizeLedger ──

describe('summarizeLedger', () => {
  test('null ledger yields a zeroed summary, never null', () => {
    const s = summarizeLedger(null)
    assert.equal(s.total, 0)
    assert.deepEqual(s.byGate, {})
    assert.deepEqual(s.byReason, {})
    assert.deepEqual(s.byTask, {})
  })

  test('undefined ledger yields a zeroed summary', () => {
    const s = summarizeLedger(undefined)
    assert.equal(s.total, 0)
  })

  test('empty ledger yields a zeroed summary', () => {
    const s = summarizeLedger([])
    assert.equal(s.total, 0)
    assert.deepEqual(s.byGate, {})
  })

  test('mixed gates/reasons/tasks counted correctly', () => {
    const items: UnverifiedItem[] = [
      { taskId: 'T001', gate: 'write-set', reason: 'no_packet' },
      { taskId: 'T001', gate: 'task-tests', reason: 'no_command' },
      { taskId: 'T002', gate: 'task-tests', reason: 'no_command' },
      { taskId: 'W1', gate: 'smoke', reason: 'no_command' },
      { taskId: 'verify', gate: 'structural', reason: 'analysis_unavailable' }
    ]
    const s = summarizeLedger(items)
    assert.equal(s.total, 5)
    assert.deepEqual(s.byGate, {
      'write-set': 1,
      'task-tests': 2,
      smoke: 1,
      structural: 1
    })
    assert.deepEqual(s.byReason, {
      no_packet: 1,
      no_command: 3,
      analysis_unavailable: 1
    })
    assert.deepEqual(s.byTask, { T001: 2, T002: 1, W1: 1, verify: 1 })
  })

  test('null entries inside the array are skipped', () => {
    const items = [
      { taskId: 'T001', gate: 'smoke' as const, reason: 'no_command' as const },
      null as unknown as UnverifiedItem
    ]
    const s = summarizeLedger(items)
    assert.equal(s.total, 1)
  })
})

// ── blueprintOutcome ──

describe('blueprintOutcome', () => {
  test('complete + empty ledger yields complete', () => {
    assert.equal(blueprintOutcome({ status: 'complete', unverifiedJson: [] }), 'complete')
  })

  test('complete + null ledger yields complete', () => {
    assert.equal(blueprintOutcome({ status: 'complete', unverifiedJson: null }), 'complete')
  })

  test('complete + missing ledger yields complete', () => {
    assert.equal(blueprintOutcome({ status: 'complete' }), 'complete')
  })

  test('complete + non-empty ledger yields complete-unproven', () => {
    assert.equal(
      blueprintOutcome({
        status: 'complete',
        unverifiedJson: [{ taskId: 'verify', gate: 'smoke', reason: 'no_command' }]
      }),
      'complete-unproven'
    )
  })

  test('building yields incomplete regardless of ledger', () => {
    assert.equal(
      blueprintOutcome({
        status: 'building',
        unverifiedJson: [{ taskId: 'T001', gate: 'smoke', reason: 'no_command' }]
      }),
      'incomplete'
    )
  })

  test('failed yields incomplete', () => {
    assert.equal(blueprintOutcome({ status: 'failed', unverifiedJson: [] }), 'incomplete')
  })

  test('cancelled yields incomplete', () => {
    assert.equal(blueprintOutcome({ status: 'cancelled' }), 'incomplete')
  })

  test('agrees with isCompletedWithWarnings semantics on the same inputs', () => {
    // isCompletedWithWarnings(bp) = status==='complete' && ledger non-empty.
    // blueprintOutcome must agree on exactly that population.
    const cases: Array<{ status: string; ledger: UnverifiedItem[] | null }> = [
      { status: 'complete', ledger: null },
      { status: 'complete', ledger: [] },
      { status: 'complete', ledger: [{ taskId: 'x', gate: 'smoke', reason: 'no_command' }] },
      { status: 'failed', ledger: [{ taskId: 'x', gate: 'smoke', reason: 'no_command' }] }
    ]
    for (const c of cases) {
      const withWarnings = c.status === 'complete' && (c.ledger?.length ?? 0) > 0
      const outcome = blueprintOutcome({ status: c.status, unverifiedJson: c.ledger })
      assert.equal(
        outcome === 'complete-unproven',
        withWarnings,
        `outcome=${outcome} must agree with isCompletedWithWarnings=${withWarnings}`
      )
    }
  })
})

summaryAsync()
