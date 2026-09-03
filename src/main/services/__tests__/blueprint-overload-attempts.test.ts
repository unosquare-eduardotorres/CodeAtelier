/**
 * blueprint-overload-attempts.test.ts — A11: overload retry inside the gate
 * ladder, and the scheduler back-pressure that remains outside it.
 *
 * WHY THIS EXISTS
 *
 * Both schedulers used to intercept `failureReason === 'overload'` at settle
 * time and re-dispatch through `executeTask` directly, bypassing
 * `executeTaskWithGates`. A task that hit one API overload and then succeeded
 * was therefore marked complete with **no gate grading, no peer review and no
 * escalation** — and `handleTaskCompletion` stamped it `outcomeKind: 'verified'`,
 * a claim nothing had checked. The same ~55-line branch existed twice, which is
 * §1.2's standing "both schedulers or neither" duplication.
 *
 * The retry now lives in the ladder, once. These tests pin the three things
 * that move as a result:
 *
 *   1. A re-run task IS graded — `gradeTask` runs and the result carries a
 *      `gateReport`. This is the hole the old path left open.
 *   2. Overload EXHAUSTION still returns exactly `failureReason: 'overload'`.
 *      `executeWave`'s drain check compares that string on equality, so any
 *      rewording silently costs the operator the terminal message.
 *   3. The scheduler halves its parallel cap once per overloaded task. Without
 *      it, parallelism stays high against a saturated provider and manufactures
 *      more overload.
 *
 * Attempt accounting is a DELTA: `executeTask` is stubbed, so only the ladder's
 * own `recordAttempt` calls land. One clean run = 1; one overload + success = 2.
 *
 * Run: tsx src/main/services/__tests__/blueprint-overload-attempts.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
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

/** `captureGateBaseline` needs a real HEAD, or the ladder early-exits ungraded. */
const GIT_AVAILABLE = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

