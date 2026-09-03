/**
 * blueprint-overload-attempts.test.ts — the attempt counter on the overload
 * re-dispatch path, for BOTH schedulers.
 *
 * WHY THIS EXISTS
 *
 * `blueprintTaskRepository.recordAttempt` is called after every `executeTask`
 * on the escalation ladder (`executeTaskWithGates`, `runPeerReviewIfEnabled`,
 * `escalateToLead`) — but the two overload re-dispatch sites, one in
 * `executeDag` and one in `executeWave`, used to call `executeTask` without it.
 * Two executions therefore shared one attempt number, on precisely the failure
 * path `turn_usage.attempt` (A4) exists to study: a task that hit an API
 * overload and was retried looked like a task that ran once.
 *
 * The claim under test is a DELTA, not an absolute: `dispatchTask` is stubbed
 * here, so the first execution's own `recordAttempt` (inside the real ladder)
 * never runs. A clean run must therefore leave `attempts` at 0 and an
 * overload-retried run at exactly 1 — the re-dispatch, and nothing else.
 *
 * Both schedulers are covered because they carry the same code twice: a fix
 * applied to one and not the other is the standing failure mode here.
 *
 * Run: tsx src/main/services/__tests__/blueprint-overload-attempts.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintPhaseRepository: any
let blueprintTaskRepository: any
let BlueprintBuildService: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
  blueprintTaskRepository = repos.blueprintTaskRepository
  BlueprintBuildService = require('../blueprint-build.service').BlueprintBuildService
} catch (err) {
  console.log(`⚠ overload-attempts setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('overload re-dispatch attempts (skipped — no DB)', () => {
    test('re-dispatch records an attempt', () => {}, { skipReason: 'no DB' })
  })
} else {
  /** Mirrors OVERLOAD_BACKOFF_BASE_MS in blueprint-build.service.ts. */
  const OVERLOAD_BACKOFF_BASE_MS = 60_000

  const freshWs = (): string => {
    const helper = require('../../db/repositories/__tests__/db-test-helper')
    return helper.attachTestDb()!.wsId
  }

  /**
   * Compress ONLY the overload backoff sleep (60 s). `abortAwareSleep` is a
   * module-level function, so it cannot be stubbed per-instance; the narrowest
   * intervention is a global `setTimeout` that shortens timers at or above the
   * backoff base and delegates everything else untouched — a sibling suite's
   * 10 ms timer keeps its real duration. Swapped inside `runExclusive` and
   * restored in a `finally`.
   */
  async function withCompressedBackoff<T>(fn: () => Promise<T>): Promise<T> {
    const real = globalThis.setTimeout
    globalThis.setTimeout = ((handler: never, ms?: number, ...args: never[]) =>
      real(handler, (ms ?? 0) >= OVERLOAD_BACKOFF_BASE_MS ? 1 : ms, ...args)) as typeof real
    try {
      return await fn()
    } finally {
      globalThis.setTimeout = real
    }
  }

  function seedTask(wsId: string): { blueprintId: string; task: any } {
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'overload attempts' })
    blueprintPhaseRepository.createAllPhases(bp.id)
    blueprintTaskRepository.create({
      blueprintId: bp.id,
      taskId: 'T001',
      wave: 1,
      description: 'Task T001',
      filePathsJson: ['src/a.ts'],
      isParallel: true,
      dependsOnJson: []
    })
    const task = blueprintTaskRepository.findByBlueprint(bp.id)[0]
    return { blueprintId: bp.id, task }
  }

  const emptyResult = (withScheduler: boolean): Record<string, unknown> => ({
    tasksCompleted: 0,
    tasksResumed: 0,
    filesCreated: [],
    filesModified: [],
    discoveries: [],
    failed: false,
    taskTimings: [],
    taskFailures: [],
    ...(withScheduler
      ? {
          scheduler: {
            mode: 'dag' as const,
            perTaskWaitMs: {},
            drainCount: 0,
            maxParallelism: 0,
            parallelismHistogram: {}
          }
        }
      : {})
  })

  interface Run {
    /** `attempts` on the task row after the scheduler returned. */
    attempts: number
    /** How many times the overload path re-dispatched via `executeTask`. */
    reDispatches: number
    status: string
  }

  /**
   * Run one task through one scheduler. `overload` makes the first settle
   * report `failureReason: 'overload'`, which is the only trigger for the
   * re-dispatch branch; the re-dispatched execution is stubbed to succeed.
   */
  async function runOne(mode: 'dag' | 'wave', opts: { overload: boolean }): Promise<Run> {
    return runExclusive(() =>
      withCompressedBackoff(async () => {
        const wsId = freshWs()
        const { blueprintId, task } = seedTask(wsId)
        const svc = new BlueprintBuildService()

        let settledOnce = false
        let reDispatches = 0

        svc.dispatchTask = (p: any): void => {
          const promise = new Promise((resolve) => {
            setTimeout(() => {
              const overloaded = opts.overload && !settledOnce
              settledOnce = true
              resolve(
                overloaded
                  ? {
                      success: false,
                      completion: null,
                      discoveries: [],
                      failureReason: 'overload'
                    }
                  : { success: true, completion: null, discoveries: [] }
              )
            }, 5)
          })
          p.inFlight.set(p.task.taskId, { promise, files: p.taskFiles, task: p.task })
        }

        // The overload branch re-dispatches through executeTask directly,
        // bypassing dispatchTask and the gate ladder.
        svc.executeTask = async (): Promise<unknown> => {
          reDispatches++
          return { success: true, completion: null, discoveries: [] }
        }
        svc.runWaveGates = async (): Promise<unknown> => ({ overall: 'pass', gates: [] })

        if (mode === 'dag') {
          const { buildTaskDag } = require('../../../shared/task-dag')
          const dag = buildTaskDag([{ taskId: 'T001', wave: 1, dependsOnJson: [] }])
          await svc.executeDag({
            dag,
            blueprintId,
            workspaceId: wsId,
            workspacePath: '/tmp/nonexistent-workspace',
            executionPath: '/tmp/nonexistent-workspace',
            phaseContext: {} as never,
            result: emptyResult(true)
          })
        } else {
          await svc.executeWave({
            waveNum: 1,
            waveTasks: [task],
            blueprintId,
            workspaceId: wsId,
            workspacePath: '/tmp/nonexistent-workspace',
            executionPath: '/tmp/nonexistent-workspace',
            phaseContext: {} as never,
            result: emptyResult(false)
          })
        }

        const after = blueprintTaskRepository.findById(task.id)
        return { attempts: after.attempts, reDispatches, status: after.status }
      })
    )
  }

  for (const mode of ['dag', 'wave'] as const) {
    describe(`overload re-dispatch attempts — ${mode} scheduler`, () => {
      test('an overload re-dispatch records exactly one attempt', async () => {
        const run = await runOne(mode, { overload: true })
        assert.equal(run.reDispatches, 1, 'the overload branch must re-dispatch once')
        assert.equal(
          run.attempts,
          1,
          'the re-dispatched execution must bump the attempt counter — otherwise it ' +
            'shares an attempt number with the execution it replaced'
        )
        assert.equal(run.status, 'complete', 'the retried task still settles normally')
      })

      test('a clean run adds no attempt of its own (no double-count)', async () => {
        const run = await runOne(mode, { overload: false })
        assert.equal(run.reDispatches, 0, 'no overload, no re-dispatch')
        assert.equal(
          run.attempts,
          0,
          'attempts are the ladder’s to record — the scheduler must not add one ' +
            'on the normal path'
        )
        assert.equal(run.status, 'complete')
      })
    })
  }
}

if (require.main === module) void summaryAsync()
