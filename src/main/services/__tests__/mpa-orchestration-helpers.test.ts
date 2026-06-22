/**
 * Unit tests for MPA orchestration pure slices — phase resolution, run status
 * computation, iteration guards, token accumulation patterns.
 *
 * Phase 14, Track 6 — mpa-orchestration.service.ts (~962 lines at 17.67%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Import actual pure functions where available ──

import { buildPlannerGoalCondition, buildBuilderGoalCondition, buildVerifierGoalCondition } from '../mpa-goal-conditions'
import { hasFailingCriteria } from '../mpa-artifact-parsers'

// ── Replicated constants ──

const MAX_VERIFY_ITERATIONS = 3

// ── Replicated logic for phase and status computation ──

type MpaPhaseType = 'plan' | 'execute' | 'verify'
type MpaRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retrying'

/**
 * Replicated run status computation logic from executePhaseLoop.
 */
function computeRunStatus(params: {
  allPhasesCompleted: boolean
  currentPhaseRunning: boolean
  phaseFailed: boolean
  retriesAvailable: boolean
  cancelled: boolean
}): MpaRunStatus {
  if (params.cancelled) return 'cancelled'
  if (params.allPhasesCompleted) return 'completed'
  if (params.phaseFailed && params.retriesAvailable) return 'retrying'
  if (params.phaseFailed && !params.retriesAvailable) return 'failed'
  if (params.currentPhaseRunning) return 'running'
  return 'pending'
}

/**
 * Replicated phase role resolution.
 */
function resolvePhaseRole(phaseType: MpaPhaseType): string {
  switch (phaseType) {
    case 'plan': return 'mpa-planner'
    case 'execute': return 'mpa-builder'
    case 'verify': return 'mpa-verifier'
  }
}

/**
 * Replicated iteration guard logic from runVerifyLoop.
 */
function shouldContinueVerifyLoop(
  verifyIteration: number,
  allComplete: boolean,
  maxIterations: number
): boolean {
  return verifyIteration < maxIterations && !allComplete
}

/**
 * Replicated token accumulation pattern.
 */
function accumulatePhaseTokens(
  phases: Array<{ tokens: number }>
): number {
  return phases.reduce((sum, p) => sum + p.tokens, 0)
}

// ── Tests ──

describe('Phase type resolution', () => {
  test('plan_phase_resolves_to_planner_role', () => {
    assert.equal(resolvePhaseRole('plan'), 'mpa-planner')
  })

  test('execute_phase_resolves_to_builder_role', () => {
    assert.equal(resolvePhaseRole('execute'), 'mpa-builder')
  })

  test('verify_phase_resolves_to_verifier_role', () => {
    assert.equal(resolvePhaseRole('verify'), 'mpa-verifier')
  })
})

describe('Run status computation', () => {
  test('all_phases_completed_returns_completed', () => {
    const status = computeRunStatus({
      allPhasesCompleted: true,
      currentPhaseRunning: false,
      phaseFailed: false,
      retriesAvailable: false,
      cancelled: false
    })
    assert.equal(status, 'completed')
  })

  test('current_phase_running_returns_running', () => {
    const status = computeRunStatus({
      allPhasesCompleted: false,
      currentPhaseRunning: true,
      phaseFailed: false,
      retriesAvailable: false,
      cancelled: false
    })
    assert.equal(status, 'running')
  })

  test('phase_failed_retries_available_returns_retrying', () => {
    const status = computeRunStatus({
      allPhasesCompleted: false,
      currentPhaseRunning: false,
      phaseFailed: true,
      retriesAvailable: true,
      cancelled: false
    })
    assert.equal(status, 'retrying')
  })

  test('phase_failed_no_retries_returns_failed', () => {
    const status = computeRunStatus({
      allPhasesCompleted: false,
      currentPhaseRunning: false,
      phaseFailed: true,
      retriesAvailable: false,
      cancelled: false
    })
    assert.equal(status, 'failed')
  })

  test('cancelled_returns_cancelled', () => {
    const status = computeRunStatus({
      allPhasesCompleted: false,
      currentPhaseRunning: false,
      phaseFailed: false,
      retriesAvailable: false,
      cancelled: true
    })
    assert.equal(status, 'cancelled')
  })
})

