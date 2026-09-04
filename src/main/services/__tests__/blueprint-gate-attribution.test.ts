/**
 * F1–F6 — gate attribution: WHO changed a peer-owned file, and what the kernel
 * is allowed to conclude when it cannot tell.
 *
 * Reconstructed from blueprint 6c4a6a85. T004 and T012 ran concurrently in one
 * worktree. T012 deleted 69 lines out of a spec T004 declares, and its write-set
 * gate reported `pass — 2 file(s) changed, all in set`: the peer exemption had
 * dropped the third path without ever asking who wrote it. The deletion then
 * failed T005 twice, tripped the stop-loss, and the run died on a transport
 * error that matched no retry pattern — 11 tasks cascade-skipped.
 *
 * The properties pinned here:
 *   - an unattributable peer-owned change is `unverifiable`, never a false pass
 *     and never a false fail (F1)
 *   - the same change WITH write-tool evidence is a real `fail` (F1 step 2)
 *   - a peer's own COMMITTED change is still a clean pass (no R1.2 regression)
 *   - a peer-review re-grade leaves a trace even though the row keeps the
 *     original verdict (F2)
 *   - one in-ladder re-run for a resume-safe infra failure, and only one (F4)
 *   - a peer's packet `testFiles` are exempt too (F5)
 *
 * Run: tsx src/main/services/__tests__/blueprint-gate-attribution.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import {
  captureGateBaseline,
  defaultCommandRunner,
  runGates,
  type CommandRunner,
  type GateTaskContext
} from '../blueprint-gates.service'
import { ledgerItemsFrom, type GateResult } from '../../../shared/gate-types'

// ── Temp-repo helpers (mirrors blueprint-gates.test.ts) ──

const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const tempDirs: string[] = []

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-attr-'))
  tempDirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'gate@test.local'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Gate Test'], { cwd: dir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
  write(dir, files)
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  return dir
}

function commitAll(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir })
}

/** Real git, everything else green — the command gates are not what is under test. */
const greenRunner: CommandRunner = async (command, opts) => {
  if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
  return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
}

/** T004's spec — the file T012 deleted lines from. */
const PEER_SPEC = 'apps/web/tests/enrollment-schemas.test.ts'
const PEER_SPEC_BEFORE = [
  "test('renewal state keeps the prior carrier', () => { expect(renew()).toBe('aon') })",
  "test('renewal state carries the contribution method', () => { expect(method()).toBe('flat') })",
  "test('renewal state rejects an unknown plan', () => { expect(() => renew('x')).toThrow() })",
  ''
].join('\n')
/** The two survivors — a pure deletion, which produces no added diff line. */
const PEER_SPEC_AFTER = [
  "test('renewal state keeps the prior carrier', () => { expect(renew()).toBe('aon') })",
  ''
].join('\n')

function t012Ctx(dir: string, over: Partial<GateTaskContext> = {}): GateTaskContext {
  return {
    blueprintId: 'bp-6c4a6a85',
    taskId: 'T012',
    workspacePath: dir,
    executionPath: dir,
    plannedFiles: [],
    packet: {
      allowedFiles: ['app/workspace/page.tsx', 'app/workspace/ElectionWorkspace.tsx'],
      testFiles: [],
      testCommand: 'run-task-tests'
    },
    commands: {
      lint: { command: 'run-lint', provenance: 'detected' },
      build: { command: 'run-build', provenance: 'detected' }
    },
    // T004 declares the spec — that is what made it exempt for T012.
    exemptFiles: [PEER_SPEC],
    runner: greenRunner,
    ...over
  }
}

function t012Repo(): string {
  return makeRepo({
    'app/workspace/page.tsx': 'export default function Page() { return null }\n',
    'app/workspace/ElectionWorkspace.tsx': 'export const Workspace = () => null\n',
    [PEER_SPEC]: PEER_SPEC_BEFORE
  })
}

const writeSetOf = (gates: GateResult[]): GateResult | undefined =>
  gates.find((g) => g.name === 'write-set')

// ── F1 — the T012 scenario ──

