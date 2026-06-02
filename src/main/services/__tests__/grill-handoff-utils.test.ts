/**
 * Unit tests for deriveGrillDecisions — the renderer-side helper that maps
 * grill decisions for the MPA handoff.
 *
 * Pure logic — no DOM, no React, no Electron deps — so we can run it
 * directly from the main-process test harness.
 *
 * Coverage:
 *  - Prefers live session decisions (maps questionFull → reason).
 *  - Falls back to the persisted plan, flattening multiple tracks.
 *  - Empty plan + empty session → [].
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { deriveGrillDecisions } from '../../../renderer/src/components/workspace/grill/handoff-utils'
import type { GrillStructuredPlan, DecisionEntry } from '../../../shared/types'

function makePlan(decisions: GrillStructuredPlan['decisions']): GrillStructuredPlan {
  return {
    version: 1,
    title: 'T',
    summary: 'S',
    goalType: 'feature',
    decisions,
    items: [],
    risks: [],
    constraints: [],
    originalDescription: '',
    requirementDocument: ''
  }
}

describe('deriveGrillDecisions', () => {
  test('prefers session decisions when present (maps questionFull → reason)', () => {
    const sessionDecisions: DecisionEntry[] = [
      { iteration: 1, question: 'Q1', answer: 'A1', questionFull: 'Full Q1' },
      { iteration: 2, question: 'Q2', answer: 'A2' }
    ]
    const plan = makePlan([
      {
        trackId: 't',
        trackName: 'Track',
        score: 90,
        items: [{ question: 'PQ', answer: 'PA', rationale: 'PR' }]
      }
    ])

    const result = deriveGrillDecisions(plan, sessionDecisions)
    assert.deepEqual(result, [
      { header: 'Q1', selectedOption: 'A1', reason: 'Full Q1' },
      { header: 'Q2', selectedOption: 'A2', reason: '' }
    ])
  })

  test('falls back to plan decisions, flattening multiple tracks', () => {
    const plan = makePlan([
      {
        trackId: 't1',
        trackName: 'Track 1',
        score: 80,
        items: [
          { question: 'Q1', answer: 'A1', rationale: 'R1' },
          { question: 'Q2', answer: 'A2', rationale: 'R2' }
        ]
      },
      {
        trackId: 't2',
        trackName: 'Track 2',
        score: 70,
        items: [{ question: 'Q3', answer: 'A3', rationale: 'R3' }]
      }
    ])

    const result = deriveGrillDecisions(plan, [])
    assert.deepEqual(result, [
      { header: 'Q1', selectedOption: 'A1', reason: 'R1' },
      { header: 'Q2', selectedOption: 'A2', reason: 'R2' },
      { header: 'Q3', selectedOption: 'A3', reason: 'R3' }
    ])
  })

  test('empty plan + empty session → []', () => {
    const result = deriveGrillDecisions(makePlan([]), [])
    assert.deepEqual(result, [])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
