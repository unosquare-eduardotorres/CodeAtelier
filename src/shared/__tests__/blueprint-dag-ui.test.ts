/**
 * blueprint-dag-ui.test.ts — D4 tests for the DAG-scheduling UI derivations.
 *
 * The BUILD scheduler dispatches by dependsOn readiness; the UI derives
 * ready/blocked chips and wave completion from task statuses (no schema
 * migration, no new events). These tests pin the pure derivations in
 * src/shared/task-readiness.ts.
 *
 * Run: tsx src/shared/__tests__/blueprint-dag-ui.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../main/services/__tests__/test-harness'
import {
  isTerminalTask,
  taskReadiness,
  waveCompletion,
  type ReadinessTask
} from '../task-readiness'

function t(
  taskId: string,
  wave: number,
  status: string,
  dependsOn?: string[],
  skippedByUserAt?: string | null
): ReadinessTask {
  return {
    taskId,
    wave,
    status,
    dependsOnJson: dependsOn ?? [],
    skippedByUserAt: skippedByUserAt ?? null
  }
}

describe('isTerminalTask', () => {
  test('complete, failed, and user-skipped are terminal', () => {
    assert.ok(isTerminalTask(t('A', 1, 'complete')))
    assert.ok(isTerminalTask(t('A', 1, 'failed')))
    assert.ok(isTerminalTask(t('A', 1, 'skipped', [], '2025-01-01T00:00:00Z')))
  })
  test('pending, running, and cascade-skipped are NOT terminal', () => {
    assert.ok(!isTerminalTask(t('A', 1, 'pending')))
    assert.ok(!isTerminalTask(t('A', 1, 'running')))
    assert.ok(!isTerminalTask(t('A', 1, 'skipped', [], null)))
  })
})

describe('taskReadiness', () => {
  test('pending task with all deps settled is ready', () => {
    const r = taskReadiness([t('A', 1, 'complete'), t('B', 2, 'pending', ['A'])])
    assert.deepEqual(r.get('B'), { ready: true, blockedBy: [] })
  })

  test('pending task with an unsettled dep is blocked, naming the blocker', () => {
    const r = taskReadiness([t('A', 1, 'running'), t('B', 2, 'pending', ['A'])])
    assert.deepEqual(r.get('B'), { ready: false, blockedBy: ['A'] })
  })

  test('user-skipped dep satisfies readiness (matches scheduler rule)', () => {
    const r = taskReadiness([
      t('A', 1, 'skipped', [], '2025-01-01T00:00:00Z'),
      t('B', 2, 'pending', ['A'])
    ])
    assert.deepEqual(r.get('B'), { ready: true, blockedBy: [] })
  })

  test('cascade-skipped dep blocks (no silent misorder in the UI either)', () => {
    const r = taskReadiness([t('A', 1, 'skipped', [], null), t('B', 2, 'pending', ['A'])])
    assert.deepEqual(r.get('B'), { ready: false, blockedBy: ['A'] })
  })

  test('failed dep blocks', () => {
    const r = taskReadiness([t('A', 1, 'failed'), t('B', 2, 'pending', ['A'])])
    assert.deepEqual(r.get('B'), { ready: false, blockedBy: ['A'] })
  })

  test('terminal tasks are never shown ready or blocked', () => {
    const r = taskReadiness([t('A', 1, 'complete'), t('B', 1, 'running'), t('C', 1, 'failed')])
    assert.deepEqual(r.get('A'), { ready: false, blockedBy: [] })
    assert.deepEqual(r.get('C'), { ready: false, blockedBy: [] })
  })

  test('running task with unsettled dep still reports its blockers', () => {
    // Running tasks dispatched before a dep settled cannot happen under the
    // scheduler, but the derivation must not crash or lie if statuses race.
    const r = taskReadiness([t('A', 1, 'pending'), t('B', 2, 'running', ['A'])])
    assert.deepEqual(r.get('B'), { ready: false, blockedBy: ['A'] })
  })

  test('unknown dep ids are ignored (scheduler drops them too)', () => {
    const r = taskReadiness([t('B', 2, 'pending', ['GHOST'])])
    assert.deepEqual(r.get('B'), { ready: true, blockedBy: [] })
  })

  test('multiple blockers all listed', () => {
    const r = taskReadiness([
      t('A', 1, 'pending'),
      t('B', 1, 'running'),
      t('C', 2, 'pending', ['A', 'B'])
    ])
    assert.deepEqual(r.get('C'), { ready: false, blockedBy: ['A', 'B'] })
  })
})

describe('waveCompletion (derived)', () => {
  test('wave complete only when ALL its tasks are terminal', () => {
    const w = waveCompletion([
      t('A', 1, 'complete'),
      t('B', 1, 'complete'),
      t('C', 2, 'running'),
      t('D', 2, 'pending')
    ])
    assert.equal(w.get(1), true)
    assert.equal(w.get(2), false)
  })

  test('user-skipped counts toward wave completion; cascade-skip does not', () => {
    const w = waveCompletion([
      t('A', 1, 'complete'),
      t('B', 1, 'skipped', [], '2025-01-01T00:00:00Z'),
      t('C', 2, 'complete'),
      t('D', 2, 'skipped', [], null) // cascade skip — not terminal
    ])
    assert.equal(w.get(1), true)
    assert.equal(w.get(2), false)
  })

  test('empty task set yields no waves', () => {
    assert.equal(waveCompletion([]).size, 0)
  })
})
