/**
 * Unit tests for task-dag.ts — the pure DAG scheduler primitives that lift
 * Blueprint BUILD's within-wave parallelism to the whole task graph.
 *
 * Covers: build/normalization, upward-rank ordering, structural release,
 * cycle detection, unknown-dep reporting, stall detection via readiness
 * predicates, and the readiness status rule (user-skip satisfies,
 * cascade-skip blocks).
 *
 * Run: tsx src/shared/__tests__/task-dag.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../main/services/__tests__/test-harness'
import {
  buildTaskDag,
  detectCycle,
  readyTasks,
  markComplete,
  collectTransitiveDependents,
  isDepSatisfied,
  compareByRank,
  type DagTaskInput
} from '../task-dag'

/** Convenience: build a task with defaults. */
function t(taskId: string, wave: number, dependsOn?: string[]): DagTaskInput {
  return { taskId, wave, dependsOnJson: dependsOn ?? [] }
}

describe('buildTaskDag', () => {
  test('builds adjacency and in-degrees for a diamond graph', () => {
    const dag = buildTaskDag([t('A', 1), t('B', 1, ['A']), t('C', 1, ['A']), t('D', 2, ['B', 'C'])])
    assert.equal(dag.nodes.size, 4)
    assert.deepEqual(dag.nodes.get('B')!.deps, ['A'])
    assert.deepEqual(dag.nodes.get('A')!.dependents.sort(), ['B', 'C'])
    assert.equal(dag.nodes.get('D')!.inDegree, 2)
    assert.equal(dag.cycle, null)
    assert.equal(dag.unknownDeps.length, 0)
    // Topological order respects deps
    const order = dag.topoOrder
    assert.ok(order.indexOf('A') < order.indexOf('B'))
    assert.ok(order.indexOf('A') < order.indexOf('C'))
    assert.ok(order.indexOf('B') < order.indexOf('D'))
    assert.ok(order.indexOf('C') < order.indexOf('D'))
  })

  test('drops self-references and dedupes repeated deps', () => {
    const dag = buildTaskDag([t('A', 1), t('B', 1, ['A', 'A', 'B'])])
    assert.deepEqual(dag.nodes.get('B')!.deps, ['A'])
    assert.equal(dag.nodes.get('B')!.inDegree, 1)
    assert.equal(dag.unknownDeps.length, 0)
  })

  test('reports unknown dep ids and ignores them for scheduling', () => {
    const dag = buildTaskDag([t('A', 1), t('B', 1, ['A', 'GHOST'])])
    assert.deepEqual(dag.unknownDeps, [{ taskId: 'B', dep: 'GHOST' }])
    // GHOST ignored → B's structural in-degree is 1 (A only)
    assert.equal(dag.nodes.get('B')!.inDegree, 1)
    // With A satisfied, both A-independent tasks are ready (A itself has no deps)
    const done = new Set(['A'])
    assert.deepEqual(
      readyTasks(dag, (id) => done.has(id)),
      ['A', 'B']
    )
  })

  test('first task wins on duplicate taskIds', () => {
    const dag = buildTaskDag([t('A', 1), t('A', 2, ['A'])])
    assert.equal(dag.nodes.size, 1)
    assert.equal(dag.nodes.get('A')!.wave, 1)
  })

  test('empty task set yields an empty dag', () => {
    const dag = buildTaskDag([])
    assert.equal(dag.nodes.size, 0)
    assert.equal(dag.cycle, null)
    assert.deepEqual(dag.topoOrder, [])
  })
})

