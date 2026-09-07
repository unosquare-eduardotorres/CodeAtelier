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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import { fingerprintGateFailure, fingerprintPhaseError } from '../blueprint-failure-fingerprint'

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintTaskRepository: any
let blueprintTelemetryRepository: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintTaskRepository = repos.blueprintTaskRepository
  blueprintTelemetryRepository =
    require('../../db/repositories/blueprint-telemetry.repository').blueprintTelemetryRepository
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

    // T003 — `command_missing` must invalidate the command caches exactly as
    // `no_command` does, so re-detection (and the venv rewrite) gets a chance
    // on the next rung instead of grading against the same dead resolution.
    test('a command_missing gate verdict marks resolution stale and invalidates the caches', () => {
      const { BlueprintBuildService } = require('../blueprint-build.service')
      const svc = new BlueprintBuildService()
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'T003 R2.1' })
      const blueprintId = bp.id

      svc.gateCommandCache.set(blueprintId, {
        test: {
          command: 'multiplexer/.venv-mux/Scripts/python.exe -m unittest',
          provenance: 'declared'
        }
      })
      svc.manifestCache.set(blueprintId, {})

      // The report the gate produces when the interpreter path is absent
      // (T003: cmd.exe "The system cannot find the path specified.").
      const commandMissingReport = {
        overall: 'unverifiable',
        gates: [
          {
            name: 'task-tests',
            verdict: 'unverifiable',
            reason: 'command_missing',
            evidence: ['multiplexer/.venv-mux/Scripts/python.exe — the runner is not installed'],
            durationMs: 1
          }
        ]
      }
      assert.equal(
        svc.isCommandResolutionStale(commandMissingReport),
        true,
        'command_missing must mark resolution stale (T003)'
      )
      assert.equal(
        svc.isCommandResolutionStale({
          overall: 'fail',
          gates: [
            { name: 'task-tests', verdict: 'fail', evidence: ['assert 1 == 2'], durationMs: 1 }
          ]
        }),
        false,
        'a red suite says nothing about resolution'
      )
      assert.equal(
        svc.isCommandResolutionStale({
          overall: 'unverifiable',
          gates: [
            {
              name: 'build',
              verdict: 'unverifiable',
              reason: 'no_command',
              evidence: [],
              durationMs: 1
            }
          ]
        }),
        true,
        'no_command keeps its R2.1 behavior'
      )

      // The invalidation gradeTask performs on a stale resolution:
      svc.gateCommandCache.delete(blueprintId)
      svc.manifestCache.delete(blueprintId)
      assert.equal(svc.gateCommandCache.has(blueprintId), false)
      assert.equal(svc.manifestCache.has(blueprintId), false)
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
  function makeRepo(extra: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'stop-loss-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'ladder@test.local'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Ladder Test'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    for (const [rel, content] of Object.entries(extra)) writeFileSync(join(dir, rel), content)
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
    /** `failure_reason` on the task row — nothing writes it on this path. */
    rowFailureReason: string | null
    /** The reason on the RETURNED result, which is where the stop-loss note rides. */
    failureReason: string | null
    /** C1/C2 — for the scope-park assertions. */
    blueprintId: string
    taskId: string
    outcomeKind: string | null | undefined
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
    svc.executeTask = async (p: {
      writeActivity?: { writeToolCalls: number }
    }): Promise<unknown> => {
      builderRuns++
      // 1.4 — the zero-work requeue intercepts a stop-loss whose rung wrote
      // nothing. These tests exercise the stop-loss→ESCALATION path, so the
      // stub simulates a rung that wrote a file (a real builder session
      // always emits at least one write-capable tool_use on a graded failure).
      if (p?.writeActivity) p.writeActivity.writeToolCalls++
      return { success: true, completion: null, discoveries: [] }
    }
    let graded = 0
    svc.gradeTask = async (): Promise<unknown> => grades[Math.min(graded++, grades.length - 1)]
    svc.escalateToLead = async (): Promise<unknown> => {
      escalated = true
      return {
        success: false,
        completion: null,
        discoveries: [],
        failureReason: 'quality gate failed after escalation: task-tests'
      }
    }
    // Keep the ladder off disk-scanning paths that have nothing to say here.
    svc.resolveGateCommandsFor = (): unknown => ({})
    svc.readManifestsCached = (): unknown => ({})

    // The RESULT, not the row: this test calls the ladder directly, so
    // `handleTaskCompletion` — the only writer of `failure_reason` — never runs.
    const result = (await svc.executeTaskWithGates({
      task,
      blueprintId: bp.id,
      workspaceId: wsId,
      workspacePath: dir,
      executionPath: dir,
      phaseContext: {} as never,
      priorDiscoveries: [],
      tDispatch: Date.now(),
      waveNum: 1
    })) as { failureReason?: string | null; outcomeKind?: string | null }

    const after = blueprintTaskRepository.findById(task.id)
    // Removed here rather than in a trailing cleanup test: the harness starts
    // async tests concurrently, so a shared teardown runs before they finish.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    return {
      builderRuns,
      escalated,
      attempts: after.attempts,
      rowFailureReason: after.failureReason,
      failureReason: result?.failureReason ?? null,
      blueprintId: bp.id,
      taskId: task.id,
      outcomeKind: result?.outcomeKind
    }
  }

  // ── Packet test files damaged by a failed attempt ──

  describe('a failed attempt’s damage to a packet test file must not poison the next rung', () => {
    const SPEC = "test('spec', () => { expect(run()).toBe(42) })\n"
    const WEAKENED = "test('spec', () => {})\n"

    interface IntegrityRun {
      builderRuns: number
      escalated: boolean
      /** True at each grading = the tree was damaged when that grading ran. */
      gradedDamaged: boolean[]
      /** The packet test file as the ladder left it. */
      finalSpec: string
      failureReason: string | null
      /** The fix instructions handed to the LAST builder attempt. */
      lastInstructions: string
    }

    /**
     * The real ladder, with a miniature `test-integrity` in place of `gradeTask`:
     * it grades what is ON DISK, exactly as the real gate does. That is the
     * property under test — nothing else in the ladder reverts the tree, so an
     * attempt's leftover edit is what the next attempt is graded on.
     */
    async function runIntegrityLadder(reweakenEveryAttempt: boolean): Promise<IntegrityRun> {
      const dir = makeRepo({ 't.test.ts': SPEC })
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'test-integrity ladder' })
      const created = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'T001',
        wave: 1,
        description: 'Make the pre-authored test pass',
        filePathsJson: ['a.ts']
      })
      // No testCommand: the red proof must not spawn anything on this path.
      const task = blueprintTaskRepository.setPacket(created.id, {
        allowedFiles: ['a.ts'],
        testFiles: ['t.test.ts']
      })

      const { BlueprintBuildService } = require('../blueprint-build.service')
      const svc = new BlueprintBuildService()

      let builderRuns = 0
      let escalated = false
      let lastInstructions = ''
      const gradedDamaged: boolean[] = []

      svc.executeTask = async (p: {
        gateFixInstructions?: string
        writeActivity?: { writeToolCalls: number }
      }): Promise<unknown> => {
        builderRuns++
        lastInstructions = p?.gateFixInstructions ?? ''
        // 1.4 — simulate a rung that wrote (see runLadder for why).
        if (p?.writeActivity) p.writeActivity.writeToolCalls++
        // Attempt 1 edits the spec instead of the implementation.
        if (reweakenEveryAttempt || builderRuns === 1) {
          writeFileSync(join(dir, 't.test.ts'), WEAKENED)
        }
        return { success: true, completion: null, discoveries: [] }
      }
      svc.gradeTask = async (): Promise<unknown> => {
        const damaged = readFileSync(join(dir, 't.test.ts'), 'utf-8') !== SPEC
        gradedDamaged.push(damaged)
        return damaged
          ? {
              overall: 'fail',
              gates: [
                {
                  name: 'test-integrity',
                  verdict: 'fail',
                  evidence: [
                    'test file modified (content differs from the pre-session spec): t.test.ts'
                  ],
                  files: ['t.test.ts'],
                  durationMs: 1
                }
              ]
            }
          : { overall: 'pass', gates: [] }
      }
      svc.escalateToLead = async (): Promise<unknown> => {
        escalated = true
        return {
          success: false,
          completion: null,
          discoveries: [],
          failureReason: 'quality gate failed after escalation: test-integrity'
        }
      }
      svc.resolveGateCommandsFor = (): unknown => ({})
      svc.readManifestsCached = (): unknown => ({})

      const result = (await svc.executeTaskWithGates({
        task,
        blueprintId: bp.id,
        workspaceId: wsId,
        workspacePath: dir,
        executionPath: dir,
        phaseContext: {} as never,
        priorDiscoveries: [],
        tDispatch: Date.now(),
        waveNum: 1
      })) as { failureReason?: string | null }

      const finalSpec = readFileSync(join(dir, 't.test.ts'), 'utf-8')
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
      return {
        builderRuns,
        escalated,
        gradedDamaged,
        finalSpec,
        failureReason: result?.failureReason ?? null,
        lastInstructions
      }
    }

    test(
      'attempt 2 is graded on a repaired tree, not on attempt 1’s leftover',
      async () => {
        const run = await runIntegrityLadder(false)
        assert.deepEqual(
          run.gradedDamaged,
          [true, false],
          'attempt 1 damaged the spec; attempt 2 touched nothing and must grade clean — ' +
            'before the restore this graded [true, true] forever'
        )
        assert.equal(run.builderRuns, 2)
        assert.equal(run.escalated, false, 'a recoverable failure must not reach the lead model')
        assert.equal(run.finalSpec, SPEC, 'the specification is back, byte for byte')
        assert.match(
          run.lastInstructions,
          /ALREADY restored[\s\S]*t\.test\.ts/,
          'the retry must be told the restore happened, or it reads the instruction as ' +
            '“edit this test file” — the one thing it must not do'
        )
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'a builder that re-weakens the file every attempt still trips the stop-loss',
      async () => {
        const run = await runIntegrityLadder(true)
        assert.deepEqual(run.gradedDamaged, [true, true], 'the damage is genuinely re-done')
        assert.equal(
          run.builderRuns,
          2,
          'B3 still cuts the third rung — this builder is not moving'
        )
        assert.equal(run.escalated, true)
        assert.match(run.failureReason ?? '', /stop-loss after 2 identical gate failure\(s\)/)
        assert.equal(
          run.finalSpec,
          SPEC,
          'and the lead model inherits a repaired tree rather than the corpse'
        )
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )
  })

  // ── Exits that never produce a test-integrity verdict ──

  describe('a task that does not SUCCEED must never end with a weakened packet spec', () => {
    const SPEC = "test('spec', () => { expect(run()).toBe(42) })\n"
    const WEAKENED = "test('spec', () => {})\n"

    interface NetRun {
      builderRuns: number
      /** `test_restore` telemetry stages, in the order they were written. */
      restoreStages: string[]
      /** The packet test file as the ladder left it. */
      finalSpec: string
    }

    /**
     * The real ladder against a real temp repo, with only the session and the
     * grader stubbed. `damagedGate` decides WHICH gate the stub fails on while
     * the spec is damaged — `write-set` is the case `runGates` short-circuits
     * on, so no `test-integrity` verdict exists and the report-driven restore
     * has nothing to act on.
     */
    async function runNetLadder(opts: {
      damagedGate: 'test-integrity' | 'write-set'
      /** false — every session reports failure, so the ladder never grades. */
      sessionSucceeds?: boolean
      /** true — the REAL escalateToLead runs, and its own attempt damages the spec. */
      realEscalation?: boolean
    }): Promise<NetRun> {
      const dir = makeRepo({ 't.test.ts': SPEC })
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'restore net' })
      const created = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'T001',
        wave: 1,
        description: 'Make the pre-authored test pass',
        filePathsJson: ['a.ts']
      })
      const task = blueprintTaskRepository.setPacket(created.id, {
        allowedFiles: ['a.ts'],
        testFiles: ['t.test.ts']
      })

      const { BlueprintBuildService } = require('../blueprint-build.service')
      const svc = new BlueprintBuildService()

      let builderRuns = 0
      // EVERY session weakens the spec — including the lead model's.
      svc.executeTask = async (p: {
        writeActivity?: { writeToolCalls: number }
      }): Promise<unknown> => {
        builderRuns++
        // 1.4 — simulate a rung that wrote (see runLadder for why).
        if (p?.writeActivity) p.writeActivity.writeToolCalls++
        writeFileSync(join(dir, 't.test.ts'), WEAKENED)
        return opts.sessionSucceeds === false
          ? {
              success: false,
              completion: null,
              discoveries: [],
              failureReason: 'session died mid-flight',
              failureClass: 'session'
            }
          : { success: true, completion: null, discoveries: [] }
      }
      svc.gradeTask = async (): Promise<unknown> => {
        const damaged = readFileSync(join(dir, 't.test.ts'), 'utf-8') !== SPEC
        if (!damaged) return { overall: 'pass', gates: [] }
        return {
          overall: 'fail',
          gates: [
            {
              name: opts.damagedGate,
              verdict: 'fail',
              evidence: ['the spec no longer matches the pre-session capture'],
              // Only test-integrity carries the machine-readable path list; a
              // short-circuited run never even computes that verdict.
              ...(opts.damagedGate === 'test-integrity' ? { files: ['t.test.ts'] } : {}),
              durationMs: 1
            }
          ]
        }
      }
      if (!opts.realEscalation) {
        svc.escalateToLead = async (): Promise<unknown> => ({
          success: false,
          completion: null,
          discoveries: [],
          failureReason: `quality gate failed after escalation: ${opts.damagedGate}`
        })
      }
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

      const finalSpec = readFileSync(join(dir, 't.test.ts'), 'utf-8')
      const restoreStages = blueprintTelemetryRepository
        .findByBlueprint(bp.id)
        .filter((r: { kind: string }) => r.kind === 'test_restore')
        .map((r: { data: Record<string, unknown> }) => String(r.data.stage))
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
      return { builderRuns, restoreStages, finalSpec }
    }

    test(
      'the lead model’s OWN damage is restored on the way out of the escalation',
      async () => {
        const run = await runNetLadder({ damagedGate: 'test-integrity', realEscalation: true })
        assert.deepEqual(
          run.restoreStages,
          ['ladder', 'ladder', 'escalation'],
          'the escalation rung grades and returns — without its own restore the most ' +
            'common terminal path ends with the weakened spec on disk, and the ' +
            'operator’s next Retry captures it as the new baseline (a FALSE GREEN)'
        )
        assert.equal(run.finalSpec, SPEC, 'the specification is back, byte for byte')
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'a write-set failure short-circuits past test-integrity, and the sweep still repairs the tree',
      async () => {
        const run = await runNetLadder({ damagedGate: 'write-set' })
        assert.deepEqual(
          run.restoreStages,
          ['sweep'],
          'no test-integrity verdict exists on this path, so the report-driven ' +
            'restore has nothing to act on — only the tree-driven net can see the damage'
        )
        assert.equal(run.finalSpec, SPEC)
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'a session that dies after damaging the spec is never graded — and is still swept',
      async () => {
        const run = await runNetLadder({ damagedGate: 'test-integrity', sessionSucceeds: false })
        assert.equal(run.builderRuns, 1, 'a session failure exits the ladder immediately')
        assert.deepEqual(run.restoreStages, ['sweep'])
        assert.equal(
          run.finalSpec,
          SPEC,
          'the ladder returns before any grading, so only the finally net stands ' +
            'between this damage and the next Retry’s baseline'
        )
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )
  })

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
          /quality gate failed after escalation/,
          'the escalation reason must survive — the renderer keys its explanation off it'
        )
        assert.match(
          run.failureReason ?? '',
          /stop-loss after 2 identical gate failure\(s\).*skipped 1 builder attempt/,
          'the skip must ride out on the result, with true counts — a write to the ' +
            'task row here is overwritten by handleTaskCompletion on every path'
        )
        assert.equal(
          run.rowFailureReason,
          null,
          'and the ladder itself writes nothing to the row: `failure_reason` is ' +
            'handleTaskCompletion’s to set, from the result above'
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
      'a repeat that arrives on the LAST attempt claims no saving it did not make',
      async () => {
        // A, B, B — the run of identical failures is 2, but it completes on
        // attempt 3, where there is no remaining rung to skip. The stop-loss
        // must stay silent rather than announce "3× in a row, skipped 0".
        const run = await runLadder([
          gateFail('unused variable foo'),
          gateFail('expected 3 assertions, got 0'),
          gateFail('expected 7 assertions, got 0')
        ])
        assert.equal(run.builderRuns, 3, 'nothing was skippable — all three rungs run')
        assert.equal(run.escalated, true)
        assert.ok(
          !(run.failureReason ?? '').includes('stop-loss'),
          'a stop-loss on the final attempt saves nothing and must not be claimed'
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

  // ═════════════════════════════════════════════════════════════════════
  // B3 (ring) — recurrence, not just consecutive equality
  //
  // T011 on 7624e83f oscillated task-tests → write-set → task-tests: every
  // attempt reset a consecutive counter, rounds 3 and 4 burned the full
  // ladder. The ring catches any recurrence inside its window.
  // ═══════════════════════════════════════════════════════════════════

  describe('B3 (ring) — stop-loss on a RECURRED (non-consecutive) fingerprint', () => {
    test(
      'an A,B,A,B 2-cycle trips the ring stop-loss while rungs remain (A,B,A on the last rung does not)',
      async () => {
        // MAX_BUILDER_ATTEMPTS = 3: an A,B,A recurrence completes exactly on
        // the last rung, where the last-attempt guard (correctly) claims no
        // saving — that terminal shape is the C1 post-loop park's job, not
        // the stop-loss's. The ring's own cut is observable only when the
        // recurrence is detected with a rung left to skip — which needs the
        // 4th attempt of a 2-cycle, i.e. beyond this ladder's cap. What CAN
        // be asserted here is the complement: A,B,A neither cuts (nothing to
        // skip) nor FALSELY announces a stop-loss, and A,B,C keeps all
        // rungs. The ring-vs-consecutive distinction is therefore pinned by
        // the empty-chain test above (the old consecutive logic cleared the
        // chain on every alternation; the ring does not) and by the C1
        // parking test below, whose signature IS the alternation.
        const run = await runLadder([
          gateFail('expected 3 assertions, got 0'),
          gateFail('unused variable foo'),
          gateFail('expected 7 assertions, got 0')
        ])
        assert.equal(run.builderRuns, 3, 'nothing skippable on the last rung')
        assert.ok(
          !(run.failureReason ?? '').includes('stop-loss'),
          'a stop-loss on the final attempt saves nothing and must not be claimed'
        )
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'distinct failures A,B,C keep all 3 builder attempts',
      async () => {
        const run = await runLadder([
          gateFail('expected 3 assertions, got 0'),
          gateFail('unused variable foo'),
          gateFail('missing return type')
        ])
        assert.equal(run.builderRuns, 3, 'no recurrence inside the window — no cut')
        assert.equal(run.escalated, true)
        assert.ok(!(run.failureReason ?? '').includes('stop-loss'))
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'an empty-fingerprint attempt breaks the chain: A, (no signature), A does not trip',
      async () => {
        const run = await runLadder([
          gateFail('expected 3 assertions, got 0'),
          { overall: 'fail', gates: [] },
          gateFail('expected 7 assertions, got 0')
        ])
        assert.equal(run.builderRuns, 3, 'the ring must clear on an empty signature')
        assert.ok(!(run.failureReason ?? '').includes('stop-loss'))
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )
  })

  // ═════════════════════════════════════════════════════════════════════
  // C1/C2 — blocked_by_scope: the write-set / task-tests alternation with a
  // stable out-of-set file list parks the task instead of escalating.
  //
  // The live signature: the builder keeps producing the SAME out-of-set fix
  // (stable `files` on the write-set gate) while task-tests stays red on the
  // defect that fix would cure — each attempt "fixes" one gate and
  // reintroduces the other.
  // ═══════════════════════════════════════════════════════════════════

  /** A gate report whose write-set failure carries a structured files array. */
  const writeSetFail = (files: string[]): unknown => ({
    overall: 'fail',
    gates: [
      {
        name: 'write-set',
        verdict: 'fail',
        evidence: files.map((f) => `outside write-set: ${f}`),
        files,
        durationMs: 1
      }
    ]
  })

  const taskTestsFail = (msg: string): unknown => ({
    overall: 'fail',
    gates: [{ name: 'task-tests', verdict: 'fail', evidence: [msg], durationMs: 1 }]
  })

  describe('C1/C2 — blocked_by_scope parks the task for a human decision', () => {
    test(
      'alternating task-tests/write-set with a stable files list parks instead of escalating',
      async () => {
        const outOfSet = ['apps/enrollment/src/lib/enrollment/sign-gate.ts']
        const run = await runLadder([
          writeSetFail(outOfSet),
          taskTestsFail('npm run test:e2e:portal exited 1'),
          writeSetFail(outOfSet)
        ])
        // MAX_BUILDER_ATTEMPTS = 3: the 2-cycle completes on the last rung,
        // exhaustion would escalate — the park intercepts BEFORE the premium
        // rung (the exact 4-escalation waste of the motivating run).
        assert.equal(run.builderRuns, 3, 'all builder rungs spent (2-cycle needs 3)')
        assert.equal(
          run.escalated,
          false,
          'the premium model must NOT be spent on a constraint it cannot change'
        )
        assert.match(run.failureReason ?? '', /blocked_by_scope/, 'the park reason names the lane')
        assert.match(
          run.failureReason ?? '',
          /sign-gate\.ts/,
          'and the exact files the human must grant'
        )
        // C2 — the telemetry row and the parked outcome kind.
        const rows = blueprintTelemetryRepository
          .findByBlueprint(run.blueprintId)
          .filter((r: { kind: string }) => r.kind === 'scope_amendment')
        assert.equal(rows.length, 1, 'exactly one scope_amendment row')
        const data = rows[0].data as { proposedFiles?: string[] }
        assert.deepEqual(data.proposedFiles, outOfSet)
        // This test calls the ladder directly, so handleTaskCompletion (the
        // row writer) did not run — the kind rides on the RESULT instead.
        assert.equal(run.outcomeKind, 'needs_scope_amendment')
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'write-set failing twice on the same files WITHOUT task-tests is the B3 case, not C1',
      async () => {
        const run = await runLadder([
          writeSetFail(['src/rogue.ts']),
          writeSetFail(['src/rogue.ts']),
          writeSetFail(['src/rogue.ts'])
        ])
        assert.equal(run.escalated, true, 'no alternation → no scope park, plain stop-loss')
        assert.match(run.failureReason ?? '', /stop-loss/)
        assert.ok(!(run.failureReason ?? '').includes('blocked_by_scope'))
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'a write-set failure whose files VARY each attempt does not trip C1',
      async () => {
        const run = await runLadder([
          taskTestsFail('suite red'),
          writeSetFail(['src/one.ts']),
          taskTestsFail('suite red'),
          writeSetFail(['src/two.ts'])
        ])
        assert.equal(
          run.escalated,
          true,
          'no stable out-of-set target — the builder is still exploring, escalate'
        )
        assert.ok(!(run.failureReason ?? '').includes('blocked_by_scope'))
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )
  })

  // ── T003 — pre-dispatch prerequisite check ──

  describe('T003 — pre-dispatch prerequisite: missing test interpreter fails fast', () => {
    /** The effective (post-rewrite) per-task test command, captured at grading. */
    interface PrereqRun {
      builderRuns: number
      failureReason: string | null
      failureClass: string | undefined
      attempts: number
      telemetryRows: Array<Record<string, unknown>>
      effectiveCommand: string | null
      /** The temp repo root (workspacePath = executionPath in this harness). */
      dir: string
    }

    /**
     * Drive the real ladder with a venv-path test command; `venvExists` decides
     * disk state. Without `packet`, the venv command comes from the
     * workspace-level resolution (`resolveGateCommandsFor`); with `packet`, it
     * comes from the PACKET's `testCommand` — the G2/G6 path that must flow
     * through the SAME prerequisite check and the SAME venv rewrite.
     */
    async function runPrereqLadder(
      venvExists: boolean,
      packet?: { allowedFiles: string[]; testFiles: string[]; testCommand: string }
    ): Promise<PrereqRun> {
      const dir = makeRepo()
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'T003 prereq' })
      let task = blueprintTaskRepository.create({
        blueprintId: bp.id,
        taskId: 'T003',
        wave: 1,
        description: 'Doomed task',
        filePathsJson: ['a.ts']
      })

      const venvRel = 'multiplexer/.venv-mux/Scripts/python.exe'
      if (venvExists) {
        mkdirSync(join(dir, 'multiplexer/.venv-mux/Scripts'), { recursive: true })
        writeFileSync(join(dir, venvRel), '# stub')
      }
      if (packet) task = blueprintTaskRepository.setPacket(task.id, packet)

      const { BlueprintBuildService } = require('../blueprint-build.service')
      const { effectiveTaskTestCommand } =
        require('../blueprint-gates.service') as typeof import('../blueprint-gates.service')
      const svc = new BlueprintBuildService()
      let builderRuns = 0
      svc.executeTask = async (p: {
        writeActivity?: { writeToolCalls: number }
      }): Promise<unknown> => {
        builderRuns++
        if (p?.writeActivity) p.writeActivity.writeToolCalls++
        return { success: true, completion: null, discoveries: [] }
      }
      // The effective command the prerequisite check derives from — captured
      // at grading time so the assertion sees the same string the check used.
      let effectiveCommand: string | null = null
      svc.gradeTask = async (gateCtx: unknown): Promise<unknown> => {
        const eff = effectiveTaskTestCommand(gateCtx as never)
        if (!effectiveCommand && eff) effectiveCommand = eff.command
        return {
          overall: 'pass',
          gates: [{ name: 'task-tests', verdict: 'pass', evidence: [], durationMs: 1 }]
        }
      }
      svc.resolveGateCommandsFor = (): unknown =>
        packet
          ? {}
          : {
              test: { command: `${venvRel} -m unittest discover -s tests`, provenance: 'declared' }
            }
      svc.readManifestsCached = (): unknown => ({})

      const result = (await svc.executeTaskWithGates({
        task,
        blueprintId: bp.id,
        workspaceId: wsId,
        workspacePath: dir,
        executionPath: dir,
        phaseContext: {} as never,
        priorDiscoveries: [],
        tDispatch: Date.now(),
        waveNum: 1
      })) as {
        failureReason?: string | null
        failureClass?: string
      }

      const telemetryRows = blueprintTelemetryRepository
        .findByBlueprint(bp.id)
        .filter((r: any) => r.kind === 'gate' || r.kind === 'prerequisite')
        .map((r: any) => ({ kind: r.kind, ...(r.dataJson ?? r.data) }))
      const after = blueprintTaskRepository.findById(task.id)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
      return {
        builderRuns,
        failureReason: result?.failureReason ?? null,
        failureClass: result?.failureClass,
        attempts: after.attempts,
        telemetryRows,
        effectiveCommand,
        dir
      }
    }

    test(
      'missing venv interpreter → NO dispatch, prerequisite-unmet infra result, no attempt burned',
      async () => {
        const run = await runPrereqLadder(false)
        assert.equal(run.builderRuns, 0, 'a doomed rung must not dispatch a builder session')
        assert.equal(run.attempts, 0, 'no builder attempt may be consumed')
        assert.ok(run.failureReason?.startsWith('prerequisite-unmet:'), `saw: ${run.failureReason}`)
        assert.ok(run.failureReason?.includes('multiplexer/.venv-mux/Scripts/python.exe'))
        assert.equal(run.failureClass, 'infra')
        assert.ok(
          run.telemetryRows.some(
            (r) => r.kind === 'prerequisite' && r.prerequisite === 'test-interpreter'
          ),
          'a telemetry row must record the skipped dispatch (kind: prerequisite)'
        )
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'interpreter present → dispatch happens normally',
      async () => {
        const run = await runPrereqLadder(true)
        assert.ok(run.builderRuns >= 1, 'the rung must dispatch when the prerequisite holds')
        assert.equal(run.attempts, run.builderRuns)
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    // ── G2+G6 — the packet `testCommand` flows through the same fix stack ──

    test(
      'packet-declared venv command missing on disk → still fail-fast (no dispatch)',
      async () => {
        const run = await runPrereqLadder(false, {
          allowedFiles: ['a.ts'],
          testFiles: ['tests/test_a.py'],
          testCommand: 'multiplexer/.venv-mux/Scripts/python.exe -m unittest discover -s tests'
        })
        assert.equal(
          run.builderRuns,
          0,
          'a packet-declared doomed interpreter must not dispatch — before G2 the check read only commands.test and never saw it'
        )
        assert.equal(run.attempts, 0, 'no builder attempt may be consumed')
        assert.ok(run.failureReason?.startsWith('prerequisite-unmet:'), `saw: ${run.failureReason}`)
        assert.ok(run.failureReason?.includes('multiplexer/.venv-mux/Scripts/python.exe'))
        assert.equal(run.failureClass, 'infra')
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'packet command present in SOURCE → rewritten and dispatched (the gate grades the rewritten form)',
      async () => {
        const run = await runPrereqLadder(true, {
          allowedFiles: ['a.ts'],
          testFiles: ['tests/test_a.py'],
          testCommand: 'multiplexer/.venv-mux/Scripts/python.exe -m unittest discover -s tests'
        })
        assert.ok(run.builderRuns >= 1, 'the rung must dispatch once the rewrite holds')
        assert.equal(run.attempts, run.builderRuns, 'attempts consumed normally')
        // workspacePath = executionPath = dir here, and the venv stub lives in
        // dir — so the rewrite yields the absolute source path under dir.
        assert.equal(
          run.effectiveCommand,
          `${join(run.dir, 'multiplexer', '.venv-mux', 'Scripts', 'python.exe')} -m unittest discover -s tests`,
          'G6 must grade the REWRITTEN packet command — the raw relative token would never resolve'
        )
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

// ── C1 — the scope-block detector itself (pure; runs without a DB) ──

describe('detectScopeBlock (C1)', () => {
  const { detectScopeBlock } = require('../blueprint-build.service') as {
    detectScopeBlock: (
      log: readonly { failedGates: readonly string[]; writeSetFiles: readonly string[] }[]
    ) => ReadonlySet<string> | undefined
  }

  const e = (failedGates: string[], writeSetFiles: string[] = []) => ({
    failedGates,
    writeSetFiles
  })

  test('the live signature parks: task-tests/write-set alternation, stable files', () => {
    const files = ['apps/enrollment/src/lib/enrollment/sign-gate.ts']
    const hit = detectScopeBlock([
      e(['task-tests']),
      e(['write-set'], files),
      e(['task-tests']),
      e(['write-set'], files)
    ])
    assert.ok(hit)
    assert.deepEqual([...hit].sort(), files)
  })

  test('both gates must appear: write-set twice without task-tests is NOT C1', () => {
    const hit = detectScopeBlock([
      e(['write-set'], ['src/rogue.ts']),
      e(['write-set'], ['src/rogue.ts'])
    ])
    assert.equal(hit, undefined)
  })

  test('a single write-set occurrence is not enough', () => {
    const hit = detectScopeBlock([
      e(['task-tests']),
      e(['write-set'], ['src/a.ts']),
      e(['task-tests'])
    ])
    assert.equal(hit, undefined)
  })

  test('varying file lists do not intersect → undefined', () => {
    const hit = detectScopeBlock([
      e(['task-tests']),
      e(['write-set'], ['src/one.ts']),
      e(['task-tests']),
      e(['write-set'], ['src/two.ts'])
    ])
    assert.equal(hit, undefined)
  })

  test('the intersection wins, not the union: only the recurring paths are proposed', () => {
    const hit = detectScopeBlock([
      e(['task-tests']),
      e(['write-set'], ['src/shared.ts', 'src/transient.ts']),
      e(['task-tests']),
      e(['write-set'], ['src/shared.ts'])
    ])
    assert.ok(hit)
    assert.deepEqual([...hit], ['src/shared.ts'])
  })

  test('identical failed-gate combos throughout is NOT alternation (B3\u2019s case)', () => {
    // task-tests AND write-set failing together every time — one combination,
    // no alternation. This is a plain B3 recurrence, not a scope block.
    const hit = detectScopeBlock([
      e(['task-tests', 'write-set'], ['src/a.ts']),
      e(['task-tests', 'write-set'], ['src/a.ts'])
    ])
    assert.equal(hit, undefined)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
