/**
 * Tests for pure-logic functions extracted from mpa.ipc.ts.
 *
 * Run: tsx src/main/ipc/__tests__/mpa-ipc-handlers.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summary } from '../../services/__tests__/test-harness'
import { computeMpaStatus, MPA_IDLE_STATUS, validateCampaignGoals } from '../mpa-ipc-handlers'
import type { MpaRun, MpaPhase } from '../../../shared/mpa-types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRun(overrides?: Partial<MpaRun>): MpaRun {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    conversationId: null,
    grillSessionId: null,
    title: 'Test Run',
    goal: 'Implement feature X',
    goalType: 'feature',
    status: 'running',
    currentPhase: 'plan',
    configJson: {},
    createdAt: '2025-06-01T12:00:00.000Z',
    completedAt: null,
    totalTokens: 0,
    campaignId: null,
    orderIndex: null,
    blueprintId: null,
    blueprintPhaseId: null,
    ...overrides
  }
}

function makePhase(overrides?: Partial<MpaPhase>): MpaPhase {
  return {
    id: 'phase-1',
    runId: 'run-1',
    phaseType: 'plan',
    iteration: 1,
    status: 'pending',
    agentRole: 'planner',
    goalCondition: null,
    inputArtifactId: null,
    outputArtifactId: null,
    startedAt: null,
    completedAt: null,
    tokensUsed: 0,
    streamContent: '',
    ...overrides
  }
}

// ── MPA_IDLE_STATUS ──────────────────────────────────────────────────────────

describe('MPA_IDLE_STATUS', () => {
  test('is the expected idle sentinel', () => {
    assert.equal(MPA_IDLE_STATUS.status, 'idle')
    assert.equal(MPA_IDLE_STATUS.runId, null)
    assert.equal(MPA_IDLE_STATUS.currentPhase, null)
    assert.equal(MPA_IDLE_STATUS.phaseIndex, 0)
    assert.equal(MPA_IDLE_STATUS.totalPhases, 0)
    assert.equal(MPA_IDLE_STATUS.iteration, 0)
    assert.equal(MPA_IDLE_STATUS.awaitingApproval, false)
  })
})

// ── computeMpaStatus ─────────────────────────────────────────────────────────

describe('computeMpaStatus', () => {
  test('returns running status with active plan phase', () => {
    const run = makeRun({ status: 'running', currentPhase: 'plan' })
    const phases = [
      makePhase({ id: 'p1', phaseType: 'plan', status: 'running', iteration: 1 }),
      makePhase({ id: 'p2', phaseType: 'execute', status: 'pending' }),
      makePhase({ id: 'p3', phaseType: 'verify', status: 'pending' })
    ]
    const status = computeMpaStatus(run, 'run-1', phases)
    assert.equal(status.status, 'running')
    assert.equal(status.runId, 'run-1')
    assert.equal(status.currentPhase, 'plan')
    assert.equal(status.phaseIndex, 1)
    assert.equal(status.totalPhases, 3)
    assert.equal(status.iteration, 1)
    assert.equal(status.awaitingApproval, false)
  })

  test('returns execute phase at correct index', () => {
    const run = makeRun({ status: 'running' })
    const phases = [
      makePhase({ id: 'p1', phaseType: 'plan', status: 'completed' }),
      makePhase({ id: 'p2', phaseType: 'execute', status: 'running', iteration: 1 }),
      makePhase({ id: 'p3', phaseType: 'verify', status: 'pending' })
    ]
    const status = computeMpaStatus(run, 'run-1', phases)
    assert.equal(status.currentPhase, 'execute')
    assert.equal(status.phaseIndex, 2)
    assert.equal(status.totalPhases, 3)
  })

  test('uses run.currentPhase when no phase is running', () => {
    const run = makeRun({ status: 'running', currentPhase: 'verify' })
    const phases = [
      makePhase({ phaseType: 'plan', status: 'completed' }),
      makePhase({ phaseType: 'execute', status: 'completed' }),
      makePhase({ phaseType: 'verify', status: 'completed' })
    ]
    const status = computeMpaStatus(run, 'run-1', phases)
    assert.equal(status.currentPhase, 'verify')
    assert.equal(status.phaseIndex, 3) // phases.length since no running found
  })

  test('paused run indicates awaitingApproval', () => {
    const run = makeRun({ status: 'paused' })
    const phases = [makePhase({ phaseType: 'plan', status: 'completed' })]
    const status = computeMpaStatus(run, 'run-1', phases)
    assert.equal(status.status, 'paused')
    assert.equal(status.awaitingApproval, true)
  })

  test('no phases defaults totalPhases to 3', () => {
    const run = makeRun({ status: 'running' })
    const status = computeMpaStatus(run, 'run-1', [])
    assert.equal(status.totalPhases, 3)
    assert.equal(status.phaseIndex, 0)
  })

  test('completed run returns completed status', () => {
    const run = makeRun({ status: 'completed' })
    const phases = [
      makePhase({ phaseType: 'plan', status: 'completed' }),
      makePhase({ phaseType: 'execute', status: 'completed' }),
      makePhase({ phaseType: 'verify', status: 'completed' })
    ]
    const status = computeMpaStatus(run, 'run-1', phases)
    assert.equal(status.status, 'completed')
    assert.equal(status.awaitingApproval, false)
    assert.equal(status.phaseIndex, 3)
  })

  test('null run returns running fallback', () => {
    const status = computeMpaStatus(null, 'run-1', [])
    assert.equal(status.status, 'running')
    assert.equal(status.runId, 'run-1')
    assert.equal(status.currentPhase, null)
    assert.equal(status.phaseIndex, 0)
    assert.equal(status.totalPhases, 0)
    assert.equal(status.iteration, 1)
    assert.equal(status.awaitingApproval, false)
  })

  test('iteration is picked from running phase', () => {
    const run = makeRun({ status: 'running' })
    const phases = [
      makePhase({ phaseType: 'plan', status: 'completed', iteration: 1 }),
      makePhase({ phaseType: 'execute', status: 'running', iteration: 3 })
    ]
    const status = computeMpaStatus(run, 'run-1', phases)
    assert.equal(status.iteration, 3)
  })

  test('iteration defaults to 1 when no running phase', () => {
    const run = makeRun({ status: 'running' })
    const phases = [makePhase({ phaseType: 'plan', status: 'completed', iteration: 2 })]
    const status = computeMpaStatus(run, 'run-1', phases)
    assert.equal(status.iteration, 1)
  })

  test('null currentPhase in run with no running phases yields null', () => {
    const run = makeRun({ status: 'running', currentPhase: null })
    const phases = [makePhase({ phaseType: 'plan', status: 'completed' })]
    const status = computeMpaStatus(run, 'run-1', phases)
    assert.equal(status.currentPhase, null)
  })
})

// ── validateCampaignGoals ────────────────────────────────────────────────────

describe('validateCampaignGoals', () => {
  test('accepts non-empty goals array', () => {
    const result = validateCampaignGoals([{ title: 'Goal 1' }])
    assert.equal(result.valid, true)
    assert.equal(result.error, undefined)
  })

  test('rejects empty array', () => {
    const result = validateCampaignGoals([])
    assert.equal(result.valid, false)
    assert.ok(result.error?.includes('goal'))
  })

  test('rejects null', () => {
    const result = validateCampaignGoals(null)
    assert.equal(result.valid, false)
  })

  test('rejects undefined', () => {
    const result = validateCampaignGoals(undefined)
    assert.equal(result.valid, false)
  })

  test('rejects non-array (string)', () => {
    const result = validateCampaignGoals('not an array')
    assert.equal(result.valid, false)
  })

  test('rejects non-array (object)', () => {
    const result = validateCampaignGoals({ goals: [] })
    assert.equal(result.valid, false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
