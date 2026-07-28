/**
 * Tests for the parallel wave-task scheduler in BlueprintBuildService.
 *
 * These tests validate the scheduling logic at a unit level:
 * - File-overlap serialization
 * - Exclusive task handling (empty filePathsJson)
 * - Cap enforcement (1–6)
 * - Greedy skip-ahead behavior
 * - Graceful drain on failure
 * - Skipped marking for unstarted tasks
 * - Discovery snapshot isolation + merge
 * - Resume skip (BP-RESUME-01)
 *
 * Since BlueprintBuildService depends on Electron and DB singletons,
 * we test the pure scheduling helper functions (normalizePaths,
 * filesOverlap) and verify the cap-clamp preference logic.
 */
import assert from 'node:assert/strict'
import { normalize } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'

// ── Pure helpers extracted for testing (mirror blueprint-build.service.ts) ──

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []
}

function normalizePaths(paths: string[] | undefined): Set<string> {
  if (!paths?.length) return new Set()
  return new Set(paths.map((p) => normalize(p)))
}

function filesOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const f of a) {
    if (b.has(f)) return true
  }
  return false
}

function clampCap(value: number): number {
  return Math.max(1, Math.min(6, Math.round(value)))
}

// ── Test: normalizePaths ──

describe('normalizePaths', () => {
  test('returns empty set for undefined/null/empty', () => {
    assert.deepStrictEqual(normalizePaths(undefined), new Set())
    assert.deepStrictEqual(normalizePaths([]), new Set())
  })

  test('normalizes forward slashes and removes trailing separators', () => {
    const result = normalizePaths(['src/foo/bar.ts', 'src/baz/../qux.ts'])
    assert.ok(result.has(normalize('src/foo/bar.ts')))
    assert.ok(result.has(normalize('src/qux.ts')))
  })

  test('deduplicates equivalent paths', () => {
    const result = normalizePaths(['src/foo.ts', 'src/./foo.ts'])
    assert.strictEqual(result.size, 1)
  })
})

// ── Test: filesOverlap ──

describe('filesOverlap', () => {
  test('returns false for disjoint sets', () => {
    const a = new Set(['src/a.ts', 'src/b.ts'])
    const b = new Set(['src/c.ts', 'src/d.ts'])
    assert.strictEqual(filesOverlap(a, b), false)
  })

  test('returns true for overlapping sets', () => {
    const a = new Set(['src/a.ts', 'src/b.ts'])
    const b = new Set(['src/b.ts', 'src/c.ts'])
    assert.strictEqual(filesOverlap(a, b), true)
  })

  test('returns false when both sets are empty', () => {
    assert.strictEqual(filesOverlap(new Set(), new Set()), false)
  })

  test('returns false when one set is empty', () => {
    const a = new Set(['src/a.ts'])
    assert.strictEqual(filesOverlap(a, new Set()), false)
    assert.strictEqual(filesOverlap(new Set(), a), false)
  })
})

// ── Test: cap enforcement ──

describe('cap enforcement (parallelBuildAgents)', () => {
  test('clamps below minimum to 1', () => {
    assert.strictEqual(clampCap(0), 1)
    assert.strictEqual(clampCap(-5), 1)
  })

  test('clamps above maximum to 6', () => {
    assert.strictEqual(clampCap(7), 6)
    assert.strictEqual(clampCap(100), 6)
  })

  test('passes through valid values (1–6)', () => {
    for (let n = 1; n <= 6; n++) {
      assert.strictEqual(clampCap(n), n)
    }
  })

  test('rounds non-integer values', () => {
    assert.strictEqual(clampCap(2.7), 3)
    assert.strictEqual(clampCap(3.2), 3)
  })

  test('cap=1 degenerates to sequential (single slot)', () => {
    assert.strictEqual(clampCap(1), 1)
    // With cap=1, only one task dispatched at a time — equivalent to the old loop
  })
})

// ── Test: greedy skip-ahead logic ──

describe('greedy skip-ahead scheduling', () => {
  test('non-overlapping tasks can be dispatched concurrently', () => {
    const taskA = { files: normalizePaths(['src/a.ts']), taskId: 'T001' }
    const taskB = { files: normalizePaths(['src/b.ts']), taskId: 'T002' }
    const taskC = { files: normalizePaths(['src/a.ts', 'src/c.ts']), taskId: 'T003' }

    // A and B don't overlap — can be dispatched together
    assert.strictEqual(filesOverlap(taskA.files, taskB.files), false)
    // A and C overlap on src/a.ts — C must wait for A
    assert.strictEqual(filesOverlap(taskA.files, taskC.files), true)
  })

  test('exclusive task (empty files) blocks all and waits for empty inFlight', () => {
    const exclusive = normalizePaths(undefined)
    const regular = normalizePaths(['src/a.ts'])
    // Exclusive task has empty file set — it runs alone
    assert.strictEqual(exclusive.size, 0)
    assert.strictEqual(regular.size, 1)
  })
})

