/**
 * P0 — the no-write-activity guard, and the evidence it decides on.
 *
 * The guard exists to keep the R029 hole shut: a completion that claims files
 * while the session invoked no write-capable tool is describing a PRIOR run's
 * output, not this one. Its original premise — "stale files on disk from an
 * earlier run" — holds only for a cold session. A session resumed after a stall
 * already wrote its files and correctly emits a completion claiming them with
 * zero write-tool calls of its own, and `executeTask`'s counters are locals
 * reset on every call. So the guard as written fails resumed work that is on
 * disk, which is the silent regression these tests pin shut.
 *
 * Three things are covered:
 *   1. `shouldFailForNoWriteActivity` — the decision, as a pure table.
 *   2. `isBaselineDiffEmpty` — the evidence, against a real temp git repo.
 *      Diff-base semantics cannot be faked without re-implementing them.
 *   3. The threading — write activity must ACCUMULATE across the ladder's
 *      rungs, which is the whole reason the box exists.
 *
 * Run: tsx src/main/services/__tests__/blueprint-no-write-activity-guard.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

import type { GateTaskContext } from '../blueprint-gates.service'

setupElectronStub()

// `require`, not a top-level import: ESM imports are hoisted above the
// `setupElectronStub()` call, and blueprint-build.service reaches db/index.ts,
// whose `schema.sql?raw` import only resolves once the stub's loader is
// installed. Same reason blueprint-gate-ladder.test.ts requires it lazily.
const { shouldFailForNoWriteActivity } = require('../blueprint-build.service') as {
  shouldFailForNoWriteActivity: (input: {
    cumulativeWriteToolCalls: number
    cumulativeBashCalls: number
    claimedFiles: number
    hasCompletion: boolean
    hasPlannedFiles: boolean
    baselineDiffEmpty: boolean | null
  }) => boolean
}
const { captureGateBaseline, isBaselineDiffEmpty } = require('../blueprint-gates.service') as {
  captureGateBaseline: (
    ctx: GateTaskContext
  ) => Promise<import('../blueprint-gates.service').GateBaseline>
  isBaselineDiffEmpty: (
    ctx: GateTaskContext,
    baseline: import('../blueprint-gates.service').GateBaseline
  ) => Promise<boolean | null>
}

const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const tempDirs: string[] = []

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nowrite-guard-'))
  tempDirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'guard@test.local'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Guard Test'], { cwd: dir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  return dir
}

function ctxFor(dir: string): GateTaskContext {
  return {
    blueprintId: 'bp-guard',
    taskId: 'T001',
    workspacePath: dir,
    executionPath: dir,
    plannedFiles: ['a.ts'],
    commands: {},
    commandGates: []
  }
}

function cleanup(): void {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

// ── 1. The decision ──

describe('shouldFailForNoWriteActivity — the stale-claim decision', () => {
  const base = {
    cumulativeWriteToolCalls: 0,
    cumulativeBashCalls: 0,
    claimedFiles: 2,
    hasCompletion: true,
    hasPlannedFiles: true,
    baselineDiffEmpty: true
  }

  test('fails a claim with no write activity and an empty diff', () => {
    // The case the guard was built for: nothing ran, nothing changed, yet the
    // completion names files. Those files predate the task.
    assert.equal(shouldFailForNoWriteActivity(base), true)
  })

  test('passes a resumed attempt: no write tools this task, but the diff is not empty', () => {
    // THE REGRESSION. A resumed session emits a completion claiming files it
    // wrote before the stall, with zero write-tool calls of its own. The diff
    // is the direct measurement and it outranks the counter.
    assert.equal(
      shouldFailForNoWriteActivity({ ...base, baselineDiffEmpty: false }),
      false,
      'work that is provably on disk must never be failed as a stale claim'
    )
  })

  test('an unanswerable diff leaves the decision to the counters', () => {
    // null = git could not answer (no baseline commit, or the diff failed).
    // Absence of evidence is not evidence of absence: behave exactly as before
    // the diff existed, or a repo without git silently stops being guarded.
    assert.equal(shouldFailForNoWriteActivity({ ...base, baselineDiffEmpty: null }), true)
    assert.equal(
      shouldFailForNoWriteActivity({
        ...base,
        baselineDiffEmpty: null,
        cumulativeWriteToolCalls: 3
      }),
      false
    )
  })

  test('any write activity across the task clears the guard', () => {
    assert.equal(shouldFailForNoWriteActivity({ ...base, cumulativeWriteToolCalls: 1 }), false)
    // Bash counts: a task can legitimately do all its work through a script.
    assert.equal(shouldFailForNoWriteActivity({ ...base, cumulativeBashCalls: 1 }), false)
  })

  test('a completion claiming no files is not a stale claim', () => {
    // An agent that inspected the code, found it already correct and declined to
    // rewrite it claims nothing — there is no false claim to punish.
    assert.equal(shouldFailForNoWriteActivity({ ...base, claimedFiles: 0 }), false)
  })

  test('no completion at all still fails when the task had planned files', () => {
    // The session died before producing a completion block and the task was
    // supposed to touch files. Silence plus no activity is a failure.
    assert.equal(
      shouldFailForNoWriteActivity({ ...base, claimedFiles: 0, hasCompletion: false }),
      true
    )
    // ...but a task with no planned files has nothing to have failed to write.
    assert.equal(
      shouldFailForNoWriteActivity({
        ...base,
        claimedFiles: 0,
        hasCompletion: false,
        hasPlannedFiles: false
      }),
      false
    )
  })
})

// ── 2. The evidence ──

describe('isBaselineDiffEmpty — the direct measurement', () => {
  test('reports empty for a tree untouched since the baseline', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo()
    const ctx = ctxFor(dir)
    const baseline = await captureGateBaseline(ctx)
    assert.equal(await isBaselineDiffEmpty(ctx, baseline), true)
  })

  test('reports non-empty for a modified tracked file', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo()
    const ctx = ctxFor(dir)
    const baseline = await captureGateBaseline(ctx)
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2\n')
    assert.equal(await isBaselineDiffEmpty(ctx, baseline), false)
  })

  test('reports non-empty for an untracked new file', async () => {
    if (!GIT_AVAILABLE) return
    // An untracked file has no diff hunk. If it did not count, a task whose
    // whole output is new files would look like it did nothing.
    const dir = makeRepo()
    const ctx = ctxFor(dir)
    const baseline = await captureGateBaseline(ctx)
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1\n')
    assert.equal(await isBaselineDiffEmpty(ctx, baseline), false)
  })

  test('reports non-empty for work the task committed itself', async () => {
    if (!GIT_AVAILABLE) return
    // The diff base is the baseline COMMIT, not HEAD — a task that committed its
    // own work must not read as having changed nothing.
    const dir = makeRepo()
    const ctx = ctxFor(dir)
    const baseline = await captureGateBaseline(ctx)
    writeFileSync(join(dir, 'a.ts'), 'export const a = 3\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'agent commit'], { cwd: dir })
    assert.equal(await isBaselineDiffEmpty(ctx, baseline), false)
  })

  test('subtracts files that were already dirty before the task started', async () => {
    if (!GIT_AVAILABLE) return
    // The user's uncommitted edits are not this task's work. Counting them would
    // clear the guard for a task that genuinely did nothing.
    const dir = makeRepo()
    const ctx = ctxFor(dir)
    writeFileSync(join(dir, 'a.ts'), 'export const a = 99\n')
    const baseline = await captureGateBaseline(ctx)
    assert.ok(baseline.preexistingDirty.includes('a.ts'), 'fixture must actually be dirty')
    assert.equal(await isBaselineDiffEmpty(ctx, baseline), true)
  })

  test('returns null when there is no baseline commit to diff against', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo()
    const ctx = ctxFor(dir)
    const baseline = await captureGateBaseline(ctx)
    const unanchored = { ...baseline, baselineCommit: null }
    assert.equal(
      await isBaselineDiffEmpty(ctx, unanchored),
      null,
      'unknown must be distinguishable from "nothing changed"'
    )
  })
})

// ── 3. The threading ──

// Attached at IMPORT time, not inside the test. `attachTestDb` installs the
// database globally the first time anyone calls it; doing that from a test body
// means it lands part-way through a concurrent run, after other files have
// already seeded workspaces into whatever was installed before. Every DB-using
// file in this suite attaches at import for that reason.
let dbEnv: { wsId: string } | null = null
let blueprintRepository: any
let blueprintTaskRepository: any
try {
  dbEnv = require('../../db/repositories/__tests__/db-test-helper').attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintTaskRepository = repos.blueprintTaskRepository
} catch {
  dbEnv = null
}

describe('write activity accumulates across the retry ladder', () => {
  test('every rung sees the write calls the previous rungs made', async () => {
    if (!GIT_AVAILABLE || !dbEnv) return
    const env = dbEnv

    const dir = makeRepo()
    const bp = blueprintRepository.create({ workspaceId: env.wsId, title: 'P0 threading' })
    const task = blueprintTaskRepository.create({
      blueprintId: bp.id,
      taskId: 'T001',
      wave: 1,
      description: 'Accumulate write activity',
      filePathsJson: ['a.ts']
    })

    const { BlueprintBuildService } = require('../blueprint-build.service')
    const svc = new BlueprintBuildService()

    // What each rung SAW on entry. If the box were per-attempt (or absent) every
    // reading would be 0 — which is exactly the bug.
    const seen: number[] = []
    svc.executeTask = async (p: {
      writeActivity?: { writeToolCalls: number }
      baselineDiffEmpty?: () => Promise<boolean | null>
    }): Promise<unknown> => {
      seen.push(p.writeActivity?.writeToolCalls ?? -1)
      assert.ok(p.baselineDiffEmpty, 'the ladder must hand executeTask a diff probe')
      // Stand in for the session writing one file.
      if (p.writeActivity) p.writeActivity.writeToolCalls++
      return { success: true, completion: null, discoveries: [] }
    }
    svc.gradeTask = async (): Promise<unknown> => ({
      overall: 'fail',
      gates: [
        { name: 'task-tests', verdict: 'fail', evidence: [`run ${seen.length}`], durationMs: 1 }
      ]
    })
    svc.escalateToLead = async (p: {
      writeActivity?: { writeToolCalls: number }
    }): Promise<unknown> => {
      seen.push(p.writeActivity?.writeToolCalls ?? -1)
      return { success: false, completion: null, discoveries: [], failureReason: 'escalated' }
    }
    svc.resolveGateCommandsFor = (): unknown => ({})
    svc.readManifestsCached = (): unknown => ({})

    await svc.executeTaskWithGates({
      task,
      blueprintId: bp.id,
      workspaceId: env.wsId,
      workspacePath: dir,
      executionPath: dir,
      phaseContext: {} as never,
      priorDiscoveries: [],
      tDispatch: Date.now(),
      waveNum: 1
    })

    assert.ok(seen.length >= 2, 'the ladder must have run more than one rung')
    assert.equal(seen[0], 0, 'the first attempt starts from zero')
    assert.deepEqual(
      seen,
      seen.map((_, i) => i),
      'each rung must see one more write call than the last — a reset box would read all zeros'
    )
  })
})

// Guarded: under the shared runner an unconditional `summaryAsync()` drains the
// pending queue from inside a single file and abandons that file's own in-flight
// async tests — they then report as neither passed nor failed.
process.on('exit', cleanup)

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
