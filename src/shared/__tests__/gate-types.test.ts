/**
 * Unit tests for the gate verdict algebra.
 *
 * The invariant these guard is the one the whole quality stack rests on:
 * `unverifiable` is not a soft `fail`. A gate that could not run must never
 * block the pipeline, and a gate that ran and went red must never be softened
 * into a warning.
 *
 * Run: tsx src/shared/__tests__/gate-types.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'
import {
  aggregateVerdict,
  boundEvidence,
  buildGateReport,
  gatesBlockAdvance,
  ledgerItemsFrom,
  EVIDENCE_MAX_CHARS,
  type GateResult
} from '../gate-types'

function gate(over: Partial<GateResult> & Pick<GateResult, 'name' | 'verdict'>): GateResult {
  return { evidence: [], durationMs: 0, ...over }
}

describe('aggregateVerdict', () => {
  test('all pass → pass', () => {
    assert.equal(
      aggregateVerdict([
        gate({ name: 'lint', verdict: 'pass' }),
        gate({ name: 'build', verdict: 'pass' })
      ]),
      'pass'
    )
  })

  test('any fail wins, even alongside pass and unverifiable', () => {
    assert.equal(
      aggregateVerdict([
        gate({ name: 'lint', verdict: 'pass' }),
        gate({ name: 'build', verdict: 'unverifiable' }),
        gate({ name: 'task-tests', verdict: 'fail' })
      ]),
      'fail'
    )
  })

  test('unverifiable outranks pass but never becomes fail', () => {
    const verdict = aggregateVerdict([
      gate({ name: 'write-set', verdict: 'pass' }),
      gate({ name: 'build', verdict: 'unverifiable', reason: 'no_command' })
    ])
    assert.equal(verdict, 'unverifiable')
    assert.notEqual(verdict, 'fail')
  })

  test('an all-unverifiable run is unverifiable, not fail', () => {
    assert.equal(
      aggregateVerdict([
        gate({ name: 'build', verdict: 'unverifiable', reason: 'no_command' }),
        gate({ name: 'task-tests', verdict: 'unverifiable', reason: 'no_packet' })
      ]),
      'unverifiable'
    )
  })

  test('an empty gate list is unverifiable — nothing was checked, so nothing passed', () => {
    assert.equal(aggregateVerdict([]), 'unverifiable')
  })
})

describe('gatesBlockAdvance', () => {
  test('only fail blocks advancement', () => {
    assert.equal(
      gatesBlockAdvance(buildGateReport([gate({ name: 'lint', verdict: 'fail' })])),
      true
    )
    assert.equal(
      gatesBlockAdvance(
        buildGateReport([gate({ name: 'lint', verdict: 'unverifiable', reason: 'no_command' })])
      ),
      false
    )
    assert.equal(
      gatesBlockAdvance(buildGateReport([gate({ name: 'lint', verdict: 'pass' })])),
      false
    )
  })

  test('a missing report does not block', () => {
    assert.equal(gatesBlockAdvance(null), false)
    assert.equal(gatesBlockAdvance(undefined), false)
  })
})

describe('boundEvidence', () => {
  test('short evidence is returned untouched', () => {
    const lines = ['src/a.ts changed', 'src/b.ts changed']
    assert.deepEqual(boundEvidence(lines), lines)
  })

  test('a 50K compiler log is capped under the serialized budget', () => {
    const lines = Array.from(
      { length: 500 },
      (_, i) => `error TS2345 at line ${i}: ${'x'.repeat(90)}`
    )
    const bounded = boundEvidence(lines)
    assert.ok(
      JSON.stringify(bounded).length <= EVIDENCE_MAX_CHARS,
      `serialized length ${JSON.stringify(bounded).length} exceeds ${EVIDENCE_MAX_CHARS}`
    )
    assert.equal(bounded[bounded.length - 1], '…truncated')
  })

  test('the front of the evidence is kept — the first lines name the problem', () => {
    const lines = ['THE ACTUAL ERROR', ...Array.from({ length: 400 }, () => 'y'.repeat(80))]
    const bounded = boundEvidence(lines)
    assert.equal(bounded[0], 'THE ACTUAL ERROR')
  })

  test('a single oversized line is hard-truncated rather than dropped entirely', () => {
    const bounded = boundEvidence(['z'.repeat(10_000)])
    assert.ok(JSON.stringify(bounded).length <= EVIDENCE_MAX_CHARS)
    assert.equal(bounded.length, 2)
    assert.ok(bounded[0].startsWith('zzz'), 'the line survives in truncated form')
    assert.equal(bounded[1], '…truncated')
  })

  test('an empty list stays empty (no spurious truncation marker)', () => {
    assert.deepEqual(boundEvidence([]), [])
  })
})

describe('buildGateReport / ledgerItemsFrom', () => {
  test('overall is computed, not supplied', () => {
    const report = buildGateReport(
      [gate({ name: 'lint', verdict: 'pass' }), gate({ name: 'build', verdict: 'fail' })],
      { startedAt: '2026-01-01T00:00:00.000Z' }
    )
    assert.equal(report.overall, 'fail')
    assert.equal(report.startedAt, '2026-01-01T00:00:00.000Z')
  })

  test('only unverifiable gates become ledger items', () => {
    const report = buildGateReport([
      gate({ name: 'lint', verdict: 'pass' }),
      gate({
        name: 'build',
        verdict: 'unverifiable',
        reason: 'no_command',
        evidence: ['no build script']
      }),
      gate({ name: 'task-tests', verdict: 'fail', evidence: ['1 failing'] })
    ])
    const items = ledgerItemsFrom(report, 'T003', '2026-01-01T00:00:00.000Z')
    assert.equal(items.length, 1)
    assert.deepEqual(items[0], {
      taskId: 'T003',
      gate: 'build',
      reason: 'no_command',
      detail: 'no build script',
      at: '2026-01-01T00:00:00.000Z'
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
