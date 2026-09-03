/**
 * P1 — `TaskResult.failureClass`, the machine-readable half of a task failure.
 *
 * `failureReason` is prose written for a human, and the stop-loss APPENDS to it.
 * Anything that routes on it has to substring-match, so one reword silently
 * sends gate failures down an infra path — a behaviour change with no compile
 * error and no alarm. `failureClass` exists so routing never has to parse.
 *
 * Its only real failure mode is omission: a new failure path that sets a reason
 * and forgets the class produces `undefined`, which every `=== 'quality'` test
 * reads as "not quality" and every `!== 'aborted'` test reads as "retry it".
 * So the second suite here is a source-level completeness check over the
 * service — the one shape a value test cannot cover, because the defect is a
 * path that does not exist yet.
 *
 * Run: tsx src/main/services/__tests__/blueprint-task-failure-class.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import type { SendOutcome } from '../agent-session.service'

setupElectronStub()

// `require` after the stub, not a hoisted import — see the note in
// blueprint-no-write-activity-guard.test.ts.
const { classifySendOutcome, isResumeSafeOutcome } = require('../blueprint-build.service') as {
  classifySendOutcome: (o: Exclude<SendOutcome, 'ok'>) => 'infra' | 'quality' | 'aborted'
  isResumeSafeOutcome: (o: Exclude<SendOutcome, 'ok'>) => boolean
}

describe('classifySendOutcome — every abnormal session outcome has a class', () => {
  // Table over the WHOLE union. `SendOutcome` gaining a member is a compile
  // error in the service's switch; this pins the values that switch produces.
  const cases: [Exclude<SendOutcome, 'ok'>, 'infra' | 'quality' | 'aborted'][] = [
    ['aborted', 'aborted'],
    ['overload', 'infra'],
    ['error', 'infra'],
    ['context_overflow', 'infra'],
    ['turn_limit_exhausted', 'infra']
  ]

  for (const [outcome, expected] of cases) {
    test(`${outcome} → ${expected}`, () => {
      assert.equal(classifySendOutcome(outcome), expected)
    })
  }

  test('a session outcome is never classified as a quality verdict', () => {
    // The gates grade work; the transport does not. If a send outcome ever
    // classified as 'quality' it would route a session that never ran to the
    // "the code was wrong" path.
    for (const [outcome] of cases) {
      assert.notEqual(classifySendOutcome(outcome), 'quality', `${outcome} must not be 'quality'`)
    }
  })

  test('only user cancellation is aborted', () => {
    // 'aborted' is the one class that means "do not retry". Widening it by
    // accident would silently stop retrying real failures.
    const aborted = cases.filter(([, c]) => c === 'aborted').map(([o]) => o)
    assert.deepEqual(aborted, ['aborted'])
  })
})

describe('R5 — resume permission is its own answer, not an inference from the class', () => {
  // The two outcomes below are 'infra' AND unresumable: resuming re-sends the
  // transcript that overflowed. When that fact lived in a comment on
  // `failureClass`, nothing stopped a caller from reading 'infra' as a permit.
  const cases: [Exclude<SendOutcome, 'ok'>, boolean][] = [
    ['overload', true],
    ['error', true],
    ['context_overflow', false],
    ['turn_limit_exhausted', false],
    ['aborted', false]
  ]

  for (const [outcome, expected] of cases) {
    test(`${outcome} → resumeSafe ${expected}`, () => {
      assert.equal(isResumeSafeOutcome(outcome), expected)
    })
  }

  test('the class alone does not decide it — infra splits both ways', () => {
    const infra = cases.filter(([o]) => classifySendOutcome(o) === 'infra')
    assert.ok(
      infra.some(([, safe]) => safe) && infra.some(([, safe]) => !safe),
      "if every 'infra' outcome agreed, the class WOULD be a permit and this " +
        'function would be redundant — it is not'
    )
  })
})

describe('every failing TaskResult in the service carries a failureClass', () => {
  const SOURCE = readFileSync(join(__dirname, '..', 'blueprint-build.service.ts'), 'utf-8')

  /**
   * The object literal enclosing `index`: walk back to its `{`, then forward to
   * the matching `}`. Brace-counted rather than line-indented, so reformatting
   * the file does not change the answer.
   */
  function enclosingLiteral(source: string, index: number): string {
    let depth = 0
    let open = -1
    for (let i = index; i >= 0; i--) {
      if (source[i] === '}') depth++
      else if (source[i] === '{') {
        if (depth === 0) {
          open = i
          break
        }
        depth--
      }
    }
    assert.notEqual(open, -1, 'every `success: false` must sit inside an object literal')

    depth = 0
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) return source.slice(open, i + 1)
      }
    }
    throw new Error('unbalanced object literal')
  }

  test('no failing TaskResult is constructed without a class', () => {
    const sites: number[] = []
    for (let i = SOURCE.indexOf('success: false'); i !== -1;) {
      sites.push(i)
      i = SOURCE.indexOf('success: false', i + 1)
    }
    assert.ok(sites.length >= 7, `expected the known failure sites, found ${sites.length}`)

    const missing: string[] = []
    for (const at of sites) {
      const literal = enclosingLiteral(SOURCE, at)
      // A spread of an already-classified result carries the class forward, so
      // it counts: `{ ...result, success: false, failureReason }` re-labels a
      // failure that was classified where it was born.
      if (literal.includes('failureClass') || /\.\.\.\w+/.test(literal)) continue
      missing.push(`line ${SOURCE.slice(0, at).split('\n').length}`)
    }

    assert.deepEqual(
      missing,
      [],
      `failing TaskResult(s) with no failureClass at: ${missing.join(', ')} — ` +
        'an unclassified failure defaults to undefined, which routing reads as "not quality"'
    )
  })

  test('failureReason wording is untouched by the classification work', () => {
    // The UI and `humanizeFailureReason`'s /quality gate failed/i branch key off
    // these exact strings. P1 adds a field; it must not reword a single one.
    for (const phrase of [
      "failureReason: 'aborted'",
      '`quality gate failed: ${failedNames}`',
      '`quality gate failed after escalation: ${failedNames}`',
      "'no-write-activity'",
      '`executor error: ${executorErrorBox.value.slice(0, 200)}`',
      'verification failed — '
    ]) {
      assert.ok(SOURCE.includes(phrase), `failure wording changed: ${phrase}`)
    }
  })
})