if (!env) {
  describe('overload retry (skipped — no DB)', () => {
    test('retry is graded', () => {}, { skipReason: 'no DB' })
  })
} else {
  const freshWs = (): string => {
    const helper = require('../../db/repositories/__tests__/db-test-helper')
    return helper.attachTestDb()!.wsId
  }

  /** A one-commit repo — the gate baseline needs a resolvable HEAD. */
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'overload-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'overload@test.local'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Overload Test'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
    return dir
  }

  function seedTask(wsId: string): { blueprintId: string; task: any } {
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'overload attempts' })
    blueprintPhaseRepository.createAllPhases(bp.id)
    blueprintTaskRepository.create({
      blueprintId: bp.id,
      taskId: 'T001',
      wave: 1,
      description: 'Task T001',
      filePathsJson: ['a.ts'],
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
    /** How many times `executeTask` ran — builder rungs plus overload re-runs. */
    executions: number
    /** How many times the deterministic grader ran. */
    gradings: number
    /** The `attempt` argument of every `overloadBackoffMs` call, in order. */
    backoffCalls: number[]
    /** The `cap` argument of every `halveCapOnOverload` call, in order. */
    capHalvings: number[]
    /** The TaskResult `handleTaskCompletion` was handed — what the row is built from. */
    settledResult: any
    /** phaseProgress texts emitted during the run. */
    progress: string[]
    status: string
  }

  /**
   * Run one task through one scheduler with the REAL `dispatchTask` →
   * `executeTaskWithGates` path. Only the leaves are stubbed: `executeTask`
   * (the session) and `gradeTask` (the grader). `overloads` is how many
   * consecutive overload results the session returns before succeeding —
   * 3 exceeds OVERLOAD_MAX_RETRIES and drives the exhaustion case.
   */
  async function runOne(mode: 'dag' | 'wave', opts: { overloads: number }): Promise<Run> {
    const wsId = freshWs()
    const dir = makeRepo()
    const { blueprintId, task } = seedTask(wsId)
    const svc = new BlueprintBuildService()

    // Compress the 60 s overload backoff through the production seam, and RECORD
    // the calls. Overriding a seam the code has stopped calling is silent: the
    // run would take the real path and die on a harness timeout rather than a
    // failed assertion, which reads as flake instead of regression. Nothing
    // process-global is touched, so this suite is safe alongside any other.
    const backoffCalls: number[] = []
    svc.overloadBackoffMs = (attempt: number): number => {
      backoffCalls.push(attempt)
      return 1
    }

    const capHalvings: number[] = []
    svc.halveCapOnOverload = (cap: number): number => {
      capHalvings.push(cap)
      return Math.max(1, Math.floor(cap / 2))
    }

    let executions = 0
    svc.executeTask = async (): Promise<unknown> => {
      executions++
      return executions <= opts.overloads
        ? { success: false, completion: null, discoveries: [], failureReason: 'overload' }
        : { success: true, completion: null, discoveries: [] }
    }

    let gradings = 0
    svc.gradeTask = async (): Promise<unknown> => {
      gradings++
      return { overall: 'pass', gates: [] }
    }
    svc.runWaveGates = async (): Promise<unknown> => ({ overall: 'pass', gates: [] })
    svc.resolveGateCommandsFor = (): unknown => ({})
    svc.readManifestsCached = (): unknown => ({})

    // The TaskResult that reaches the row — the old path's defect was visible
    // exactly here, as a `verified` outcome with no gateReport behind it.
    let settledResult: any = null
    const realCompletion = svc.handleTaskCompletion.bind(svc)
    svc.handleTaskCompletion = (p: any): void => {
      settledResult = p.taskResult
      realCompletion(p)
    }

    const progress: string[] = []
    svc.on('phaseProgress', (d: any) => progress.push(String(d?.text ?? '')))

    const common = {
      blueprintId,
      workspaceId: wsId,
      workspacePath: dir,
      executionPath: dir,
      phaseContext: {} as never
    }

    if (mode === 'dag') {
      const { buildTaskDag } = require('../../../shared/task-dag')
      const dag = buildTaskDag([{ taskId: 'T001', wave: 1, dependsOnJson: [] }])
      await svc.executeDag({ dag, ...common, result: emptyResult(true) })
    } else {
      await svc.executeWave({
        waveNum: 1,
        waveTasks: [task],
        ...common,
        result: emptyResult(false)
      })
    }

    const after = blueprintTaskRepository.findById(task.id)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    return {
      attempts: after.attempts,
      executions,
      gradings,
      backoffCalls,
      capHalvings,
      settledResult,
      progress,
      status: after.status
    }
  }

  const gitOnly = { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }

  for (const mode of ['dag', 'wave'] as const) {
    describe(`A11 overload retry in the gate ladder — ${mode} scheduler`, () => {
      test(
        'a task that recovers from overload is GRADED, not waved through',
        async () => {
          const run = await runOne(mode, { overloads: 1 })

          assert.equal(run.executions, 2, 'one overload, one re-run')
          assert.deepEqual(
            run.backoffCalls,
            [1],
            'the backoff must be taken through `overloadBackoffMs` — an inline ' +
              'expression here means this suite silently waits the real 60 s'
          )
          assert.ok(
            run.gradings >= 1,
            'THE POINT OF A11: the old scheduler re-dispatch bypassed the ladder, ' +
              'so a recovered task was never graded at all'
          )
          assert.ok(
            run.settledResult?.gateReport,
            'the settled result must carry the grader verdict — without it ' +
              'handleTaskCompletion stamps `verified` on the strength of nothing'
          )
          assert.equal(run.settledResult?.success, true)
          assert.equal(run.status, 'complete')
        },
        gitOnly
      )

      test(
        'the overload re-run consumes no builder attempt but does record one',
        async () => {
          const run = await runOne(mode, { overloads: 1 })
          // Two executions, two attempts: the re-run is a distinct execution and
          // must count as one, or it shares an attempt number with the execution
          // it replaced — on precisely the failure path `turn_usage.attempt`
          // exists to study. It is NOT a builder rung: `MAX_BUILDER_ATTEMPTS` is
          // untouched, which is why the ladder still had a rung left to grade.
          assert.equal(run.attempts, 2)
          assert.equal(run.executions, 2)
        },
        gitOnly
      )

      test(
        'a clean run spends no overload machinery',
        async () => {
          const run = await runOne(mode, { overloads: 0 })
          assert.equal(run.executions, 1)
          assert.equal(run.attempts, 1)
          assert.deepEqual(run.backoffCalls, [], 'no overload, no backoff')
          assert.deepEqual(run.capHalvings, [], 'no overload, no back-pressure')
          assert.equal(run.status, 'complete')
        },
        gitOnly
      )

      test(
        'the cap is halved exactly once for a task that saw an overload',
        async () => {
          const run = await runOne(mode, { overloads: 1 })
          assert.equal(
            run.capHalvings.length,
            1,
            'once per task — retries now happen inside the ladder, so the ' +
              'scheduler sees one settle and must not compound the reduction'
          )
        },
        gitOnly
      )

      test(
        'exhausted overload returns exactly `overload`',
        async () => {
          // 3 overloads > OVERLOAD_MAX_RETRIES (2): initial + 2 re-runs all fail.
          const run = await runOne(mode, { overloads: 3 })

          assert.equal(run.executions, 3, 'initial run plus OVERLOAD_MAX_RETRIES re-runs')
          assert.deepEqual(run.backoffCalls, [1, 2], 'exponential, one per re-run')
          assert.equal(
            run.settledResult?.failureReason,
            'overload',
            "executeWave's drain check compares this string on EQUALITY — any " +
              'suffix or rewording silently costs the operator the terminal message'
          )
          assert.equal(run.settledResult?.overloadCount, 2)
          assert.equal(run.status, 'failed')
        },
        gitOnly
      )
    })
  }

  describe('A11 — the wave drain message survives the move', () => {
    test(
      'exhausted overload still emits the terminal wave message',
      async () => {
        const run = await runOne('wave', { overloads: 3 })
        assert.ok(
          run.progress.some((t) => /failed after 3 attempts/.test(t)),
          'this message is keyed off `failureReason === "overload"` at the drain ' +
            'check; it is the only UI trace of a permanently overloaded task'
        )
      },
      gitOnly
    )
  })

  // The suite above overrides both seams, so nothing in it observes the
  // production numbers. These pin them.
  describe('overload seams — production behaviour', () => {
    test('backoff doubles from a 60 s base', () => {
      const svc = new BlueprintBuildService()
      assert.equal(svc.overloadBackoffMs(1), 60_000)
      assert.equal(svc.overloadBackoffMs(2), 120_000)
    })

    test('cap halving floors at 1 and never divides below it', () => {
      const svc = new BlueprintBuildService()
      assert.equal(svc.halveCapOnOverload(6, 'x', 'T1'), 3)
      assert.equal(svc.halveCapOnOverload(3, 'x', 'T1'), 1)
      assert.equal(svc.halveCapOnOverload(2, 'x', 'T1'), 1)
      assert.equal(svc.halveCapOnOverload(1, 'x', 'T1'), 1, 'already serial — nothing to give')
    })
  })
}

if (require.main === module) void summaryAsync()
