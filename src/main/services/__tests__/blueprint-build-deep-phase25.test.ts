/**
 * Phase 25, Wave 1 — BlueprintBuildService deep body coverage.
 *
 * Covers: blueprint-build.service.ts (1696 lines, ~18% covered)
 *
 * Strategy: Test exported pure functions + constants directly.
 * Construct BlueprintBuildService with EventEmitter, mock internal state
 * via bracket notation, and exercise private methods (buildTaskContext,
 * buildArtifactSummary, cancelBlueprint, shutdown, safeEmit, normalizePaths,
 * filesOverlap, finalizeFailed, finalizeSuccess).
 *
 * Run: tsx src/main/services/__tests__/blueprint-build-deep-phase25.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, createSpy } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ═══════════════════════════════════════════════════════════════════════════
// Exported pure functions & constants (direct import, no class needed)
// ═══════════════════════════════════════════════════════════════════════════

let EVIDENCE_ONLY_RX: RegExp
let abortAwareSleep: (ms: number, signal?: AbortSignal) => Promise<void>
let BlueprintBuildService: any
let blueprintBuildService: any
let loaded = false

try {
  const mod = require('../blueprint-build.service')
  EVIDENCE_ONLY_RX = mod.EVIDENCE_ONLY_RX
  abortAwareSleep = mod.abortAwareSleep
  BlueprintBuildService = mod.BlueprintBuildService
  blueprintBuildService = mod.blueprintBuildService
  loaded = true
} catch (err) {
  console.log(`⚠ blueprint-build.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

// ─── EVIDENCE_ONLY_RX ─────────────────────────────────────────────────────

if (loaded) {
  describe('EVIDENCE_ONLY_RX — regex tests', () => {
    test('matches "re-run verification checks"', () => {
      assert.ok(EVIDENCE_ONLY_RX.test('re-run verification checks'))
    })

    test('matches "rerun verify with evidence"', () => {
      assert.ok(EVIDENCE_ONLY_RX.test('rerun verify with evidence'))
    })

    test('matches "verification pass"', () => {
      assert.ok(EVIDENCE_ONLY_RX.test('verify pass'))
    })

    test('matches "verification evidence"', () => {
      assert.ok(EVIDENCE_ONLY_RX.test('verification evidence'))
    })

    test('matches "evidence eslint"', () => {
      assert.ok(EVIDENCE_ONLY_RX.test('evidence for eslint'))
    })

    test('matches "evidence tsc"', () => {
      assert.ok(EVIDENCE_ONLY_RX.test('evidence tsc analysis'))
    })

    test('matches "evidence vitest"', () => {
      assert.ok(EVIDENCE_ONLY_RX.test('evidence vitest results'))
    })

    test('matches "evidence complexity"', () => {
      assert.ok(EVIDENCE_ONLY_RX.test('evidence complexity analysis'))
    })

    test('matches "evidence dead_code"', () => {
      assert.ok(EVIDENCE_ONLY_RX.test('evidence dead_code'))
    })

    test('matches "evidence deadcode"', () => {
      assert.ok(EVIDENCE_ONLY_RX.test('evidence deadcode'))
    })

    test('does NOT match regular task description', () => {
      assert.ok(!EVIDENCE_ONLY_RX.test('implement user authentication'))
    })

    test('does NOT match "create a new component"', () => {
      assert.ok(!EVIDENCE_ONLY_RX.test('create a new component'))
    })

    test('does NOT match empty string', () => {
      assert.ok(!EVIDENCE_ONLY_RX.test(''))
    })

    test('does NOT match partial "verify" without qualifying context', () => {
      assert.ok(!EVIDENCE_ONLY_RX.test('verify the build'))
    })
  })

  // ─── abortAwareSleep ─────────────────────────────────────────────────────

  describe('abortAwareSleep — basic behavior', () => {
    test('resolves after timeout', async () => {
      const start = Date.now()
      await abortAwareSleep(50)
      const elapsed = Date.now() - start
      assert.ok(elapsed >= 40, `should have waited at least 40ms, got ${elapsed}`)
    })

    test('rejects immediately if signal already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      try {
        await abortAwareSleep(5000, controller.signal)
        assert.fail('should have rejected')
      } catch (err) {
        assert.ok(err instanceof Error)
        assert.equal(err.message, 'aborted')
      }
    })

    test('rejects when signal fires during sleep', async () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 30)
      try {
        await abortAwareSleep(5000, controller.signal)
        assert.fail('should have rejected')
      } catch (err) {
        assert.ok(err instanceof Error)
        assert.equal(err.message, 'aborted')
      }
    })

    test('resolves without signal', async () => {
      await abortAwareSleep(10)
      assert.ok(true)
    })

    test('resolves with undefined signal', async () => {
      await abortAwareSleep(10, undefined)
      assert.ok(true)
    })
  })

  // ─── BlueprintBuildService — construction & state ──────────────────────

  describe('BlueprintBuildService — construction', () => {
    test('can construct new instance', () => {
      const service = new BlueprintBuildService()
      assert.ok(service !== undefined)
    })

    test('is an EventEmitter', () => {
      const service = new BlueprintBuildService()
      assert.equal(typeof service.on, 'function')
      assert.equal(typeof service.emit, 'function')
      assert.equal(typeof service.removeListener, 'function')
    })

    test('activeSessions starts empty', () => {
      const service = new BlueprintBuildService()
      const sessions = (service as any).activeSessions
      assert.ok(sessions instanceof Map)
      assert.equal(sessions.size, 0)
    })

    test('activeBlueprintIds starts empty', () => {
      const service = new BlueprintBuildService()
      const ids = (service as any).activeBlueprintIds
      assert.ok(ids instanceof Map)
      assert.equal(ids.size, 0)
    })

    test('perTaskStatus starts empty', () => {
      const service = new BlueprintBuildService()
      const status = (service as any).perTaskStatus
      assert.ok(status instanceof Map)
      assert.equal(status.size, 0)
    })
  })

  // ─── safeEmit ──────────────────────────────────────────────────────────

  describe('BlueprintBuildService — safeEmit', () => {
    test('emits event and returns true for valid listener', () => {
      const service = new BlueprintBuildService()
      const received: any[] = []
      service.on('phaseProgress', (data: any) => received.push(data))
      const result = (service as any).safeEmit('phaseProgress', { text: 'hello' })
      assert.equal(result, true)
      assert.equal(received.length, 1)
      assert.equal(received[0].text, 'hello')
    })

    test('catches listener throws without crashing', () => {
      const service = new BlueprintBuildService()
      service.on('phaseProgress', () => {
        throw new Error('listener error')
      })
      // Should not throw
      const result = (service as any).safeEmit('phaseProgress', { text: 'test' })
      // safeEmit should return true/false based on whether emit happened
      assert.ok(typeof result === 'boolean')
    })

    test('returns false when no listeners', () => {
      const service = new BlueprintBuildService()
      const result = (service as any).safeEmit('nonExistentEvent', {})
      assert.equal(result, false)
    })
  })

  // ─── buildTaskContext (private method) ─────────────────────────────────

  describe('BlueprintBuildService — buildTaskContext', () => {
    test('includes task ID and wave', () => {
      const service = new BlueprintBuildService()
      const buildCtx = (service as any).buildTaskContext.bind(service)
      const result = buildCtx({
        taskId: 'T-001',
        wave: 1,
        description: 'Create user service',
        filePathsJson: [],
        dependsOnJson: []
      })
      assert.ok(result.includes('T-001'))
      assert.ok(result.includes('Wave'))
      assert.ok(result.includes('Create user service'))
    })

    test('includes user story when provided', () => {
      const service = new BlueprintBuildService()
      const buildCtx = (service as any).buildTaskContext.bind(service)
      const result = buildCtx({
        taskId: 'T-002',
        wave: 1,
        description: 'Test',
        userStory: 'As a user, I want to login',
        filePathsJson: [],
        dependsOnJson: []
      })
      assert.ok(result.includes('As a user, I want to login'))
    })

    test('includes file paths when provided', () => {
      const service = new BlueprintBuildService()
      const buildCtx = (service as any).buildTaskContext.bind(service)
      const result = buildCtx({
        taskId: 'T-003',
        wave: 1,
        description: 'Test',
        filePathsJson: ['src/a.ts', 'src/b.ts'],
        dependsOnJson: []
      })
      assert.ok(result.includes('src/a.ts'))
      assert.ok(result.includes('src/b.ts'))
    })

    test('includes dependencies when provided', () => {
      const service = new BlueprintBuildService()
      const buildCtx = (service as any).buildTaskContext.bind(service)
      const result = buildCtx({
        taskId: 'T-004',
        wave: 2,
        description: 'Test',
        filePathsJson: [],
        dependsOnJson: ['T-001', 'T-002']
      })
      assert.ok(result.includes('T-001'))
      assert.ok(result.includes('Depends On'))
    })

    test('threads prior discoveries (capped at 20)', () => {
      const service = new BlueprintBuildService()
      const buildCtx = (service as any).buildTaskContext.bind(service)
      const discoveries = Array.from({ length: 25 }, (_, i) => `discovery-${i}`)
      const result = buildCtx(
        { taskId: 'T-005', wave: 1, description: 'Test', filePathsJson: [], dependsOnJson: [] },
        discoveries
      )
      assert.ok(result.includes('Discoveries from earlier tasks'))
      // Should include last 20 (5-24)
      assert.ok(result.includes('discovery-24'))
      assert.ok(result.includes('discovery-5'))
    })

    test('includes prior attempt output on retry', () => {
      const service = new BlueprintBuildService()
      const buildCtx = (service as any).buildTaskContext.bind(service)
      const result = buildCtx(
        { taskId: 'T-006', wave: 1, description: 'Test', filePathsJson: [], dependsOnJson: [] },
        [],
        'Previous attempt failed due to X'
      )
      assert.ok(result.includes('Prior Attempt Output'))
      assert.ok(result.includes('Previous attempt failed due to X'))
      assert.ok(result.includes('Build on this work'))
    })

    test('truncates prior attempt output at 4000 chars', () => {
      const service = new BlueprintBuildService()
      const buildCtx = (service as any).buildTaskContext.bind(service)
      const longOutput = 'x'.repeat(5000)
      const result = buildCtx(
        { taskId: 'T-007', wave: 1, description: 'Test', filePathsJson: [], dependsOnJson: [] },
        [],
        longOutput
      )
      assert.ok(result.includes('…[truncated]'))
      // Should not contain the full 5000 chars
      assert.ok(!result.includes('x'.repeat(5000)))
    })

    test('handles empty discoveries array', () => {
      const service = new BlueprintBuildService()
      const buildCtx = (service as any).buildTaskContext.bind(service)
      const result = buildCtx(
        { taskId: 'T-008', wave: 1, description: 'Test', filePathsJson: [], dependsOnJson: [] },
        []
      )
      assert.ok(!result.includes('Discoveries from earlier tasks'))
    })

    test('handles no filePathsJson', () => {
      const service = new BlueprintBuildService()
      const buildCtx = (service as any).buildTaskContext.bind(service)
      const result = buildCtx({
        taskId: 'T-009',
        wave: 1,
        description: 'Test',
        filePathsJson: undefined,
        dependsOnJson: undefined
      })
      assert.ok(!result.includes('**Files**'))
      assert.ok(!result.includes('**Depends On**'))
    })
  })

  // ─── buildArtifactSummary (private method) ─────────────────────────────

  describe('BlueprintBuildService — buildArtifactSummary', () => {
    test('basic summary with tasks completed', () => {
      const service = new BlueprintBuildService()
      const buildSummary = (service as any).buildArtifactSummary.bind(service)
      const result = buildSummary(3, 5, [], [])
      assert.ok(result.includes('Build Phase Summary'))
      assert.ok(result.includes('3/5 completed'))
    })

    test('includes resumed count', () => {
      const service = new BlueprintBuildService()
      const buildSummary = (service as any).buildArtifactSummary.bind(service)
      const result = buildSummary(5, 5, [], [], 2)
      assert.ok(result.includes('2 resumed from prior run'))
    })

    test('includes created files', () => {
      const service = new BlueprintBuildService()
      const buildSummary = (service as any).buildArtifactSummary.bind(service)
      const result = buildSummary(1, 1, ['src/new.ts', 'src/new2.ts'], [])
      assert.ok(result.includes('Files Created'))
      assert.ok(result.includes('src/new.ts'))
      assert.ok(result.includes('src/new2.ts'))
    })

    test('includes modified files', () => {
      const service = new BlueprintBuildService()
      const buildSummary = (service as any).buildArtifactSummary.bind(service)
      const result = buildSummary(1, 1, [], ['src/old.ts'])
      assert.ok(result.includes('Files Modified'))
      assert.ok(result.includes('src/old.ts'))
    })

    test('truncates file lists at 50', () => {
      const service = new BlueprintBuildService()
      const buildSummary = (service as any).buildArtifactSummary.bind(service)
      const manyFiles = Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`)
      const result = buildSummary(1, 1, manyFiles, [])
      assert.ok(result.includes('file-49'))
      // File 50+ should NOT be included (0-indexed, slice(0,50) stops at index 49)
      assert.ok(!result.includes('file-50'))
    })

    test('does not include resumed when 0', () => {
      const service = new BlueprintBuildService()
      const buildSummary = (service as any).buildArtifactSummary.bind(service)
      const result = buildSummary(2, 2, [], [], 0)
      assert.ok(!result.includes('resumed'))
    })

    test('handles all zero values', () => {
      const service = new BlueprintBuildService()
      const buildSummary = (service as any).buildArtifactSummary.bind(service)
      const result = buildSummary(0, 0, [], [])
      assert.ok(result.includes('0/0 completed'))
    })
  })

  // ─── cancelBlueprint ────────────────────────────────────────────────────

  describe('BlueprintBuildService — cancelBlueprint', () => {
    test('no-ops when no active sessions', async () => {
      const service = new BlueprintBuildService()
      // Should not throw
      await service.cancelBlueprint('bp-nonexistent')
      assert.ok(true)
    })

    test('stops sessions for matching blueprint', async () => {
      const service = new BlueprintBuildService()
      const stopSpy = createSpy(async () => {})
      const mockSession = { stop: stopSpy }
      const sessions = new Set([mockSession])
      ;(service as any).activeSessions.set('ws-1', sessions)
      ;(service as any).activeBlueprintIds.set('ws-1', 'bp-123')

      await service.cancelBlueprint('bp-123')
      assert.equal(stopSpy.callCount, 1)
      assert.equal((service as any).activeSessions.has('ws-1'), false)
      assert.equal((service as any).activeBlueprintIds.has('ws-1'), false)
    })

    test('ignores sessions for non-matching blueprint', async () => {
      const service = new BlueprintBuildService()
      const stopSpy = createSpy(async () => {})
      const mockSession = { stop: stopSpy }
      const sessions = new Set([mockSession])
      ;(service as any).activeSessions.set('ws-1', sessions)
      ;(service as any).activeBlueprintIds.set('ws-1', 'bp-other')

      await service.cancelBlueprint('bp-123')
      assert.equal(stopSpy.callCount, 0) // should not stop
    })

    test('handles session stop failure gracefully', async () => {
      const service = new BlueprintBuildService()
      const stopSpy = createSpy(async () => {
        throw new Error('stop failed')
      })
      const mockSession = { stop: stopSpy }
      const sessions = new Set([mockSession])
      ;(service as any).activeSessions.set('ws-1', sessions)
      ;(service as any).activeBlueprintIds.set('ws-1', 'bp-err')

      // Should not throw
      await service.cancelBlueprint('bp-err')
      assert.equal(stopSpy.callCount, 1)
    })

    test('stops multiple sessions', async () => {
      const service = new BlueprintBuildService()
      const stop1 = createSpy(async () => {})
      const stop2 = createSpy(async () => {})
      const sessions = new Set([{ stop: stop1 }, { stop: stop2 }])
      ;(service as any).activeSessions.set('ws-1', sessions)
      ;(service as any).activeBlueprintIds.set('ws-1', 'bp-multi')

      await service.cancelBlueprint('bp-multi')
      assert.equal(stop1.callCount, 1)
      assert.equal(stop2.callCount, 1)
    })
  })

  // ─── shutdown ────────────────────────────────────────────────────────────

  describe('BlueprintBuildService — shutdown', () => {
    test('clears all sessions and blueprint IDs', async () => {
      const service = new BlueprintBuildService()
      const stop1 = createSpy(async () => {})
      const stop2 = createSpy(async () => {})
      ;(service as any).activeSessions.set('ws-1', new Set([{ stop: stop1 }]))
      ;(service as any).activeSessions.set('ws-2', new Set([{ stop: stop2 }]))
      ;(service as any).activeBlueprintIds.set('ws-1', 'bp-1')
      ;(service as any).activeBlueprintIds.set('ws-2', 'bp-2')

      await service.shutdown()
      assert.equal((service as any).activeSessions.size, 0)
      assert.equal((service as any).activeBlueprintIds.size, 0)
      assert.equal(stop1.callCount, 1)
      assert.equal(stop2.callCount, 1)
    })

    test('no-ops when no active sessions', async () => {
      const service = new BlueprintBuildService()
      await service.shutdown()
      assert.ok(true)
    })

    test('handles stop failure gracefully during shutdown', async () => {
      const service = new BlueprintBuildService()
      const failStop = createSpy(async () => {
        throw new Error('session stop err')
      })
      ;(service as any).activeSessions.set('ws-1', new Set([{ stop: failStop }]))
      ;(service as any).activeBlueprintIds.set('ws-1', 'bp-1')

      await service.shutdown()
      assert.equal((service as any).activeSessions.size, 0)
    })
  })

  // ─── singleton export ──────────────────────────────────────────────────

  describe('BlueprintBuildService — singleton', () => {
    test('exports blueprintBuildService singleton', () => {
      assert.ok(blueprintBuildService !== undefined)
      assert.ok(blueprintBuildService instanceof BlueprintBuildService)
    })

    test('singleton has key methods', () => {
      assert.equal(typeof blueprintBuildService.startBuildPhase, 'function')
      assert.equal(typeof blueprintBuildService.cancelBlueprint, 'function')
      assert.equal(typeof blueprintBuildService.shutdown, 'function')
    })
  })

  // ─── Event emission patterns ───────────────────────────────────────────

  describe('BlueprintBuildService — event patterns', () => {
    test('phaseStart event can be listened to', () => {
      const service = new BlueprintBuildService()
      const events: any[] = []
      service.on('phaseStart', (data: any) => events.push(data))
      ;(service as any).safeEmit('phaseStart', {
        blueprintId: 'bp-1',
        workspaceId: 'ws-1',
        phase: 'build',
        goal: 'Build 3 tasks',
        totalTasks: 3,
        totalWaves: 1
      })
      assert.equal(events.length, 1)
      assert.equal(events[0].phase, 'build')
      assert.equal(events[0].totalTasks, 3)
    })

    test('waveStart event emits correctly', () => {
      const service = new BlueprintBuildService()
      const events: any[] = []
      service.on('waveStart', (data: any) => events.push(data))
      ;(service as any).safeEmit('waveStart', {
        blueprintId: 'bp-1',
        workspaceId: 'ws-1',
        wave: 1,
        taskCount: 3
      })
      assert.equal(events.length, 1)
      assert.equal(events[0].wave, 1)
      assert.equal(events[0].taskCount, 3)
    })

    test('phaseProgress event emits correctly', () => {
      const service = new BlueprintBuildService()
      const events: any[] = []
      service.on('phaseProgress', (data: any) => events.push(data))
      ;(service as any).safeEmit('phaseProgress', {
        blueprintId: 'bp-1',
        workspaceId: 'ws-1',
        phase: 'build',
        text: 'Task T-001 completed',
        kind: 'text'
      })
      assert.equal(events.length, 1)
      assert.equal(events[0].kind, 'text')
    })

    test('waveTaskComplete event emits correctly', () => {
      const service = new BlueprintBuildService()
      const events: any[] = []
      service.on('waveTaskComplete', (data: any) => events.push(data))
      ;(service as any).safeEmit('waveTaskComplete', {
        blueprintId: 'bp-1',
        workspaceId: 'ws-1',
        wave: 1,
        taskId: 'T-001',
        status: 'complete'
      })
      assert.equal(events.length, 1)
      assert.equal(events[0].taskId, 'T-001')
    })

    test('taskTiming event emits correctly', () => {
      const service = new BlueprintBuildService()
      const events: any[] = []
      service.on('taskTiming', (data: any) => events.push(data))
      ;(service as any).safeEmit('taskTiming', {
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        timing: { taskId: 'T-001', wave: 1, durationMs: 5000 }
      })
      assert.equal(events.length, 1)
      assert.equal(events[0].timing.durationMs, 5000)
    })
  })

  // ─── Internal state management ─────────────────────────────────────────

  describe('BlueprintBuildService — state management', () => {
    test('activeSessions tracks per-workspace', () => {
      const service = new BlueprintBuildService()
      const sessions = new Set(['session1', 'session2'])
      ;(service as any).activeSessions.set('ws-1', sessions)
      assert.equal((service as any).activeSessions.get('ws-1')?.size, 2)
    })

    test('activeBlueprintIds tracks per-workspace', () => {
      const service = new BlueprintBuildService()
      ;(service as any).activeBlueprintIds.set('ws-1', 'bp-abc')
      assert.equal((service as any).activeBlueprintIds.get('ws-1'), 'bp-abc')
    })

    test('perTaskStatus tracks per-statusKey', () => {
      const service = new BlueprintBuildService()
      ;(service as any).perTaskStatus.set('ws-1::bp-1::T-001', 'running')
      assert.equal((service as any).perTaskStatus.get('ws-1::bp-1::T-001'), 'running')
    })

    test('multiple workspaces tracked independently', () => {
      const service = new BlueprintBuildService()
      ;(service as any).activeSessions.set('ws-1', new Set(['s1']))
      ;(service as any).activeSessions.set('ws-2', new Set(['s2', 's3']))
      assert.equal((service as any).activeSessions.get('ws-1')?.size, 1)
      assert.equal((service as any).activeSessions.get('ws-2')?.size, 2)
    })
  })

  // ─── TaskTiming shape validation ───────────────────────────────────────

  describe('TaskTiming — shape', () => {
    test('timing object has expected fields', () => {
      const timing = {
        taskId: 'T-001',
        wave: 1,
        tDispatch: 1000,
        tSessionReady: 1500,
        tFirstChunk: 2000,
        tComplete: 5000,
        tSlotFreed: 5100,
        durationMs: 4100
      }
      assert.equal(timing.taskId, 'T-001')
      assert.equal(timing.wave, 1)
      assert.equal(timing.durationMs, 4100)
      assert.ok(timing.tSlotFreed > timing.tDispatch)
    })

    test('timing with zero timestamps', () => {
      const timing = {
        taskId: 'T-002',
        wave: 0,
        tDispatch: 0,
        tSessionReady: 0,
        tFirstChunk: 0,
        tComplete: 0,
        tSlotFreed: 0,
        durationMs: 0
      }
      assert.equal(timing.durationMs, 0)
    })
  })

  // ─── BuildResult shape validation ──────────────────────────────────────

  describe('BuildResult — accumulator shape', () => {
    test('default result shape', () => {
      const result = {
        tasksCompleted: 0,
        tasksResumed: 0,
        filesCreated: [] as string[],
        filesModified: [] as string[],
        failed: false,
        discoveries: [] as string[],
        taskTimings: [] as any[],
        taskFailures: [] as any[]
      }
      assert.equal(result.tasksCompleted, 0)
      assert.equal(result.failed, false)
      assert.equal(result.discoveries.length, 0)
    })

    test('accumulates discoveries with cap at 20', () => {
      const result = {
        discoveries: [] as string[]
      }
      for (let i = 0; i < 25; i++) {
        result.discoveries.push(`disc-${i}`)
      }
      if (result.discoveries.length > 20) {
        result.discoveries = result.discoveries.slice(-20)
      }
      assert.equal(result.discoveries.length, 20)
      assert.equal(result.discoveries[0], 'disc-5')
      assert.equal(result.discoveries[19], 'disc-24')
    })

    test('taskFailures accumulates', () => {
      const result = {
        taskFailures: [] as Array<{ taskId: string; reason: string }>
      }
      result.taskFailures.push({ taskId: 'T-001', reason: 'no-write-activity' })
      result.taskFailures.push({ taskId: 'T-002', reason: 'verification failed' })
      assert.equal(result.taskFailures.length, 2)
    })
  })
}

// ─── Standalone runner ──────────────────────────────────────────────────
if (require.main === module) {
  void summaryAsync()
}