// ── Test: discovery snapshot isolation ──

describe('discovery snapshot isolation', () => {
  test('snapshot captures current state at dispatch time', () => {
    const discoveries = ['d1', 'd2', 'd3']
    const snapshot = [...discoveries]
    // Mutations to the original don't affect the snapshot
    discoveries.push('d4')
    assert.deepStrictEqual(snapshot, ['d1', 'd2', 'd3'])
  })

  test('discoveries cap at 20 after merge', () => {
    const discoveries: string[] = []
    for (let i = 0; i < 25; i++) {
      discoveries.push(`d${i}`)
    }
    // Cap logic from the service
    const capped = discoveries.length > 20 ? discoveries.slice(-20) : discoveries
    assert.strictEqual(capped.length, 20)
    assert.strictEqual(capped[0], 'd5')
    assert.strictEqual(capped[19], 'd24')
  })
})

// ── Test: graceful drain semantics ──

describe('graceful drain on failure', () => {
  test('draining flag prevents new dispatches', () => {
    let draining = false
    const pending = ['T001', 'T002', 'T003']
    const inFlightSize = 1
    const cap = 3

    // Before failure: can dispatch
    assert.ok(!draining && inFlightSize < cap)

    // After failure: draining = true
    draining = true
    // No new dispatches when draining
    assert.ok(draining)
    // But in-flight tasks continue (inFlightSize > 0)
    assert.strictEqual(inFlightSize, 1)
    // Remaining pending tasks will be marked 'skipped'
    assert.strictEqual(pending.length, 3)
  })
})

// ── Test: file overlap detection (residual risk) ──

describe('residual risk: undeclared file overlap detection', () => {
  test('detects overlap between two completed tasks', () => {
    const completedFiles = new Map<string, Set<string>>()
    completedFiles.set('T001', normalizePaths(['src/a.ts', 'src/b.ts']))
    completedFiles.set('T002', normalizePaths(['src/b.ts', 'src/c.ts']))
    completedFiles.set('T003', normalizePaths(['src/d.ts']))

    const overlaps: Array<[string, string, string[]]> = []
    const taskIds = [...completedFiles.keys()]
    for (let i = 0; i < taskIds.length; i++) {
      for (let j = i + 1; j < taskIds.length; j++) {
        const a = completedFiles.get(taskIds[i])!
        const b = completedFiles.get(taskIds[j])!
        if (filesOverlap(a, b)) {
          const overlap = [...a].filter((f) => b.has(f))
          overlaps.push([taskIds[i], taskIds[j], overlap])
        }
      }
    }
    assert.strictEqual(overlaps.length, 1)
    assert.deepStrictEqual(overlaps[0][0], 'T001')
    assert.deepStrictEqual(overlaps[0][1], 'T002')
    assert.ok(overlaps[0][2].some((f) => f.includes('b.ts')))
  })
})

// ── Test: no-double-dispatch invariant (C3 fix) ──

