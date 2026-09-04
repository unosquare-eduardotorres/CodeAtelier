/**
 * Phase 1 improvements — E12 / E1 / A6 contracts.
 *
 * E12 — classifyPhaseRetryDelay: class-based backoff for auto-retries.
 *       First match wins; overload > cold-start > slow; default preserves the
 *       old flat 5s. Attempt number scales the base.
 *       E12-fix — shouldDispatchScheduledRetry truth table + the timer
 *       integration that FAILS on pre-fix main: schedule → markPipelineStopped
 *       → advance → the retry must actually dispatch.
 * E1  — countNeedsClarificationMarkers: deterministic marker count, the
 *       AUTHORITY for auto-skipping CLARIFY. Accepts the templated
 *       `[NEEDS CLARIFICATION: reason]` form, not just the bare tag.
 *       E1-fix — decideClarifySkip matrix incl. the needsClarification veto
 *       (vacuous pre-fix: the prompt hardcodes status "complete") and the
 *       checklist false-positive pin.
 * A6  — buildTaskCommitSubject: `feat: <description> (<taskId>)`, guaranteed
 *       to satisfy TASK_ID_IN_SUBJECT (imported, never duplicated) so the
 *       enforced commit can never drift from the survival scan's attribution
 *       pattern. Plus the temp-git-repo enforcement tests (§2's A6 note):
 *       A6-fix — the commit is scoped to (dirty ∩ claimed); siblings' files
 *       stay dirty; unclaimable dirt degrades honestly instead of
 *       mis-attributing.
 *
 * Run: npx tsx src/main/services/__tests__/blueprint-phase1-improvements.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import simpleGit from 'simple-git'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import { attachTestDb } from '../../db/repositories/__tests__/db-test-helper'

setupElectronStub()

// Repositories + services are required AFTER the stub and a real DB are in
// place — a service first required under another file's repository mock keeps
// that mock in its bindings (see db-test-helper's reloadWithRealDeps note).
const dbContext = attachTestDb()

const { classifyPhaseRetryDelay, shouldDispatchScheduledRetry } = require('../blueprint.service') as {
  classifyPhaseRetryDelay: (
    error: string,
    attempt: number
  ) => {
    delayClass: string
    delayMs: number
  }
  shouldDispatchScheduledRetry: (input: {
    blueprint: { status: string } | null | undefined
    isRunning: boolean
    scheduledGeneration: number
    currentGeneration: number
  }) => { dispatch: boolean; reason: string }
}
const { countNeedsClarificationMarkers, decideClarifySkip } = require(
  '../blueprint-artifact-parsers'
) as {
  countNeedsClarificationMarkers: (text: string) => number
  decideClarifySkip: (input: {
    specText: string
    completion?: {
      status: string
      needsClarification?: boolean
      clarificationCount?: number
    }
    enabled: boolean
  }) => { skip: boolean; markerCount: number; reportedCount?: number; reason: string }
}
const { TASK_ID_IN_SUBJECT } = require('../blueprint-gates.service') as {
  TASK_ID_IN_SUBJECT: RegExp
}

// ── E12 ──

describe('E12 — classifyPhaseRetryDelay', () => {
  test('overload class wins over slow for a rate-limit error', () => {
    const { delayClass, delayMs } = classifyPhaseRetryDelay('API rate limit exceeded', 1)
    assert.equal(delayClass, 'overload')
    assert.ok(delayMs >= 30_000 && delayMs < 60_000, `attempt-1 overload in [30s,60s): ${delayMs}`)
  })

  test('overload matches "overloaded" spelling too', () => {
    assert.equal(classifyPhaseRetryDelay('provider is overloaded', 1).delayClass, 'overload')
  })

  test('cold-start class matches the OpenCode session bootstrap failure', () => {
    const { delayClass, delayMs } = classifyPhaseRetryDelay(
      'Failed to create OpenCode session (500)',
      1
    )
    assert.equal(delayClass, 'cold-start')
    assert.ok(
      delayMs >= 15_000 && delayMs < 30_000,
      `attempt-1 cold-start in [15s,30s): ${delayMs}`
    )
  })

  test('slow class matches timeouts via isSlowTransientError', () => {
    const { delayClass, delayMs } = classifyPhaseRetryDelay('request timed out', 1)
    assert.equal(delayClass, 'slow')
    assert.ok(delayMs >= 15_000 && delayMs < 20_000, `attempt-1 slow in [15s,20s): ${delayMs}`)
  })

  test('attempt number scales the base (attempt 2 doubles it)', () => {
    const first = classifyPhaseRetryDelay('request timed out', 1)
    const second = classifyPhaseRetryDelay('request timed out', 2)
    assert.equal(second.delayClass, 'slow')
    // base 15s * 2 = 30s floor; jitter ≤ 5s ⇒ upper bound 35s
    assert.ok(
      second.delayMs >= 30_000 && second.delayMs < 35_000,
      `attempt-2 slow in [30s,35s): ${second.delayMs}`
    )
    assert.ok(first.delayMs < second.delayMs, 'attempt 2 backs off harder than attempt 1')
  })

  test('default class preserves the legacy flat 5s with no jitter', () => {
    const { delayClass, delayMs } = classifyPhaseRetryDelay('EPIPE broken pipe', 1)
    assert.equal(delayClass, 'default')
    assert.equal(delayMs, 5_000)
  })

  test('default class also scales with attempt', () => {
    assert.equal(classifyPhaseRetryDelay('EPIPE broken pipe', 2).delayMs, 10_000)
  })

  test('overload errors are not misclassified despite matching no timeout word', () => {
    // The old single-classifier idea (isSlowTransientError alone) would have
    // missed this — the exact drift E12's class list closes.
    assert.notEqual(classifyPhaseRetryDelay('429 too many requests', 1).delayClass, 'default')
    assert.notEqual(classifyPhaseRetryDelay('429 too many requests', 1).delayClass, 'slow')
  })
})

// ── E12-fix — dispatch guard (pure truth table) ──

describe('E12-fix — shouldDispatchScheduledRetry truth table', () => {
  const base = {
    blueprint: { status: 'failed' as string },
    isRunning: false,
    scheduledGeneration: 3,
    currentGeneration: 3
  }

  test('REGRESSION PIN: status failed → dispatch (callers persist failed before scheduling)', () => {
    const r = shouldDispatchScheduledRetry(base)
    assert.equal(r.dispatch, true)
    assert.equal(r.reason, 'ok')
  })

  test('pipeline busy → drop with reason pipeline-busy', () => {
    const r = shouldDispatchScheduledRetry({ ...base, isRunning: true })
    assert.deepEqual(r, { dispatch: false, reason: 'pipeline-busy' })
  })

  test('deleted blueprint → drop with reason deleted', () => {
    const r = shouldDispatchScheduledRetry({ ...base, blueprint: null })
    assert.deepEqual(r, { dispatch: false, reason: 'deleted' })
  })

  test('cancelled → drop with reason cancelled', () => {
    const r = shouldDispatchScheduledRetry({ ...base, blueprint: { status: 'cancelled' } })
    assert.deepEqual(r, { dispatch: false, reason: 'cancelled' })
  })

  test('generation bump between schedule and fire → drop with reason superseded', () => {
    const r = shouldDispatchScheduledRetry({ ...base, currentGeneration: 4 })
    assert.deepEqual(r, { dispatch: false, reason: 'superseded' })
  })

  test('cancelled wins over superseded (checked first)', () => {
    const r = shouldDispatchScheduledRetry({
      blueprint: { status: 'cancelled' },
      isRunning: false,
      scheduledGeneration: 1,
      currentGeneration: 99
    })
    assert.equal(r.reason, 'cancelled')
  })

  test('REGRESSION PIN: the predicate takes no active-blueprint-id input — the guard may never again read a field markPipelineStopped clears', () => {
    // Compile-time shape check: the fix exists BECAUSE the old guard compared
    // getActiveBlueprintId() (nulled by markPipelineStopped in every caller's
    // finally) against the blueprint id. If someone re-adds such an input, this
    // test's type signature (and the source's) must change with it — visibly.
    const input = base as unknown as Record<string, unknown>
    assert.equal(input['blueprintId'], undefined, 'predicate must not receive blueprintId')
    assert.equal(input['activeBlueprintId'], undefined)
    assert.equal(input['pipelineBlueprintId'], undefined)
    // And the function must still make a decision from only the four inputs:
    assert.equal(shouldDispatchScheduledRetry(base).dispatch, true)
  })
})

// ── E1-fix — decideClarifySkip matrix ──

describe('E1-fix — decideClarifySkip', () => {
  test('0 markers + clean completion → skip', () => {
    const r = decideClarifySkip({
      specText: '# Spec\n\n- FR-001: thing\n',
      completion: { status: 'complete' },
      enabled: true
    })
    assert.deepEqual({ skip: r.skip, reason: r.reason }, { skip: true, reason: 'skip' })
    assert.equal(r.markerCount, 0)
  })

  test('REGRESSION PIN (fails on pre-fix main): needsClarification: true vetoes despite status "complete"', () => {
    // specify-phase.md hardcodes "status": "complete" and carries the signal
    // in needsClarification — the pre-fix veto read only status and was vacuous.
    const r = decideClarifySkip({
      specText: '# Spec\n\n- FR-001: thing\n',
      completion: { status: 'complete', needsClarification: true },
      enabled: true
    })
    assert.equal(r.skip, false)
    assert.equal(r.reason, 'llm-veto')
  })

  test('status needs_clarification still vetoes (legacy field)', () => {
    const r = decideClarifySkip({
      specText: '# Spec\n',
      completion: { status: 'needs_clarification' },
      enabled: true
    })
    assert.equal(r.skip, false)
    assert.equal(r.reason, 'llm-veto')
  })

  test('veto carries reportedCount when the LLM supplied one', () => {
    const r = decideClarifySkip({
      specText: '# Spec\n',
      completion: { status: 'complete', needsClarification: true, clarificationCount: 3 },
      enabled: true
    })
    assert.equal(r.skip, false)
    assert.equal(r.reportedCount, 3)
  })

  test('markers present → no skip regardless of completion claims', () => {
    const r = decideClarifySkip({
      specText: '- FR-001: thing [NEEDS CLARIFICATION: scope?]',
      completion: { status: 'complete', needsClarification: false },
      enabled: true
    })
    assert.equal(r.skip, false)
    assert.equal(r.reason, 'markers-present')
    assert.equal(r.markerCount, 1)
  })

  test('disabled (kill switch) → no skip, reason disabled, markerCount 0 (not computed)', () => {
    const r = decideClarifySkip({
      specText: 'whatever [NEEDS CLARIFICATION]',
      completion: undefined,
      enabled: false
    })
    assert.deepEqual(
      { skip: r.skip, reason: r.reason, markerCount: r.markerCount },
      { skip: false, reason: 'disabled', markerCount: 0 }
    )
  })

  test('absent completion + clean text → skip (no veto from undefined)', () => {
    const r = decideClarifySkip({ specText: 'clean', completion: undefined, enabled: true })
    assert.equal(r.skip, true)
  })

  test('KNOWN LIMITATION PIN: the checklist literal itself scores markerCount 1 and suppresses the skip', () => {
    // checklist.md instructs "…marked with [NEEDS CLARIFICATION]"; an agent
    // echoing the checklist (or writing "0 [NEEDS CLARIFICATION] markers")
    // suppresses the auto-skip. Failure direction is safe (extra clarify turn,
    // never a skipped needed one) and clarify_skip telemetry measures how often
    // it fires. Section-scoped counting is deliberately deferred until that
    // data exists — this pin documents the behaviour instead of leaving it latent.
    const echoedChecklist =
      '## Checklist\n\n- [ ] All unclear requirements marked with [NEEDS CLARIFICATION]\n'
    const r = decideClarifySkip({
      specText: echoedChecklist,
      completion: { status: 'complete', needsClarification: false },
      enabled: true
    })
    assert.equal(r.markerCount, 1)
    assert.equal(r.skip, false)
    assert.equal(r.reason, 'markers-present')
  })
})

// ── E1 ──

describe('E1 — countNeedsClarificationMarkers', () => {
  test('zero markers in a clean spec', () => {
    const spec = `# Spec\n\n- FR-001: Users MUST log in\n- FR-002: Sessions SHOULD expire\n`
    assert.equal(countNeedsClarificationMarkers(spec), 0)
  })

  test('counts bare markers', () => {
    const spec = `- FR-001: thing [NEEDS CLARIFICATION]\n- FR-002: other`
    assert.equal(countNeedsClarificationMarkers(spec), 1)
  })

  test('counts the templated reason form emitted by the spec template', () => {
    // spec.md:82 instructs `[NEEDS CLARIFICATION: reason]` — a bare-tag-only
    // regex would count 0 here and wrongly auto-skip CLARIFY.
    const spec = `- FR-001: thing [NEEDS CLARIFICATION: is SSO in scope?]\n- FR-002: other [NEEDS CLARIFICATION: which timezone?]`
    assert.equal(countNeedsClarificationMarkers(spec), 2)
  })

  test('case-insensitive', () => {
    assert.equal(
      countNeedsClarificationMarkers('[needs clarification: a]\n[Needs Clarification]'),
      2
    )
  })

  test('completion-JSON booleans are never markers', () => {
    assert.equal(countNeedsClarificationMarkers('"needsClarification": false'), 0)
  })
})

// ── A6 — subject contract (pure) ──

describe('A6 — buildTaskCommitSubject contract (pure)', () => {
  test('subject satisfies TASK_ID_IN_SUBJECT (imported regex — cannot drift)', () => {
    const subject = buildTaskCommitSubjectForTest({
      taskId: 'T001',
      description: 'Add nodemailer transport with retry'
    })
    assert.ok(TASK_ID_IN_SUBJECT.test(subject), `subject must be attributable: "${subject}"`)
    assert.ok(subject.startsWith('feat: '), `default type prefix: "${subject}"`)
    assert.ok(subject.endsWith('(T001)'), `taskId suffix: "${subject}"`)
  })

  test('R-prefixed remediation ids are attributable too', () => {
    const subject = buildTaskCommitSubjectForTest({
      taskId: 'R003',
      description: 'Refine sign-off notification copy'
    })
    assert.ok(TASK_ID_IN_SUBJECT.test(subject), `R-ids must match: "${subject}"`)
  })

  test('long descriptions are collapsed and capped at 72 chars', () => {
    const subject = buildTaskCommitSubjectForTest({
      taskId: 'T012',
      description:
        'This   description\nhas\twhitespace and is quite long indeed — long enough that the subject cap should truncate it well before the end of this very verbose sentence'
    })
    const desc = subject.slice('feat: '.length, subject.length - ' (T012)'.length)
    assert.ok(desc.length <= 72, `desc capped at 72: ${desc.length}`)
    assert.ok(!desc.includes('\n') && !/\s{2,}/.test(desc), 'whitespace collapsed')
  })

  test('non-matching taskId throws instead of producing an unattributable commit', () => {
    assert.throws(
      () => buildTaskCommitSubjectForTest({ taskId: 'X1', description: 'anything' }),
      /TASK_ID_IN_SUBJECT/
    )
  })
})

// ── A6 — enforcement in a real temp git repo (§2's A6 note) ──

const gitAvailable = spawnSync('git', ['--version']).status === 0

/** Build the subject via the real export once available, else via the require cache. */
function buildTaskCommitSubjectForTest(input: {
  taskId: string
  description: string
  type?: string
}): string {
  // Loaded lazily so this file still works when the DB is unavailable (the
  // subject contract itself is pure and needs no repository bindings).
  const mod = require('../blueprint-build.service') as {
    buildTaskCommitSubject: typeof buildTaskCommitSubjectForTest
  }
  return mod.buildTaskCommitSubject(input)
}

