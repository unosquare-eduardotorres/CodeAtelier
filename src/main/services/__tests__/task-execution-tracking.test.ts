/**
 * Unit tests for task-level execution tracking.
 *
 * Tests the plan-execution store's updateTask action, task hydration from
 * PhaseProgress, and backward compatibility (phaseProgress without task fields).
 *
 * These are pure-logic tests — they exercise the store/type contracts without
 * Electron or renderer dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import type { PhaseProgress } from '../../../shared/types'

// ── TaskProgress type validation tests ──

describe('task-execution-tracking › TaskProgress type shape', () => {
  test('TaskProgress accepts all valid statuses', () => {
    const statuses = ['pending', 'running', 'complete', 'failed', 'skipped'] as const
    for (const status of statuses) {
      const task = { taskId: 't-1', title: 'Test', status }
      assert.equal(task.status, status)
    }
  })

  test('TaskProgress with optional fields', () => {
    const task = {
      taskId: 't-1',
      title: 'Add endpoint',
      status: 'running' as const,
      startedAt: Date.now(),
      files: ['src/api/login.ts', 'src/api/signup.ts']
    }
    assert.equal(task.files?.length, 2)
    assert.ok(task.startedAt)
  })
})

// ── PhaseProgress persistence shape tests ──

describe('task-execution-tracking › PhaseProgress task persistence', () => {
  test('PhaseProgress without tasks is backward-compatible', () => {
    const progress: PhaseProgress = {
      phaseId: 1,
      status: 'completed',
      startedAt: '2026-07-28T00:00:00Z',
      completedAt: '2026-07-28T00:01:00Z',
      touchedFiles: ['src/app.ts']
    }
    assert.equal(progress.tasks, undefined)
    // Should serialize/deserialize cleanly without tasks field
    const json = JSON.stringify(progress)
    const parsed = JSON.parse(json) as PhaseProgress
    assert.equal(parsed.tasks, undefined)
    assert.equal(parsed.phaseId, 1)
  })

  test('PhaseProgress with tasks round-trips through JSON', () => {
    const progress: PhaseProgress = {
      phaseId: 2,
      status: 'in_progress',
      startedAt: '2026-07-28T00:00:00Z',
      completedAt: null,
      touchedFiles: [],
      tasks: [
        { taskId: '2-0', title: 'Add login endpoint', status: 'complete' },
        { taskId: '2-1', title: 'Add signup endpoint', status: 'running' },
        { taskId: '2-2', title: 'Add forgot-password', status: 'pending' }
      ]
    }
    const json = JSON.stringify(progress)
    const parsed = JSON.parse(json) as PhaseProgress
    assert.equal(parsed.tasks?.length, 3)
    assert.equal(parsed.tasks?.[0]?.taskId, '2-0')
    assert.equal(parsed.tasks?.[0]?.status, 'complete')
    assert.equal(parsed.tasks?.[1]?.status, 'running')
    assert.equal(parsed.tasks?.[2]?.status, 'pending')
  })

  test('Task update merges into existing tasks array', () => {
    const tasks = [
      { taskId: '1-0', title: 'Setup', status: 'complete' },
      { taskId: '1-1', title: 'Implement', status: 'pending' }
    ]
    const update = { taskId: '1-1', title: 'Implement', status: 'running' }

    const idx = tasks.findIndex((t) => t.taskId === update.taskId)
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], ...update }
    }

    assert.equal(tasks[1].status, 'running')
    assert.equal(tasks[0].status, 'complete')
  })

  test('New task appends to tasks array', () => {
    const tasks = [{ taskId: '1-0', title: 'Setup', status: 'complete' }]
    const update = { taskId: '1-1', title: 'Implement', status: 'running' }

    const idx = tasks.findIndex((t) => t.taskId === update.taskId)
    if (idx < 0) {
      tasks.push(update)
    }

    assert.equal(tasks.length, 2)
    assert.equal(tasks[1].taskId, '1-1')
    assert.equal(tasks[1].status, 'running')
  })
})

// ── PhaseProgressEvent backward compatibility ──

describe('task-execution-tracking › PhaseProgressEvent backward compat', () => {
  test('phaseProgress without task fields processes cleanly', () => {
    const progress = {
      planId: 'plan-123',
      phaseId: 1,
      phaseTitle: 'Setup project',
      status: 'started' as const,
      totalPhases: 3
    }
    // Simulates the condition check in useAppIpcListeners:
    // if (data.phaseProgress.taskId && data.phaseProgress.taskStatus)
    const taskId = (progress as Record<string, unknown>).taskId as string | undefined
    const taskStatus = (progress as Record<string, unknown>).taskStatus as string | undefined
    const shouldUpdateTask = !!(taskId && taskStatus)
    assert.equal(shouldUpdateTask, false)
  })

  test('phaseProgress with task fields extracts correctly', () => {
    const progress = {
      planId: 'plan-456',
      phaseId: 2,
      phaseTitle: 'Auth endpoints',
      status: 'in_progress' as const,
      totalPhases: 4,
      taskId: '2-1',
      taskTitle: 'Add login endpoint',
      taskStatus: 'running' as const,
      totalTasks: 3
    }
    assert.ok(progress.taskId)
    assert.ok(progress.taskStatus)
    assert.equal(progress.taskTitle, 'Add login endpoint')
    assert.equal(progress.totalTasks, 3)
  })
})

// ── Store action logic tests (pure, no zustand dependency) ──

describe('task-execution-tracking › updateTask logic', () => {
  // Simulate the core updateTask logic without zustand
  function applyTaskUpdate(
    phases: Array<{
      phaseId: number
      tasks: Array<{
        taskId: string
        title: string
        status: string
        startedAt?: number
        completedAt?: number
      }>
    }>,
    update: { phaseId: number; taskId: string; title: string; status: string }
  ): typeof phases {
    return phases.map((p) => {
      if (p.phaseId !== update.phaseId) return p
      let tasks = [...p.tasks]
      const idx = tasks.findIndex((t) => t.taskId === update.taskId)
      if (idx >= 0) {
        tasks[idx] = {
          ...tasks[idx],
          title: update.title,
          status: update.status,
          startedAt:
            update.status === 'running'
              ? (tasks[idx].startedAt ?? Date.now())
              : tasks[idx].startedAt,
          completedAt:
            update.status === 'complete' || update.status === 'failed'
              ? Date.now()
              : tasks[idx].completedAt
        }
      } else {
        tasks = [
          ...tasks,
          {
            taskId: update.taskId,
            title: update.title,
            status: update.status,
            startedAt: update.status === 'running' ? Date.now() : undefined,
            completedAt:
              update.status === 'complete' || update.status === 'failed' ? Date.now() : undefined
          }
        ]
      }
      return { ...p, tasks }
    })
  }

  test('updates existing task status', () => {
    const phases = [
      {
        phaseId: 1,
        tasks: [
          { taskId: '1-0', title: 'Setup', status: 'pending' },
          { taskId: '1-1', title: 'Implement', status: 'pending' }
        ]
      }
    ]

    const result = applyTaskUpdate(phases, {
      phaseId: 1,
      taskId: '1-0',
      title: 'Setup',
      status: 'running'
    })

    assert.equal(result[0].tasks[0].status, 'running')
    assert.ok(result[0].tasks[0].startedAt)
    assert.equal(result[0].tasks[1].status, 'pending')
  })

  test('appends new task if not found', () => {
    const phases = [
      {
        phaseId: 1,
        tasks: [{ taskId: '1-0', title: 'Setup', status: 'complete' }]
      }
    ]

    const result = applyTaskUpdate(phases, {
      phaseId: 1,
      taskId: '1-1',
      title: 'New task',
      status: 'running'
    })

    assert.equal(result[0].tasks.length, 2)
    assert.equal(result[0].tasks[1].taskId, '1-1')
    assert.equal(result[0].tasks[1].status, 'running')
  })

  test('does not modify other phases', () => {
    const phases = [
      { phaseId: 1, tasks: [{ taskId: '1-0', title: 'Setup', status: 'pending' }] },
      { phaseId: 2, tasks: [{ taskId: '2-0', title: 'Build', status: 'pending' }] }
    ]

    const result = applyTaskUpdate(phases, {
      phaseId: 2,
      taskId: '2-0',
      title: 'Build',
      status: 'running'
    })

    assert.equal(result[0].tasks[0].status, 'pending')
    assert.equal(result[1].tasks[0].status, 'running')
  })

  test('sets completedAt on complete/failed', () => {
    const phases = [
      {
        phaseId: 1,
        tasks: [{ taskId: '1-0', title: 'Setup', status: 'running', startedAt: Date.now() }]
      }
    ]

    const result = applyTaskUpdate(phases, {
      phaseId: 1,
      taskId: '1-0',
      title: 'Setup',
      status: 'complete'
    })

    assert.equal(result[0].tasks[0].status, 'complete')
    assert.ok(result[0].tasks[0].completedAt)
  })

  test('preserves startedAt on status transitions', () => {
    const startTime = Date.now() - 5000
    const phases = [
      {
        phaseId: 1,
        tasks: [{ taskId: '1-0', title: 'Setup', status: 'running', startedAt: startTime }]
      }
    ]

    const result = applyTaskUpdate(phases, {
      phaseId: 1,
      taskId: '1-0',
      title: 'Setup',
      status: 'complete'
    })

    assert.equal(result[0].tasks[0].startedAt, startTime)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
