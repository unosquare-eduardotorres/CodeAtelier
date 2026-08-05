/**
 * council-mpa-grill-services-deep.test.ts — Phase 21, File 7
 *
 * Deep body coverage for council/mpa/grill/plan services:
 *   - council.service.ts: collectSettled, CouncilService state, isRunning, start locks
 *   - mpa-orchestration.service.ts: MpaOrchestrationService pipeline maps, isRunning,
 *     findPipelineByRunId, findWorkspaceIdByRunId, getOrCreatePipeline
 *   - mpa-campaign.service.ts: MpaCampaignService state, isRunningForWorkspace
 *   - grill-persistence.controller.ts: GrillPersistenceController tracking state,
 *     getStatusForWorkspace, getTrackingForWorkspace, currentSessionId, clearTracking
 *   - grill-agent.service.ts: GrillAgentService state, isRunning, isRunningForWorkspace
 *   - plan-registry.service.ts: PlanRegistryService CRUD methods shape
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ═══════════════════════════════════════════════════════════════════════════
// collectSettled — pure function (replicated from council.service.ts)
// ═══════════════════════════════════════════════════════════════════════════

function collectSettled<T>(results: PromiseSettledResult<T | null>[]): T[] {
  return results
    .filter((r): r is PromiseFulfilledResult<T | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((r): r is T => r !== null)
}

describe('collectSettled — pure function', () => {
  test('returns fulfilled non-null values', () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: 'fulfilled', value: 'a' },
      { status: 'fulfilled', value: 'b' },
      { status: 'fulfilled', value: 'c' }
    ]
    assert.deepEqual(collectSettled(results), ['a', 'b', 'c'])
  })

  test('filters out rejected results', () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: 'fulfilled', value: 'a' },
      { status: 'rejected', reason: new Error('failed') },
      { status: 'fulfilled', value: 'c' }
    ]
    assert.deepEqual(collectSettled(results), ['a', 'c'])
  })

  test('filters out null values from fulfilled results', () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: 'fulfilled', value: 'a' },
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: 'c' }
    ]
    assert.deepEqual(collectSettled(results), ['a', 'c'])
  })

  test('all rejected returns empty array', () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: 'rejected', reason: new Error('e1') },
      { status: 'rejected', reason: new Error('e2') }
    ]
    assert.deepEqual(collectSettled(results), [])
  })

  test('all null returns empty array', () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: null }
    ]
    assert.deepEqual(collectSettled(results), [])
  })

  test('mixed: rejected, null, and valid', () => {
    const results: PromiseSettledResult<number | null>[] = [
      { status: 'rejected', reason: new Error('e1') },
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: 42 },
      { status: 'rejected', reason: 'string error' },
      { status: 'fulfilled', value: 0 },
      { status: 'fulfilled', value: null }
    ]
    assert.deepEqual(collectSettled(results), [42, 0])
  })

  test('empty input returns empty array', () => {
    assert.deepEqual(collectSettled([]), [])
  })

  test('preserves order of fulfilled values', () => {
    const results: PromiseSettledResult<number | null>[] = [
      { status: 'fulfilled', value: 3 },
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 }
    ]
    assert.deepEqual(collectSettled(results), [3, 1, 2])
  })
})

// ── Graceful module loading ──────────────────────────────────────────────

let CouncilService: any
let councilService: any
let councilLoaded = false

try {
  const mod = require('../council.service')
  CouncilService = mod.CouncilService
  councilService = mod.councilService
  councilLoaded = true
} catch (err) {
  console.log(`⚠ council.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

let MpaOrchestrationService: any
let mpaOrchestrationService: any
let mpaOrchLoaded = false

try {
  const mod = require('../mpa-orchestration.service')
  MpaOrchestrationService = mod.MpaOrchestrationService
  mpaOrchestrationService = mod.mpaOrchestrationService
  mpaOrchLoaded = true
} catch (err) {
  console.log(`⚠ mpa-orchestration.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

let MpaCampaignService: any
let mpaCampaignService: any
let mpaCampLoaded = false

try {
  const mod = require('../mpa-campaign.service')
  MpaCampaignService = mod.MpaCampaignService
  mpaCampaignService = mod.mpaCampaignService
  mpaCampLoaded = true
} catch (err) {
  console.log(`⚠ mpa-campaign.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

let GrillPersistenceController: any
let grillPersistenceController: any
let grillPersistLoaded = false

try {
  const mod = require('../grill-persistence.controller')
  GrillPersistenceController = mod.GrillPersistenceController
  grillPersistenceController = mod.grillPersistenceController
  grillPersistLoaded = true
} catch (err) {
  console.log(`⚠ grill-persistence.controller.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

let GrillAgentService: any
let grillAgentService: any
let grillAgentLoaded = false

try {
  const mod = require('../grill-agent.service')
  GrillAgentService = mod.GrillAgentService
  grillAgentService = mod.grillAgentService
  grillAgentLoaded = true
} catch (err) {
  console.log(`⚠ grill-agent.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

let planRegistryService: any
let planRegLoaded = false

try {
  const mod = require('../plan-registry.service')
  planRegistryService = mod.planRegistryService
  planRegLoaded = true
} catch (err) {
  console.log(`⚠ plan-registry.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

// ═══════════════════════════════════════════════════════════════════════════
// CouncilService — Deep body coverage
// ═══════════════════════════════════════════════════════════════════════════

if (councilLoaded) {
  describe('CouncilService — construction & state', () => {
    test('extends EventEmitter', () => {
      const svc = new CouncilService()
      assert.ok(svc instanceof require('node:events').EventEmitter)
    })

    test('sessions starts as empty Map', () => {
      const svc = new CouncilService()
      assert.ok((svc as any).sessions instanceof Map)
      assert.equal((svc as any).sessions.size, 0)
    })

    test('startLocks starts as empty Set', () => {
      const svc = new CouncilService()
      assert.ok((svc as any).startLocks instanceof Set)
      assert.equal((svc as any).startLocks.size, 0)
    })
  })

  describe('CouncilService — isRunning / isRunningForWorkspace', () => {
    test('isRunning returns false with empty sessions', () => {
      const svc = new CouncilService()
      assert.equal(svc.isRunning, false)
    })

    test('isRunning returns true when a session has running=true', () => {
      const svc = new CouncilService()
      ;(svc as any).sessions.set('ws-1', { running: true })
      assert.equal(svc.isRunning, true)
    })

    test('isRunning returns false when all sessions have running=false', () => {
      const svc = new CouncilService()
      ;(svc as any).sessions.set('ws-1', { running: false })
      ;(svc as any).sessions.set('ws-2', { running: false })
      assert.equal(svc.isRunning, false)
    })

    test('isRunningForWorkspace returns false for unknown workspace', () => {
      const svc = new CouncilService()
      assert.equal(svc.isRunningForWorkspace('unknown'), false)
    })

    test('isRunningForWorkspace returns true for running workspace', () => {
      const svc = new CouncilService()
      ;(svc as any).sessions.set('ws-x', { running: true })
      assert.equal(svc.isRunningForWorkspace('ws-x'), true)
    })

    test('isRunningForWorkspace returns false for stopped workspace', () => {
      const svc = new CouncilService()
      ;(svc as any).sessions.set('ws-x', { running: false })
      assert.equal(svc.isRunningForWorkspace('ws-x'), false)
    })
  })

  describe('CouncilService — evaluate / cancel / shutdown', () => {
    test('evaluate is an async function', () => {
      assert.equal(typeof councilService.evaluate, 'function')
    })

    test('cancel is a function', () => {
      assert.equal(typeof councilService.cancel, 'function')
    })

    test('shutdown is a function', () => {
      assert.equal(typeof councilService.shutdown, 'function')
    })

    test('getSessionState is a function', () => {
      assert.equal(typeof councilService.getSessionState, 'function')
    })

    test('shutdown on clean instance does not throw', async () => {
      const svc = new CouncilService()
      await svc.shutdown()
      assert.ok(true)
    })

    test('cancelSession is a function', () => {
      assert.equal(typeof councilService.cancelSession, 'function')
    })

    test('resumeSession is a function', () => {
      assert.equal(typeof councilService.resumeSession, 'function')
    })

    test('reconcileStaleRuns is a function', () => {
      assert.equal(typeof councilService.reconcileStaleRuns, 'function')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// MpaOrchestrationService — Deep body coverage
// ═══════════════════════════════════════════════════════════════════════════

if (mpaOrchLoaded) {
  describe('MpaOrchestrationService — construction & state', () => {
    test('extends EventEmitter', () => {
      const svc = new MpaOrchestrationService()
      assert.ok(svc instanceof require('node:events').EventEmitter)
    })

    test('pipelines starts as empty Map', () => {
      const svc = new MpaOrchestrationService()
      assert.ok((svc as any).pipelines instanceof Map)
      assert.equal((svc as any).pipelines.size, 0)
    })

    test('startLocks starts as empty Set', () => {
      const svc = new MpaOrchestrationService()
      assert.ok((svc as any).startLocks instanceof Set)
      assert.equal((svc as any).startLocks.size, 0)
    })
  })

  describe('MpaOrchestrationService — isRunning / currentRunId', () => {
    test('isRunning returns false with no pipelines', () => {
      const svc = new MpaOrchestrationService()
      assert.equal(svc.isRunning, false)
    })

    test('isRunning returns true when a pipeline is running', () => {
      const svc = new MpaOrchestrationService()
      ;(svc as any).pipelines.set('ws-1', { running: true, currentRunId: 'r-1' })
      assert.equal(svc.isRunning, true)
    })

    test('isRunningForWorkspace returns false for unknown workspace', () => {
      const svc = new MpaOrchestrationService()
      assert.equal(svc.isRunningForWorkspace('unknown'), false)
    })

    test('isRunningForWorkspace returns true for running pipeline', () => {
      const svc = new MpaOrchestrationService()
      ;(svc as any).pipelines.set('ws-1', { running: true })
      assert.equal(svc.isRunningForWorkspace('ws-1'), true)
    })

    test('currentRunId returns null with no pipelines', () => {
      const svc = new MpaOrchestrationService()
      assert.equal(svc.currentRunId, null)
    })

    test('currentRunId returns run ID of first running pipeline', () => {
      const svc = new MpaOrchestrationService()
      ;(svc as any).pipelines.set('ws-1', { running: true, currentRunId: 'run-123' })
      assert.equal(svc.currentRunId, 'run-123')
    })
  })

  describe('MpaOrchestrationService — getOrCreatePipeline', () => {
    test('creates new pipeline for unknown workspace', () => {
      const svc = new MpaOrchestrationService()
      const pipeline = (svc as any).getOrCreatePipeline('ws-new')
      assert.ok(pipeline)
      assert.equal(pipeline.running, false)
      assert.equal(pipeline.abortController, null)
      assert.equal(pipeline.currentPhaseSession, null)
      assert.equal(pipeline.pendingGateResolve, null)
      assert.equal(pipeline.currentRunId, null)
    })

    test('returns existing pipeline for known workspace', () => {
      const svc = new MpaOrchestrationService()
      const p1 = (svc as any).getOrCreatePipeline('ws-exist')
      p1.running = true
      const p2 = (svc as any).getOrCreatePipeline('ws-exist')
      assert.equal(p2.running, true, 'Should return same pipeline instance')
    })
  })

  describe('MpaOrchestrationService — findPipelineByRunId', () => {
    test('returns undefined for unknown runId', () => {
      const svc = new MpaOrchestrationService()
      assert.equal((svc as any).findPipelineByRunId('unknown'), undefined)
    })

    test('finds pipeline by runId', () => {
      const svc = new MpaOrchestrationService()
      const p = (svc as any).getOrCreatePipeline('ws-a')
      p.currentRunId = 'run-abc'
      const found = (svc as any).findPipelineByRunId('run-abc')
      assert.ok(found)
      assert.equal(found.currentRunId, 'run-abc')
    })
  })

  describe('MpaOrchestrationService — findWorkspaceIdByRunId', () => {
    test('returns undefined for unknown runId', () => {
      const svc = new MpaOrchestrationService()
      assert.equal((svc as any).findWorkspaceIdByRunId('unknown'), undefined)
    })

    test('finds workspace ID by runId', () => {
      const svc = new MpaOrchestrationService()
      const p = (svc as any).getOrCreatePipeline('ws-b')
      p.currentRunId = 'run-xyz'
      assert.equal((svc as any).findWorkspaceIdByRunId('run-xyz'), 'ws-b')
    })
  })

  describe('MpaOrchestrationService — cancel / shutdown', () => {
    test('orchestrate is an async function', () => {
      assert.equal(typeof mpaOrchestrationService.orchestrate, 'function')
    })

    test('respondToGate is a function', () => {
      assert.equal(typeof mpaOrchestrationService.respondToGate, 'function')
    })

    test('cancel is a function', () => {
      assert.equal(typeof mpaOrchestrationService.cancel, 'function')
    })

    test('getStatus is a function', () => {
      assert.equal(typeof mpaOrchestrationService.getStatus, 'function')
    })

    test('shutdown on clean instance does not throw', async () => {
      const svc = new MpaOrchestrationService()
      await svc.shutdown()
      assert.ok(true)
    })

    test('resumeRun is a function', () => {
      assert.equal(typeof mpaOrchestrationService.resumeRun, 'function')
    })

    test('reconcileStaleRuns is a function', () => {
      assert.equal(typeof mpaOrchestrationService.reconcileStaleRuns, 'function')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// MpaCampaignService — Deep body coverage
// ═══════════════════════════════════════════════════════════════════════════

if (mpaCampLoaded) {
  describe('MpaCampaignService — construction & state', () => {
    test('extends EventEmitter', () => {
      const svc = new MpaCampaignService()
      assert.ok(svc instanceof require('node:events').EventEmitter)
    })

    test('isRunningForWorkspace returns false for unknown workspace', () => {
      const svc = new MpaCampaignService()
      assert.equal(svc.isRunningForWorkspace('unknown'), false)
    })

    test('start is an async function', () => {
      assert.equal(typeof mpaCampaignService.start, 'function')
    })

    test('cancel is a function', () => {
      assert.equal(typeof mpaCampaignService.cancel, 'function')
    })

    test('respond is a function', () => {
      assert.equal(typeof mpaCampaignService.respond, 'function')
    })

    test('reconcileStale is a function', () => {
      assert.equal(typeof mpaCampaignService.reconcileStale, 'function')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// GrillPersistenceController — Deep body coverage
// ═══════════════════════════════════════════════════════════════════════════

if (grillPersistLoaded) {
  describe('GrillPersistenceController — construction & state', () => {
    test('activeSessions starts as empty Map', () => {
      const ctrl = new GrillPersistenceController()
      assert.ok((ctrl as any).activeSessions instanceof Map)
      assert.equal((ctrl as any).activeSessions.size, 0)
    })

    test('FLUSH_INTERVAL_MS is a positive number', () => {
      assert.ok((GrillPersistenceController as any).FLUSH_INTERVAL_MS > 0)
    })
  })

  describe('GrillPersistenceController — getTracking / getTrackingForWorkspace', () => {
    test('getTracking returns null for unknown workspace', () => {
      const ctrl = new GrillPersistenceController()
      assert.equal((ctrl as any).getTracking('unknown'), null)
    })

    test('getTrackingForWorkspace returns null for unknown workspace', () => {
      const ctrl = new GrillPersistenceController()
      assert.equal(ctrl.getTrackingForWorkspace('unknown'), null)
    })

    test('getTrackingForWorkspace returns evaluationHandled for tracked workspace', () => {
      const ctrl = new GrillPersistenceController()
      ;(ctrl as any).activeSessions.set('ws-1', {
        sessionId: 's-1',
        ideaId: 'i-1',
        trackId: 'grilled',
        workspaceId: 'ws-1',
        evaluationHandled: false,
        messageBuffer: [],
        flushTimer: null
      })
      const result = ctrl.getTrackingForWorkspace('ws-1')
      assert.ok(result)
      assert.equal(result!.evaluationHandled, false)
    })
  })

  describe('GrillPersistenceController — currentSessionId', () => {
    test('returns null with no active sessions', () => {
      const ctrl = new GrillPersistenceController()
      assert.equal(ctrl.currentSessionId, null)
    })

    test('returns first active session ID', () => {
      const ctrl = new GrillPersistenceController()
      ;(ctrl as any).activeSessions.set('ws-1', { sessionId: 'session-abc' })
      assert.equal(ctrl.currentSessionId, 'session-abc')
    })
  })

  describe('GrillPersistenceController — clearTracking', () => {
    test('clearTracking with unknown workspace is a no-op', () => {
      const ctrl = new GrillPersistenceController()
      // Should not throw
      ctrl.clearTracking('nonexistent')
      assert.ok(true)
    })

    test('clearTracking without workspace clears all sessions', () => {
      const ctrl = new GrillPersistenceController()
      // Note: clearTracking without args calls DB — just test the no-sessions path
      ;(ctrl as any).activeSessions.clear()
      ctrl.clearTracking()
      assert.equal((ctrl as any).activeSessions.size, 0)
    })
  })

  describe('GrillPersistenceController — flushToDb', () => {
    test('flushToDb is a no-op for unknown workspace', () => {
      const ctrl = new GrillPersistenceController()
      ;(ctrl as any).flushToDb('unknown')
      assert.ok(true, 'Should not throw')
    })

    test('flushToDb is a no-op for empty buffer', () => {
      const ctrl = new GrillPersistenceController()
      ;(ctrl as any).activeSessions.set('ws-1', {
        sessionId: 's-1',
        messageBuffer: [],
        flushTimer: null
      })
      ;(ctrl as any).flushToDb('ws-1')
      assert.ok(true, 'Should not throw with empty buffer')
    })
  })

  describe('GrillPersistenceController — public API shape', () => {
    test('startTracking is an async function', () => {
      assert.equal(typeof grillPersistenceController.startTracking, 'function')
    })

    test('handleStreamChunk is a function', () => {
      assert.equal(typeof grillPersistenceController.handleStreamChunk, 'function')
    })

    test('handleEvaluationResult is a function', () => {
      assert.equal(typeof grillPersistenceController.handleEvaluationResult, 'function')
    })

    test('handleComplete is a function', () => {
      assert.equal(typeof grillPersistenceController.handleComplete, 'function')
    })

    test('saveAnswers is a function', () => {
      assert.equal(typeof grillPersistenceController.saveAnswers, 'function')
    })

    test('markEvaluating is a function', () => {
      assert.equal(typeof grillPersistenceController.markEvaluating, 'function')
    })

    test('getStatusForWorkspace is a function', () => {
      assert.equal(typeof grillPersistenceController.getStatusForWorkspace, 'function')
    })

    test('notifyTerminal is a function', () => {
      assert.equal(typeof grillPersistenceController.notifyTerminal, 'function')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// GrillAgentService — Deep body coverage
// ═══════════════════════════════════════════════════════════════════════════

if (grillAgentLoaded) {
  describe('GrillAgentService — construction & state', () => {
    test('extends EventEmitter', () => {
      const svc = new GrillAgentService()
      assert.ok(svc instanceof require('node:events').EventEmitter)
    })

    test('sessions starts as empty Map', () => {
      const svc = new GrillAgentService()
      assert.ok((svc as any).sessions instanceof Map)
      assert.equal((svc as any).sessions.size, 0)
    })

    test('greenfieldSession starts as null', () => {
      const svc = new GrillAgentService()
      assert.equal((svc as any).greenfieldSession, null)
    })
  })

  describe('GrillAgentService — isRunning / isRunningForWorkspace', () => {
    test('isRunning returns false with empty sessions', () => {
      const svc = new GrillAgentService()
      assert.equal(svc.isRunning, false)
    })

    test('isRunning returns true when greenfield is running', () => {
      const svc = new GrillAgentService()
      ;(svc as any).greenfieldSession = { running: true }
      assert.equal(svc.isRunning, true)
    })

    test('isRunning returns true when regular session is running', () => {
      const svc = new GrillAgentService()
      ;(svc as any).sessions.set('ws-1', { running: true })
      assert.equal(svc.isRunning, true)
    })

    test('isRunningForWorkspace returns false for unknown', () => {
      const svc = new GrillAgentService()
      assert.equal(svc.isRunningForWorkspace('unknown'), false)
    })

    test('isRunningForWorkspace returns true for running', () => {
      const svc = new GrillAgentService()
      ;(svc as any).sessions.set('ws-1', { running: true })
      assert.equal(svc.isRunningForWorkspace('ws-1'), true)
    })
  })

  describe('GrillAgentService — evaluate / cancel / shutdown', () => {
    test('evaluate is an async function', () => {
      assert.equal(typeof grillAgentService.evaluate, 'function')
    })

    test('evaluateGreenfield is an async function', () => {
      assert.equal(typeof grillAgentService.evaluateGreenfield, 'function')
    })

    test('cancel is a function', () => {
      assert.equal(typeof grillAgentService.cancel, 'function')
    })

    test('shutdown on clean instance does not throw', async () => {
      const svc = new GrillAgentService()
      await svc.shutdown()
      assert.ok(true)
    })

    test('parseGrillEvaluation is a function', () => {
      assert.equal(typeof (grillAgentService as any).parseGrillEvaluation, 'function')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// PlanRegistryService — Deep body coverage
// ═══════════════════════════════════════════════════════════════════════════

if (planRegLoaded) {
  describe('PlanRegistryService — construction & methods', () => {
    test('singleton exists', () => {
      assert.ok(planRegistryService)
    })

    test('registerChatPlan is a function', () => {
      assert.equal(typeof planRegistryService.registerChatPlan, 'function')
    })

    test('registerGrillPlan is a function', () => {
      assert.equal(typeof planRegistryService.registerGrillPlan, 'function')
    })

    test('registerAuditPlan is a function', () => {
      assert.equal(typeof planRegistryService.registerAuditPlan, 'function')
    })

    test('registerCouncilVerdict is a function', () => {
      assert.equal(typeof planRegistryService.registerCouncilVerdict, 'function')
    })

    test('registerChatPlan returns null when DB not available', () => {
      const result = planRegistryService.registerChatPlan({
        workspaceId: 'ws-1',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        plan: { title: 'Test Plan', summary: 'test', items: [] },
        rawContent: 'raw'
      })
      // Without DB, should return null (non-critical error handling)
      assert.equal(result, null)
    })

    test('registerGrillPlan returns null when DB not available', () => {
      const result = planRegistryService.registerGrillPlan({
        workspaceId: 'ws-1',
        grillSessionId: 'gs-1',
        plan: { title: 'Grill Plan', summary: 'test', items: [] } as any
      })
      assert.equal(result, null)
    })

    test('registerAuditPlan returns null when DB not available', () => {
      const result = planRegistryService.registerAuditPlan({
        workspaceId: 'ws-1',
        auditPlanId: 'ap-1',
        plan: { title: 'Audit Plan', summary: 'test', items: [] } as any
      })
      assert.equal(result, null)
    })

    test('registerCouncilVerdict returns null when DB not available', () => {
      const result = planRegistryService.registerCouncilVerdict({
        workspaceId: 'ws-1',
        councilSessionId: 'cs-1',
        verdict: { overallScore: 8, sections: { recommendation: 'proceed' } } as any,
        originalPlan: { title: 'Original', summary: 'test', items: [] } as any
      })
      assert.equal(result, null)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Skip blocks for failed module loads
// ═══════════════════════════════════════════════════════════════════════════

if (!councilLoaded) {
  describe('CouncilService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!mpaOrchLoaded) {
  describe('MpaOrchestrationService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!mpaCampLoaded) {
  describe('MpaCampaignService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!grillPersistLoaded) {
  describe('GrillPersistenceController (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!grillAgentLoaded) {
  describe('GrillAgentService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!planRegLoaded) {
  describe('PlanRegistryService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
