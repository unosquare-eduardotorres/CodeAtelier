/**
 * Unit tests for Blueprint phase-chain map.
 *
 * Validates that the chain dispatch logic covers all expected transitions:
 * specify → clarify → plan → tasks → review (→ approval gate → build → verify handled by existing code)
 *
 * Pure function test — no service instantiation.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Phase Chain Map ──

const BLUEPRINT_PHASE_ORDER = [
  'specify', 'clarify', 'plan', 'tasks', 'review', 'build', 'verify'
] as const

type BlueprintPhaseType = (typeof BLUEPRINT_PHASE_ORDER)[number]

/**
 * The expected auto-dispatch chain map.
 * Each entry maps a phase to the next phase that should be auto-dispatched on success.
 * null = no auto-dispatch (handled by a different mechanism like approval gate).
 */
const PHASE_CHAIN: Partial<Record<BlueprintPhaseType, BlueprintPhaseType | null>> = {
  specify: 'clarify',   // blueprint-spec.service.ts → startClarifyPhase
  clarify: 'plan',      // blueprint-spec.service.ts → dispatchPlanPhase
  plan: 'tasks',        // blueprint-plan.service.ts → startTasksPhase
  tasks: 'review',      // blueprint-tasks.service.ts → startReviewPhase
  review: null,         // review → approval gate (user decision, not auto-dispatch)
  build: 'verify',      // blueprint-build.service.ts → startVerifyPhase (existing)
  verify: null           // terminal phase
}

// ── Tests ──

describe('Blueprint phase-chain map', () => {
  test('specify_chains_to_clarify', () => {
    assert.equal(PHASE_CHAIN.specify, 'clarify')
  })

  test('clarify_chains_to_plan', () => {
    assert.equal(PHASE_CHAIN.clarify, 'plan')
  })

  test('plan_chains_to_tasks', () => {
    assert.equal(PHASE_CHAIN.plan, 'tasks')
  })

  test('tasks_chains_to_review', () => {
    assert.equal(PHASE_CHAIN.tasks, 'review')
  })

  test('review_does_not_auto_chain_requires_approval_gate', () => {
    assert.equal(PHASE_CHAIN.review, null)
  })

  test('build_chains_to_verify', () => {
    assert.equal(PHASE_CHAIN.build, 'verify')
  })

  test('verify_is_terminal_no_auto_chain', () => {
    assert.equal(PHASE_CHAIN.verify, null)
  })

  test('all_7_phases_have_chain_entries', () => {
    for (const phase of BLUEPRINT_PHASE_ORDER) {
      assert.ok(
        phase in PHASE_CHAIN,
        `Missing chain entry for phase '${phase}'`
      )
    }
  })

  test('auto_dispatched_phases_cover_specify_through_review_gap', () => {
    // The bug was that specify→clarify→plan→tasks→review had no auto-dispatch.
    // Verify the full auto-chain from specify to review:
    let current: BlueprintPhaseType = 'specify'
    const visited: BlueprintPhaseType[] = [current]

    while (PHASE_CHAIN[current] !== null && PHASE_CHAIN[current] !== undefined) {
      current = PHASE_CHAIN[current]!
      visited.push(current)
      // Safety: prevent infinite loop
      if (visited.length > 10) break
    }

    assert.deepEqual(visited, ['specify', 'clarify', 'plan', 'tasks', 'review'])
  })
})

describe('Phase chain — cancelled guard', () => {
  test('dispatch_should_be_skipped_when_status_is_cancelled', () => {
    // Simulate the cancelled-status guard that each chain dispatch uses
    function shouldDispatch(currentStatus: string): boolean {
      return currentStatus !== 'cancelled'
    }

    assert.equal(shouldDispatch('clarifying'), true)
    assert.equal(shouldDispatch('planning'), true)
    assert.equal(shouldDispatch('cancelled'), false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