describe('R1 — a failed ATTEMPT persists its class, even when the task recovers', () => {
  let env: { wsId: string } | null = null
  let blueprintRepository: any
  let blueprintTaskRepository: any
  let blueprintTelemetryRepository: any
  try {
    env = require('../../db/repositories/__tests__/db-test-helper').attachTestDb()
    const repos = require('../../db/repositories/blueprint.repository')
    blueprintRepository = repos.blueprintRepository
    blueprintTaskRepository = repos.blueprintTaskRepository
    blueprintTelemetryRepository =
      require('../../db/repositories/blueprint-telemetry.repository').blueprintTelemetryRepository
  } catch {
    env = null
  }

  const GIT_AVAILABLE = ((): boolean => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  /** A one-commit repo — `captureGateBaseline` needs a real HEAD to resolve. */
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'attempt-failure-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'ladder@test.local'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Ladder Test'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
    return dir
  }

  const skipReason = !env ? 'no DB' : GIT_AVAILABLE ? undefined : 'git not available'

  test(
    'a gate failure that the NEXT attempt fixes still leaves a row behind',
    async () => {
      if (!env) return
      // THE SCENARIO THE SETTLE-TIME ROW COULD NOT SEE. `handleTaskCompletion`
      // runs once per task, at settle, and a task that fails then succeeds
      // settles as a success — with `failure_reason` cleared. 86 of 201 tasks in
      // the reference run look like this, and they are the entire population M0
      // asks about. Only a row written from inside the ladder survives it.
      const dir = makeRepo()
      const bp = blueprintRepository.create({ workspaceId: env.wsId, title: 'R1 attempt rows' })
      const task = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'T001',
        wave: 1,
        description: 'Fails its gates once, then passes',
        filePathsJson: ['a.ts']
      })

      const { BlueprintBuildService } = require('../blueprint-build.service')
      const svc = new BlueprintBuildService()
      svc.executeTask = async (): Promise<unknown> => ({
        success: true,
        completion: null,
        discoveries: []
      })
      let graded = 0
      svc.gradeTask = async (): Promise<unknown> =>
        graded++ === 0
          ? {
              overall: 'fail',
              gates: [
                { name: 'task-tests', verdict: 'fail', evidence: ['1 failed'], durationMs: 1 }
              ]
            }
          : { overall: 'pass', gates: [] }
      svc.escalateToLead = async (): Promise<unknown> => {
        throw new Error('the ladder must not escalate — attempt 2 passes')
      }
      svc.resolveGateCommandsFor = (): unknown => ({})
      svc.readManifestsCached = (): unknown => ({})

      const ladderResult = (await svc.executeTaskWithGates({
        task,
        blueprintId: bp.id,
        workspaceId: env.wsId,
        workspacePath: dir,
        executionPath: dir,
        phaseContext: {} as never,
        priorDiscoveries: [],
        tDispatch: Date.now(),
        waveNum: 1
      })) as { success: boolean }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }

      assert.equal(ladderResult.success, true, 'the retry fixed it — the TASK is a success')

      const rows = blueprintTelemetryRepository
        .findByBlueprint(bp.id)
        .filter((r: { kind: string }) => r.kind === 'task_failure')
      assert.equal(rows.length, 1, 'the failed attempt is recorded even though the task passed')
      assert.equal(rows[0].taskId, 'T001')
      assert.equal(rows[0].attempt, 1, 'the loop index — the number a settle-time row cannot give')
      assert.equal(rows[0].data.failureClass, 'quality')
      assert.equal(rows[0].data.failedGates, 'task-tests')

      // And the settle path adds nothing: a success clears `failure_reason`, so
      // without the row above the run would claim this task never retried.
      svc.handleTaskCompletion({
        task,
        taskResult: { success: true, completion: null, discoveries: [], outcomeKind: 'verified' },
        blueprintId: bp.id,
        workspaceId: env.wsId,
        waveNum: 1,
        result: {
          taskTimings: [],
          filesCreated: [],
          filesModified: [],
          discoveries: [],
          taskFailures: [],
          tasksCompleted: 0
        }
      })
      assert.equal(
        blueprintTaskRepository.findById(task.id).failureReason,
        null,
        'the recovered task keeps no reason — this is why the attempt row exists'
      )
      assert.equal(
        blueprintTelemetryRepository
          .findByBlueprint(bp.id)
          .filter((r: { kind: string }) => r.kind === 'task_failure').length,
        1,
        'the attempt row survives the recovery, and settle does not add a second'
      )
    },
    { skipReason }
  )

  test(
    'an attempt that fails before the gates is recorded with its infra class',
    async () => {
      if (!env) return
      const dir = makeRepo()
      const bp = blueprintRepository.create({ workspaceId: env.wsId, title: 'R1 infra attempt' })
      const task = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'T002',
        wave: 2,
        description: 'Dies in transport',
        filePathsJson: ['a.ts']
      })

      const { BlueprintBuildService } = require('../blueprint-build.service')
      const svc = new BlueprintBuildService()
      svc.executeTask = async (): Promise<unknown> => ({
        success: false,
        completion: null,
        discoveries: [],
        failureReason: 'executor error: server died',
        failureClass: 'infra'
      })
      svc.gradeTask = async (): Promise<unknown> => {
        throw new Error('an ungraded failure must never reach the gates')
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
        waveNum: 2
      })
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }

      const rows = blueprintTelemetryRepository
        .findByBlueprint(bp.id)
        .filter((r: { kind: string }) => r.kind === 'task_failure')
      assert.equal(rows.length, 1, 'exactly one row — the ungraded attempt, not the settle')
      assert.equal(rows[0].data.failureClass, 'infra')
      assert.equal(rows[0].data.wave, 2, 'the wave rides along — M0 splits retries by wave')
      assert.equal(rows[0].attempt, 1)
    },
    { skipReason }
  )
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
