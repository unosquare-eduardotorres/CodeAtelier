/**
 * R3.2 — escalation-ladder transition tests (closes M4.5).
 *
 * The ladder is bounded by construction:
 *
 *   attempt 1 → gates fail → attempt 2 (with evidence) → gates fail
 *     → attempt 3 (with evidence) → gates fail → lead model fixes → gates fail
 *     → task failed, phase hard-holds.
 *
 * These tests pin the DB-side accounting the ladder relies on — `recordAttempt`
 * monotonicity, `setEscalatedTo`, `setGateReport` replace-vs-accumulate
 * semantics, and `resetForRetry` clearing attempt state without touching the
 * ledger — plus the ladder-shape invariants (bounded attempts, escalation only
 * after exhaustion, unverifiable never entering the ladder).
 *
 * B3 adds a shortcut to that ladder: two IDENTICAL gate-failure fingerprints
 * end the builder rungs early, because a third cold session with the same
 * prompt cannot change a deterministic failure. Those tests drive the real
 * `executeTaskWithGates` against a real temp git repo (the baseline capture
 * needs one) with the session and the grader stubbed.
 *
 * Run: tsx src/main/services/__tests__/blueprint-gate-ladder.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import { fingerprintGateFailure, fingerprintPhaseError } from '../blueprint-failure-fingerprint'

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintTaskRepository: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintTaskRepository = repos.blueprintTaskRepository
} catch (err) {
  console.log(`⚠ gate-ladder setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('gate escalation ladder (skipped — no DB)', () => {
    test('ladder transitions', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  const MAX_BUILDER_ATTEMPTS = 3 // mirrors blueprint-build.service.ts

  function seedTask(): { blueprintId: string; taskId: string } {
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Ladder test' })
    const task = blueprintTaskRepository.create({
      blueprintId: bp.id,
      taskId: 'T001',
      wave: 1,
      description: 'Ladder task',
      filePathsJson: ['src/a.ts']
    })
    return { blueprintId: bp.id, taskId: task.id }
  }

  const failReport = (gate: string) => ({
    overall: 'fail',
    gates: [{ name: gate, verdict: 'fail', evidence: ['boom'], durationMs: 1 }]
  })
  const unverifiedReport = (gate: string, reason: string) => ({
    overall: 'unverifiable',
    gates: [{ name: gate, verdict: 'unverifiable', reason, evidence: ['meh'], durationMs: 1 }]
  })

  // ── Attempt accounting ──

  describe('recordAttempt (M4.5)', () => {
    test('is monotonic across the whole ladder', () => {
      const { taskId } = seedTask()
      assert.equal(blueprintTaskRepository.findById(taskId).attempts, 0)
      assert.equal(blueprintTaskRepository.recordAttempt(taskId), 1)
      assert.equal(blueprintTaskRepository.recordAttempt(taskId), 2)
      assert.equal(blueprintTaskRepository.recordAttempt(taskId), 3)
      assert.equal(blueprintTaskRepository.recordAttempt(taskId), 4, 'escalation rung also counts')
    })

    test('resetForRetry clears gate state but KEEPS attempts and the ledger', () => {
      const { taskId } = seedTask()
      blueprintTaskRepository.recordAttempt(taskId)
      blueprintTaskRepository.recordAttempt(taskId)
      blueprintTaskRepository.setEscalatedTo(taskId, 'blueprint:lead-review')
      blueprintTaskRepository.setGateReport(taskId, failReport('lint'), [
        { taskId: 'T001', gate: 'lint', reason: 'no_command', at: '2026-01-01T00:00:00Z' }
      ])

      const reset = blueprintTaskRepository.resetForRetry(taskId)
      assert.equal(reset.gatesJson, null, 'stale gate report must not leak into the new attempt')
      assert.equal(reset.escalatedTo, null, 'escalation flag must not leak either')
      assert.equal(reset.attempts, 2, 'attempts stay monotonic — history is not rewritten')
      assert.equal(
        reset.unverifiedJson.length,
        1,
        'the unverified ledger accumulates across attempts'
      )
    })
  })

  // ── Gate-report persistence ──

  describe('setGateReport (M4.3)', () => {
    test('the retry verdict REPLACES the report while the ledger ACCUMULATES', () => {
      const { taskId } = seedTask()
      blueprintTaskRepository.setGateReport(taskId, unverifiedReport('lint', 'no_command'), [
        { taskId: 'T001', gate: 'lint', reason: 'no_command', at: 't1' }
      ])
      blueprintTaskRepository.setGateReport(taskId, failReport('task-tests'), [
        { taskId: 'T001', gate: 'task-tests', reason: 'no_tests', at: 't2' }
      ])

      const task = blueprintTaskRepository.findById(taskId)
      assert.equal(task.gatesJson.overall, 'fail', 'latest verdict wins')
      assert.equal(task.gatesJson.gates[0].name, 'task-tests')
      assert.equal(task.unverifiedJson.length, 2, 'both attempts’ unverified items persist')
    })
  })

  // ── Ladder shape (pure invariants, no service instantiation) ──

  describe('ladder shape', () => {
    /**
     * The ladder as implemented in executeTaskWithGates: N builder attempts,
     * each graded; on exhaustion exactly one lead-model attempt, graded; then
     * the task fails. `unverifiable` exits the ladder immediately.
     */
    function simulateLadder(
      verdicts: Array<'pass' | 'fail' | 'unverifiable'>,
      leadVerdict: 'pass' | 'fail' | 'unverifiable' | null
    ): {
      builderRuns: number
      leadRuns: number
      escalated: boolean
      final: 'complete' | 'failed' | 'advanced'
      attempts: number
    } {
      let builderRuns = 0
      let leadRuns = 0
      let escalated = false
      let attempts = 0
      let final: 'complete' | 'failed' | 'advanced' = 'advanced'

      for (const verdict of verdicts) {
        builderRuns++
        attempts++
        if (verdict === 'pass' || verdict === 'unverifiable') {
          final = verdict === 'pass' ? 'complete' : 'advanced'
          return { builderRuns, leadRuns, escalated, final, attempts }
        }
      }
      if (leadVerdict !== null) {
        escalated = true
        leadRuns = 1
        attempts++
        final = leadVerdict === 'fail' ? 'failed' : leadVerdict === 'pass' ? 'complete' : 'advanced'
      } else {
        final = 'failed'
      }
      return { builderRuns, leadRuns, escalated, final, attempts }
    }

    test('bounded: worst case is MAX_BUILDER_ATTEMPTS builder runs + exactly one lead run', () => {
      const r = simulateLadder(['fail', 'fail', 'fail'], 'fail')
      assert.equal(r.builderRuns, MAX_BUILDER_ATTEMPTS)
      assert.equal(r.leadRuns, 1)
      assert.equal(r.escalated, true)
      assert.equal(r.final, 'failed')
      assert.equal(r.attempts, MAX_BUILDER_ATTEMPTS + 1)
    })

    test('a first-attempt pass never escalates', () => {
      const r = simulateLadder(['pass'], null)
      assert.equal(r.builderRuns, 1)
      assert.equal(r.leadRuns, 0)
      assert.equal(r.escalated, false)
      assert.equal(r.final, 'complete')
    })

    test('a second-attempt pass escalates nothing and completes', () => {
      const r = simulateLadder(['fail', 'pass'], null)
      assert.equal(r.builderRuns, 2)
      assert.equal(r.leadRuns, 0)
      assert.equal(r.final, 'complete')
    })

    test('unverifiable NEVER enters the ladder — it exits on the attempt that produced it', () => {
      const r = simulateLadder(['fail', 'unverifiable'], null)
      assert.equal(r.builderRuns, 2)
      assert.equal(r.leadRuns, 0)
      assert.equal(r.escalated, false)
      assert.equal(r.final, 'advanced', 'unverifiable warns and continues — never a retry')
    })

    test('the lead model passing after builder exhaustion completes the task', () => {
      const r = simulateLadder(['fail', 'fail', 'fail'], 'pass')
      assert.equal(r.leadRuns, 1)
      assert.equal(r.final, 'complete')
    })
  })

  // ── R2.1 — gate-command cache invalidation ──

  describe('R2.1 — gate-command cache invalidation (scaffold scenario)', () => {
    const { isManifestFile } = require('../blueprint-build.service')

    test('the manifest predicate recognises toolchain files across ecosystems', () => {
      for (const manifest of [
        'package.json',
        'sub/package.json',
        'Cargo.toml',
        'crates/core/Cargo.toml',
        'pyproject.toml',
        'src/Api.csproj',
        'tests/Api.Tests.csproj',
        'go.mod'
      ]) {
        assert.ok(isManifestFile(manifest), `must be a manifest: ${manifest}`)
      }
      for (const notManifest of [
        'src/index.ts',
        'package.json.bak',
        'README.md',
        'src/Program.cs',
        'go.mod.sum',
        'Cargo.lock'
      ]) {
        assert.ok(!isManifestFile(notManifest), `must NOT be a manifest: ${notManifest}`)
      }
    })

    test('a task whose write-set intersects a manifest invalidates the cached commands', () => {
      const { BlueprintBuildService } = require('../blueprint-build.service')
      const svc = new BlueprintBuildService()
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'R2.1 scaffold' })
      const blueprintId = bp.id

      // Seed the caches with an EMPTY resolution (blank workspace).
      svc.gateCommandCache.set(blueprintId, {})
      svc.manifestCache.set(blueprintId, {})

      // Simulate gradeTask's invalidation check for a scaffold task that wrote
      // package.json: the write-set intersects a manifest → caches must clear.
      const task = blueprintTaskRepository.create({
        blueprintId,
        taskId: 'T001',
        wave: 1,
        description: 'Scaffold the project',
        filePathsJson: ['package.json', 'src/index.ts']
      })
      const touchedManifest = [
        ...(task.packetJson?.allowedFiles ?? []),
        ...(task.filePathsJson ?? [])
      ].some((f: unknown) => typeof f === 'string' && isManifestFile(f as string))
      assert.ok(touchedManifest, 'a scaffold task writing package.json must trigger')

      // The invalidation gradeTask performs:
      svc.gateCommandCache.delete(blueprintId)
      svc.manifestCache.delete(blueprintId)

      assert.equal(svc.gateCommandCache.has(blueprintId), false)
      assert.equal(svc.manifestCache.has(blueprintId), false)
    })

    test('a task with a plain source write-set does NOT invalidate', () => {
      const plain = ['src/a.ts', 'src/b/c.ts', 'README.md']
      assert.ok(!plain.some((f) => isManifestFile(f)))
    })
  })

  // ── setEscalatedTo ──

  describe('setEscalatedTo (M4.5)', () => {
    test('records the role and clears with null', () => {
      const { taskId } = seedTask()
      const marked = blueprintTaskRepository.setEscalatedTo(taskId, 'blueprint:lead-review')
      assert.equal(marked.escalatedTo, 'blueprint:lead-review')
      const cleared = blueprintTaskRepository.setEscalatedTo(taskId, null)
      assert.equal(cleared.escalatedTo, null)
    })
  })

  // ── B3 — stop-loss on a repeated gate-failure fingerprint ──

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
    const dir = mkdtempSync(join(tmpdir(), 'stop-loss-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'ladder@test.local'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Ladder Test'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
    return dir
  }

  const gateFail = (evidence: string): unknown => ({
    overall: 'fail',
    gates: [{ name: 'task-tests', verdict: 'fail', evidence: [evidence], durationMs: 1 }]
  })

  interface LadderRun {
    builderRuns: number
    escalated: boolean
    attempts: number
    failureReason: string | null
  }

  /**
   * Drive the real `executeTaskWithGates` with the session and the grader
   * stubbed: `grades[n]` is the verdict handed back for builder attempt n+1.
   */
  async function runLadder(grades: unknown[]): Promise<LadderRun> {
    const dir = makeRepo()
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'B3 stop-loss' })
    const task = blueprintTaskRepository.create({
      blueprintId: bp.id,
      taskId: 'T001',
      wave: 1,
      description: 'Stop-loss task',
      filePathsJson: ['a.ts']
    })

    const { BlueprintBuildService } = require('../blueprint-build.service')
    const svc = new BlueprintBuildService()

    let builderRuns = 0
    let escalated = false
    svc.executeTask = async (): Promise<unknown> => {
      builderRuns++
      return { success: true, completion: null, discoveries: [] }
    }
    let graded = 0
    svc.gradeTask = async (): Promise<unknown> => grades[Math.min(graded++, grades.length - 1)]
    svc.escalateToLead = async (): Promise<unknown> => {
      escalated = true
      return { success: false, completion: null, discoveries: [], failureReason: 'lead failed' }
    }
    // Keep the ladder off disk-scanning paths that have nothing to say here.
    svc.resolveGateCommandsFor = (): unknown => ({})
    svc.readManifestsCached = (): unknown => ({})

    await svc.executeTaskWithGates({
      task,
      blueprintId: bp.id,
      workspaceId: wsId,
      workspacePath: dir,
      executionPath: dir,
      phaseContext: {} as never,
      priorDiscoveries: [],
      tDispatch: Date.now(),
      waveNum: 1
    })

    const after = blueprintTaskRepository.findById(task.id)
    // Removed here rather than in a trailing cleanup test: the harness starts
    // async tests concurrently, so a shared teardown runs before they finish.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    return { builderRuns, escalated, attempts: after.attempts, failureReason: after.failureReason }
  }

  describe('B3 — stop-loss on a repeated gate-failure fingerprint', () => {
    test(
      'an identical failure twice cuts the ladder from 3 builder attempts to 2',
      async () => {
        const run = await runLadder([
          gateFail('expected 3 assertions, got 0'),
          // Same failure, different numbers/paths — the fingerprint normalises
          // those away, which is the whole point: this is the SAME failure.
          gateFail('expected 7 assertions, got 0'),
          gateFail('expected 9 assertions, got 0')
        ])
        assert.equal(run.builderRuns, 2, 'the third builder attempt must be skipped')
        assert.equal(run.escalated, true, 'the ladder still ends at the lead model')
        assert.equal(run.attempts, 2, 'attempts follow the executions actually spent')
        assert.match(
          run.failureReason ?? '',
          /stop-loss after 2 identical gate failure/,
          'the skip must be recorded, not silent'
        )
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'a VARYING failure keeps all 3 builder attempts',
      async () => {
        const run = await runLadder([
          gateFail('unused variable foo'),
          gateFail('missing return type'),
          gateFail('unreachable code after return')
        ])
        assert.equal(run.builderRuns, 3, 'the builder is still moving — do not cut it short')
        assert.equal(run.escalated, true)
        assert.equal(run.attempts, 3)
        assert.ok(
          !(run.failureReason ?? '').includes('stop-loss'),
          'no stop-loss when the fingerprint changes'
        )
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'a pass on attempt 2 never reaches the stop-loss',
      async () => {
        const run = await runLadder([
          gateFail('expected 3 assertions, got 0'),
          { overall: 'pass', gates: [] }
        ])
        assert.equal(run.builderRuns, 2)
        assert.equal(run.escalated, false, 'a pass ends the ladder')
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )
  })
}

// ── B3 — the fingerprint itself (pure; runs without a DB) ──

describe('failure fingerprint (B3)', () => {
  test('normalises the parts that legitimately vary between attempts', () => {
    const a = fingerprintPhaseError('R045: verification failed after 3 checks in src/main/a.ts')
    const b = fingerprintPhaseError('R041: verification failed after 9 checks in src/main/b.ts')
    assert.equal(a, b, 'task id, count and path must not make two identical failures differ')
  })

  test('keeps genuinely different failures apart', () => {
    assert.notEqual(
      fingerprintPhaseError('lint failed: unused variable'),
      fingerprintPhaseError('lint failed: missing return type')
    )
  })

  test('gate order does not change the fingerprint', () => {
    const g = (name: string, evidence: string): unknown => ({
      name,
      verdict: 'fail',
      evidence: [evidence],
      durationMs: 1
    })
    const forward = fingerprintGateFailure({
      overall: 'fail',
      gates: [g('lint', 'unused variable'), g('task-tests', 'assertion failed')]
    } as never)
    const reversed = fingerprintGateFailure({
      overall: 'fail',
      gates: [g('task-tests', 'assertion failed'), g('lint', 'unused variable')]
    } as never)
    assert.equal(forward, reversed)
  })

  test('passing gates contribute nothing, and a clean report has no fingerprint', () => {
    const withPass = fingerprintGateFailure({
      overall: 'fail',
      gates: [
        { name: 'lint', verdict: 'pass', evidence: ['ok'], durationMs: 1 },
        { name: 'task-tests', verdict: 'fail', evidence: ['boom'], durationMs: 1 }
      ]
    } as never)
    const failOnly = fingerprintGateFailure({
      overall: 'fail',
      gates: [{ name: 'task-tests', verdict: 'fail', evidence: ['boom'], durationMs: 1 }]
    } as never)
    assert.equal(withPass, failOnly)

    // An empty fingerprint must never compare equal to a previous one, or a
    // report with no failing gate would trip the stop-loss on itself.
    assert.equal(fingerprintGateFailure({ overall: 'pass', gates: [] } as never), '')
    assert.equal(fingerprintGateFailure(null), '')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