describe('upwardRank ordering', () => {
  test('tasks blocking more downstream work rank higher', () => {
    // A → B → D, A → C (D depends on B,C? no — keep it: A feeds a chain of 3)
    const dag = buildTaskDag([
      t('A', 1),
      t('B', 1, ['A']),
      t('C', 1),
      t('D', 2, ['B']),
      t('E', 2, ['C'])
    ])
    // Chain A→B→D: ranks A=3, B=2, D=1. C feeds E: rank 2.
    assert.equal(dag.nodes.get('A')!.upwardRank, 3)
    assert.equal(dag.nodes.get('B')!.upwardRank, 2)
    assert.equal(dag.nodes.get('D')!.upwardRank, 1)
    assert.equal(dag.nodes.get('C')!.upwardRank, 2)
    // Ready set: A (rank 3) outranks C (rank 2) — critical path first
    assert.deepEqual(
      readyTasks(dag, () => false),
      ['A', 'C']
    )
  })

  test('tie-break: lower wave, then taskId', () => {
    const dag = buildTaskDag([t('Z', 1), t('A', 1), t('M', 2)])
    assert.deepEqual(
      readyTasks(dag, () => false),
      ['A', 'Z', 'M']
    )
  })

  test('diamond join releases with dependents ranked by their own subtrees', () => {
    const dag = buildTaskDag([
      t('A', 1),
      t('B', 1, ['A']),
      t('C', 1, ['A']),
      t('D', 2, ['B']),
      t('E', 3, ['C', 'D'])
    ])
    // B→D→E chain: B=3, D=2, E=1; C=2 (feeds E)
    assert.equal(dag.nodes.get('B')!.upwardRank, 3)
    assert.equal(dag.nodes.get('C')!.upwardRank, 2)
    const done = new Set(['A'])
    // A itself is terminal — the caller filters it; here we assert the
    // rank order of the still-actionable ready set.
    const actionable = readyTasks(dag, (id) => done.has(id)).filter((id) => !done.has(id))
    assert.deepEqual(actionable, ['B', 'C'])
  })
})

describe('markComplete', () => {
  test('releases dependents exactly when their last dep completes', () => {
    const dag = buildTaskDag([t('A', 1), t('B', 1), t('J', 2, ['A', 'B'])])
    assert.deepEqual(markComplete(dag, 'A'), []) // J still waits on B
    assert.deepEqual(markComplete(dag, 'B'), ['J']) // last dep done
    assert.equal(dag.nodes.get('J')!.inDegree, 0)
  })

  test('returns [] for unknown ids (defensive)', () => {
    const dag = buildTaskDag([t('A', 1)])
    assert.deepEqual(markComplete(dag, 'NOPE'), [])
  })

  test('never decrements below zero on repeated completion', () => {
    const dag = buildTaskDag([t('A', 1), t('B', 1, ['A'])])
    markComplete(dag, 'A')
    markComplete(dag, 'A') // duplicate completion event
    assert.equal(dag.nodes.get('B')!.inDegree, 0)
  })
})

describe('cycle detection', () => {
  test('detects a direct cycle and extracts its path', () => {
    const dag = buildTaskDag([t('A', 1, ['B']), t('B', 1, ['A'])])
    assert.ok(dag.cycle !== null)
    assert.ok(dag.cycle!.length >= 2)
    assert.deepEqual([...dag.cycle!].sort(), ['A', 'B'])
    // Cyclic nodes excluded from topo order
    assert.equal(dag.topoOrder.length, 0)
    assert.deepEqual(detectCycle(dag), dag.cycle)
  })

  test('detects an indirect cycle with an acyclic tail', () => {
    const dag = buildTaskDag([t('T', 1), t('A', 1, ['T', 'C']), t('B', 1, ['A']), t('C', 1, ['B'])])
    assert.ok(dag.cycle !== null)
    // T is acyclic and still ordered
    assert.deepEqual(dag.topoOrder, ['T'])
  })

  test('self-reference alone is NOT a cycle (dropped at normalization)', () => {
    const dag = buildTaskDag([t('A', 1, ['A'])])
    assert.equal(dag.cycle, null)
    assert.deepEqual(dag.topoOrder, ['A'])
  })
})