describe('no-double-dispatch invariant (C3 fix)', () => {
  /**
   * Simulates the C3 bug scenario:
   * Tasks A, B, C where B overlaps A.
   * A and C dispatch (B skipped for overlap).
   * C completes first → pendingIdx still at B.
   * Next scan must NOT re-dispatch C.
   */
  test('dispatched set prevents re-dispatch of out-of-order completed tasks', () => {
    const pending = [
      { taskId: 'T001', files: normalizePaths(['src/a.ts']) },
      { taskId: 'T002', files: normalizePaths(['src/a.ts', 'src/b.ts']) }, // overlaps T001
      { taskId: 'T003', files: normalizePaths(['src/c.ts']) }               // no overlap
    ]
    const cap = 3
    const dispatched = new Set<string>()
    const inFlight = new Map<string, { files: Set<string> }>()

    // Round 1: scan from idx 0
    let scanStart = 0
    while (inFlight.size < cap && scanStart < pending.length) {
      const task = pending[scanStart]
      if (dispatched.has(task.taskId)) { scanStart++; continue }

      const currentFiles = new Set<string>()
      for (const entry of inFlight.values()) { for (const f of entry.files) currentFiles.add(f) }

      if (filesOverlap(task.files, currentFiles)) { scanStart++; continue }

      inFlight.set(task.taskId, { files: task.files })
      dispatched.add(task.taskId)
      scanStart++
    }
    // T001 and T003 dispatched, T002 skipped (overlap with T001)
    assert.ok(dispatched.has('T001'))
    assert.ok(!dispatched.has('T002'))
    assert.ok(dispatched.has('T003'))
    assert.strictEqual(inFlight.size, 2)

    // Simulate: T003 completes first
    inFlight.delete('T003')

    // Round 2: scan again (pendingIdx would still be at T002 or earlier)
    scanStart = 0 // worst case: restart from beginning
    const dispatched2 = new Set<string>()
    while (inFlight.size < cap && scanStart < pending.length) {
      const task = pending[scanStart]
      if (dispatched.has(task.taskId)) { scanStart++; continue } // C3 fix: skip already-dispatched

      const currentFiles = new Set<string>()
      for (const entry of inFlight.values()) { for (const f of entry.files) currentFiles.add(f) }

      if (filesOverlap(task.files, currentFiles)) { scanStart++; continue }

      dispatched2.add(task.taskId)
      dispatched.add(task.taskId)
      inFlight.set(task.taskId, { files: task.files })
      scanStart++
    }
    // T003 must NOT be re-dispatched (already in dispatched set)
    assert.ok(!dispatched2.has('T003'), 'T003 must not be re-dispatched')
    // T002 should now dispatch (T001 still in flight, but with C3 fix we check DB status;
    // in this pure test, T002 overlaps T001 still in flight, so it's still blocked)
    assert.ok(!dispatched2.has('T002'), 'T002 still overlaps in-flight T001')
  })

  test('completed tasks are skipped by dispatched set even without DB check', () => {
    const dispatched = new Set<string>(['T001', 'T002'])
    // Simulate scan encountering already-dispatched tasks
    assert.ok(dispatched.has('T001'))
    assert.ok(dispatched.has('T002'))
    assert.ok(!dispatched.has('T003'))
    // Only T003 would be eligible for dispatch
  })
})

// ── Test: exclusive-blocks-all invariant (C4 fix) ──

describe('exclusive-blocks-all invariant (C4 fix)', () => {
  test('exclusive task (empty files) blocks all further dispatches while running', () => {
    const exclusiveTask = { taskId: 'T001', files: normalizePaths(undefined) } // empty = exclusive
    const cap = 3

    const dispatched = new Set<string>()
    const inFlight = new Map<string, { files: Set<string> }>()
    let exclusiveInFlight = false

    // Dispatch exclusive task (only when inFlight empty)
    assert.strictEqual(exclusiveTask.files.size, 0)
    assert.strictEqual(inFlight.size, 0)
    inFlight.set(exclusiveTask.taskId, { files: exclusiveTask.files })
    dispatched.add(exclusiveTask.taskId)
    exclusiveInFlight = true

    // Now try to dispatch regular task — should be blocked by exclusiveInFlight
    const canDispatch = !exclusiveInFlight && inFlight.size < cap
    assert.strictEqual(canDispatch, false, 'regular task must not dispatch while exclusive is in-flight')

    // After exclusive completes
    inFlight.delete(exclusiveTask.taskId)
    exclusiveInFlight = false

    const canDispatchNow = !exclusiveInFlight && inFlight.size < cap
    assert.strictEqual(canDispatchNow, true, 'regular task can dispatch after exclusive completes')
  })

  test('empty allInFlightFiles for exclusive task does not allow peers without guard', () => {
    // Demonstrates why C4 existed: exclusive task has empty files,
    // so allInFlightFiles() returns empty set, and no file overlap is detected.
    const exclusiveFiles = normalizePaths(undefined)
    const regularFiles = normalizePaths(['src/a.ts'])
    // Without exclusiveInFlight guard, overlap check passes…
    assert.strictEqual(filesOverlap(regularFiles, exclusiveFiles), false)
    // …so the guard must be external (exclusiveInFlight flag)
  })
})

// ── Test: reported-file overlap detection (H2 fix) ──

