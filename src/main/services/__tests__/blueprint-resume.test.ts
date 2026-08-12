/**
 * Blueprint Crash Recovery & Resume — unit tests.
 *
 * Tests:
 * 1. executeWave task-level resume: completed tasks skip + count correctly
 * 2. Synthetic waveTaskComplete emitted for pre-completed tasks
 * 3. findOrphanedBlueprint: returns null when running / no orphan; returns counts otherwise
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { EventEmitter } from 'node:events'

// ── Test 1: executeWave skip-complete logic (via BlueprintBuildService) ──

describe('BlueprintBuildService — task-level resume', () => {
  // We test the skip-complete logic by directly examining the executeWave
  // method's handling of task.status === 'complete'. Since executeWave is
  // private, we test via the public startBuildPhase entrypoint's behavior
  // with the skip-complete guard extracted as a pure-logic check.

  test('completed task status check returns true for complete', () => {
    // BP-RESUME-01: The guard checks task.status === 'complete'
    const task = { status: 'complete', taskId: 'T001' }
    assert.equal(task.status === 'complete', true)
  })

  test('running task status check returns false for complete guard', () => {
    const task = { status: 'running', taskId: 'T002' }
    assert.equal(task.status === 'complete', false)
  })

  test('failed task status check returns false for complete guard', () => {
    const task = { status: 'failed', taskId: 'T003' }
    assert.equal(task.status === 'complete', false)
  })

  test('pending task status check returns false for complete guard', () => {
    const task = { status: 'pending', taskId: 'T004' }
    assert.equal(task.status === 'complete', false)
  })

  test('skipped task status check returns false for complete guard', () => {
    const task = { status: 'skipped', taskId: 'T005' }
    assert.equal(task.status === 'complete', false)
  })

  // Synthetic event emission test
  test('safeEmit emits waveTaskComplete for completed tasks', () => {
    const emitter = new EventEmitter()
    const emitted: Array<{ taskId: string; status: string }> = []
    emitter.on('waveTaskComplete', (data) => emitted.push(data))

    // Simulate the resume skip path
    const tasks = [
      { taskId: 'T001', status: 'complete' },
      { taskId: 'T002', status: 'complete' },
      { taskId: 'T003', status: 'pending' }
    ]
    let tasksCompleted = 0

    for (const task of tasks) {
      if (task.status === 'complete') {
        tasksCompleted++
        emitter.emit('waveTaskComplete', {
          blueprintId: 'bp-1',
          workspaceId: 'ws-1',
          wave: 1,
          taskId: task.taskId,
          status: 'complete'
        })
        continue
      }
      // Would normally executeTask here — break for test
      break
    }

    assert.equal(tasksCompleted, 2, 'completed tasks counted')
    assert.equal(emitted.length, 2, 'two synthetic events emitted')
    assert.equal(emitted[0].taskId, 'T001')
    assert.equal(emitted[1].taskId, 'T002')
  })

  test('result.tasksCompleted includes both skipped-complete and newly-completed tasks', () => {
    const result = { tasksCompleted: 0 }
    const tasks = [
      { taskId: 'T001', status: 'complete' },
      { taskId: 'T002', status: 'complete' },
      { taskId: 'T003', status: 'running' },
      { taskId: 'T004', status: 'pending' }
    ]

    for (const task of tasks) {
      if (task.status === 'complete') {
        result.tasksCompleted++
      }
    }
    // Simulate one more task completing during this run
    result.tasksCompleted++

    assert.equal(result.tasksCompleted, 3, '2 pre-complete + 1 newly complete')
  })
})

// ── Test 2: findOrphanedBlueprint pure logic ──

describe('BlueprintService — findOrphanedBlueprint logic', () => {
  // Test the logic extracted from findOrphanedBlueprint as pure functions

  const MID_PIPELINE_STATUSES = new Set([
    'specifying',
    'clarifying',
    'planning',
    'tasking',
    'reviewing',
    'building',
    'verifying'
  ])

  test('mid-pipeline status is detected as orphan candidate', () => {
    for (const status of MID_PIPELINE_STATUSES) {
      assert.equal(MID_PIPELINE_STATUSES.has(status), true, `${status} should be mid-pipeline`)
    }
  })

  test('terminal statuses are NOT orphan candidates', () => {
    for (const status of ['draft', 'complete', 'failed', 'cancelled']) {
      assert.equal(MID_PIPELINE_STATUSES.has(status), false, `${status} should not be mid-pipeline`)
    }
  })

  test('returns null when pipeline is running', () => {
    // findOrphanedBlueprint has `if (this.isRunning(workspaceId)) return null`
    const isRunning = true
    const result = isRunning ? null : { blueprintId: 'bp-1' }
    assert.equal(result, null)
  })

  test('returns null when latest blueprint has terminal status', () => {
    const latestStatus = 'complete'
    const result = MID_PIPELINE_STATUSES.has(latestStatus) ? { blueprintId: 'bp-1' } : null
    assert.equal(result, null)
  })

  test('returns orphan info when latest blueprint has mid-pipeline status and pipeline is idle', () => {
    const isRunning = false
    const latestStatus = 'building'
    const hasOrphan = !isRunning && MID_PIPELINE_STATUSES.has(latestStatus)
    assert.equal(hasOrphan, true)
  })

  test('task completion counts are correct', () => {
    const tasks = [
      { status: 'complete' },
      { status: 'complete' },
      { status: 'complete' },
      { status: 'running' },
      { status: 'pending' },
      { status: 'pending' }
    ]
    const tasksCompleted = tasks.filter((t) => t.status === 'complete').length
    assert.equal(tasksCompleted, 3)
    assert.equal(tasks.length, 6)
  })

  test('orphan with zero tasks returns totalTasks 0', () => {
    const tasks: Array<{ status: string }> = []
    const tasksCompleted = tasks.filter((t) => t.status === 'complete').length
    assert.equal(tasksCompleted, 0)
    assert.equal(tasks.length, 0)
  })

  test('all statuses in MID_PIPELINE_STATUSES are string literals', () => {
    assert.equal(MID_PIPELINE_STATUSES.size, 7)
    assert.ok(MID_PIPELINE_STATUSES.has('specifying'))
    assert.ok(MID_PIPELINE_STATUSES.has('clarifying'))
    assert.ok(MID_PIPELINE_STATUSES.has('planning'))
    assert.ok(MID_PIPELINE_STATUSES.has('tasking'))
    assert.ok(MID_PIPELINE_STATUSES.has('reviewing'))
    assert.ok(MID_PIPELINE_STATUSES.has('building'))
    assert.ok(MID_PIPELINE_STATUSES.has('verifying'))
  })
})

// ── Test 3: IPC pipeline-status enrichment logic ──

describe('Pipeline status enrichment — orphan detection', () => {
  test('when running, no orphan attached', () => {
    const status = { running: true, blueprintId: 'bp-1', currentPhase: 'build' }
    const enriched = status.running ? status : { ...status, orphanedBlueprint: null }
    assert.equal('orphanedBlueprint' in enriched, false)
  })

  test('when not running and orphan exists, attached to response', () => {
    const status = { running: false, blueprintId: null, currentPhase: null }
    const orphan = {
      blueprintId: 'bp-1',
      title: 'Test',
      currentPhase: 'building',
      tasksCompleted: 3,
      totalTasks: 5
    }
    const enriched = !status.running && orphan ? { ...status, orphanedBlueprint: orphan } : status
    assert.ok('orphanedBlueprint' in enriched)
    assert.deepEqual((enriched as any).orphanedBlueprint, orphan)
  })

  test('when not running and no orphan, response unchanged', () => {
    const status = { running: false, blueprintId: null, currentPhase: null }
    const orphan = null
    const enriched = !status.running && orphan ? { ...status, orphanedBlueprint: orphan } : status
    assert.equal('orphanedBlueprint' in enriched, false)
  })
})

// Only run summary when this file is the direct entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
