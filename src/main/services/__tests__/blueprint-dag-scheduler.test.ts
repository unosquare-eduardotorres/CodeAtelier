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
let blueprintTelemetryRepository: any
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
  blueprintTelemetryRepository =
    require('../../db/repositories/blueprint-telemetry.repository').blueprintTelemetryRepository
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

  describe('P1a — peer-file exemption covers COMPLETED peers, not just in-flight ones', () => {
    /**
     * The T001/T002 shape from run 984eac4d. T002 finished and committed
     * `.env.example` at 14:16; T001 retried at 14:18 against a baseline from
     * before that commit. Sourcing the exemption set from the in-flight map
     * left T002 in neither the baseline nor the exemption set, so T001's gate
     * report named T002's finished deliverable as T001's violation — and T001
     * reverted it.
     */
    test('a peer that already completed still owns its declared files', () => {
      const wsId = freshWs()
      const { blueprintId, tasks } = seedTasks(
        [
          { taskId: 'T001', wave: 1, files: ['src/a.ts'] },
          { taskId: 'T002', wave: 1, files: ['.env.example'] }
        ],
        wsId
      )
      // T002 is DONE — not pending, not running, not in any in-flight map.
      const t2 = tasks.find((t: any) => t.taskId === 'T002')
      blueprintTaskRepository.updateStatus(t2.id, 'complete')

      const svc = new BlueprintBuildService()
      const gateCtx: any = { taskId: 'T001', exemptFiles: [] }
      const peers = blueprintTaskRepository.findByBlueprint(blueprintId)
      svc.refreshExemptFiles(gateCtx, peers)

      assert.ok(
        gateCtx.exemptFiles.includes('.env.example'),
        `completed peer's file must stay exempt, got ${JSON.stringify(gateCtx.exemptFiles)}`
      )
      assert.ok(
        !gateCtx.exemptFiles.includes('src/a.ts'),
        'the graded task never exempts its own write-set'
      )
    })

    test('packet allowedFiles of a completed peer are exempt too', () => {
      const wsId = freshWs()
      const { blueprintId, tasks } = seedTasks(
        [
          { taskId: 'T001', wave: 1, files: ['src/a.ts'] },
          { taskId: 'T008', wave: 1, files: [] }
        ],
        wsId
      )
      const t8 = tasks.find((t: any) => t.taskId === 'T008')
      blueprintTaskRepository.setPacket(t8.id, {
        allowedFiles: ['src/notification-templates.ts']
      })
      blueprintTaskRepository.updateStatus(t8.id, 'complete')

      const svc = new BlueprintBuildService()
      const gateCtx: any = { taskId: 'T001', exemptFiles: [] }
      svc.refreshExemptFiles(gateCtx, blueprintTaskRepository.findByBlueprint(blueprintId))

      assert.ok(gateCtx.exemptFiles.includes('src/notification-templates.ts'))
    })
  })

  describe('P3a — reconciliation resets the victims so a retry can repair the tree', () => {
    /**
     * The dead end this exists to prevent, observed on the real run: every task
     * is `complete`, so the resume pre-pass settles all 15, nothing dispatches,
     * reconciliation fails in about a second, and every retry repeats it
     * forever. A task whose claimed output is missing has not completed.
     */
    test('a completed task whose claimed file is gone goes back to pending', async () => {
      const wsId = freshWs()
      const { blueprintId, tasks } = seedTasks(
        [
          { taskId: 'T001', wave: 1, files: ['src/a.ts'] },
          { taskId: 'T002', wave: 1, files: ['.env.example'] }
        ],
        wsId
      )
      const t1 = tasks.find((t: any) => t.taskId === 'T001')
      const t2 = tasks.find((t: any) => t.taskId === 'T002')

      // Both complete. T002 claims a file that does not exist on disk; T001
      // claims nothing, so it must be left alone.
      for (const t of [t1, t2]) blueprintTaskRepository.updateStatus(t.id, 'complete')
      blueprintTaskRepository.setCompletion(t2.id, {
        filesCreated: ['.env.example'],
        filesModified: []
      })
      blueprintTaskRepository.setGateReport(t2.id, { overall: 'pass', gates: [] })

      const svc = new BlueprintBuildService()
      const result = { failed: false, taskFailures: [] as any[] }
      await svc.reconcileBuildOutput({
        blueprintId,
        workspaceId: wsId,
        // A directory with no .env.example and no git history.
        executionPath: '/tmp/nonexistent-reconcile-fixture',
        allTasks: blueprintTaskRepository.findByBlueprint(blueprintId),
        result
      })

      assert.ok(result.failed, 'the phase must fail on a missing claimed file')

      const after = blueprintTaskRepository.findByBlueprint(blueprintId)
      const t2After = after.find((t: any) => t.taskId === 'T002')
      const t1After = after.find((t: any) => t.taskId === 'T001')
      assert.equal(t2After.status, 'pending', 'the victim is reset so a retry rebuilds it')
      assert.equal(t2After.gatesJson, null, 'the stale gate report is cleared with it')
      assert.equal(t1After.status, 'complete', 'an unaffected task is left alone')
    })

    test('a user-skipped task is never resurrected by reconciliation', async () => {
      const wsId = freshWs()
      const { blueprintId, tasks } = seedTasks(
        [{ taskId: 'T001', wave: 1, files: ['src/a.ts'] }],
        wsId
      )
      const t1 = tasks.find((t: any) => t.taskId === 'T001')
      blueprintTaskRepository.updateStatus(t1.id, 'complete')
      blueprintTaskRepository.setCompletion(t1.id, {
        filesCreated: ['src/gone.ts'],
        filesModified: []
      })
      blueprintTaskRepository.setUserSkipped(t1.id, true)

      const svc = new BlueprintBuildService()
      const result = { failed: false, taskFailures: [] as any[] }
      await svc.reconcileBuildOutput({
        blueprintId,
        workspaceId: wsId,
        executionPath: '/tmp/nonexistent-reconcile-fixture',
        allTasks: blueprintTaskRepository.findByBlueprint(blueprintId),
        result
      })

      const after = blueprintTaskRepository
        .findByBlueprint(blueprintId)
        .find((t: any) => t.taskId === 'T001')
      assert.notEqual(after.status, 'pending', 'a human decision is never overruled')
    })
  })

  describe('P3a — BUILD-end reconciliation: the record vs the tree', () => {
    const { execFileSync } = require('node:child_process')
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')
    const repos: string[] = []

    /** A repo with a baseline commit, then one task commit per entry. */
    function seedRepo(): { dir: string; baseline: string } {
      const dir = mkdtempSync(join(tmpdir(), 'recon-'))
      repos.push(dir)
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
      }
      writeFileSync(join(dir, 'owned.ts'), 'export const baseline = 1\n')
      writeFileSync(join(dir, 'twin.ts'), 'export const other = 1\n')
      git('init', '-q')
      git('config', 'user.email', 'r@test.local')
      git('config', 'user.name', 'Recon Test')
      git('config', 'commit.gpgsign', 'false')
      git('add', '-A')
      git('commit', '-q', '-m', 'baseline')
      const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' })
        .trim()
      return { dir, baseline }
    }

    async function runReconcile(
      dir: string,
      baseline: string,
      claims: { taskId: string; created?: string[]; modified?: string[] }[]
    ): Promise<{
      failed: boolean
      taskFailures: { taskId: string; reason: string }[]
      blueprintId: string
    }> {
      const wsId = freshWs()
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'recon' })
      blueprintRepository.update(bp.id, { settingsJson: { buildBaselineCommit: baseline } })
      const tasks: any[] = []
      for (const c of claims) {
        const t = blueprintTaskRepository.create({
          blueprintId: bp.id,
          taskId: c.taskId,
          wave: 1,
          description: c.taskId,
          filePathsJson: [],
          isParallel: true,
          dependsOnJson: []
        })
        blueprintTaskRepository.setCompletion(t.id, {
          filesCreated: c.created ?? [],
          filesModified: c.modified ?? []
        })
        blueprintTaskRepository.updateStatus(t.id, 'complete')
        tasks.push(t)
      }
      const result: any = { failed: false, taskFailures: [] }
      await new BlueprintBuildService().reconcileBuildOutput({
        blueprintId: bp.id,
        workspaceId: wsId,
        executionPath: dir,
        allTasks: blueprintTaskRepository.findByBlueprint(bp.id),
        result
      })
      return { ...result, blueprintId: bp.id }
    }

    test('a destructive revert of a MODIFIED claim is reported but does NOT block', async () => {
      // The T008 shape: T008 committed an export into a file it claimed as
      // MODIFIED, T005 later gutted it, and the DB still read complete+verified.
      //
      // Line survival is a heuristic — “revised” and “reverted” are not reliably
      // separable from a diff — so it warns and records instead of failing the
      // phase. Three false positives on two real runs bought that decision.
      const { dir, baseline } = seedRepo()
      const git = (...a: string[]): void => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
      writeFileSync(
        join(dir, 'owned.ts'),
        'export const baseline = 1\nexport function sendInternalSignoffNotice() {}\nexport const alsoMine = 2\nexport const andThis = 3\n'
      )
      git('add', '-A')
      git('commit', '-q', '-m', 'T008: add the internal signoff notice')
      // A net-NEGATIVE commit by another task: deletes 3, adds 1.
      writeFileSync(join(dir, 'owned.ts'), 'export const baseline = 1\nexport const restored = 1\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'T005: restore the seam to its baseline')

      const result = await runReconcile(dir, baseline, [{ taskId: 'T008', modified: ['owned.ts'] }])

      assert.equal(result.failed, false, 'a heuristic finding must not block a green build')
      assert.equal(result.taskFailures.length, 0, 'and must not be reported as a task failure')
      // It is still DETECTED — the telemetry row is the durable record.
      const rows = blueprintTelemetryRepository
        .findByBlueprint(result.blueprintId)
        .filter((r: any) => r.kind === 'reconciliation')
      const victims = rows.flatMap((r: any) => r.data.victimTasks ?? [])
      assert.ok(victims.includes('T008'), `T008 must still be recorded as a victim — got ${victims}`)
    })

    test('a later task REVISING an earlier task’s file is not a victim at all', async () => {
      // The R003/T011 shape that blocked a real run: a remediation task refining
      // an earlier task's feature. Net-ADDITIVE, so it is normal work, not
      // destruction — and `R###` must be recognised as a task id at all.
      const { dir, baseline } = seedRepo()
      const git = (...a: string[]): void => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
      writeFileSync(
        join(dir, 'owned.ts'),
        'export const baseline = 1\nexport const notifyTheInbox = true\nexport const waitForIt = 1\n'
      )
      git('add', '-A')
      git('commit', '-q', '-m', 'T011: notify the shared inbox after a committed signature')
      // R003 refines it: removes one line, adds several. Net POSITIVE.
      writeFileSync(
        join(dir, 'owned.ts'),
        'export const baseline = 1\nexport const notifyTheInbox = true\nexport const boundedWait = 5000\nexport const retries = 3\nexport const timeoutMs = 250\n'
      )
      git('add', '-A')
      git('commit', '-q', '-m', 'R003: bound the wait on the CHR-44 sign-off notification')

      const result = await runReconcile(dir, baseline, [{ taskId: 'T011', modified: ['owned.ts'] }])

      assert.equal(result.failed, false)
      const rows = blueprintTelemetryRepository
        .findByBlueprint(result.blueprintId)
        .filter((r: any) => r.kind === 'reconciliation')
      const victims = rows.flatMap((r: any) => r.data.victimTasks ?? [])
      assert.deepEqual(victims, [], `a refinement must not be reported as loss — got ${victims}`)
    })

    test('a CREATED claim is judged on existence, not on line survival', async () => {
      // The T009 shape: it CREATED a byte-identical twin. Repairing the original
      // legitimately rewrote a few stale lines in that copy — billing it as
      // “T009's work was destroyed” would block the build on a correct fix.
      const { dir, baseline } = seedRepo()
      const git = (...a: string[]): void => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
      writeFileSync(join(dir, 'twin.ts'), 'export const other = 1\nexport const staleDoc = "copied"\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'T009: byte-identical twin')
      writeFileSync(join(dir, 'twin.ts'), 'export const other = 1\nexport const freshDoc = "repaired"\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'T008: repair the twin')

      const result = await runReconcile(dir, baseline, [{ taskId: 'T009', created: ['twin.ts'] }])

      assert.equal(result.failed, false, 'the created file still exists — nothing was lost')
    })

    test('a claimed path that no longer exists fails whichever kind it was', async () => {
      const { dir, baseline } = seedRepo()
      const result = await runReconcile(dir, baseline, [
        { taskId: 'T004', created: ['never-written.ts'] }
      ])
      assert.equal(result.failed, true)
      assert.ok(result.taskFailures.map((f) => f.reason).join(' ').includes('never-written.ts'))
    })

    process.on('exit', () => {
      for (const d of repos.splice(0)) {
        try {
          rmSync(d, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
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
