/**
 * A1 — durable session per build task: resume, not cold-restart.
 *
 * Pins the mechanism the ladder now wires:
 *
 *   1. `isResumeSafeOutcome` truth table (regression pin — it predates A1 and
 *      must not drift: overload/error resume; context_overflow,
 *      turn_limit_exhausted, aborted never do).
 *   2. Identity is STABLE across attempts within a generation; the generation
 *      rotates only when the permit is denied for a reason that carries a
 *      transcript to abandon (not-safe / provider-changed / stale / poisoned).
 *   3. THE regression pin: permit + persisted session id → `session.start()`
 *      receives `resumeSessionId` + `resumeConversationId`, and the map seed
 *      survives `send()` under the same conversation id. On pre-fix main the
 *      seed keyed `_lastActiveConversationId` (null at start() time) and every
 *      attempt minted `…-${Date.now()}` — nothing resumed, ever.
 *   4. Decline reasons land in telemetry with the right taxonomy
 *      (no-persisted-id / flag-off / not-safe / stale / provider-changed /
 *      poisoned).
 *   5. A resume whose rung fails again at the session level (non-overload)
 *      is not retried as a resume — the next rung goes cold on the SAME
 *      ladder retry, no extra builder attempt.
 *   6. `TaskWriteActivity` accumulation keeps a zero-write resumed rung from
 *      failing no-write-activity (work an earlier attempt already did).
 *   7. The conversation row exists before the first send — the persistence
 *      substrate; without it no session id survives the attempt boundary.
 *   8. A1 Phase 0 — the permit reads the rung's `resumableSessionId` stamp,
 *      NOT the DB: `undefined` declines `no-persisted-id` regardless of DB
 *      state, and a stamped id resumes with the DB reader pointing at a
 *      throwing stub (no DB read happens at all).
 *   9. A1 Phase 1 — a poisoned previous rung declines `poisoned` (the id is
 *      never re-resumed); abort-during-send is classed `aborted` with
 *      `resumeSafe: false`.
 *  10. A1 Phase 2 — `buildResumeContinuationMessage` is short, names the
 *      failure, and never restates the task/partial.
 *  11. A1 Phase 4 — cross-run resume grants ONLY under its own flag, and
 *      declines `no-persisted-id` with the flag off (default).
 *
 * Run: tsx src/main/services/__tests__/blueprint-session-resume.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintTaskRepository: any
let blueprintTelemetryRepository: any
let conversationRepository: any
let appPreferenceRepository: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  blueprintRepository = require('../../db/repositories/blueprint.repository').blueprintRepository
  blueprintTaskRepository =
    require('../../db/repositories/blueprint.repository').blueprintTaskRepository
  blueprintTelemetryRepository =
    require('../../db/repositories/blueprint-telemetry.repository').blueprintTelemetryRepository
  conversationRepository =
    require('../../db/repositories/conversation.repository').conversationRepository
  appPreferenceRepository =
    require('../../db/repositories/app-preference.repository').appPreferenceRepository
} catch (err) {
  console.log(`⚠ session-resume setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

const buildServiceModule = (): any => require('../blueprint-build.service')

if (!env) {
  describe('blueprint session resume (skipped — no DB)', () => {
    test('resume mechanism', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  const GIT_AVAILABLE = ((): boolean => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'a1-resume-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'a1@test.local'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'A1 Test'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
    return dir
  }

  function seedTask(blueprintId: string, taskId = 'T001'): any {
    return blueprintTaskRepository.create({
      blueprintId,
      taskId,
      wave: 1,
      description: 'Resume test task',
      filePathsJson: ['a.ts']
    })
  }

  // ── 1. The permit (pure) ──

  describe('A1 — isResumeSafeOutcome (regression pin)', () => {
    test('overload and error are resume-safe; the rest are not', () => {
      const { isResumeSafeOutcome } = buildServiceModule()
      assert.equal(isResumeSafeOutcome('overload'), true)
      assert.equal(isResumeSafeOutcome('error'), true)
      assert.equal(isResumeSafeOutcome('context_overflow'), false)
      assert.equal(isResumeSafeOutcome('turn_limit_exhausted'), false)
      assert.equal(isResumeSafeOutcome('aborted'), false)
    })
  })

  if (!GIT_AVAILABLE) {
    describe('A1 — ladder mechanics (skipped — no git)', () => {
      test('resume wiring', () => {}, { skipReason: 'no git' })
    })
  } else {
    /**
     * Drive the REAL `executeTaskWithGates` with executeTask/gradeTask stubbed
     * per rung. The resume DECISION wiring (permit evaluation, telemetry,
     * generation rotation, rung params) is the code under test; executeTask's
     * body is not.
     */
    async function runLadder(opts: {
      dir: string
      blueprintId: string
      results: Array<Record<string, unknown>>
      flagOn?: boolean
      crossRunOn?: boolean
    }): Promise<{
      builderRuns: number
      rungExecutions: Array<{ convId: string; resumeSessionId?: string; generation?: number }>
    }> {
      appPreferenceRepository.set('blueprint_session_resume', String(opts.flagOn ?? true))
      // A1 Phase 4 — the cross-run sub-flag is OFF by default; a test that
      // wants attempt-1 resume flips it explicitly.
      appPreferenceRepository.set('blueprint_cross_run_resume', String(opts.crossRunOn ?? false))
      const { BlueprintBuildService } = buildServiceModule()
      const svc = new BlueprintBuildService()

      const rungExecutions: Array<{
        convId: string
        resumeSessionId?: string
        generation?: number
      }> = []
      let run = 0
      svc.executeTask = async (p: {
        resumeSessionId?: string
        taskGeneration?: number
        blueprintId: string
        task: { taskId: string }
      }): Promise<Record<string, unknown>> => {
        run++
        const gen = p.taskGeneration && p.taskGeneration > 0 ? `-g${p.taskGeneration}` : ''
        rungExecutions.push({
          convId: `blueprint-build-${p.blueprintId}-${p.task.taskId}${gen}`,
          resumeSessionId: p.resumeSessionId,
          generation: p.taskGeneration ?? 0
        })
        const result = { ...opts.results[Math.min(run - 1, opts.results.length - 1)] }
        // A1 Phase 0 — model what the REAL executeTask does: the session id is
        // stamped on the result in the finally. When the stub's result does not
        // provide one, the rung behaves as if the session map dropped it
        // (poisoned turn) — `undefined` is meaningful evidence, and the DB is
        // never consulted.
        result.resumableSessionId = result.resumableSessionId ?? undefined
        result.executeAttempt = run
        result.teardown = Promise.resolve()
        return result
      }
      svc.gradeTask = async (): Promise<unknown> => ({ overall: 'pass', gates: [] })
      svc.escalateToLead = async (): Promise<unknown> => ({
        success: false,
        completion: null,
        discoveries: [],
        failureReason: 'escalation failed'
      })
      svc.resolveGateCommandsFor = (): unknown => ({})
      svc.readManifestsCached = (): unknown => ({})

      const task = seedTask(opts.blueprintId)
      await svc.executeTaskWithGates({
        task,
        blueprintId: opts.blueprintId,
        workspaceId: wsId,
        workspacePath: opts.dir,
        executionPath: opts.dir,
        phaseContext: {} as never,
        priorDiscoveries: [],
        tDispatch: Date.now(),
        waveNum: 1
      })

      return { builderRuns: run, rungExecutions }
    }

    const rungFailure = (
      outcome: string,
      stamps?: Record<string, unknown>
    ): Record<string, unknown> => ({
      success: false,
      completion: null,
      discoveries: [],
      failureReason: outcome,
      failureClass: 'infra',
      resumeSafe: outcome === 'overload' || outcome === 'error',
      sendOutcome: outcome,
      ...stamps
    })
    const rungSuccess = (stamps?: Record<string, unknown>): Record<string, unknown> => ({
      success: true,
      completion: null,
      discoveries: [],
      ...stamps
    })

    // ── 2. Identity + resume wiring ──

    describe('A1 — identity and resume wiring', () => {
      test('permit + persisted id → the retry rung receives the resumeSessionId (the regression pin)', async () => {
        const dir = makeRepo()
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 resume' })
        const task = seedTask(bp.id)
        const convId = `blueprint-build-${bp.id}-${task.taskId}`

        const { blueprintService } = require('../blueprint.service')
        blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
        conversationRepository.updateSessionId(convId, 'sess-aaaaaaaa-bbbb')

        const { builderRuns, rungExecutions } = await runLadder({
          dir,
          blueprintId: bp.id,
          results: [
            // The failed rung stamped the live id (Phase 0) — what the REAL
            // executeTask's finally does when the session map still holds it.
            rungFailure('error', { resumableSessionId: 'sess-aaaaaaaa-bbbb' }),
            rungSuccess()
          ]
        })

        assert.equal(builderRuns, 2, 'F4 re-run runs once after the infra failure')
        assert.equal(rungExecutions[0].convId, convId, 'identity is stable — no Date.now() suffix')
        assert.equal(rungExecutions[1].convId, convId, 'the resumed rung keeps the same identity')
        assert.equal(
          rungExecutions[1].resumeSessionId,
          'sess-aaaaaaaa-bbbb',
          'the retry rung must carry the persisted session id — pre-fix main never did'
        )
        rmSync(dir, { recursive: true, force: true })
      })

      test('the conversation row exists before the retry can read a persisted id', () => {
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 ensure-row' })
        const task = seedTask(bp.id)
        const convId = `blueprint-build-${bp.id}-${task.taskId}`

        const { blueprintService } = require('../blueprint.service')
        blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
        // updateSessionId is what processMetaChunk calls in production — it must
        // not throw on a row ensurePhaseConversation just created.
        conversationRepository.updateSessionId(convId, 'sess-row-check-1')
        assert.equal(conversationRepository.getSessionId(convId), 'sess-row-check-1')
      })
    })

    // ── 2–5. Scenario walkthrough (sequential: the app-preference row is a
    // global and the harness runs async tests concurrently — one body, ordered
    // phases, no interleaving) ──

    describe('A1 — ladder scenarios (sequential)', () => {
      test('resume / rotation / flag-off / stale walk through the real ladder', async () => {
        const rungFailure = (
          outcome: string,
          stamps?: Record<string, unknown>
        ): Record<string, unknown> => ({
          success: false,
          completion: null,
          discoveries: [],
          failureReason: outcome,
          failureClass: 'infra',
          resumeSafe: outcome === 'overload' || outcome === 'error',
          sendOutcome: outcome,
          ...stamps
        })
        const rungSuccess = (stamps?: Record<string, unknown>): Record<string, unknown> => ({
          success: true,
          completion: null,
          discoveries: [],
          ...stamps
        })

        // ── Phase 1: the regression pin — permit + persisted id → resume ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 resume' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`
          const { blueprintService } = require('../blueprint.service')
          blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
          conversationRepository.updateSessionId(convId, 'sess-aaaaaaaa-bbbb')

          const { builderRuns, rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [
              rungFailure('error', { resumableSessionId: 'sess-aaaaaaaa-bbbb' }),
              rungSuccess()
            ],
            flagOn: true
          })
          assert.equal(builderRuns, 2, 'F4 re-run runs once after the infra failure')
          assert.equal(rungExecutions[0].convId, convId, 'identity stable — no Date.now() suffix')
          assert.equal(rungExecutions[1].convId, convId, 'the resumed rung keeps the identity')
          assert.equal(
            rungExecutions[1].resumeSessionId,
            'sess-aaaaaaaa-bbbb',
            'THE PIN: the retry rung carries the persisted session id — pre-fix main never did'
          )
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 2: quality retry — gate failure with a persisted id from the
        // run that FAILED the gate declines not-safe and rotates identity,
        // preserving pre-A1 behaviour (a fresh conversation per cold attempt).
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 quality-rotate' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`
          const { blueprintService } = require('../blueprint.service')
          blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
          // Attempt 1 ran, was graded, failed the gate — its session id persists.
          conversationRepository.updateSessionId(convId, 'sess-quality-1')

          appPreferenceRepository.set('blueprint_session_resume', 'true')
          const { BlueprintBuildService } = buildServiceModule()
          const svc = new BlueprintBuildService()
          const rungExecutions: Array<{ convId: string; resumeSessionId?: string }> = []
          let graded = 0
          svc.executeTask = async (p: {
            resumeSessionId?: string
            taskGeneration?: number
            blueprintId: string
            task: { taskId: string }
          }): Promise<Record<string, unknown>> => {
            const gen = p.taskGeneration && p.taskGeneration > 0 ? `-g${p.taskGeneration}` : ''
            rungExecutions.push({
              convId: `blueprint-build-${p.blueprintId}-${p.task.taskId}${gen}`,
              resumeSessionId: p.resumeSessionId
            })
            return rungSuccess()
          }
          const verdicts = [
            {
              overall: 'fail',
              gates: [{ name: 'task-tests', verdict: 'fail', evidence: ['x'], durationMs: 1 }]
            },
            { overall: 'pass', gates: [] }
          ]
          svc.gradeTask = async (): Promise<unknown> =>
            verdicts[Math.min(graded++, verdicts.length - 1)]
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

          assert.ok(rungExecutions.length >= 2, 'the gate failure produced a retry rung')
          assert.equal(
            rungExecutions[1].resumeSessionId,
            undefined,
            'a gate-failed attempt is never resumed — cold with fix instructions'
          )
          assert.equal(
            rungExecutions[1].convId,
            convId,
            'the quality retry keeps the identity stable and runs a COLD session on it — ' +
              'the failed reasoning is abandoned at the session level (fresh CLI/OpenCode ' +
              'session), which is the documented gate → cold + failure-memory split'
          )
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 3: flag off → cold everywhere, pre-A1 behaviour exactly ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 flag-off' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`
          const { blueprintService } = require('../blueprint.service')
          blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
          conversationRepository.updateSessionId(convId, 'sess-flag-off-1')

          const { rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [rungFailure('error'), rungSuccess()],
            flagOn: false
          })
          assert.equal(rungExecutions.length, 2, 'the F4 re-run still happens')
          assert.equal(rungExecutions[1].convId, convId, 'flag-off: identity stable, cold')
          assert.equal(
            rungExecutions[1].resumeSessionId,
            undefined,
            'flag off → no rung ever receives a resume'
          )
          const resumeRows = blueprintTelemetryRepository
            .findByBlueprint(bp.id)
            .filter((r: { kind: string }) => r.kind === 'session_resume')
          assert.ok(
            resumeRows.every((r: { data: { status?: string } }) => r.data.status !== 'attempted'),
            'no attempted row when the flag is off'
          )
          assert.ok(
            resumeRows.some((r: { data: { reason?: string } }) => r.data.reason === 'flag-off'),
            'the flag-off decline is telemetered'
          )
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 4: no persisted id → cold, identity NOT rotated ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 no-id' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`

          const { rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [rungFailure('error'), rungSuccess()],
            flagOn: true
          })
          assert.equal(
            rungExecutions[1].convId,
            convId,
            'absence-denial keeps identity stable — nothing to abandon'
          )
          assert.equal(rungExecutions[1].resumeSessionId, undefined)
          const rows = blueprintTelemetryRepository
            .findByBlueprint(bp.id)
            .filter((r: { kind: string }) => r.kind === 'session_resume')
          assert.ok(
            rows.some((r: { data: { reason?: string } }) => r.data.reason === 'no-persisted-id'),
            `expected a no-persisted-id decline — got ${JSON.stringify(rows)}`
          )
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 5: stale — a resumed F4 rung that fails again is not re-resumed ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 stale' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`
          const { blueprintService } = require('../blueprint.service')
          blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
          conversationRepository.updateSessionId(convId, 'sess-stale-1')

          const { rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [
              rungFailure('error', { resumableSessionId: 'sess-stale-1' }),
              rungFailure('error', { resumableSessionId: 'sess-stale-1' })
            ],
            flagOn: true
          })
          assert.equal(rungExecutions.length, 2, 'rung 2 is the F4 re-run; the ladder then fails')
          const resumed = rungExecutions.filter((r) => r.resumeSessionId === 'sess-stale-1')
          assert.equal(resumed.length, 1, 'the session is resumed exactly once')
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 6 (A1 Phase 0): an undefined stamp declines regardless of DB ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 P0 undef' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`
          const { blueprintService } = require('../blueprint.service')
          blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
          // The DB HAS an id — but the rung's stamp says the session map dropped
          // it. Phase 0 semantics: the stamp wins, the DB is never consulted.
          conversationRepository.updateSessionId(convId, 'sess-db-has-it')

          const { rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [rungFailure('error'), rungSuccess()],
            flagOn: true
          })
          assert.equal(
            rungExecutions[1].resumeSessionId,
            undefined,
            'an undefined stamp declines — the DB id must not leak through'
          )
          const rows = blueprintTelemetryRepository
            .findByBlueprint(bp.id)
            .filter((r: { kind: string }) => r.kind === 'session_resume')
          assert.ok(
            rows.some((r: { data: { reason?: string } }) => r.data.reason === 'no-persisted-id'),
            'the decline is telemetered as no-persisted-id'
          )
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 7 (A1 Phase 0): a stamped id resumes with NO DB row at all ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 P0 noread' })
          seedTask(bp.id)

          const { rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [
              rungFailure('error', { resumableSessionId: 'sess-stamped-1' }),
              rungSuccess()
            ],
            flagOn: true
          })
          assert.equal(
            rungExecutions[1].resumeSessionId,
            'sess-stamped-1',
            'the stamp alone drives the resume — no conversation row exists to read'
          )
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 8 (A1 Phase 1): a poisoned previous rung declines + rotates ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 P1 poison' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`
          const { blueprintService } = require('../blueprint.service')
          blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
          conversationRepository.updateSessionId(convId, 'sess-poison-1')

          // Rung 1: error + id stamped, but the session ALSO flagged poisoned —
          // the DB-write-failed backstop case. Rung 2 must go cold on a NEW
          // generation (identity rotated), never resume the poisoned id.
          const { rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [
              rungFailure('error', { resumableSessionId: 'sess-poison-1', sessionPoisoned: true }),
              rungSuccess()
            ],
            flagOn: true
          })
          assert.equal(rungExecutions[1].resumeSessionId, undefined, 'poisoned id never resumed')
          assert.match(
            rungExecutions[1].convId,
            /-g1$/,
            'the poisoned denial rotates the identity (transcript abandoned)'
          )
          const rows = blueprintTelemetryRepository
            .findByBlueprint(bp.id)
            .filter((r: { kind: string }) => r.kind === 'session_resume')
          assert.ok(
            rows.some((r: { data: { reason?: string } }) => r.data.reason === 'poisoned'),
            'the poisoned decline is telemetered'
          )
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 9 (A1 P2): a resumed rung failing on the THROW path (no
        // sendOutcome) is stale, not re-resumed ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 P2 throw-stale' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`
          const { blueprintService } = require('../blueprint.service')
          blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
          conversationRepository.updateSessionId(convId, 'sess-throw-1')

          // Rung 2 is itself a resume; it fails via the THROW path — stall
          // watchdog shape: NO sendOutcome, resumeSafe true. Pre-P2 this skipped
          // stale detection; the stamp now catches it.
          const { rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [
              rungFailure('error', { resumableSessionId: 'sess-throw-1' }),
              rungFailure('Task T001 timeout', {
                resumeSafe: true,
                resumableSessionId: 'sess-throw-1'
              })
            ],
            flagOn: true
          })
          assert.equal(rungExecutions.length, 2, 'rung 2 is the F4 re-run; the ladder then fails')
          const resumed = rungExecutions.filter((r) => r.resumeSessionId === 'sess-throw-1')
          assert.equal(resumed.length, 1, 'the session is resumed exactly once despite no outcome')
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 10 (A1 Phase 4): cross-run OFF (the default) — attempt 1 cold ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 P4 off' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`
          const { blueprintService } = require('../blueprint.service')
          blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
          conversationRepository.updateSessionId(convId, 'sess-crossrun-1')

          const { rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [rungSuccess()],
            flagOn: true
          })
          assert.equal(
            rungExecutions[0].resumeSessionId,
            undefined,
            'attempt 1 never resumes with the cross-run flag off (the default)'
          )
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 11 (A1 Phase 4): cross-run ON — a surviving id resumes attempt 1 ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'A1 P4 on' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`
          const { blueprintService } = require('../blueprint.service')
          blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
          conversationRepository.updateSessionId(convId, 'sess-crossrun-2')

          const { rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [rungSuccess()],
            flagOn: true,
            crossRunOn: true
          })
          assert.equal(
            rungExecutions[0].resumeSessionId,
            'sess-crossrun-2',
            'with the sub-flag on, a surviving persisted id is resumed on attempt 1'
          )
          // Leave the global exactly at the default — later phases depend on it.
          appPreferenceRepository.set('blueprint_cross_run_resume', 'false')
          rmSync(dir, { recursive: true, force: true })
        })()

        // ── Phase 12 (F5/3.2): master OFF × cross-run ON — the kill switch wins ──
        await (async () => {
          const dir = makeRepo()
          const bp = blueprintRepository.create({ workspaceId: wsId, title: 'F5 kill switch' })
          const task = seedTask(bp.id)
          const convId = `blueprint-build-${bp.id}-${task.taskId}`
          const { blueprintService } = require('../blueprint.service')
          blueprintService.ensurePhaseConversation(wsId, bp.id, 'build', convId)
          conversationRepository.updateSessionId(convId, 'sess-killswitch-1')

          const { rungExecutions } = await runLadder({
            dir,
            blueprintId: bp.id,
            results: [rungSuccess()],
            flagOn: false, // master kill switch OFF
            crossRunOn: true // sub-flag ON — must NOT override the master
          })
          assert.equal(
            rungExecutions[0].resumeSessionId,
            undefined,
            'the master kill switch (blueprintSessionResume OFF) forces cold even with the cross-run sub-flag on'
          )
          appPreferenceRepository.set('blueprint_cross_run_resume', 'false')
          rmSync(dir, { recursive: true, force: true })
        })()
      })
    })

    // ── 6. Write activity across a resumed attempt ──

    describe('A1 — write activity accumulates across a resumed attempt', () => {
      test('a resumed session reporting zero write calls does not fail no-write-activity', () => {
        const { shouldFailForNoWriteActivity } = buildServiceModule()
        assert.equal(
          shouldFailForNoWriteActivity({
            cumulativeWriteToolCalls: 3,
            cumulativeBashCalls: 1,
            claimedFiles: 2,
            hasCompletion: true,
            hasPlannedFiles: true,
            baselineDiffEmpty: null
          }),
          false
        )
        assert.equal(
          shouldFailForNoWriteActivity({
            cumulativeWriteToolCalls: 0,
            cumulativeBashCalls: 0,
            claimedFiles: 2,
            hasCompletion: true,
            hasPlannedFiles: true,
            baselineDiffEmpty: true
          }),
          true
        )
      })
    })

    // ── 10. Phase 2 — the continuation message (pure, no globals) ──

    describe('A1 Phase 2 — incremental resume message', () => {
      test('buildResumeContinuationMessage is short, names the failure, never restates the task', () => {
        const { buildResumeContinuationMessage, BlueprintBuildService } = buildServiceModule()
        const msg = buildResumeContinuationMessage({
          taskId: 'T001',
          attempt: 2,
          failureReason: 'quality gate failed: task-tests',
          gateFixInstructions: 'Fix X'
        })
        assert.ok(msg.length < 1200, `continuation must be short — got ${msg.length} chars`)
        assert.ok(msg.includes('T001'), 'names the task')
        assert.ok(msg.includes('quality gate failed'), 'carries the failure verdict')
        assert.ok(msg.includes('Fix X'), 'carries gate fix instructions when present')
        assert.ok(!msg.includes('User Story'), 'never restates the task block')
        assert.ok(!msg.includes('Prior Attempt Output'), 'never duplicates the transcript tail')
        // The full cold context for the same task is orders larger — pin the gap.
        const svc = new BlueprintBuildService()
        const cold = svc.buildTaskContext(
          {
            taskId: 'T001',
            wave: 1,
            description: 'x'.repeat(2000),
            userStory: 'y'.repeat(2000)
          } as never,
          undefined,
          'z'.repeat(4000),
          'prior reason',
          undefined,
          false,
          null
        )
        assert.ok(
          cold.length > msg.length * 3,
          `cold context (${cold.length}) must dwarf the continuation (${msg.length})`
        )
      })
    })
  }
}

// Await pending async tests before exiting (summaryAsync takes no name).
summaryAsync().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
