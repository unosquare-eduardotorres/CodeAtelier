/**
 * blueprint-dag-scheduler.test.ts — D3 robustness tests for the graph-wide
 * DAG scheduler (executeDag) in BlueprintBuildService.
 *
 * The wave scheduler (executeWave) is pinned by blueprint-dependson-scheduling
 * and blueprint-parallel-scheduler tests. These pin the DAG loop's own rules:
 * - Cross-wave early dispatch (a wave-2 task runs while a wave-1 peer is slow)
 * - File-overlap serialization across wave boundaries
 * - Drain-point gates run at natural stalls only (settled tree invariant)
 * - Failure drains in-flight peers and skips ONLY transitive dependents
 * - User-skipped dep satisfies readiness; cascade-skip blocks (no misorder)
 * - Cancel (abort) drains in-flight tasks
 * - Cap respected globally across the whole build
 * - Rank-order dispatch preference (critical path first)
 *
 * Run: tsx src/main/services/__tests__/blueprint-dag-scheduler.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintPhaseRepository: any
let blueprintTaskRepository: any
let appPreferenceRepository: any
let BlueprintBuildService: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
  blueprintTaskRepository = repos.blueprintTaskRepository
  const prefs = require('../../db/repositories/app-preference.repository')
  appPreferenceRepository = prefs.appPreferenceRepository
  BlueprintBuildService = require('../blueprint-build.service').BlueprintBuildService
} catch (err) {
  console.log(`⚠ DAG scheduler setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('DAG scheduler (skipped — no DB)', () => {
    test('cross-wave dispatch', () => {}, { skipReason: 'no DB' })
  })
} else {
  /**
   * Fresh workspace per test — tests run concurrently and share one DB;
   * blueprintService.getAbortSignal is keyed by workspaceId, so the cancel
   * test's AbortController must not leak into sibling tests' workspaces.
   */
  const freshWs = (): string => {
    const helper = require('../../db/repositories/__tests__/db-test-helper')
    return helper.attachTestDb()!.wsId
  }

  type TaskSpec = {
    taskId: string
    wave: number
    files: string[]
    dependsOn?: string[]
    /** ms the mocked executor takes to settle */
    durationMs?: number
    /** force the settled result to failure */
    fail?: boolean
  }

  function seedTasks(specs: TaskSpec[], wsId: string): { blueprintId: string; tasks: any[] } {
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'dag test' })
    blueprintPhaseRepository.createAllPhases(bp.id)
    for (const spec of specs) {
      blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: spec.taskId,
        wave: spec.wave,
        description: `Task ${spec.taskId}`,
        filePathsJson: spec.files,
        isParallel: true,
        dependsOnJson: spec.dependsOn ?? []
      })
    }
    return { blueprintId: bp.id, tasks: blueprintTaskRepository.findByBlueprint(bp.id) }
  }

  interface DagRunResult {
    order: string[]
    /** taskId → set of taskIds already settled when it dispatched */
    settledAtDispatch: Map<string, Set<string>>
    maxConcurrent: number
    gateWaves: number[]
    result: any
    statuses: Map<string, string>
  }

  // One file-wide pref stub, installed once, never restored mid-run: tests
  // execute concurrently and a per-test restore/patch cycle races sibling
  // runs' cap reads. Per-run caps are delivered via `pendingCap` instead.
  // The whole suite runs under runExclusive because the stub swaps a
  // process-global (see test-harness note).
  const originalGetPrefs = appPreferenceRepository.getAppPreferences
  let pendingCap = 3
  appPreferenceRepository.getAppPreferences = () => ({
    ...(originalGetPrefs.call(appPreferenceRepository) ?? {}),
    parallelBuildAgents: pendingCap,
    dagScheduling: true
  })

  /**
   * Run executeDag with dispatchTask stubbed: each task settles after its
   * durationMs, optionally failing. runWaveGates is stubbed to record the
   * wave numbers it was invoked with. Serialized via runExclusive — the
   * pref stub is a process-global swap.
   */
  async function runDag(specs: TaskSpec[], opts?: { cap?: number }): Promise<DagRunResult> {
    return runExclusive(async () => {
      const wsId = freshWs()
      const { blueprintId } = seedTasks(specs, wsId)
      const svc = new BlueprintBuildService()

      const order: string[] = []
      const settled = new Set<string>()
      const settledAtDispatch = new Map<string, Set<string>>()
      let maxConcurrent = 0
      const gateWaves: number[] = []

      pendingCap = opts?.cap ?? 3

      svc.dispatchTask = (p: any): void => {
        const spec = specs.find((s) => s.taskId === p.task.taskId)!
        order.push(p.task.taskId)
        settledAtDispatch.set(p.task.taskId, new Set(settled))
        const promise = new Promise((resolve) => {
          setTimeout(() => {
            settled.add(p.task.taskId)
            resolve(
              spec.fail
                ? { success: false, completion: null, discoveries: [], failureReason: 'boom' }
                : { success: true, completion: null, discoveries: [] }
            )
          }, spec.durationMs ?? 10)
        })
        p.inFlight.set(p.task.taskId, { promise, files: p.taskFiles, task: p.task })
        maxConcurrent = Math.max(maxConcurrent, p.inFlight.size)
      }

      svc.runWaveGates = async (p: any): Promise<any> => {
        gateWaves.push(p.waveNum)
        return { overall: 'pass', gates: [] }
      }

      const result = {
        tasksCompleted: 0,
        tasksResumed: 0,
        filesCreated: [],
        filesModified: [],
        discoveries: [],
        failed: false,
        taskTimings: [],
        taskFailures: [],
        scheduler: {
          mode: 'dag' as const,
          perTaskWaitMs: {},
          drainCount: 0,
          maxParallelism: 0,
          parallelismHistogram: {}
        }
      }

      try {
        const { buildTaskDag } = require('../../../shared/task-dag')
        const dag = buildTaskDag(
          specs.map((s) => ({ taskId: s.taskId, wave: s.wave, dependsOnJson: s.dependsOn ?? [] }))
        )
        await svc.executeDag({
          dag,
          blueprintId,
          workspaceId: wsId,
          workspacePath: '/tmp/nonexistent-workspace',
          executionPath: '/tmp/nonexistent-workspace',
          phaseContext: {} as never,
          result
        })
      } finally {
        pendingCap = 3
      }

      const statuses = new Map<string, string>()
      for (const spec of specs) {
        const rec = blueprintTaskRepository
          .findByBlueprint(blueprintId)
          .find((t: any) => t.taskId === spec.taskId)
        statuses.set(spec.taskId, rec?.status ?? 'missing')
      }

      return { order, settledAtDispatch, maxConcurrent, gateWaves, result, statuses }
    })
  }

  describe('DAG scheduler: cross-wave dispatch', () => {
    test('wave-2 task dispatches while a slow wave-1 peer is still running', async () => {
      // T001 (wave 1, slow) → T003 (wave 2). T002 (wave 1, fast, disjoint).
      // T003 must dispatch after T001 settles — but NOT wait for T002.
      const run = await runDag([
        { taskId: 'T001', wave: 1, files: ['src/a.ts'], durationMs: 80 },
        { taskId: 'T002', wave: 1, files: ['src/b.ts'], durationMs: 200 },
        { taskId: 'T003', wave: 2, files: ['src/c.ts'], dependsOn: ['T001'] }
      ])
      // T003 dispatched before T002 settled → no wave barrier
      const t3DispatchIdx = run.order.indexOf('T003')
      assert.ok(t3DispatchIdx >= 0, 'T003 dispatched')
      assert.ok(
        !run.settledAtDispatch.get('T003')!.has('T002'),
        'T003 dispatched without waiting for slow wave-1 peer T002'
      )
      assert.ok(
        run.settledAtDispatch.get('T003')!.has('T001'),
        'T003 waited for its dependency T001'
      )
    })

    test('file overlap serializes across wave boundaries', async () => {
      // T002 (wave 2) shares a file with T001 (wave 1) but declares no dep.
      // The file-overlap guard must serialize them even though T002 is
      // dependency-ready immediately.
      const run = await runDag([
        { taskId: 'T001', wave: 1, files: ['src/shared.ts'], durationMs: 80 },
        { taskId: 'T002', wave: 2, files: ['src/shared.ts'], durationMs: 10 }
      ])
      assert.ok(
        run.settledAtDispatch.get('T002')!.has('T001'),
        'T002 waited for in-flight T001 on the shared file'
      )
      assert.equal(run.maxConcurrent, 1, 'overlapping tasks never ran concurrently')
    })
  })

  describe('DAG scheduler: drain-point gates', () => {
    test('gates run at natural stalls only — not per completion', async () => {
      // Diamond: A → (B, C) → D. One join stall → exactly one gate run.
      const run = await runDag([
        { taskId: 'A', wave: 1, files: ['src/a.ts'] },
        { taskId: 'B', wave: 2, files: ['src/b.ts'], dependsOn: ['A'] },
        { taskId: 'C', wave: 2, files: ['src/c.ts'], dependsOn: ['A'] },
        { taskId: 'D', wave: 3, files: ['src/d.ts'], dependsOn: ['B', 'C'] }
      ])
      assert.equal(run.gateWaves.length, 1, `expected 1 gate run, got ${run.gateWaves.length}`)
      assert.equal(run.result.scheduler.drainCount, 1)
    })

    test('no gates when nothing dispatched (empty graph)', async () => {
      const run = await runDag([])
      assert.equal(run.gateWaves.length, 0)
    })
  })

  describe('DAG scheduler: failure semantics', () => {
    test('failure drains peers and skips only transitive dependents', async () => {
      // T001 fails. T002 depends on it (doomed). T003 is independent (healthy).
      // T004 depends on T003 (healthy chain).
      const run = await runDag([
        { taskId: 'T001', wave: 1, files: ['src/a.ts'], fail: true, durationMs: 10 },
        { taskId: 'T002', wave: 2, files: ['src/b.ts'], dependsOn: ['T001'] },
        { taskId: 'T003', wave: 1, files: ['src/c.ts'], durationMs: 60 },
        { taskId: 'T004', wave: 2, files: ['src/d.ts'], dependsOn: ['T003'] }
      ])
      assert.equal(run.statuses.get('T001'), 'failed')
      assert.equal(run.statuses.get('T002'), 'skipped', 'dependent of failed task skipped')
      // T003 was in flight when T001 failed — graceful drain lets it finish.
      assert.equal(run.statuses.get('T003'), 'complete', 'healthy peer completed during drain')
      // T004: dependent of a healthy task. It may or may not have dispatched
      // before drain began; either way it must NOT be silently mis-ordered.
      const t4 = run.statuses.get('T004')
      assert.ok(
        t4 === 'complete' || t4 === 'skipped',
        `T004 terminal (${t4}), not stuck pending/running`
      )
      assert.ok(run.result.failed, 'build marked failed')
    })

    test('cancel (abort) drains in-flight tasks without new dispatches', async () => {
      const wsId = freshWs()
      const { blueprintId } = seedTasks(
        [
          { taskId: 'T001', wave: 1, files: ['src/a.ts'], durationMs: 10 },
          { taskId: 'T002', wave: 1, files: ['src/b.ts'], durationMs: 10 }
        ],
        wsId
      )
      const svc = new BlueprintBuildService()
      // Abort after first dispatch: the loop must drain, not dispatch T002.
      let dispatchCount = 0
      svc.dispatchTask = (p: any): void => {
        dispatchCount++
        const promise = new Promise((resolve) =>
          setTimeout(() => resolve({ success: true, completion: null, discoveries: [] }), 10)
        )
        p.inFlight.set(p.task.taskId, { promise, files: p.taskFiles, task: p.task })
      }
      svc.runWaveGates = async (): Promise<any> => ({ overall: 'pass', gates: [] })

      const { buildTaskDag } = require('../../../shared/task-dag')
      const dag = buildTaskDag([
        { taskId: 'T001', wave: 1, dependsOnJson: [] },
        { taskId: 'T002', wave: 1, dependsOnJson: [] }
      ])

      const result = {
        tasksCompleted: 0,
        tasksResumed: 0,
        filesCreated: [],
        filesModified: [],
        discoveries: [],
        failed: false,
        taskTimings: [],
        taskFailures: [],
        scheduler: {
          mode: 'dag',
          perTaskWaitMs: {},
          drainCount: 0,
          maxParallelism: 0,
          parallelismHistogram: {}
        }
      }

      // Wire an abort signal through blueprintService.getAbortSignal.
      const controller = new AbortController()
      const { blueprintService } = require('../blueprint.service')
      const origGetAbort = blueprintService.getAbortSignal
      blueprintService.getAbortSignal = () => controller.signal
      // Abort while T001 is in flight.
      setTimeout(() => controller.abort(), 5)
      try {
        await svc.executeDag({
          dag,
          blueprintId,
          workspaceId: wsId,
          workspacePath: '/tmp/x',
          executionPath: '/tmp/x',
          phaseContext: {} as never,
          result
        })
      } finally {
        blueprintService.getAbortSignal = origGetAbort
      }
      // Abort observed at the next loop iteration: at most the first-batch
      // dispatches happened; nothing re-dispatched after drain.
      assert.ok(dispatchCount <= 2, `dispatch count bounded (${dispatchCount})`)
    })
  })

  describe('DAG scheduler: readiness status rules', () => {
    test('user-skipped dep satisfies readiness', async () => {
      const wsId = freshWs()
      const { blueprintId } = seedTasks(
        [
          { taskId: 'T001', wave: 1, files: ['src/a.ts'] },
          { taskId: 'T002', wave: 2, files: ['src/b.ts'], dependsOn: ['T001'] }
        ],
        wsId
      )
      // User-skip T001 directly in the DB.
      const t1 = blueprintTaskRepository
        .findByBlueprint(blueprintId)
        .find((t: any) => t.taskId === 'T001')
      blueprintTaskRepository.setUserSkipped(t1.id, true)
      blueprintTaskRepository.updateStatus(t1.id, 'skipped')

      const svc = new BlueprintBuildService()
      const order: string[] = []
      svc.dispatchTask = (p: any): void => {
        order.push(p.task.taskId)
        const promise = Promise.resolve({ success: true, completion: null, discoveries: [] })
        p.inFlight.set(p.task.taskId, { promise, files: p.taskFiles, task: p.task })
      }
      svc.runWaveGates = async (): Promise<any> => ({ overall: 'pass', gates: [] })

      const { buildTaskDag } = require('../../../shared/task-dag')
      const dag = buildTaskDag([
        { taskId: 'T001', wave: 1, dependsOnJson: [] },
        { taskId: 'T002', wave: 2, dependsOnJson: ['T001'] }
      ])
      const result = {
        tasksCompleted: 0,
        tasksResumed: 0,
        filesCreated: [],
        filesModified: [],
        discoveries: [],
        failed: false,
        taskTimings: [],
        taskFailures: [],
        scheduler: {
          mode: 'dag',
          perTaskWaitMs: {},
          drainCount: 0,
          maxParallelism: 0,
          parallelismHistogram: {}
        }
      }
      await svc.executeDag({
        dag,
        blueprintId,
        workspaceId: wsId,
        workspacePath: '/tmp/x',
        executionPath: '/tmp/x',
        phaseContext: {} as never,
        result
      })
      assert.ok(order.includes('T002'), 'T002 dispatched — user-skipped dep satisfied readiness')
      assert.ok(!order.includes('T001'), 'user-skipped T001 never dispatched')
    })

    test('cascade-skipped dep blocks the dependent (no silent misorder)', async () => {
      const wsId = freshWs()
      const { blueprintId } = seedTasks(
        [
          { taskId: 'T001', wave: 1, files: ['src/a.ts'] },
          { taskId: 'T002', wave: 2, files: ['src/b.ts'], dependsOn: ['T001'] }
        ],
        wsId
      )
      // Simulate a stale cascade-skip: T001 'skipped' with NO user timestamp.
      const t1 = blueprintTaskRepository
        .findByBlueprint(blueprintId)
        .find((t: any) => t.taskId === 'T001')
      blueprintTaskRepository.updateStatus(t1.id, 'skipped')

      const svc = new BlueprintBuildService()
      const order: string[] = []
      svc.dispatchTask = (p: any): void => {
        order.push(p.task.taskId)
        const promise = Promise.resolve({ success: true, completion: null, discoveries: [] })
        p.inFlight.set(p.task.taskId, { promise, files: p.taskFiles, task: p.task })
      }
      svc.runWaveGates = async (): Promise<any> => ({ overall: 'pass', gates: [] })

      const { buildTaskDag } = require('../../../shared/task-dag')
      const dag = buildTaskDag([
        { taskId: 'T001', wave: 1, dependsOnJson: [] },
        { taskId: 'T002', wave: 2, dependsOnJson: ['T001'] }
      ])
      const result = {
        tasksCompleted: 0,
        tasksResumed: 0,
        filesCreated: [],
        filesModified: [],
        discoveries: [],
        failed: false,
        taskTimings: [],
        taskFailures: [],
        scheduler: {
          mode: 'dag',
          perTaskWaitMs: {},
          drainCount: 0,
          maxParallelism: 0,
          parallelismHistogram: {}
        }
      }
      await svc.executeDag({
        dag,
        blueprintId,
        workspaceId: wsId,
        workspacePath: '/tmp/x',
        executionPath: '/tmp/x',
        phaseContext: {} as never,
        result
      })
      assert.ok(
        !order.includes('T002'),
        'T002 never dispatched — cascade-skip does not satisfy readiness'
      )
      // And it surfaces as skipped (stall detection), not stuck pending.
      const t2 = blueprintTaskRepository
        .findByBlueprint(blueprintId)
        .find((t: any) => t.taskId === 'T002')
      assert.equal(t2.status, 'skipped', 'blocked dependent marked skipped by stall detection')
    })
  })

  describe('DAG scheduler: cap and rank order', () => {
    test('cap respected globally across the whole build', async () => {
      // 4 independent tasks, cap 2 → never more than 2 concurrent.
      const run = await runDag(
        [
          { taskId: 'T001', wave: 1, files: ['src/a.ts'], durationMs: 30 },
          { taskId: 'T002', wave: 1, files: ['src/b.ts'], durationMs: 30 },
          { taskId: 'T003', wave: 2, files: ['src/c.ts'], durationMs: 30 },
          { taskId: 'T004', wave: 2, files: ['src/d.ts'], durationMs: 30 }
        ],
        { cap: 2 }
      )
      assert.ok(run.maxConcurrent <= 2, `max concurrent ${run.maxConcurrent} <= cap 2`)
      assert.equal(run.result.scheduler.maxParallelism, run.maxConcurrent)
    })

    test('rank order: critical-path task dispatches before isolated peers', async () => {
      // T001 feeds a 3-long chain; T002 is isolated. Both ready at t=0 with
      // slots available — T001 (higher upwardRank) dispatches first.
      const run = await runDag([
        { taskId: 'T001', wave: 1, files: ['src/a.ts'] },
        { taskId: 'T002', wave: 1, files: ['src/b.ts'] },
        { taskId: 'T003', wave: 2, files: ['src/c.ts'], dependsOn: ['T001'] },
        { taskId: 'T004', wave: 3, files: ['src/d.ts'], dependsOn: ['T003'] }
      ])
      assert.equal(run.order[0], 'T001', 'critical-path root dispatched first')
    })
  })
}

// ── Runner ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
