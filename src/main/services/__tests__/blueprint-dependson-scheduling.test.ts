/**
 * blueprint-dependson-scheduling.test.ts — BP-DEPENDSON-DISPATCH-01.
 *
 * `dependsOn` was persisted by the tasks phase, rendered into the task prompt,
 * and read by nothing else. The wave scheduler guarded only on file *writes*, so
 * a gate task — one that validates what its wave-mates produce and therefore
 * declares no overlapping files — dispatched alongside them and tested against
 * half-applied edits.
 *
 * These tests pin both halves of the fix: declared dependencies serialize, and
 * nothing else does (no throughput regression).
 *
 * Run: tsx src/main/services/__tests__/blueprint-dependson-scheduling.test.ts
 */
import assert from 'node:assert/strict'
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
  console.log(`⚠ dependsOn scheduling setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('dependsOn scheduling (skipped — no DB)', () => {
    test('gate task waits for its dependencies', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  type TaskSpec = { taskId: string; files: string[]; dependsOn?: string[] }

  function seedWave(specs: TaskSpec[]): { blueprintId: string; tasks: any[] } {
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'dependsOn test' })
    blueprintPhaseRepository.createAllPhases(bp.id)
    for (const spec of specs) {
      blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: spec.taskId,
        wave: 1,
        description: `Task ${spec.taskId}`,
        filePathsJson: spec.files,
        isParallel: true,
        dependsOnJson: spec.dependsOn ?? []
      })
    }
    return { blueprintId: bp.id, tasks: blueprintTaskRepository.findByBlueprint(bp.id) }
  }

  /**
   * Run one wave with dispatch stubbed out. Each dispatched task settles on a
   * short timer, and we record what had already finished at the moment it was
   * dispatched — which is exactly the fact the guard is about.
   */
  async function runWave(specs: TaskSpec[]): Promise<{
    order: string[]
    settledAtDispatch: Map<string, string[]>
    maxConcurrent: number
  }> {
    const { blueprintId, tasks } = seedWave(specs)
    const svc = new BlueprintBuildService()

    const order: string[] = []
    const settled = new Set<string>()
    const settledAtDispatch = new Map<string, string[]>()
    let maxConcurrent = 0

    svc.dispatchTask = (p: any): void => {
      order.push(p.task.taskId)
      settledAtDispatch.set(p.task.taskId, [...settled])
      const promise = new Promise((resolve) => {
        setTimeout(() => {
          settled.add(p.task.taskId)
          resolve({ success: true, completion: null, discoveries: [] })
        }, 10)
      })
      p.inFlight.set(p.task.taskId, { promise, files: p.taskFiles, task: p.task })
      maxConcurrent = Math.max(maxConcurrent, p.inFlight.size)
    }

    const result = {
      tasksCompleted: 0,
      tasksResumed: 0,
      filesCreated: [],
      filesModified: [],
      discoveries: [],
      failed: false,
      taskTimings: [],
      taskFailures: []
    }

    await svc.executeWave({
      waveNum: 1,
      waveTasks: tasks,
      blueprintId,
      workspaceId: wsId,
      workspacePath: '/tmp/nonexistent-workspace',
      executionPath: '/tmp/nonexistent-workspace',
      phaseContext: {} as never,
      result
    })

    return { order, settledAtDispatch, maxConcurrent }
  }

  describe('dependsOn gates dispatch', () => {
    test('a gate task does not start until every declared dependency has finished', async () => {
      const { order, settledAtDispatch } = await runWave([
        { taskId: 'T001', files: ['src/a.ts'] },
        { taskId: 'T002', files: ['src/b.ts'] },
        // Declares no overlapping files — the file guard alone would let this
        // run alongside T001/T002, which is exactly the T017 failure.
        { taskId: 'T003', files: ['src/gate.ts'], dependsOn: ['T001', 'T002'] }
      ])

      assert.equal(order.length, 3, 'all three tasks eventually run')
      assert.equal(order[order.length - 1], 'T003', 'the gate task runs last')

      const before = settledAtDispatch.get('T003')!
      assert.ok(before.includes('T001'), 'T001 must be finished before the gate starts')
      assert.ok(before.includes('T002'), 'T002 must be finished before the gate starts')
    })

    test('a dependency declared but absent from the wave does not block', async () => {
      // The dependency is in an earlier wave (or was removed). Blocking on a task
      // that is neither in-flight nor pending here would hang the wave.
      const { order } = await runWave([
        { taskId: 'T010', files: ['src/a.ts'], dependsOn: ['T001'] }
      ])
      assert.deepEqual(order, ['T010'])
    })

    test('independent tasks still run in parallel — no throughput regression', async () => {
      const { maxConcurrent } = await runWave([
        { taskId: 'T001', files: ['src/a.ts'] },
        { taskId: 'T002', files: ['src/b.ts'] },
        { taskId: 'T003', files: ['src/c.ts'] }
      ])
      assert.ok(
        maxConcurrent >= 2,
        `tasks with no declared dependencies must still overlap (max in-flight was ${maxConcurrent})`
      )
    })

    test('a dependency cycle still drains instead of hanging the wave', async () => {
      // blueprint-task-validator catches these before execution; the scheduler
      // must not deadlock if one slips through.
      const { order } = await runWave([
        { taskId: 'T001', files: ['src/a.ts'], dependsOn: ['T002'] },
        { taskId: 'T002', files: ['src/b.ts'], dependsOn: ['T001'] }
      ])
      assert.equal(order.length, 2, 'both tasks run — a wrong order beats a hung wave')
    })
  })
}

// summaryAsync() calls process.exit() — only run it as the entry point, or the
// shared runner is terminated mid-list.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