describe('F1 — a peer-owned change nobody can be named for', () => {
  test('T012 deleting lines from T004’s spec is unverifiable, not a pass', async () => {
    if (!GIT_AVAILABLE) return
    const dir = t012Repo()
    const ctx = t012Ctx(dir)
    const baseline = await captureGateBaseline(ctx)

    // T012's own work, plus the deletion out of the peer's spec. The deletion
    // adds no line, so it is invisible to the added-line scan the gate used.
    write(dir, {
      'app/workspace/ElectionWorkspace.tsx': 'export const Workspace = () => <div />\n',
      [PEER_SPEC]: PEER_SPEC_AFTER
    })

    const report = await runGates(ctx, baseline)
    const writeSet = writeSetOf(report.gates)

    assert.equal(writeSet?.verdict, 'unverifiable', JSON.stringify(writeSet, null, 2))
    assert.equal(writeSet?.reason, 'analysis_unavailable')
    assert.ok(
      writeSet?.files?.includes(PEER_SPEC),
      `the unattributable path must be named: ${JSON.stringify(writeSet?.files)}`
    )
    assert.ok(
      writeSet?.evidence.some((line) => line.includes(PEER_SPEC)),
      `evidence must name it too: ${JSON.stringify(writeSet?.evidence)}`
    )
  })

  test('it lands in the unverified ledger rather than passing silently', async () => {
    if (!GIT_AVAILABLE) return
    const dir = t012Repo()
    const ctx = t012Ctx(dir)
    const baseline = await captureGateBaseline(ctx)
    write(dir, { [PEER_SPEC]: PEER_SPEC_AFTER })

    const report = await runGates(ctx, baseline)
    const item = ledgerItemsFrom(report, 'T012').find((i) => i.gate === 'write-set')

    assert.ok(item, 'an unverifiable write-set must produce a ledger item')
    assert.equal(item?.reason, 'analysis_unavailable')
  })

  test('a peer’s own COMMITTED change stays a clean pass (R1.2 unchanged)', async () => {
    if (!GIT_AVAILABLE) return
    const dir = t012Repo()
    const ctx = t012Ctx(dir)
    const baseline = await captureGateBaseline(ctx)

    // This time the peer edits ITS OWN spec and commits, which is what makes the
    // change attributable to somebody other than the graded task.
    write(dir, { [PEER_SPEC]: PEER_SPEC_AFTER })
    commitAll(dir, 'T004 trim renewal-state spec')
    write(dir, {
      'app/workspace/ElectionWorkspace.tsx': 'export const Workspace = () => <div />\n'
    })

    const report = await runGates(ctx, baseline)
    const writeSet = writeSetOf(report.gates)

    assert.equal(writeSet?.verdict, 'pass', JSON.stringify(writeSet, null, 2))
  })

  test('no peers, no change in behaviour — a clean task still passes', async () => {
    if (!GIT_AVAILABLE) return
    const dir = t012Repo()
    const ctx = t012Ctx(dir, { exemptFiles: [] })
    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'app/workspace/page.tsx': 'export default function Page() { return <div /> }\n' })

    const report = await runGates(ctx, baseline)
    assert.equal(writeSetOf(report.gates)?.verdict, 'pass')
  })
})

// ── F1 step 2 — write-tool evidence turns unverifiable into fail ──