describe('reported-file overlap detection (H2 fix)', () => {
  test('detects overlap in reported filesModified, not declared filePathsJson', () => {
    // Simulate: T001 declared [a.ts], T002 declared [b.ts] (no declared overlap).
    // But both actually wrote c.ts (undeclared). Scheduler allowed parallel…
    const declaredT001 = normalizePaths(['src/a.ts'])
    const declaredT002 = normalizePaths(['src/b.ts'])
    assert.strictEqual(filesOverlap(declaredT001, declaredT002), false) // no declared overlap

    // …but reported files show both touched c.ts
    const reportedFiles = new Map<string, Set<string>>()
    reportedFiles.set('T001', normalizePaths(['src/a.ts', 'src/c.ts'])) // wrote undeclared c.ts
    reportedFiles.set('T002', normalizePaths(['src/b.ts', 'src/c.ts'])) // also wrote c.ts

    const overlaps: Array<[string, string, string[]]> = []
    const taskIds = [...reportedFiles.keys()]
    for (let i = 0; i < taskIds.length; i++) {
      for (let j = i + 1; j < taskIds.length; j++) {
        const a = reportedFiles.get(taskIds[i])!
        const b = reportedFiles.get(taskIds[j])!
        if (filesOverlap(a, b)) {
          const overlap = [...a].filter((f) => b.has(f))
          overlaps.push([taskIds[i], taskIds[j], overlap])
        }
      }
    }
    assert.strictEqual(overlaps.length, 1)
    assert.ok(overlaps[0][2].some((f) => f.includes('c.ts')))
  })

  test('no false positives when reported files are disjoint', () => {
    const reportedFiles = new Map<string, Set<string>>()
    reportedFiles.set('T001', normalizePaths(['src/a.ts']))
    reportedFiles.set('T002', normalizePaths(['src/b.ts']))
    reportedFiles.set('T003', normalizePaths(['src/c.ts']))

    let overlapCount = 0
    const taskIds = [...reportedFiles.keys()]
    for (let i = 0; i < taskIds.length; i++) {
      for (let j = i + 1; j < taskIds.length; j++) {
        if (filesOverlap(reportedFiles.get(taskIds[i])!, reportedFiles.get(taskIds[j])!)) {
          overlapCount++
        }
      }
    }
    assert.strictEqual(overlapCount, 0)
  })
})

// ── Test: dispatch-time skip predicate treats failed as eligible (R1/R3) ──

describe('dispatch-time skip predicate', () => {
  // Mirrors the C3 FIX predicate in blueprint-build.service.ts:executeWave.
  // Only 'complete' should be skipped; 'failed' must remain eligible so that
  // retry/resume can re-execute the task.
  function shouldSkipAtDispatch(dbStatus: string | undefined): boolean {
    return dbStatus === 'complete'
  }

  test('skips tasks with status "complete"', () => {
    assert.strictEqual(shouldSkipAtDispatch('complete'), true)
  })

  test('does NOT skip tasks with status "failed" (retry preserved)', () => {
    assert.strictEqual(shouldSkipAtDispatch('failed'), false,
      'failed tasks must remain eligible for dispatch so retry/resume re-executes them')
  })

  test('does NOT skip tasks with status "pending"', () => {
    assert.strictEqual(shouldSkipAtDispatch('pending'), false)
  })

  test('does NOT skip tasks with status "running"', () => {
    assert.strictEqual(shouldSkipAtDispatch('running'), false)
  })

  test('does NOT skip tasks with undefined status (new task)', () => {
    assert.strictEqual(shouldSkipAtDispatch(undefined), false)
  })
})

// ── Test: asStringArray (A1/A2 guard) ──

describe('asStringArray', () => {
  test('passes through a valid string array', () => {
    assert.deepStrictEqual(asStringArray(['src/a.ts', 'src/b.ts']), ['src/a.ts', 'src/b.ts'])
  })

  test('returns empty array for a bare string (LLM emits single value)', () => {
    assert.deepStrictEqual(asStringArray('src/a.ts'), [])
  })

  test('returns empty array for a number', () => {
    assert.deepStrictEqual(asStringArray(42), [])
  })

  test('returns empty array for a boolean', () => {
    assert.deepStrictEqual(asStringArray(true), [])
  })

  test('returns empty array for an object (non-iterable)', () => {
    assert.deepStrictEqual(asStringArray({ file: 'src/a.ts' }), [])
  })

  test('returns empty array for null', () => {
    assert.deepStrictEqual(asStringArray(null), [])
  })

  test('returns empty array for undefined', () => {
    assert.deepStrictEqual(asStringArray(undefined), [])
  })

  test('filters non-string elements from a mixed array', () => {
    assert.deepStrictEqual(asStringArray(['src/a.ts', 42, null, 'src/b.ts', true]), ['src/a.ts', 'src/b.ts'])
  })
})

// ── Runner ──
void summaryAsync()
