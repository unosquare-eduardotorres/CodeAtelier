/**
 * blueprint-task-user-skip.test.ts — BP-TASK-USER-SKIP-01.
 *
 * A task whose planned files cannot be inspected fails identically on every
 * attempt. `status = 'skipped'` was never an escape hatch: retryPhase resets it
 * to 'pending', and the failure cascade writes it on its own. The skip decision
 * therefore lives in its own column.
 *
 * Covers: BlueprintTaskRepository.setUserSkipped, BlueprintService.setTaskUserSkipped,
 * and the retry rule that must leave a user-skipped task alone.
 *
 * Run: tsx src/main/services/__tests__/blueprint-task-user-skip.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintPhaseRepository: any
let blueprintTaskRepository: any
let blueprintService: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
  blueprintTaskRepository = repos.blueprintTaskRepository
  blueprintService = require('../blueprint.service').blueprintService
} catch (err) {
  console.log(`⚠ blueprint task user-skip setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('blueprint task user-skip (skipped — no DB)', () => {
    test('setUserSkipped round trip', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  /** A failed blueprint parked on a failed BUILD phase, with the given tasks. */
  function seedFailedBuild(
    taskSpecs: Array<{ taskId: string; status: 'complete' | 'failed' | 'pending' }>
  ): { blueprintId: string } {
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Skip test' })
    blueprintPhaseRepository.createAllPhases(bp.id)
    const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'build')
    blueprintPhaseRepository.updateStatus(buildPhase.id, 'failed')
    blueprintRepository.update(bp.id, { currentPhase: 'build', status: 'failed' })

    for (const spec of taskSpecs) {
      const task = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: spec.taskId,
        wave: 1,
        description: `Task ${spec.taskId}`,
        filePathsJson: ['src/whatever.ts']
      })
      if (spec.status !== 'pending') {
        blueprintTaskRepository.updateStatus(task.id, spec.status)
      }
    }
    return { blueprintId: bp.id }
  }

  /**
   * retryPhase drives the pipeline state machine at the end, and other files in
   * the shared runner replace that module with a partial mock. The machine is
   * not what these tests assert, so stub it for the duration of the call.
   */
  function withStubbedMachine<T>(fn: () => T): T {
    const original = blueprintService.getMachine
    blueprintService.getMachine = (): unknown => ({
      isTerminal: () => true,
      isIdle: () => true,
      isRunning: () => false,
      transition: () => {},
      forceReset: () => {}
    })
    try {
      return fn()
    } finally {
      blueprintService.getMachine = original
    }
  }

  function findTask(blueprintId: string, taskId: string): any {
    return blueprintTaskRepository
      .findByBlueprint(blueprintId)
      .find((t: any) => t.taskId === taskId)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Repository
  // ═══════════════════════════════════════════════════════════════════════

  describe('BlueprintTaskRepository.setUserSkipped', () => {
    test('new tasks start with skippedByUserAt = null', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T001', status: 'pending' }])
      assert.equal(findTask(blueprintId, 'T001').skippedByUserAt, null)
    })

    test('skip sets a timestamp and leaves status untouched', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T001', status: 'failed' }])
      const task = findTask(blueprintId, 'T001')

      const updated = blueprintTaskRepository.setUserSkipped(task.id, true)
      assert.ok(updated.skippedByUserAt, 'skippedByUserAt should be set')
      assert.equal(updated.status, 'failed', 'status must not be rewritten by a skip')
    })

    test('un-skip clears the timestamp (reversible)', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T001', status: 'failed' }])
      const task = findTask(blueprintId, 'T001')

      blueprintTaskRepository.setUserSkipped(task.id, true)
      const cleared = blueprintTaskRepository.setUserSkipped(task.id, false)
      assert.equal(cleared.skippedByUserAt, null)
    })

    test('a note round-trips, and un-skipping clears it', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T001', status: 'failed' }])
      const task = findTask(blueprintId, 'T001')

      const skipped = blueprintTaskRepository.setUserSkipped(task.id, true, 'verified by hand')
      assert.equal(skipped.resolutionNote, 'verified by hand')

      // A note without a decision attached to it would be misleading.
      const cleared = blueprintTaskRepository.setUserSkipped(task.id, false)
      assert.equal(cleared.resolutionNote, null)
    })
  })

  // ════════════════════════════════════════════════════════════════
  // Outcome columns (migration 146)
  // ════════════════════════════════════════════════════════════════

  describe('BlueprintTaskRepository.setOutcome', () => {
    test('new tasks start with no outcome recorded', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T001', status: 'pending' }])
      const task = findTask(blueprintId, 'T001')
      assert.equal(task.failureReason, null)
      assert.equal(task.outcomeKind, null)
      assert.equal(task.resolutionNote, null)
    })

    test('a failure reason survives the retry reset to pending', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T001', status: 'failed' }])
      const task = findTask(blueprintId, 'T001')
      blueprintTaskRepository.setOutcome(task.id, {
        failureReason: 'verification failed — 3 stale'
      })

      withStubbedMachine(() => blueprintService.retryPhase(blueprintId))

      const after = findTask(blueprintId, 'T001')
      assert.equal(after.status, 'pending', 'retry re-queues the task')
      assert.equal(
        after.failureReason,
        'verification failed — 3 stale',
        'the reason must reach the next attempt — otherwise it walks into the same trap'
      )
    })

    test('partial updates leave the other columns alone', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T001', status: 'failed' }])
      const task = findTask(blueprintId, 'T001')

      blueprintTaskRepository.setOutcome(task.id, { failureReason: 'boom' })
      const onlyKind = blueprintTaskRepository.setOutcome(task.id, { outcomeKind: 'unproven' })
      assert.equal(onlyKind.failureReason, 'boom')
      assert.equal(onlyKind.outcomeKind, 'unproven')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Service
  // ═══════════════════════════════════════════════════════════════════════

  describe('BlueprintService.setTaskUserSkipped', () => {
    test('skip then un-skip round trips by task id', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T007', status: 'failed' }])

      const skipped = blueprintService.setTaskUserSkipped(blueprintId, 'T007', true)
      assert.ok(skipped.skippedByUserAt)
      assert.ok(findTask(blueprintId, 'T007').skippedByUserAt)

      const unskipped = blueprintService.setTaskUserSkipped(blueprintId, 'T007', false)
      assert.equal(unskipped.skippedByUserAt, null)
      assert.equal(findTask(blueprintId, 'T007').skippedByUserAt, null)
    })

    test('accepting a FAILED task records it as accepted_by_user, with the note', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T005', status: 'failed' }])

      const accepted = blueprintService.setTaskUserSkipped(
        blueprintId,
        'T005',
        true,
        'applied manually'
      )
      assert.ok(accepted.skippedByUserAt)
      assert.equal(accepted.outcomeKind, 'accepted_by_user')
      assert.equal(accepted.resolutionNote, 'applied manually')
      assert.equal(accepted.status, 'failed', 'status is untouched — no new status value')

      // Reopening it must not leave the row claiming a human accepted it.
      const reopened = blueprintService.setTaskUserSkipped(blueprintId, 'T005', false)
      assert.equal(reopened.outcomeKind, null)
      assert.equal(reopened.skippedByUserAt, null)
    })

    test('skipping a PENDING task is a skip, not an acceptance', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T006', status: 'pending' }])
      const skipped = blueprintService.setTaskUserSkipped(blueprintId, 'T006', true)
      assert.ok(skipped.skippedByUserAt)
      assert.equal(skipped.outcomeKind, null, 'never ran ≠ verified externally')
    })

    test('throws for a task that does not belong to the blueprint', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T001', status: 'failed' }])
      assert.throws(
        () => blueprintService.setTaskUserSkipped(blueprintId, 'T999', true),
        /not found/i
      )
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Retry — the assertion that would have caught the loop
  // ═══════════════════════════════════════════════════════════════════════

  describe('executeWave treats a user-skipped task as settled', () => {
    test('does not dispatch it, does not fail the wave, counts it as done', async () => {
      const { BlueprintBuildService } = require('../blueprint-build.service')
      const svc = new BlueprintBuildService()

      const { blueprintId } = seedFailedBuild([
        { taskId: 'T001', status: 'pending' },
        { taskId: 'T002', status: 'pending' }
      ])
      blueprintService.setTaskUserSkipped(blueprintId, 'T001', true)
      blueprintService.setTaskUserSkipped(blueprintId, 'T002', true)

      let dispatched = 0
      svc.dispatchTask = (): void => {
        dispatched++
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
        waveTasks: blueprintTaskRepository.findByBlueprint(blueprintId),
        blueprintId,
        workspaceId: wsId,
        workspacePath: '/tmp/nonexistent-workspace',
        executionPath: '/tmp/nonexistent-workspace',
        phaseContext: {} as never,
        result
      })

      assert.equal(dispatched, 0, 'a user-skipped task is never dispatched')
      assert.equal(result.failed, false, 'a user-skipped task cannot fail the wave')
      assert.equal(result.tasksCompleted, 2, 'it counts toward wave completion')
    })
  })

  describe('retryPhase respects a user skip', () => {
    test('resets a plain failed task but leaves a user-skipped one alone', () => {
      const { blueprintId } = seedFailedBuild([
        { taskId: 'T001', status: 'failed' },
        { taskId: 'T002', status: 'failed' },
        { taskId: 'T003', status: 'complete' }
      ])
      blueprintService.setTaskUserSkipped(blueprintId, 'T002', true)

      withStubbedMachine(() => blueprintService.retryPhase(blueprintId))

      assert.equal(findTask(blueprintId, 'T001').status, 'pending', 'plain failed task resets')
      assert.equal(
        findTask(blueprintId, 'T002').status,
        'failed',
        'user-skipped task is not re-queued'
      )
      assert.ok(findTask(blueprintId, 'T002').skippedByUserAt, 'skip mark survives the retry')
      assert.equal(findTask(blueprintId, 'T003').status, 'complete', 'complete tasks untouched')
    })

    test('an un-skipped task is re-queued by the next retry', () => {
      const { blueprintId } = seedFailedBuild([{ taskId: 'T001', status: 'failed' }])
      blueprintService.setTaskUserSkipped(blueprintId, 'T001', true)
      withStubbedMachine(() => blueprintService.retryPhase(blueprintId))
      assert.equal(findTask(blueprintId, 'T001').status, 'failed')

      // Park the blueprint back on a failed build phase and clear the skip.
      const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
      blueprintPhaseRepository.updateStatus(buildPhase.id, 'failed')
      blueprintRepository.update(blueprintId, { currentPhase: 'build', status: 'failed' })
      blueprintService.setTaskUserSkipped(blueprintId, 'T001', false)

      withStubbedMachine(() => blueprintService.retryPhase(blueprintId))
      assert.equal(findTask(blueprintId, 'T001').status, 'pending')
    })
  })
}

// summaryAsync() calls process.exit() — only run it as the entry point, or the
// shared runner is terminated mid-list.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