describe('F1 (step 2) — write-tool paths make the direction knowable', () => {
  test('the same deletion, with this task’s write tool on record, FAILS', async () => {
    if (!GIT_AVAILABLE) return
    const dir = t012Repo()
    // Absolute, exactly as the CLI backends report `file_path`.
    const ctx = t012Ctx(dir, { writtenPaths: [join(dir, PEER_SPEC)] })
    const baseline = await captureGateBaseline(ctx)
    write(dir, { [PEER_SPEC]: PEER_SPEC_AFTER })

    const report = await runGates(ctx, baseline)
    const writeSet = writeSetOf(report.gates)

    assert.equal(writeSet?.verdict, 'fail', JSON.stringify(writeSet, null, 2))
    assert.ok(
      writeSet?.evidence.some(
        (line) => line.includes('outside write-set') && line.includes(PEER_SPEC)
      ),
      `the violation must name the peer's file: ${JSON.stringify(writeSet?.evidence)}`
    )
  })

  test('a write-tool path OUTSIDE both roots is ignored, not mis-rooted into a fail', async () => {
    if (!GIT_AVAILABLE) return
    const dir = t012Repo()
    const ctx = t012Ctx(dir, { writtenPaths: ['/somewhere/else/enrollment-schemas.test.ts'] })
    const baseline = await captureGateBaseline(ctx)
    write(dir, { [PEER_SPEC]: PEER_SPEC_AFTER })

    const report = await runGates(ctx, baseline)
    // Unattributable, as if there were no write-tool evidence at all.
    assert.equal(writeSetOf(report.gates)?.verdict, 'unverifiable')
  })

  test('a peer file this task did NOT write is still exempt when the peer committed it', async () => {
    if (!GIT_AVAILABLE) return
    const dir = t012Repo()
    const ctx = t012Ctx(dir, {
      writtenPaths: [join(dir, 'app/workspace/ElectionWorkspace.tsx')]
    })
    const baseline = await captureGateBaseline(ctx)
    write(dir, { [PEER_SPEC]: PEER_SPEC_AFTER })
    commitAll(dir, 'T004 trim renewal-state spec')
    write(dir, {
      'app/workspace/ElectionWorkspace.tsx': 'export const Workspace = () => <div />\n'
    })

    const report = await runGates(ctx, baseline)
    assert.equal(writeSetOf(report.gates)?.verdict, 'pass')
  })
})

