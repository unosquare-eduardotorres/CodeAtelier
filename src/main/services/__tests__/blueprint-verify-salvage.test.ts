/**
 * blueprint-verify-salvage.test.ts
 *
 * BP-VERIFY-GATE-SALVAGE: when the verify agent's verdict cannot be extracted
 * (no fence block, post-hoc extraction null) but the deterministic gates ran
 * and came back green, the phase must complete as 'human_needed' rather than
 * dead-ending on overallStatus='unknown' (live: blueprint 8bb7c4de, 3 attempts,
 * gates green every time).
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { salvageCompletionFromGates } from '../blueprint-verify.service'
import type { BlueprintPhaseCompletion } from '../../../shared/blueprint-types'

const GREEN = { gatesAvailable: true, failed: false }

describe('salvageCompletionFromGates', () => {
  test('no completion + green gates → human_needed completion', () => {
    const salvaged = salvageCompletionFromGates(undefined, GREEN)

    assert.ok(salvaged, 'expected a salvaged completion')
    assert.equal(salvaged.overallStatus, 'human_needed')
    assert.equal(salvaged.phase, 'verify')
    assert.equal(salvaged.status, 'complete')
    assert.deepStrictEqual(salvaged.findings, [])
    assert.equal(salvaged.gateSalvaged, true)
    assert.match(String(salvaged.recommendation), /could not be extracted/)
  })

  test('no completion + failed gates → null (failure path preserved)', () => {
    assert.equal(
      salvageCompletionFromGates(undefined, { gatesAvailable: true, failed: true }),
      null
    )
  })

  test('no completion + gates unavailable → null (no evidence, no salvage)', () => {
    assert.equal(
      salvageCompletionFromGates(undefined, { gatesAvailable: false, failed: false }),
      null
    )
  })

  test('existing verdict is never overridden, even with green gates', () => {
    const completion = {
      phase: 'verify',
      status: 'complete',
      overallStatus: 'gaps_found',
      findings: [{ description: 'real gap' }]
    } as unknown as BlueprintPhaseCompletion

    assert.equal(salvageCompletionFromGates(completion, GREEN), null)
  })

  test("a 'passed' verdict is likewise left alone", () => {
    const completion = {
      phase: 'verify',
      status: 'complete',
      overallStatus: 'passed'
    } as unknown as BlueprintPhaseCompletion

    assert.equal(salvageCompletionFromGates(completion, GREEN), null)
  })

  test('completion parsed but missing overallStatus → salvaged, pre-existing keys preserved', () => {
    const completion = {
      phase: 'verify',
      status: 'complete',
      qualityGates: { fullSuite: 'pass' },
      summary: 'ran the checks'
    } as unknown as BlueprintPhaseCompletion

    const salvaged = salvageCompletionFromGates(completion, GREEN)

    assert.ok(salvaged)
    assert.equal(salvaged.overallStatus, 'human_needed')
    assert.equal(salvaged.summary, 'ran the checks')
    assert.deepStrictEqual(salvaged.qualityGates, { fullSuite: 'pass' })
  })

  test('salvage does not mutate the caller’s completion object', () => {
    const completion = { phase: 'verify', status: 'complete' } as BlueprintPhaseCompletion
    salvageCompletionFromGates(completion, GREEN)

    assert.equal(completion.overallStatus, undefined)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