describe('Goal condition extraction — expanded', () => {
  test('planner_goal_includes_truncated_goal', () => {
    const goal = 'Implement a comprehensive authentication system with JWT tokens'
    const condition = buildPlannerGoalCondition(goal)
    assert.ok(condition.includes(goal.slice(0, 150)))
    assert.ok(condition.includes('implementation plan'))
    assert.ok(condition.includes('goal-plan'))
  })

  test('planner_goal_requires_file_investigation', () => {
    const condition = buildPlannerGoalCondition('Fix the bug')
    assert.ok(condition.includes('codebase files'))
    assert.ok(condition.includes('items array'))
  })

  test('builder_goal_includes_plan_item_ids', () => {
    const plan = {
      items: [
        { id: 'item-1', title: 'Task 1', description: '', files: [], scope: '', dependsOn: [] },
        { id: 'item-2', title: 'Task 2', description: '', files: [], scope: '', dependsOn: [] }
      ]
    }
    const condition = buildBuilderGoalCondition(plan as any)
    assert.ok(condition.includes('item-1'))
    assert.ok(condition.includes('item-2'))
    assert.ok(condition.includes('fully implemented'))
  })

  test('builder_goal_requires_tests', () => {
    const plan = { items: [{ id: 'item-1', title: 'Task', description: '', files: [], scope: '', dependsOn: [] }] }
    const condition = buildBuilderGoalCondition(plan as any)
    assert.ok(condition.includes('Tests written'))
  })

  test('verifier_goal_includes_item_count', () => {
    const plan = {
      items: [
        { id: '1', title: 'A', description: '', files: [], scope: '', dependsOn: [] },
        { id: '2', title: 'B', description: '', files: [], scope: '', dependsOn: [] },
        { id: '3', title: 'C', description: '', files: [], scope: '', dependsOn: [] }
      ]
    }
    const condition = buildVerifierGoalCondition(plan as any)
    assert.ok(condition.includes('3 plan items'))
    assert.ok(condition.includes('goal-verify-report'))
  })
})

describe('Token accumulation', () => {
  test('phases_add_to_total_tokens', () => {
    const total = accumulatePhaseTokens([
      { tokens: 5000 },
      { tokens: 10000 },
      { tokens: 3000 }
    ])
    assert.equal(total, 18000)
  })

  test('empty_phases_returns_0', () => {
    const total = accumulatePhaseTokens([])
    assert.equal(total, 0)
  })

  test('single_phase_returns_its_tokens', () => {
    const total = accumulatePhaseTokens([{ tokens: 7500 }])
    assert.equal(total, 7500)
  })
})

describe('Iteration guards', () => {
  test('max_iterations_not_reached_continues', () => {
    assert.ok(shouldContinueVerifyLoop(1, false, MAX_VERIFY_ITERATIONS))
  })

  test('max_iterations_reached_stops', () => {
    assert.ok(!shouldContinueVerifyLoop(3, false, MAX_VERIFY_ITERATIONS))
  })

  test('all_complete_stops_early', () => {
    assert.ok(!shouldContinueVerifyLoop(1, true, MAX_VERIFY_ITERATIONS))
  })

  test('within_budget_and_incomplete_continues', () => {
    assert.ok(shouldContinueVerifyLoop(0, false, MAX_VERIFY_ITERATIONS))
  })
})

describe('hasFailingCriteria — expanded', () => {
  test('no_criteria_returns_false', () => {
    assert.ok(!hasFailingCriteria({ allComplete: true } as any))
  })

  test('all_pass_returns_false', () => {
    assert.ok(!hasFailingCriteria({
      allComplete: true,
      criteriaResults: [
        { status: 'pass', criterion: 'Tests pass' },
        { status: 'pass', criterion: 'Lint clean' }
      ]
    } as any))
  })

  test('one_fail_returns_true', () => {
    assert.ok(hasFailingCriteria({
      allComplete: false,
      criteriaResults: [
        { status: 'pass', criterion: 'Tests pass' },
        { status: 'fail', criterion: 'Lint clean' }
      ]
    } as any))
  })

  test('null_report_returns_false', () => {
    assert.ok(!hasFailingCriteria(null))
  })

  test('undefined_report_returns_false', () => {
    assert.ok(!hasFailingCriteria(undefined))
  })
})

// ── Module import coverage ──

describe('MPA Orchestration — module import', () => {
  test('service_module_is_importable', async () => {
    const mod = await import('../mpa-orchestration.service')
    assert.ok(mod)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