const tempDirs: string[] = []
async function makeRepo(): Promise<{ dir: string; git: ReturnType<typeof simpleGit> }> {
  const dir = mkdtempSync(join(tmpdir(), 'a6-task-commit-'))
  tempDirs.push(dir)
  const git = simpleGit(dir)
  await git.init()
  await git.addConfig('user.email', 'test@example.com')
  await git.addConfig('user.name', 'Code Atelier Test')
  await git.addConfig('commit.gpgsign', 'false')
  writeFileSync(join(dir, 'README.md'), '# base\n')
  await git.add('.')
  await git.commit('base')
  return { dir, git }
}
process.on('exit', () => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

if (!gitAvailable || !dbContext) {
  describe('A6 — enforced per-task commit (skipped)', () => {
    test('requires git and a database', () => {}, {
      skipReason: !gitAvailable ? 'git is not available on PATH' : 'no DB'
    })
  })
} else {
  const { blueprintRepository, blueprintTaskRepository } = require(
    '../../db/repositories/blueprint.repository'
  )
  const { workspaceRepository } = require('../../db/repositories/workspace.repository')
  const buildMod = require('../blueprint-build.service') as {
    blueprintBuildService: {
      commitTaskWork: (p: {
        task: { taskId: string; description: string; id: string; filePathsJson: string[] }
        blueprintId: string
        executionPath: string
        workspacePath: string
        reportedFiles: string[]
      }) => Promise<void>
    }
  }

  /** Workspace + blueprint + one task row, wired to the given repo dir. */
  function seedTask(
    dir: string,
    taskId: string,
    description: string,
    filePathsJson: string[] = [],
    /** Pre-created workspace id — two tasks on one workspace share the repo path. */
    sharedWorkspaceId?: string
  ): { task: { taskId: string; description: string; id: string; filePathsJson: string[] }; blueprintId: string } {
    const wsId =
      sharedWorkspaceId ?? workspaceRepository.create(`A6 ws ${taskId} ${Date.now()}`, dir).id
    const bp = blueprintRepository.create({ workspaceId: wsId, title: `A6 ${taskId}` })
    const task = blueprintTaskRepository.create({
      blueprintId: bp.id,
      taskId,
      wave: 1,
      description,
      filePathsJson,
      isParallel: true,
      dependsOnJson: []
    })
    return { task, blueprintId: bp.id }
  }

  describe('A6 — commitTaskWork enforcement (temp git repo)', () => {
    test('primary-tree run (executionPath === workspacePath) → isolation gate skips the commit', async () => {
      const { dir, git } = await makeRepo()
      // Left-over work the agent failed to commit — must stay uncommitted: the
      // primary tree is shared with the user's own edits.
      writeFileSync(join(dir, 'feature.ts'), 'export const x = 1\n')
      const { task, blueprintId } = seedTask(dir, 'T007', 'Wire the notification transport')

      await buildMod.blueprintBuildService.commitTaskWork({
        task,
        blueprintId,
        executionPath: dir,
        workspacePath: dir,
        reportedFiles: []
      })

      const status = await git.status()
      assert.ok(!status.isClean(), 'isolation gate must NOT commit into the primary tree')
    })

    test('clean tree → no-op (agent already committed)', async () => {
      const { dir, git } = await makeRepo()
      const { task, blueprintId } = seedTask(dir, 'T008', 'Already committed by the agent')

      const before = (await git.log(['-1'])).latest?.hash
      await buildMod.blueprintBuildService.commitTaskWork({
        task,
        blueprintId,
        executionPath: dir,
        workspacePath: `${dir}-primary`,
        reportedFiles: []
      })
      const after = (await git.log(['-1'])).latest?.hash
      assert.equal(before, after, 'clean tree must produce no new commit')
    })

    test('dirty isolated tree, file claimed via filePathsJson → committed under the task id', async () => {
      const { dir, git } = await makeRepo()
      writeFileSync(join(dir, 'leftover.ts'), 'export const y = 2\n')
      const { task, blueprintId } = seedTask(dir, 'T009', 'Adds the leftover module', [
        'leftover.ts'
      ])

      await buildMod.blueprintBuildService.commitTaskWork({
        task,
        blueprintId,
        executionPath: dir,
        workspacePath: `${dir}-primary`,
        reportedFiles: []
      })

      const status = await git.status()
      assert.ok(status.isClean(), 'claimed dirty work must have been committed')
      const subject = (await git.log(['-1'])).latest?.message ?? ''
      assert.ok(TASK_ID_IN_SUBJECT.test(subject), `commit subject must name the task: "${subject}"`)
      assert.ok(subject.includes('T009'), `subject names T009: "${subject}"`)
    })

    test('REGRESSION PIN (fails on pre-fix main): sibling task files stay dirty — commit is scoped to the settling task', async () => {
      // Two concurrent tasks declared disjoint files; T001 settles first while
      // T002's writes are mid-flight. `git add -A` (pre-fix) swept b.ts into a
      // commit bearing T001's id; the intersection rule must not.
      const { dir, git } = await makeRepo()
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
      writeFileSync(join(dir, 'b.ts'), 'export const b = 2\n')
      // One workspace, two blueprints — concurrent tasks in one executionPath.
      const ws = workspaceRepository.create(`A6 concurrent ${Date.now()}`, dir)
      const { task: t1, blueprintId } = seedTask(dir, 'T001', 'First task declares a.ts', ['a.ts'], ws.id)
      seedTask(dir, 'T002', 'Second task declares b.ts', ['b.ts'], ws.id)

      await buildMod.blueprintBuildService.commitTaskWork({
        task: t1,
        blueprintId,
        executionPath: dir,
        workspacePath: `${dir}-primary`,
        reportedFiles: []
      })

      const log = await git.log(['-1'])
      const subject = log.latest?.message ?? ''
      assert.ok(subject.includes('T001'), `subject names the settling task: "${subject}"`)
      // The commit contains ONLY a.ts:
      const filesInCommit = (
        await git.raw(['show', '--name-only', '--pretty=format:', 'HEAD'])
      )
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      assert.deepEqual(filesInCommit, ['a.ts'], `commit scoped to a.ts only: ${filesInCommit}`)
      // b.ts is still dirty afterwards:
      const status = await git.status()
      assert.ok(
        status.files.some((f) => f.path === 'b.ts'),
        `b.ts must remain dirty (sibling still in flight): ${JSON.stringify(status.files)}`
      )
    })

    test('dirty file claimed by NEITHER task → mode unattributable, no commit created', async () => {
      const { dir, git } = await makeRepo()
      writeFileSync(join(dir, 'mystery.ts'), 'export const m = 3\n')
      const { task, blueprintId } = seedTask(dir, 'T011', 'Claims nothing relevant')

      const before = (await git.log(['-1'])).latest?.hash
      await buildMod.blueprintBuildService.commitTaskWork({
        task,
        blueprintId,
        executionPath: dir,
        workspacePath: `${dir}-primary`,
        reportedFiles: []
      })
      const after = (await git.log(['-1'])).latest?.hash
      assert.equal(before, after, 'unattributable dirt must not be committed')
      const status = await git.status()
      assert.ok(!status.isClean(), 'the dirty file stays in the working tree (pre-A6 state)')
    })

    test('reportedFiles union: a file absent from filePathsJson but present in completion.filesModified is committed', async () => {
      const { dir, git } = await makeRepo()
      writeFileSync(join(dir, 'declared.ts'), 'x\n')
      writeFileSync(join(dir, 'reported-only.ts'), 'y\n')
      const { task, blueprintId } = seedTask(dir, 'T012', 'Union of claim sources', ['declared.ts'])

      await buildMod.blueprintBuildService.commitTaskWork({
        task,
        blueprintId,
        executionPath: dir,
        workspacePath: `${dir}-primary`,
        reportedFiles: ['reported-only.ts']
      })

      const filesInCommit = (await git.raw(['show', '--name-only', '--pretty=format:', 'HEAD']))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .sort()
      assert.deepEqual(
        filesInCommit,
        ['declared.ts', 'reported-only.ts'],
        `both claim sources land in the commit: ${filesInCommit}`
      )
      assert.ok((await git.status()).isClean(), 'both claimed files committed')
    })

    test('commit failure is non-fatal (nonexistent execution path)', async () => {
      // Nonexistent execution path: simple-git must reject, and the method
      // must swallow it — a green task stays green. Fresh repo so the
      // workspace row's unique repo_path is not collided.
      const { dir } = await makeRepo()
      const { task, blueprintId } = seedTask(dir, 'T010', 'whatever')

      await buildMod.blueprintBuildService.commitTaskWork({
        task,
        blueprintId,
        executionPath: join(tmpdir(), 'a6-does-not-exist-xyz'),
        workspacePath: '/elsewhere',
        reportedFiles: []
      })
      assert.ok(true, 'must not throw')
    })
  })

  // ── E12-fix — timer integration (fails on pre-fix main) ──

  describe('E12-fix — scheduleAutoRetry dispatches after markPipelineStopped', () => {
    /**
     * Clamp delays to 1ms for the duration of ONE synchronous call — the
     * class-scaled backoff (up to ~90s) elapses on the next macrotask without
     * waiting real time. The swap is installed and restored with no await in
     * between, so no concurrently-running test can observe it (the harness
     * starts async tests concurrently; an async swap window clamped the
     * opencode stall-watchers' real timers and failed their suites).
     * (node:test's MockTimers resolves to undefined under this workspace's tsx
     * CJS transform — hence the hand-rolled capture.)
     */
    function clamped<T>(fn: () => T): T {
      const original = globalThis.setTimeout
      const fastSetTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
        original(fn, Math.min(ms ?? 0, 1), ...rest)) as unknown as typeof globalThis.setTimeout
      globalThis.setTimeout = fastSetTimeout
      try {
        return fn()
      } finally {
        globalThis.setTimeout = original
      }
    }

    test('schedule → markPipelineStopped → advance → autoRetry fires (the dropped-100%-of-retries regression)', async () => {
      const { blueprintService } = require('../blueprint.service') as {
        blueprintService: {
          scheduleAutoRetry: (ctx: {
            blueprintId: string
            workspaceId: string
            workspacePath: string
            phase: string
            error: string
          }) => boolean
          create: (params: { workspaceId: string; title: string }) => { id: string }
          markPipelineRunning: (ws: string, bp: string, phase: string) => void
          markPipelineStopped: (ws: string) => void
          getPipelineGeneration: (ws: string) => number
          clearAutoRetryState: (bp: string) => void
          on: (ev: string, fn: (...args: unknown[]) => void) => void
          off: (ev: string, fn: (...args: unknown[]) => void) => void
        }
      }
      const { blueprintPhaseRepository } = require(
        '../../db/repositories/blueprint.repository'
      ) as {
        blueprintPhaseRepository: {
          findByBlueprint: (bp: string) => Array<{ id: string; status: string; phase: string }>
          updateStatus: (id: string, s: string) => void
        }
      }

      const autoRetryEvents: Array<Record<string, unknown>> = []
      // Filter by blueprint id: the harness runs async tests concurrently and
      // this is a singleton EventEmitter — a sibling test's dispatch must not
      // count here (nor ours there).
      const onAutoRetry = (...args: unknown[]): void => {
        const ev = args[0] as Record<string, unknown>
        if (ev.blueprintId === bpIdHolder.id) autoRetryEvents.push(ev)
      }
      const bpIdHolder = { id: '' }
      blueprintService.on('autoRetry', onAutoRetry)

      const scheduled = clamped(() => {
        const dir = mkdtempSync(join(tmpdir(), 'e12-retry-'))
        tempDirs.push(dir)
        const ws = workspaceRepository.create(`E12 ws ${Date.now()}`, dir)
        // blueprintService.create — NOT blueprintRepository.create — so the 7
        // phase records exist (retryPhase throws "No retryable phase found"
        // otherwise, and the throw is swallowed into the mocked log).
        const bp = blueprintService.create({ workspaceId: ws.id, title: 'E12 retry' })
        bpIdHolder.id = bp.id

        // The failure scenario every caller produces: phase ran, failed, and
        // the finally block calls markPipelineStopped BEFORE the timer fires.
        blueprintService.markPipelineRunning(ws.id, bpIdHolder.id, 'specify')
        // Simulate the failure the caller persists BEFORE scheduling:
        blueprintRepository.updateStatus(bpIdHolder.id, 'failed')
        const phaseRow = blueprintPhaseRepository
          .findByBlueprint(bpIdHolder.id)
          .find((p) => p.phase === 'specify')
        if (phaseRow) blueprintPhaseRepository.updateStatus(phaseRow.id, 'failed')
        blueprintService.markPipelineStopped(ws.id) // ← the finally-block call that nulled blueprintId pre-fix

        return blueprintService.scheduleAutoRetry({
          blueprintId: bpIdHolder.id,
          workspaceId: ws.id,
          workspacePath: dir,
          phase: 'specify',
          error: 'Failed to create OpenCode session (500)' // retryable, cold-start class
        })
      })
      assert.equal(scheduled, true, 'a retryable error must schedule')

      // The clamped (1ms) timer fires on the next macrotask; its synchronous
      // handler (guard, retryPhase's SQLite writes, emit) runs before resolve.
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      assert.equal(
        autoRetryEvents.length,
        1,
        `autoRetry must fire after markPipelineStopped — the 100%-drop regression (got ${autoRetryEvents.length})`
      )
      assert.equal(autoRetryEvents[0]?.blueprintId, bpIdHolder.id)

      blueprintService.off('autoRetry', onAutoRetry)
      blueprintService.clearAutoRetryState(bpIdHolder.id)
    })

    test('generation bump between schedule and fire → dropped with reason superseded, no autoRetry event', async () => {
      const { blueprintService } = require('../blueprint.service') as {
        blueprintService: {
          scheduleAutoRetry: (ctx: {
            blueprintId: string
            workspaceId: string
            workspacePath: string
            phase: string
            error: string
          }) => boolean
          create: (params: { workspaceId: string; title: string }) => { id: string }
          markPipelineRunning: (ws: string, bp: string, phase: string) => void
          markPipelineStopped: (ws: string) => void
          clearAutoRetryState: (bp: string) => void
          on: (ev: string, fn: (...args: unknown[]) => void) => void
          off: (ev: string, fn: (...args: unknown[]) => void) => void
        }
      }

      const autoRetryEvents: Array<Record<string, unknown>> = []
      const bpIdHolder = { id: '' }
      const onAutoRetry = (...args: unknown[]): void => {
        const ev = args[0] as Record<string, unknown>
        if (ev.blueprintId === bpIdHolder.id) autoRetryEvents.push(ev)
      }
      blueprintService.on('autoRetry', onAutoRetry)

      const scheduled = clamped(() => {
        const dir = mkdtempSync(join(tmpdir(), 'e12-superseded-'))
        tempDirs.push(dir)
        const ws = workspaceRepository.create(`E12s ws ${Date.now()}`, dir)
        const bp = blueprintService.create({ workspaceId: ws.id, title: 'E12 superseded' })
        bpIdHolder.id = bp.id

        blueprintService.markPipelineRunning(ws.id, bpIdHolder.id, 'specify')
        blueprintRepository.updateStatus(bpIdHolder.id, 'failed')
        blueprintService.markPipelineStopped(ws.id)

        const ok = blueprintService.scheduleAutoRetry({
          blueprintId: bpIdHolder.id,
          workspaceId: ws.id,
          workspacePath: dir,
          phase: 'specify',
          // isRetryableError (the schedule gate) matches ECONNRESET; note
          // "timed out" (spaced) matches NEITHER its patterns nor /timeout/i.
          error: 'ECONNRESET socket hang up'
        })

        // A different blueprint starts on the workspace while the retry pends
        // (inside the same synchronous window, so the clamped timer cannot fire
        // between schedule and bump — the generation check is exercised exactly).
        const bp2 = blueprintService.create({ workspaceId: ws.id, title: 'E12 other' })
        blueprintService.markPipelineRunning(ws.id, bp2.id, 'plan')
        blueprintService.markPipelineStopped(ws.id)
        return ok
      })
      assert.equal(scheduled, true, 'a retryable error must schedule')

      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      assert.equal(autoRetryEvents.length, 0, 'superseded retry must NOT dispatch')

      blueprintService.off('autoRetry', onAutoRetry)
      blueprintService.clearAutoRetryState(bpIdHolder.id)
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
