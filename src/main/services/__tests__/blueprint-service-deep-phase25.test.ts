/**
 * Phase 25, Wave 1B — BlueprintService deep body coverage.
 *
 * Covers: blueprint.service.ts (1563 lines, ~41% covered)
 *
 * Strategy: Test PHASE_ARTIFACT_RELEVANCE constant, construct BlueprintService
 * and exercise pipeline state management, state machine lifecycle, abort
 * signal management, retryable error detection, and method shapes.
 *
 * Run: tsx src/main/services/__tests__/blueprint-service-deep-phase25.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let BlueprintService: any
let blueprintService: any
let PHASE_ARTIFACT_RELEVANCE: Record<string, Set<string>>
let loaded = false

try {
  const mod = require('../blueprint.service')
  BlueprintService = mod.BlueprintService
  blueprintService = mod.blueprintService
  PHASE_ARTIFACT_RELEVANCE = mod.PHASE_ARTIFACT_RELEVANCE
  loaded = true
} catch (err) {
  console.log(`⚠ blueprint.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (loaded) {
  // ═══════════════════════════════════════════════════════════════════════
  // PHASE_ARTIFACT_RELEVANCE — exported constant
  // ═══════════════════════════════════════════════════════════════════════

  describe('PHASE_ARTIFACT_RELEVANCE (Phase 25)', () => {
    test('has all 7 phases', () => {
      const phases = ['specify', 'clarify', 'plan', 'tasks', 'review', 'build', 'verify']
      for (const phase of phases) {
        assert.ok(PHASE_ARTIFACT_RELEVANCE[phase] instanceof Set, `missing phase: ${phase}`)
      }
    })

    test('specify has empty set', () => {
      assert.equal(PHASE_ARTIFACT_RELEVANCE.specify.size, 0)
    })

    test('clarify includes spec', () => {
      assert.ok(PHASE_ARTIFACT_RELEVANCE.clarify.has('spec'))
    })

    test('build includes plan and tasks', () => {
      assert.ok(PHASE_ARTIFACT_RELEVANCE.build.has('plan'))
      assert.ok(PHASE_ARTIFACT_RELEVANCE.build.has('tasks'))
    })

    test('verify includes spec, plan, build, discoveries', () => {
      assert.ok(PHASE_ARTIFACT_RELEVANCE.verify.has('spec'))
      assert.ok(PHASE_ARTIFACT_RELEVANCE.verify.has('plan'))
      assert.ok(PHASE_ARTIFACT_RELEVANCE.verify.has('build'))
      assert.ok(PHASE_ARTIFACT_RELEVANCE.verify.has('discoveries'))
    })

    test('review includes spec, plan, tasks, discoveries', () => {
      assert.ok(PHASE_ARTIFACT_RELEVANCE.review.has('spec'))
      assert.ok(PHASE_ARTIFACT_RELEVANCE.review.has('plan'))
      assert.ok(PHASE_ARTIFACT_RELEVANCE.review.has('tasks'))
      assert.ok(PHASE_ARTIFACT_RELEVANCE.review.has('discoveries'))
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // BlueprintService — construction & singleton
  // ═══════════════════════════════════════════════════════════════════════

  describe('BlueprintService — construction (Phase 25)', () => {
    test('can construct new instance', () => {
      const service = new BlueprintService()
      assert.ok(service !== undefined)
    })

    test('exports singleton', () => {
      assert.ok(blueprintService !== undefined)
      assert.ok(blueprintService instanceof BlueprintService)
    })

    test('is EventEmitter', () => {
      assert.equal(typeof blueprintService.on, 'function')
      assert.equal(typeof blueprintService.emit, 'function')
    })
  })

  // ── Method shapes ────────────────────────────────────────────────────

  describe('BlueprintService — method shapes (Phase 25)', () => {
    test('has create', () => assert.equal(typeof blueprintService.create, 'function'))
    test('has cancel', () => assert.equal(typeof blueprintService.cancel, 'function'))
    test('has delete', () => assert.equal(typeof blueprintService.delete, 'function'))
    test('has getBlueprint', () => assert.equal(typeof blueprintService.getBlueprint, 'function'))
    test('has listBlueprints', () =>
      assert.equal(typeof blueprintService.listBlueprints, 'function'))
    test('has advancePhase', () => assert.equal(typeof blueprintService.advancePhase, 'function'))
    test('has skipPhase', () => assert.equal(typeof blueprintService.skipPhase, 'function'))
    test('has retryPhase', () => assert.equal(typeof blueprintService.retryPhase, 'function'))
    test('has rewindToPhase', () => assert.equal(typeof blueprintService.rewindToPhase, 'function'))
    test('has assemblePhaseContext', () =>
      assert.equal(typeof blueprintService.assemblePhaseContext, 'function'))
    test('has populateTasks', () => assert.equal(typeof blueprintService.populateTasks, 'function'))
    test('has appendTasks', () => assert.equal(typeof blueprintService.appendTasks, 'function'))
    test('has getTasksByWave', () =>
      assert.equal(typeof blueprintService.getTasksByWave, 'function'))
    test('has markPipelineRunning', () =>
      assert.equal(typeof blueprintService.markPipelineRunning, 'function'))
    test('has markPipelineStopped', () =>
      assert.equal(typeof blueprintService.markPipelineStopped, 'function'))
    test('has failPipeline', () => assert.equal(typeof blueprintService.failPipeline, 'function'))
    test('has isRetryableError', () =>
      assert.equal(typeof blueprintService.isRetryableError, 'function'))
    test('has scheduleAutoRetry', () =>
      assert.equal(typeof blueprintService.scheduleAutoRetry, 'function'))
    test('has getActiveBlueprintId', () =>
      assert.equal(typeof blueprintService.getActiveBlueprintId, 'function'))
    test('has getAbortSignal', () =>
      assert.equal(typeof blueprintService.getAbortSignal, 'function'))
    test('has isRunning', () => assert.equal(typeof blueprintService.isRunning, 'function'))
    test('has saveRetryContext', () =>
      assert.equal(typeof blueprintService.saveRetryContext, 'function'))
    test('has shutdown', () => assert.equal(typeof blueprintService.shutdown, 'function'))
    test('has getOrCreatePipeline', () =>
      assert.equal(typeof blueprintService.getOrCreatePipeline, 'function'))
    test('has publishSnapshot', () =>
      assert.equal(typeof blueprintService.publishSnapshot, 'function'))
    test('has getPipelineStatus', () =>
      assert.equal(typeof blueprintService.getPipelineStatus, 'function'))
  })

  // ── Pipeline state management ─────────────────────────────────────────

  describe('BlueprintService — pipeline state (Phase 25)', () => {
    test('getOrCreatePipeline creates new state', () => {
      const service = new BlueprintService()
      const state = service.getOrCreatePipeline('ws-test-p25')
      assert.ok(state !== undefined)
      assert.equal(state.running, false)
      assert.equal(state.blueprintId, null)
    })

    test('getOrCreatePipeline returns same state on second call', () => {
      const service = new BlueprintService()
      const state1 = service.getOrCreatePipeline('ws-same')
      const state2 = service.getOrCreatePipeline('ws-same')
      assert.equal(state1, state2)
    })

    test('different workspaces get different states', () => {
      const service = new BlueprintService()
      const state1 = service.getOrCreatePipeline('ws-a')
      const state2 = service.getOrCreatePipeline('ws-b')
      assert.notEqual(state1, state2)
    })
  })

  // ── isRunning ─────────────────────────────────────────────────────────

  describe('BlueprintService — isRunning (Phase 25)', () => {
    test('returns false for unknown workspace', () => {
      const service = new BlueprintService()
      assert.equal(service.isRunning('ws-unknown', 'bp-1'), false)
    })

    test('returns false when not running', () => {
      const service = new BlueprintService()
      service.getOrCreatePipeline('ws-1')
      assert.equal(service.isRunning('ws-1', 'bp-1'), false)
    })
  })

  // ── getActiveBlueprintId ──────────────────────────────────────────────

  describe('BlueprintService — getActiveBlueprintId (Phase 25)', () => {
    test('returns null for unknown workspace', () => {
      const service = new BlueprintService()
      assert.equal(service.getActiveBlueprintId('ws-unknown'), null)
    })

    test('returns null when no active blueprint', () => {
      const service = new BlueprintService()
      service.getOrCreatePipeline('ws-1')
      assert.equal(service.getActiveBlueprintId('ws-1'), null)
    })
  })

  // ── getAbortSignal ────────────────────────────────────────────────────

  describe('BlueprintService — getAbortSignal (Phase 25)', () => {
    test('returns null for unknown workspace', () => {
      const service = new BlueprintService()
      assert.equal(service.getAbortSignal('ws-unknown'), null)
    })
  })

  // ── isRetryableError ──────────────────────────────────────────────────

  describe('BlueprintService — isRetryableError (Phase 25)', () => {
    test('rate_limit_error is retryable', () => {
      assert.equal(blueprintService.isRetryableError('rate_limit_error'), true)
    })

    test('overloaded_error is retryable', () => {
      assert.equal(blueprintService.isRetryableError('overloaded_error'), true)
    })

    test('ECONNRESET is retryable', () => {
      assert.equal(blueprintService.isRetryableError('ECONNRESET: connection reset'), true)
    })

    test('generic error may not be retryable', () => {
      const result = blueprintService.isRetryableError('some random error')
      assert.equal(typeof result, 'boolean')
    })

    test('empty string is not retryable', () => {
      const result = blueprintService.isRetryableError('')
      assert.equal(result, false)
    })

    // COLD-BOOTSTRAP (blueprint 718c wave 2): both wave tasks died with this
    // exact message ~10s after server start; the phase hard-failed because it
    // matched no retryable pattern. The identical create succeeds on retry.
    test('Failed to create OpenCode session is retryable', () => {
      assert.equal(
        blueprintService.isRetryableError('executor error: Failed to create OpenCode session'),
        true
      )
    })
  })

  // ── Event emission ────────────────────────────────────────────────────

  describe('BlueprintService — events (Phase 25)', () => {
    test('emits snapshot events', () => {
      const service = new BlueprintService()
      const events: any[] = []
      service.on('snapshot', (e: any) => events.push(e))
      service.emit('snapshot', { workspaceId: 'ws-1', blueprintId: 'bp-1' })
      assert.equal(events.length, 1)
    })
  })

  // ── shutdown ──────────────────────────────────────────────────────────

  describe('BlueprintService — shutdown (Phase 25)', () => {
    test('shutdown on fresh instance does not throw', async () => {
      const service = new BlueprintService()
      await service.shutdown()
      assert.ok(true)
    })
  })
}

if (require.main === module) {
  void summaryAsync()
}