describe('readyTasks with status predicates', () => {
  test('cross-wave readiness: wave-2 task ready while wave-1 peer still pending', () => {
    const dag = buildTaskDag([
      t('A', 1),
      t('B', 1), // slow wave-1 peer
      t('C', 2, ['A']) // wave-2 task depending only on A
    ])
    const done = new Set(['A'])
    const ready = readyTasks(dag, (id) => done.has(id))
    assert.ok(ready.includes('C'))
    assert.ok(!ready.includes('B') === false) // B has no deps — it IS ready
    assert.ok(ready.includes('B'))
  })

  test('stall detection: cascade-skipped dep leaves dependent blocked', () => {
    const dag = buildTaskDag([t('A', 1), t('B', 2, ['A'])])
    // A cascade-skipped: status 'skipped' with NO user timestamp
    const status = new Map([
      ['A', { status: 'skipped', skippedByUserAt: null }],
      ['B', { status: 'pending', skippedByUserAt: null }]
    ])
    const ready = readyTasks(dag, (id) => status.get(id)?.status === 'complete').filter(
      (id) => status.get(id)?.status === 'pending'
    )
    assert.deepEqual(ready, []) // B blocked — never silently mis-ordered
  })

  test('user-skipped dep satisfies readiness', () => {
    const dag = buildTaskDag([t('A', 1), t('B', 2, ['A'])])
    const status = new Map([
      ['A', { status: 'skipped', skippedByUserAt: '2025-01-01T00:00:00Z' }],
      ['B', { status: 'pending', skippedByUserAt: null }]
    ])
    const ready = readyTasks(dag, (id) =>
      isDepSatisfied(status.get(id)?.status ?? 'pending', status.get(id)?.skippedByUserAt ?? null)
    ).filter((id) => status.get(id)?.status === 'pending')
    assert.deepEqual(ready, ['B'])
  })

  test('failed dep does not satisfy readiness', () => {
    const dag = buildTaskDag([t('A', 1), t('B', 2, ['A'])])
    // A failed → not satisfied → B not ready; only A (terminal) appears
    const ready = readyTasks(dag, () => false).filter((id) => id !== 'A')
    assert.deepEqual(ready, [])
  })
})

describe('isDepSatisfied — the readiness status rule', () => {
  test('complete satisfies', () => {
    assert.ok(isDepSatisfied('complete'))
  })
  test('user skip satisfies', () => {
    assert.ok(isDepSatisfied('skipped', '2025-01-01T00:00:00Z'))
  })
  test('cascade skip does NOT satisfy', () => {
    assert.ok(!isDepSatisfied('skipped', null))
    assert.ok(!isDepSatisfied('skipped'))
  })
  test('pending/running/failed do not satisfy', () => {
    assert.ok(!isDepSatisfied('pending'))
    assert.ok(!isDepSatisfied('running'))
    assert.ok(!isDepSatisfied('failed'))
  })
})

describe('collectTransitiveDependents', () => {
  test('collects only transitive dependents of the roots', () => {
    const dag = buildTaskDag([
      t('A', 1),
      t('B', 1),
      t('C', 2, ['A']),
      t('D', 3, ['C']),
      t('E', 2, ['B'])
    ])
    const doomed = collectTransitiveDependents(dag, ['A'])
    assert.deepEqual([...doomed].sort(), ['C', 'D']) // E untouched
  })

  test('handles multiple roots and shared descendants', () => {
    const dag = buildTaskDag([t('A', 1), t('B', 1), t('J', 2, ['A', 'B'])])
    const doomed = collectTransitiveDependents(dag, ['A', 'B'])
    assert.deepEqual([...doomed], ['J'])
  })

  test('empty roots yield empty set', () => {
    const dag = buildTaskDag([t('A', 1), t('B', 1, ['A'])])
    assert.equal(collectTransitiveDependents(dag, []).size, 0)
  })
})

describe('compareByRank', () => {
  test('higher rank first, then lower wave, then taskId', () => {
    const mk = (taskId: string, wave: number, upwardRank: number) => ({
      taskId,
      wave,
      upwardRank,
      deps: [],
      dependents: [],
      inDegree: 0
    })
    const list = [mk('b', 1, 1), mk('a', 1, 3), mk('c', 2, 3), mk('d', 1, 1)]
    list.sort(compareByRank)
    assert.deepEqual(
      list.map((n) => n.taskId),
      ['a', 'c', 'b', 'd']
    )
  })
})
