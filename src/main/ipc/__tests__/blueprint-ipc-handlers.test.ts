/**
 * Tests for pure-logic functions extracted from blueprint.ipc.ts.
 *
 * Run: tsx src/main/ipc/__tests__/blueprint-ipc-handlers.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summary } from '../../services/__tests__/test-harness'
import {
  VALID_BLUEPRINT_PHASES,
  validateBlueprintPhase,
  selectPhaseToRetry,
  extractGrillDecisions,
  determineApprovalAction
} from '../blueprint-ipc-handlers'
import type { BlueprintPhase } from '../../../shared/blueprint-types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePhase(overrides?: Partial<BlueprintPhase>): BlueprintPhase {
  return {
    id: 'phase-1',
    blueprintId: 'bp-1',
    phase: 'plan',
    status: 'pending',
    conversationId: null,
    artifactsJson: [],
    contextSnapshot: null,
    startedAt: null,
    completedAt: null,
    ...overrides
  }
}

// ── VALID_BLUEPRINT_PHASES ───────────────────────────────────────────────────

describe('VALID_BLUEPRINT_PHASES', () => {
  test('contains all 7 phases in correct order', () => {
    assert.deepEqual(
      [...VALID_BLUEPRINT_PHASES],
      ['specify', 'clarify', 'plan', 'tasks', 'review', 'build', 'verify']
    )
  })
})

// ── validateBlueprintPhase ───────────────────────────────────────────────────

describe('validateBlueprintPhase', () => {
  for (const phase of VALID_BLUEPRINT_PHASES) {
    test(`accepts valid phase: ${phase}`, () => {
      assert.equal(validateBlueprintPhase(phase), phase)
    })
  }

  test('rejects invalid phase', () => {
    assert.equal(validateBlueprintPhase('deploy'), null)
  })

  test('rejects empty string', () => {
    assert.equal(validateBlueprintPhase(''), null)
  })

  test('rejects similar-but-wrong phase name', () => {
    assert.equal(validateBlueprintPhase('Build'), null) // case-sensitive
  })
})

// ── selectPhaseToRetry ───────────────────────────────────────────────────────

describe('selectPhaseToRetry', () => {
  test('selects failed phase first', () => {
    const phases = [
      makePhase({ phase: 'specify', status: 'complete' }),
      makePhase({ phase: 'plan', status: 'failed' }),
      makePhase({ phase: 'build', status: 'active' })
    ]
    assert.equal(selectPhaseToRetry(phases, 'specify'), 'plan')
  })

  test('falls back to active phase when no failed phase', () => {
    const phases = [
      makePhase({ phase: 'specify', status: 'complete' }),
      makePhase({ phase: 'plan', status: 'active' })
    ]
    assert.equal(selectPhaseToRetry(phases, 'specify'), 'plan')
  })

  test('falls back to currentPhase when no failed or active phase', () => {
    const phases = [
      makePhase({ phase: 'specify', status: 'complete' }),
      makePhase({ phase: 'plan', status: 'complete' })
    ]
    assert.equal(selectPhaseToRetry(phases, 'build'), 'build')
  })

  test('returns null when no phases and no currentPhase', () => {
    assert.equal(selectPhaseToRetry([], null), null)
  })

  test('returns null when empty phases and null currentPhase', () => {
    const phases: BlueprintPhase[] = []
    assert.equal(selectPhaseToRetry(phases, null), null)
  })

  test('prefers failed over active when both exist', () => {
    const phases = [
      makePhase({ phase: 'tasks', status: 'active' }),
      makePhase({ phase: 'review', status: 'failed' })
    ]
    assert.equal(selectPhaseToRetry(phases, 'specify'), 'review')
  })
})

// ── extractGrillDecisions ────────────────────────────────────────────────────

describe('extractGrillDecisions', () => {
  test('extracts valid grill decisions', () => {
    const settingsJson = {
      grillDecisions: [
        { header: 'Q1', selectedOption: 'Option A', reason: 'Because' }
      ]
    }
    const result = extractGrillDecisions(settingsJson)
    assert.ok(result)
    assert.equal(result!.length, 1)
    assert.equal(result![0].header, 'Q1')
  })

  test('returns undefined for null settingsJson', () => {
    assert.equal(extractGrillDecisions(null), undefined)
  })

  test('returns undefined for undefined settingsJson', () => {
    assert.equal(extractGrillDecisions(undefined), undefined)
  })

  test('returns undefined when grillDecisions key is missing', () => {
    assert.equal(extractGrillDecisions({ otherKey: 'value' }), undefined)
  })

  test('returns undefined when grillDecisions is not an array', () => {
    assert.equal(extractGrillDecisions({ grillDecisions: 'not an array' }), undefined)
  })

  test('returns empty array when grillDecisions is empty array', () => {
    const result = extractGrillDecisions({ grillDecisions: [] })
    assert.ok(result)
    assert.equal(result!.length, 0)
  })
})

// ── determineApprovalAction ──────────────────────────────────────────────────

describe('determineApprovalAction', () => {
  test('approved returns build action', () => {
    const action = determineApprovalAction(true)
    assert.equal(action.kind, 'build')
  })

  test('rejected returns rewind to plan', () => {
    const action = determineApprovalAction(false)
    assert.equal(action.kind, 'rewind')
    if (action.kind === 'rewind') {
      assert.equal(action.toPhase, 'plan')
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