// ── Service-level: write-tool capture, exemption set, ladder, peer review ──

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
  console.log(`⚠ gate-attribution DB setup failed — those tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

describe('F1 (step 2) — writeToolTargetPath', () => {
  const { writeToolTargetPath } = require('../blueprint-build.service') as {
    writeToolTargetPath: (c: {
      toolName?: string
      toolInput?: string
      toolInputRaw?: string
    }) => string | null
  }

  test('reads file_path out of the raw tool input', () => {
    assert.equal(
      writeToolTargetPath({
        toolName: 'Write',
        toolInputRaw: JSON.stringify({ file_path: '/repo/src/a.ts', content: 'x' })
      }),
      '/repo/src/a.ts'
    )
  })

  test('covers the lowercase OpenCode names and the camelCase spelling', () => {
    assert.equal(
      writeToolTargetPath({ toolName: 'edit', toolInputRaw: JSON.stringify({ filePath: 'a.ts' }) }),
      'a.ts'
    )
    assert.equal(
      writeToolTargetPath({
        toolName: 'notebookedit',
        toolInputRaw: JSON.stringify({ notebook_path: 'n.ipynb' })
      }),
      'n.ipynb'
    )
  })

  test('a non-write tool contributes nothing', () => {
    assert.equal(
      writeToolTargetPath({
        toolName: 'Read',
        toolInputRaw: JSON.stringify({ file_path: 'a.ts' })
      }),
      null
    )
  })

  test('the CLI display summary is not JSON — that is a null, not a throw', () => {
    assert.equal(writeToolTargetPath({ toolName: 'Write', toolInput: 'src/a.ts (1 lines)' }), null)
  })
})

describe('F5 — a peer’s packet testFiles are exempt too', () => {
  test('a spec declared ONLY in testFiles is exempted', () => {
    const { BlueprintBuildService } = require('../blueprint-build.service')
    const svc = new BlueprintBuildService()
    const gateCtx: any = { taskId: 'T005', exemptFiles: [] }

    svc.refreshExemptFiles(gateCtx, [
      {
        taskId: 'T004',
        filePathsJson: ['app/enrollment_parse/qc_export.py'],
        packetJson: { allowedFiles: ['app/enrollment_parse/qc_export.py'], testFiles: [PEER_SPEC] }
      },
      { taskId: 'T005', filePathsJson: ['src/mine.ts'], packetJson: null }
    ])

    assert.ok(
      gateCtx.exemptFiles.includes(PEER_SPEC),
      `a peer's spec is the peer's property: ${JSON.stringify(gateCtx.exemptFiles)}`
    )
    assert.ok(
      !gateCtx.exemptFiles.includes('src/mine.ts'),
      'never exempt the graded task’s own set'
    )
  })
})

if (!env) {
  describe('gate-attribution ladder tests (skipped — no DB)', () => {
    test('ladder', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  function seed(title: string): { blueprintId: string; task: any; dir: string } {
    const dir = makeRepo({ 'a.ts': 'export const a = 1\n' })
    const bp = blueprintRepository.create({ workspaceId: wsId, title })
    const task = blueprintTaskRepository.create({
      blueprintId: bp.id,
      taskId: 'T005',
      wave: 2,
      description: 'elections-repo.ts',
      filePathsJson: ['a.ts']
    })
    return { blueprintId: bp.id, task, dir }
  }

  function rowsOf(
    blueprintId: string,
    kind: string
  ): { attempt: number | null; data: Record<string, unknown> }[] {
    return blueprintTelemetryRepository
      .findByBlueprint(blueprintId)
      .filter((r: { kind: string }) => r.kind === kind)
  }

  // ── F4 — one in-ladder re-run for a resume-safe infra failure ──

  describe('F4 — an infra failure buys exactly one in-ladder re-run', () => {
    async function runInfraLadder(outcomes: unknown[]): Promise<{
      dispatches: number
      attempts: number
      infraRows: { attempt: number | null; data: Record<string, unknown> }[]
      success: boolean
    }> {
      const { blueprintId, task, dir } = seed('F4 infra retry')
      const { BlueprintBuildService } = require('../blueprint-build.service')
      const svc = new BlueprintBuildService()

      let dispatches = 0
      svc.executeTask = async (): Promise<unknown> =>
        outcomes[Math.min(dispatches++, outcomes.length - 1)]
      svc.gradeTask = async (): Promise<unknown> => ({ overall: 'pass', gates: [] })
      svc.escalateToLead = async (): Promise<unknown> => ({
        success: false,
        completion: null,
        discoveries: [],
        failureReason: 'escalation failed'
      })
      svc.resolveGateCommandsFor = (): unknown => ({})
      svc.readManifestsCached = (): unknown => ({})
      // The seam that keeps this test off a real 5-second wait.
      svc.infraRetryDelayMs = (): number => 0

      const result = (await svc.executeTaskWithGates({
        task,
        blueprintId,
        workspaceId: wsId,
        workspacePath: dir,
        executionPath: dir,
        phaseContext: {} as never,
        priorDiscoveries: [],
        tDispatch: Date.now(),
        waveNum: 2
      })) as { success: boolean }

      const attempts = blueprintTaskRepository.findById(task.id).attempts
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
      return {
        dispatches,
        attempts,
        infraRows: rowsOf(blueprintId, 'infra_retry'),
        success: result?.success === true
      }
    }

    const infraFailure = {
      success: false,
      completion: null,
      discoveries: [],
      failureReason: 'error',
      failureClass: 'infra',
      resumeSafe: true
    }
    const ok = { success: true, completion: null, discoveries: [] }

    test('a transport blip is re-run once and the task recovers', async () => {
      if (!GIT_AVAILABLE) return
      const run = await runInfraLadder([infraFailure, ok])

      assert.equal(run.dispatches, 2, 'the failed dispatch is re-run inside the same attempt')
      assert.equal(run.success, true, 'the re-run result is what the ladder returns')
      assert.equal(run.infraRows.length, 1)
      assert.equal(run.infraRows[0].data.reason, 'error')
      assert.equal(run.infraRows[0].attempt, 1, 'the re-run happens INSIDE builder attempt 1')
      assert.equal(run.attempts, 2, 'both dispatches are recorded, as the overload loop does')
    })

    test('the re-run is not a builder attempt — the ladder does not advance', async () => {
      if (!GIT_AVAILABLE) return
      const run = await runInfraLadder([infraFailure, infraFailure])

      // 1 dispatch + 1 re-run, then the ladder returns. If `attempt` had
      // advanced, MAX_BUILDER_ATTEMPTS more sessions would have run.
      assert.equal(run.dispatches, 2, `expected exactly one re-run, saw ${run.dispatches}`)
      assert.equal(run.infraRows.length, 1, 'exactly one infra_retry row')
    })

    test('a NON-resume-safe infra failure (context overflow) gets no re-run', async () => {
      if (!GIT_AVAILABLE) return
      const run = await runInfraLadder([
        {
          success: false,
          completion: null,
          discoveries: [],
          failureReason: 'context_overflow',
          failureClass: 'infra',
          resumeSafe: false
        }
      ])

      assert.equal(run.dispatches, 1, 'resuming an overflowed session repeats the overflow')
      assert.equal(run.infraRows.length, 0)
    })

    test('a QUALITY failure is not infra and takes the normal ladder', async () => {
      if (!GIT_AVAILABLE) return
      const run = await runInfraLadder([
        {
          success: false,
          completion: null,
          discoveries: [],
          failureReason: 'no-write-activity',
          failureClass: 'quality',
          resumeSafe: true
        }
      ])

      assert.equal(run.infraRows.length, 0, 'a quality failure must not consume the infra re-run')
    })
  })

  // ── F2 — the peer-review re-grade leaves a trace ──

  describe('F2 — a peer-review re-grade is recorded even though the row keeps the original verdict', () => {
    test('a failing re-grade writes telemetry and a ledger entry', async () => {
      if (!GIT_AVAILABLE) return
      const { blueprintId, task, dir } = seed('F2 peer review')

      const { modelConfigService } = require('../model-config.service')
      const originalIsRoleEnabled = modelConfigService.isRoleEnabled
      modelConfigService.isRoleEnabled = (): boolean => true

      const peerModule = require('../blueprint-peer-review.service')
      const originalReview = peerModule.blueprintPeerReviewService.reviewTask
      const originalSurvivors = peerModule.blueprintPeerReviewService.recordSurvivingFindings
      peerModule.blueprintPeerReviewService.reviewTask = async (): Promise<unknown> => ({
        review: {
          findings: [{ category: 'correctness', issue: 'unchecked null', file: 'a.ts' }]
        },
        fixDispatched: true
      })
      peerModule.blueprintPeerReviewService.recordSurvivingFindings = (): void => {}

      const { BlueprintBuildService } = require('../blueprint-build.service')
      const svc = new BlueprintBuildService()

      const passReport = {
        overall: 'pass',
        gates: [{ name: 'write-set', verdict: 'pass', evidence: ['1 file(s)'], durationMs: 1 }]
      }
      let graded = 0
      svc.executeTask = async (): Promise<unknown> => ({
        success: true,
        completion: null,
        discoveries: []
      })
      // First grading = the real attempt (passes). Second = the peer-review
      // re-grade, which fails: the fix attempt broke the tree.
      svc.gradeTask = async (): Promise<unknown> => {
        graded++
        if (graded === 1) {
          blueprintTaskRepository.setGateReport(task.id, passReport)
          return passReport
        }
        return {
          overall: 'fail',
          gates: [
            {
              name: 'test-integrity',
              verdict: 'fail',
              evidence: ['spec lost 69 lines'],
              durationMs: 1
            }
          ]
        }
      }
      svc.resolveGateCommandsFor = (): unknown => ({})
      svc.readManifestsCached = (): unknown => ({})

      try {
        await svc.executeTaskWithGates({
          task,
          blueprintId,
          workspaceId: wsId,
          workspacePath: dir,
          executionPath: dir,
          phaseContext: {} as never,
          priorDiscoveries: [],
          tDispatch: Date.now(),
          waveNum: 2
        })
      } finally {
        modelConfigService.isRoleEnabled = originalIsRoleEnabled
        peerModule.blueprintPeerReviewService.reviewTask = originalReview
        peerModule.blueprintPeerReviewService.recordSurvivingFindings = originalSurvivors
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }

      const regrades = rowsOf(blueprintId, 'peer_review_regrade')
      assert.equal(regrades.length, 1, 'the re-grade verdict must be recorded somewhere')
      assert.equal(regrades[0].data.overall, 'fail')
      assert.deepEqual(regrades[0].data.failedGates, ['test-integrity'])

      const ledger = blueprintRepository.findById(blueprintId).unverifiedJson ?? []
      assert.ok(
        ledger.some(
          (i: { gate: string; reason: string }) =>
            i.gate === 'peer-review' && i.reason === 'pass_error'
        ),
        `a broken peer-review fix must be visible in the ledger: ${JSON.stringify(ledger)}`
      )

      // P3b is deliberately untouched: the row still carries the verdict the
      // task earned on its own attempt, not the synthetic-baseline re-grade.
      assert.equal(blueprintTaskRepository.findById(task.id).gatesJson.overall, 'pass')
    })
  })
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

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
