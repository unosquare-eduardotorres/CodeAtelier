/**
 * Gate engine tests — orchestration, verdict routing and the git plumbing.
 *
 * The pure judgement is covered in shared/__tests__/gate-analysis.test.ts.
 * What this file guards is the wiring around it, where the invariants live:
 *   - a gate that could not run yields `unverifiable`, never `fail`
 *   - a red test yields `fail`, never `unverifiable`
 *   - a `fail` short-circuits, so a bad write-set never pays for a 30-min build
 *
 * The git tests use a real temp repository. Diff-base semantics (a task that
 * commits its own work, a tree that was already dirty) cannot be faked with
 * string fixtures without re-implementing the thing under test.
 *
 * Run: tsx src/main/services/__tests__/blueprint-gates.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'

import {
  buildGateFixInstructions,
  captureGateBaseline,
  defaultCommandRunner,
  divergedPacketTestFiles,
  restorePacketTestFiles,
  runGates,
  selectAffectedTestFiles,
  type CommandOutcome,
  type CommandRunner,
  type GateTaskContext
} from '../blueprint-gates.service'
import type { GateName, GateVerdict } from '../../../shared/gate-types'
import type { BlueprintWorkPacket } from '../../../shared/blueprint-types'

// ── Helpers ──

const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const tempDirs: string[] = []

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-test-'))
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

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
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

/**
 * A runner that delegates git to the real binary (the gates need genuine diff
 * semantics) and answers every other command from a scripted table.
 */
function scriptedRunner(script: Record<string, Partial<CommandOutcome>>): CommandRunner {
  return async (command, opts) => {
    if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
    const entry = script[command]
    if (!entry) {
      return {
        exitCode: null,
        output: [],
        timedOut: false,
        spawnError: 'command not found',
        durationMs: 1
      }
    }
    return {
      exitCode: entry.exitCode ?? 0,
      output: entry.output ?? [],
      timedOut: entry.timedOut ?? false,
      ...(entry.spawnError ? { spawnError: entry.spawnError } : {}),
      durationMs: 1
    }
  }
}

/** A runner whose test command flips from red to green across the two calls. */
function redThenGreenRunner(testCommand: string): CommandRunner {
  let calls = 0
  return async (command, opts) => {
    if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
    if (command === testCommand) {
      calls++
      return calls === 1
        ? { exitCode: 1, output: ['1 failing'], timedOut: false, durationMs: 1 }
        : { exitCode: 0, output: ['all pass'], timedOut: false, durationMs: 1 }
    }
    return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
  }
}

const PACKET: BlueprintWorkPacket = {
  allowedFiles: ['src/feature.ts'],
  testFiles: ['src/feature.test.ts'],
  testCommand: 'run-task-tests'
}

function ctxFor(
  dir: string,
  runner: CommandRunner,
  over: Partial<GateTaskContext> = {}
): GateTaskContext {
  return {
    blueprintId: 'bp-1',
    taskId: 'T001',
    workspacePath: dir,
    executionPath: dir,
    plannedFiles: [],
    packet: PACKET,
    commands: {
      lint: { command: 'run-lint', provenance: 'detected' },
      build: { command: 'run-build', provenance: 'detected' }
    },
    runner,
    ...over
  }
}

function verdictOf(
  gates: { name: GateName; verdict: GateVerdict }[],
  name: GateName
): GateVerdict | undefined {
  return gates.find((g) => g.name === name)?.verdict
}

// ── Tests ──

describe('runGates — happy path', () => {
  test('a task that stays in its write-set and turns a red test green passes every gate', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const feature = () => null\n',
      'src/feature.test.ts': "test('feature', () => {})\n"
    })
    const runner = redThenGreenRunner('run-task-tests')
    const ctx = ctxFor(dir, runner)

    const baseline = await captureGateBaseline(ctx)
    assert.equal(baseline.redProof, 'red', 'pre-session run must record the red proof')

    write(dir, { 'src/feature.ts': 'export const feature = () => 42\n' })
    const report = await runGates(ctx, baseline)

    assert.equal(report.overall, 'pass', JSON.stringify(report.gates, null, 2))
    assert.equal(verdictOf(report.gates, 'task-tests'), 'pass')
  })
})

describe('runGates — fail routing', () => {
  test('a change outside the write-set fails and short-circuits before lint/build', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n",
      'src/other.ts': 'export const b = 1\n'
    })
    const ctx = ctxFor(
      dir,
      scriptedRunner({ 'run-lint': {}, 'run-build': {}, 'run-task-tests': { exitCode: 1 } })
    )
    const baseline = await captureGateBaseline(ctx)

    write(dir, { 'src/other.ts': 'export const b = 2\n' })
    const report = await runGates(ctx, baseline)

    assert.equal(report.overall, 'fail')
    assert.equal(verdictOf(report.gates, 'write-set'), 'fail')
    assert.equal(report.shortCircuited, true)
    assert.equal(verdictOf(report.gates, 'lint'), undefined, 'lint must not have run')
    assert.equal(verdictOf(report.gates, 'build'), undefined, 'build must not have run')
    assert.ok(report.gates[0].evidence.some((e) => e.includes('src/other.ts')))
  })

  test('a TODO added by the task fails the stub scan', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, scriptedRunner({ 'run-task-tests': { exitCode: 1 } }))
    const baseline = await captureGateBaseline(ctx)

    write(dir, { 'src/feature.ts': 'export const a = 1\n// TODO: finish this\n' })
    const report = await runGates(ctx, baseline)

    assert.equal(verdictOf(report.gates, 'stub-scan'), 'fail')
  })

  test('a TODO that was ALREADY in the file does not fail the task that edited it', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': '// TODO: legacy debt from 2023\nexport const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, redThenGreenRunner('run-task-tests'))
    const baseline = await captureGateBaseline(ctx)

    write(dir, { 'src/feature.ts': '// TODO: legacy debt from 2023\nexport const a = 2\n' })
    const report = await runGates(ctx, baseline)

    assert.equal(verdictOf(report.gates, 'stub-scan'), 'pass')
  })

  test('editing a packet test file fails test-integrity, not the write-set', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => { expect(a).toBe(2) })\n"
    })
    const ctx = ctxFor(dir, scriptedRunner({ 'run-task-tests': { exitCode: 1 } }))
    const baseline = await captureGateBaseline(ctx)

    write(dir, { 'src/feature.test.ts': "test('a', () => { expect(a).toBe(1) })\n" })
    const report = await runGates(ctx, baseline)

    assert.equal(verdictOf(report.gates, 'write-set'), 'pass')
    assert.equal(verdictOf(report.gates, 'test-integrity'), 'fail')
  })

  test('a task that commits its own work is still measured against the baseline commit', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n",
      'src/other.ts': 'export const b = 1\n'
    })
    const ctx = ctxFor(dir, scriptedRunner({ 'run-task-tests': { exitCode: 1 } }))
    const baseline = await captureGateBaseline(ctx)

    write(dir, { 'src/other.ts': 'export const b = 2\n' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'agent commit'], { cwd: dir })

    const report = await runGates(ctx, baseline)
    assert.equal(
      verdictOf(report.gates, 'write-set'),
      'fail',
      'a committed out-of-set change still counts'
    )
  })

  test('a tree that was already dirty does not blame this task for the user’s edits', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n",
      'src/other.ts': 'export const b = 1\n'
    })
    write(dir, { 'src/other.ts': 'export const b = 99 // user was mid-edit\n' })

    const ctx = ctxFor(dir, redThenGreenRunner('run-task-tests'))
    const baseline = await captureGateBaseline(ctx)
    assert.ok(baseline.preexistingDirty.includes('src/other.ts'))

    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    const report = await runGates(ctx, baseline)

    assert.equal(verdictOf(report.gates, 'write-set'), 'pass')
  })

  test('a red test after the session is a fail, never a warning', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(
      dir,
      scriptedRunner({
        'run-lint': {},
        'run-build': {},
        'run-task-tests': { exitCode: 1, output: ['1 failing'] }
      })
    )
    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)
    assert.equal(verdictOf(report.gates, 'task-tests'), 'fail')
    assert.equal(report.overall, 'fail')
  })
})

describe('runGates — unverifiable routing', () => {
  test('a missing lint command warns and never blocks', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, redThenGreenRunner('run-task-tests'), {
      commands: { build: { command: 'run-build', provenance: 'detected' } }
    })
    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)
    const lint = report.gates.find((g) => g.name === 'lint')!
    assert.equal(lint.verdict, 'unverifiable')
    assert.equal(lint.reason, 'no_command')
    assert.equal(report.overall, 'unverifiable')
    assert.notEqual(report.overall, 'fail')
  })

  test('a task with no packet degrades to unverifiable rather than failing', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/feature.ts': 'export const a = 1\n' })
    const ctx = ctxFor(dir, scriptedRunner({ 'run-lint': {}, 'run-build': {} }), {
      packet: null,
      commands: {}
    })
    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)
    assert.equal(report.overall, 'unverifiable')
    const writeSet = report.gates.find((g) => g.name === 'write-set')!
    assert.equal(writeSet.reason, 'no_packet')
    assert.equal(report.gates.find((g) => g.name === 'test-integrity')!.reason, 'no_packet')
  })

  test('a test that was already GREEN before the task is vacuous, not proof', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(
      dir,
      scriptedRunner({ 'run-lint': {}, 'run-build': {}, 'run-task-tests': {} })
    )
    const baseline = await captureGateBaseline(ctx)
    assert.equal(baseline.redProof, 'green')

    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    const report = await runGates(ctx, baseline)

    const tests = report.gates.find((g) => g.name === 'task-tests')!
    assert.equal(tests.verdict, 'unverifiable')
    assert.equal(tests.reason, 'vacuous_test')
  })

  test('a build TIMEOUT is unverifiable — a slow machine must not burn the retry ladder', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(
      dir,
      scriptedRunner({
        'run-lint': {},
        'run-build': { exitCode: null, timedOut: true },
        'run-task-tests': { exitCode: 1 }
      })
    )
    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)
    const build = report.gates.find((g) => g.name === 'build')!
    assert.equal(build.verdict, 'unverifiable')
    assert.equal(build.reason, 'timeout')
  })

  test('a TEST timeout is a fail — a suite that never finished is not green', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    let calls = 0
    const runner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      if (command === 'run-task-tests') {
        calls++
        return calls === 1
          ? { exitCode: 1, output: [], timedOut: false, durationMs: 1 }
          : { exitCode: null, output: [], timedOut: true, durationMs: 1 }
      }
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    const ctx = ctxFor(dir, runner)
    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)
    assert.equal(verdictOf(report.gates, 'task-tests'), 'fail')
  })

  test('a non-git directory makes the diff gates unverifiable, not failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-nogit-'))
    tempDirs.push(dir)
    write(dir, { 'src/feature.ts': 'export const a = 1\n' })

    const ctx = ctxFor(dir, scriptedRunner({}), { commands: {} })
    const baseline = await captureGateBaseline(ctx)
    assert.equal(baseline.baselineCommit, null)

    const report = await runGates(ctx, baseline)
    assert.equal(report.overall, 'unverifiable')
    assert.equal(report.gates.find((g) => g.name === 'write-set')!.reason, 'no_git')
  })
})

describe('destructive-revert (P1b) — replay of run 984eac4d', () => {
  /**
   * The shape that destroyed three deliverables: task A commits its work AFTER
   * task B captured its baseline, so A's committed lines are invisible to B's
   * diff base. B then “cleans up” a file it does not own and the record still
   * says A is complete and verified.
   */
  function commitAs(dir: string, taskId: string, files: Record<string, string>): void {
    write(dir, files)
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', `${taskId}: peer work`], { cwd: dir })
  }

  test('deleting a line a peer task committed fails the gate and names the victim', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n",
      '.env.example': 'EXISTING_KEY=1\n'
    })
    // T001's baseline is captured BEFORE T002 commits — exactly the stale-base
    // window a retry sits in.
    const ctx = ctxFor(dir, scriptedRunner({ 'run-task-tests': { exitCode: 1 } }))
    const baseline = await captureGateBaseline(ctx)

    commitAs(dir, 'T002', {
      '.env.example': 'EXISTING_KEY=1\nENROLLMENT_INTERNAL_NOTIFY_TO=ops@example.com\n'
    })

    // T001 does its own work AND reverts the peer's file.
    write(dir, {
      'src/feature.ts': 'export const a = 2\n',
      '.env.example': 'EXISTING_KEY=1\n'
    })

    const report = await runGates(ctx, baseline)
    const gate = report.gates.find((g) => g.name === 'destructive-revert')!
    assert.equal(gate.verdict, 'fail', JSON.stringify(report.gates, null, 2))
    assert.ok(
      gate.evidence.some((e) => e.includes('T002')),
      'names the victim task'
    )
    assert.ok(
      gate.evidence.some((e) => e.includes('.env.example')),
      'names the file'
    )
    assert.equal(report.overall, 'fail')
  })

  test('a file the graded task OWNS is its own business to rewrite', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, redThenGreenRunner('run-task-tests'))
    const baseline = await captureGateBaseline(ctx)

    // A peer touched THIS task's declared file and committed. Rewriting it is
    // not a destructive revert — it is the write-set owner doing its job.
    commitAs(dir, 'T002', { 'src/feature.ts': 'export const a = 1\nexport const peerLine = 99\n' })
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)
    assert.equal(report.gates.find((g) => g.name === 'destructive-revert')!.verdict, 'pass')
  })

  test('the graded task may revert its OWN earlier commit', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, redThenGreenRunner('run-task-tests'))
    const baseline = await captureGateBaseline(ctx)

    commitAs(dir, 'T001', { 'src/scratch.ts': 'export const experiment = true\n' })
    rmSync(join(dir, 'src/scratch.ts'))
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)
    assert.equal(report.gates.find((g) => g.name === 'destructive-revert')!.verdict, 'pass')
  })

  test('a task that walks back its OWN work with a deletion-only commit is not a victim', async () => {
    if (!GIT_AVAILABLE) return
    // Live shape from run 984eac4d: `dee825b7 "T005 keep the mailer belt inside
    // its write-set"` is 271 deletions and ZERO additions — T005 removing its
    // own earlier lines to satisfy its own write-set gate. A deletion-only
    // commit contributes nothing to the "newest adder" map, so the older T005
    // commit's additions read as destroyed and T005 was reported as the victim
    // of a later task — itself.
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    // `src/belt.ts` is T005's declared file, so P1a exempts it from T001's
    // write-set — without that the write-set gate short-circuits first and this
    // scenario never reaches `destructive-revert` at all.
    const ctx = ctxFor(dir, redThenGreenRunner('run-task-tests'), {
      exemptFiles: ['src/belt.ts']
    })
    const baseline = await captureGateBaseline(ctx)

    // T005 adds a belt, then removes it again in a pure-deletion commit.
    commitAs(dir, 'T005', {
      'src/belt.ts': 'export const mailerParityBelt = true\nexport const portalCoverage = 1\n'
    })
    write(dir, { 'src/belt.ts': 'export const portalCoverage = 1\n' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'T005: keep the belt inside its write-set'], {
      cwd: dir
    })

    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    const report = await runGates(ctx, baseline)

    const gate = report.gates.find((g) => g.name === 'destructive-revert')
    assert.ok(gate, `gate never ran: ${JSON.stringify(report.gates, null, 2)}`)
    assert.equal(gate.verdict, 'pass', JSON.stringify(gate.evidence, null, 2))
  })

  test('a revert that adds a few lines back still cannot mask what it deleted', async () => {
    if (!GIT_AVAILABLE) return
    // The loss that actually killed run 984eac4d, and the one an earlier draft
    // of this gate MISSED: `5ef69312 "T005 restore apps/web mail seam to its
    // baseline"` deleted 82 lines from mailer.ts and added 7 back. Suppressing
    // an older commit's additions whenever a NEWER commit added to the same
    // file let those 7 lines hide T008's 77 — the `sendInternalSignoffNotice`
    // export whose absence failed the typecheck 31 minutes later (TS2305).
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n",
      'src/mailer.ts': 'export const baseline = true\n'
    })
    const ctx = ctxFor(dir, redThenGreenRunner('run-task-tests'), {
      exemptFiles: ['src/mailer.ts']
    })
    const baseline = await captureGateBaseline(ctx)

    // T008 adds the template block.
    commitAs(dir, 'T008', {
      'src/mailer.ts':
        'export const baseline = true\n' +
        'export function sendInternalSignoffNotice(): void {}\n' +
        'export const internalSignoffSubject = "Sign-off received"\n' +
        'export const internalSignoffBody = "A client signed their elections"\n' +
        'export const internalSignoffTokens = ["client_name", "signer_name"]\n' +
        'export const internalSignoffTemplate = "internal-signoff.md"\n'
    })
    // T005 “restores the baseline”: the real 5ef69312 was +7/-82 on this file.
    // Net-NEGATIVE is what makes it destruction rather than a refinement — it
    // deletes five of T008's lines and adds one of its own.
    write(dir, { 'src/mailer.ts': 'export const baseline = true\nexport const restoredSeam = 1\n' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'T005: restore the mail seam to its baseline'], {
      cwd: dir
    })

    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    const report = await runGates(ctx, baseline)

    const gate = report.gates.find((g) => g.name === 'destructive-revert')!
    assert.equal(gate.verdict, 'fail', JSON.stringify(gate.evidence, null, 2))
    assert.ok(
      gate.evidence.some((e) => e.includes('T008')),
      'names T008 as the victim'
    )
    assert.ok(
      gate.evidence.some((e) => e.includes('sendInternalSignoffNotice')),
      'names the destroyed export'
    )
  })

  test('nothing committed since the baseline is a PASS, not an unprovable claim', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, redThenGreenRunner('run-task-tests'))
    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)
    const gate = report.gates.find((g) => g.name === 'destructive-revert')!
    assert.equal(gate.verdict, 'pass')
    assert.equal(report.overall, 'pass', 'a serial build must not be tainted by this gate')
  })

  test('commits that do not name a task id are unverifiable, never a false fail', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n",
      'docs/notes.md': 'original\n'
    })
    const ctx = ctxFor(dir, redThenGreenRunner('run-task-tests'))
    const baseline = await captureGateBaseline(ctx)

    write(dir, { 'docs/notes.md': 'original\nsomebody else was here entirely\n' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'chore: unrelated'], { cwd: dir })
    write(dir, { 'docs/notes.md': 'original\n', 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)
    const gate = report.gates.find((g) => g.name === 'destructive-revert')!
    assert.equal(gate.verdict, 'unverifiable')
    assert.equal(gate.reason, 'analysis_unavailable')
  })
})

describe('build gate baseline (P2a) — a task is not blamed for a tree it inherited', () => {
  /** A runner whose build command emits a fixed diagnostic set. */
  function buildRunner(before: string[], after: string[]): CommandRunner {
    let builds = 0
    let tests = 0
    return async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      if (command === 'run-build') {
        const output = builds++ === 0 ? before : after
        return {
          exitCode: output.length > 0 ? 1 : 0,
          output,
          timedOut: false,
          durationMs: 1
        }
      }
      // Red before, green after — so `task-tests` passes and the overall verdict
      // is decided by the build gate alone, which is what these tests are about.
      if (command === 'run-task-tests') {
        return tests++ === 0
          ? { exitCode: 1, output: ['1 failing'], timedOut: false, durationMs: 1 }
          : { exitCode: 0, output: ['all pass'], timedOut: false, durationMs: 1 }
      }
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
  }

  const INHERITED = [
    "src/signoff-notification.ts(12,7): error TS2305: Module './mailer' has no exported member 'sendInternalSignoffNotice'."
  ]

  test('the live T002 shape: an inherited typecheck error is unverifiable, not a fail', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    // Same error before and after, only shifted down a line by this task's edit.
    const shifted = [INHERITED[0].replace('(12,7)', '(19,7)')]
    const ctx = ctxFor(dir, buildRunner(INHERITED, shifted), { commandGates: ['build'] })

    const baseline = await captureGateBaseline(ctx)
    assert.equal(baseline.buildBefore?.failed, true, 'the tree was broken on arrival')

    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    const report = await runGates(ctx, baseline)
    const build = report.gates.find((g) => g.name === 'build')!

    assert.equal(build.verdict, 'unverifiable', JSON.stringify(build.evidence, null, 2))
    assert.equal(build.reason, 'preexisting_failure')
    assert.notEqual(report.overall, 'fail', 'an inherited break must not burn the retry ladder')
  })

  test('a NEW error still fails, and the evidence names only the new one', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const introduced =
      "src/feature.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'."
    const ctx = ctxFor(dir, buildRunner(INHERITED, [...INHERITED, introduced]), {
      commandGates: ['build']
    })

    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    const report = await runGates(ctx, baseline)
    const build = report.gates.find((g) => g.name === 'build')!

    assert.equal(build.verdict, 'fail')
    assert.ok(
      build.evidence.some((e) => e.includes('TS2322')),
      'the error this task introduced must be named'
    )
    assert.ok(
      !build.evidence.some((e) => e.includes('TS2305')),
      'the inherited error must not be quoted back at the builder'
    )
    assert.equal(build.counts?.newErrors, 1)
    assert.equal(build.counts?.preexistingErrors, 1)
  })

  test('a tree that was GREEN before means any failure is this task’s', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, buildRunner([], INHERITED), { commandGates: ['build'] })

    const baseline = await captureGateBaseline(ctx)
    assert.equal(baseline.buildBefore?.failed, false)

    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    const report = await runGates(ctx, baseline)
    assert.equal(report.gates.find((g) => g.name === 'build')!.verdict, 'fail')
  })

  test('output with no parseable diagnostics is never discounted', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    // A toolchain whose failures carry no file:line — we cannot attribute, so we
    // must not fail open.
    const opaque = ['build failed: something went wrong']
    const ctx = ctxFor(dir, buildRunner(opaque, opaque), { commandGates: ['build'] })

    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    const report = await runGates(ctx, baseline)
    assert.equal(report.gates.find((g) => g.name === 'build')!.verdict, 'fail')
  })
})

describe('selectAffectedTestFiles', () => {
  test('packet test files are always included', () => {
    assert.deepEqual(selectAffectedTestFiles([], ['src/a.test.ts']), ['src/a.test.ts'])
  })

  test('code-graph callers that look like tests are added, others ignored', () => {
    const files = selectAffectedTestFiles(['src/a.ts'], ['src/a.test.ts'], () => [
      'src/a.test.ts',
      'src/__tests__/b.ts',
      'src/consumer.ts'
    ])
    assert.deepEqual(files.sort(), ['src/__tests__/b.ts', 'src/a.test.ts'])
  })

  test('with no packet and no graph the selection is empty — the caller falls back to the full suite', () => {
    assert.deepEqual(selectAffectedTestFiles(['src/a.ts'], undefined), [])
  })
})

describe('restorePacketTestFiles — a failed attempt must not poison the next one', () => {
  const SPEC = "test('feature', () => { expect(feature()).toBe(42) })\n"
  const WEAKENED = "test('feature', () => {})\n"

  /** Red before the session and red after — the gate under test is not task-tests. */
  const redRunner = (): CommandRunner =>
    scriptedRunner({ 'run-task-tests': { exitCode: 1, output: ['1 failing'] } })

  test('a weakened test file is restored byte-for-byte, and the next grading clears', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const feature = () => null\n',
      'src/feature.test.ts': SPEC
    })
    const ctx = ctxFor(dir, redRunner())
    const baseline = await captureGateBaseline(ctx)

    // Attempt 1 edits the spec instead of the implementation.
    write(dir, { 'src/feature.test.ts': WEAKENED })
    const failed = await runGates(ctx, baseline)
    const gate = failed.gates.find((g) => g.name === 'test-integrity')
    assert.equal(gate?.verdict, 'fail')
    assert.deepEqual(
      gate?.files,
      ['src/feature.test.ts'],
      'the offending path must ride on the result — nothing should have to parse the prose'
    )
    assert.ok(
      gate?.evidence.some((l) => l.includes('content differs')),
      'the evidence must name the check that tripped, not just that one did'
    )

    const restored = restorePacketTestFiles(ctx, baseline, gate?.files ?? [])
    assert.deepEqual(restored, ['src/feature.test.ts'])
    assert.equal(
      readFileSync(join(dir, 'src/feature.test.ts'), 'utf-8'),
      SPEC,
      'the captured BYTES, not a reconstruction of them'
    )

    // Attempt 2 touches nothing. Before the restore this graded FAIL on attempt
    // 1's leftover, fingerprinted identically and tripped the stop-loss.
    const after = await runGates(ctx, baseline)
    assert.equal(verdictOf(after.gates, 'test-integrity'), 'pass')
  })

  test('a deleted test file is written back', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const feature = () => null\n',
      'src/feature.test.ts': SPEC
    })
    const ctx = ctxFor(dir, redRunner())
    const baseline = await captureGateBaseline(ctx)

    rmSync(join(dir, 'src/feature.test.ts'))
    assert.deepEqual(restorePacketTestFiles(ctx, baseline, ['src/feature.test.ts']), [
      'src/feature.test.ts'
    ])
    assert.equal(readFileSync(join(dir, 'src/feature.test.ts'), 'utf-8'), SPEC)
  })

  test('a file the packet never declared is not ours to write', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const feature = () => null\n',
      'src/feature.test.ts': SPEC,
      'src/other.test.ts': "test('other', () => {})\n"
    })
    const ctx = ctxFor(dir, redRunner())
    const baseline = await captureGateBaseline(ctx)

    write(dir, { 'src/other.test.ts': 'wrecked\n' })
    assert.deepEqual(restorePacketTestFiles(ctx, baseline, ['src/other.test.ts']), [])
    assert.equal(
      readFileSync(join(dir, 'src/other.test.ts'), 'utf-8'),
      'wrecked\n',
      'only files the baseline captured — i.e. declared in this packet — may be rewritten'
    )
  })

  test('a captured path that escapes the execution root is refused', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const feature = () => null\n',
      'src/feature.test.ts': SPEC
    })
    const outsideDir = mkdtempSync(join(tmpdir(), 'gate-outside-'))
    tempDirs.push(outsideDir)
    const outside = join(outsideDir, 'victim.test.ts')
    writeFileSync(outside, 'untouched\n')

    const ctx = ctxFor(dir, redRunner())
    const baseline = await captureGateBaseline(ctx)
    // Fabricated: `captureGateBaseline` cannot produce an escaping key, so the
    // second bound is only reachable by forcing it.
    const escaping = `../${basename(outsideDir)}/victim.test.ts`
    baseline.testsBefore[escaping] = { hash: 'x', testCount: 1, content: 'PWNED\n' }

    assert.deepEqual(restorePacketTestFiles(ctx, baseline, [escaping]), [])
    assert.equal(readFileSync(outside, 'utf-8'), 'untouched\n')
  })

  test('a file the builder legitimately EXTENDED passes the gate, so restore never fires on it', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const feature = () => null\n',
      'src/feature.test.ts': SPEC
    })
    const ctx = ctxFor(dir, redRunner())
    const baseline = await captureGateBaseline(ctx)

    write(dir, { 'src/feature.test.ts': `${SPEC}test('feature edge case', () => {})\n` })
    const report = await runGates(ctx, baseline)
    const gate = report.gates.find((g) => g.name === 'test-integrity')
    assert.equal(gate?.verdict, 'pass', 'authoring new tests in a packet file is a deliverable')
    assert.equal(gate?.files, undefined, 'nothing to restore — the extension must survive')
  })

  test('a file that already matches the baseline is left alone and not reported', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const feature = () => null\n',
      'src/feature.test.ts': SPEC
    })
    const ctx = ctxFor(dir, redRunner())
    const baseline = await captureGateBaseline(ctx)

    assert.deepEqual(
      restorePacketTestFiles(ctx, baseline, ['src/feature.test.ts']),
      [],
      'a no-op must not be announced — the retry prompt would tell the builder a ' +
        'restore happened that never did'
    )
    assert.equal(readFileSync(join(dir, 'src/feature.test.ts'), 'utf-8'), SPEC)
  })

  test('a packet test file a PEER also declares is skipped by the gate AND by the restore', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const feature = () => null\n',
      'src/feature.test.ts': SPEC
    })
    // R1.2: the peer scheduler declares this file for another in-flight task.
    const ctx = ctxFor(dir, redRunner(), { exemptFiles: ['src/feature.test.ts'] })
    const baseline = await captureGateBaseline(ctx)

    // The change is the PEER's, mid-session and uncommitted.
    write(dir, { 'src/feature.test.ts': WEAKENED })
    const report = await runGates(ctx, baseline)
    const gate = report.gates.find((g) => g.name === 'test-integrity')
    assert.equal(
      gate?.verdict,
      'unverifiable',
      'this gate reads DISK, not the diff, so it needs the peer attribution every ' +
        'other gate already gets — a peer edit is not this task’s violation'
    )

    assert.deepEqual(restorePacketTestFiles(ctx, baseline, ['src/feature.test.ts']), [])
    assert.equal(
      readFileSync(join(dir, 'src/feature.test.ts'), 'utf-8'),
      WEAKENED,
      'the kernel must never do what REVERT_SCOPE_RULE forbids the builder from ' +
        'doing: overwrite a peer’s in-flight work with pre-session bytes'
    )
  })

  test('a write that does not read back as the captured hash is reported as NOT restored', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const feature = () => null\n',
      'src/feature.test.ts': SPEC
    })
    const ctx = ctxFor(dir, redRunner())
    const baseline = await captureGateBaseline(ctx)

    // The real causes — a short write, a full disk, a concurrent writer between
    // the write and the read-back — cannot be produced deterministically, so the
    // branch is driven by a capture whose hash does not describe its content.
    // What is under test is the guard: the restore reports only what it can
    // PROVE landed as the pre-session spec.
    baseline.testsBefore['src/feature.test.ts'] = {
      hash: createHash('sha256').update('something else entirely').digest('hex'),
      testCount: 1,
      content: SPEC
    }
    write(dir, { 'src/feature.test.ts': WEAKENED })

    assert.deepEqual(
      restorePacketTestFiles(ctx, baseline, ['src/feature.test.ts']),
      [],
      'announcing a restore that cannot be verified would make the next gate ' +
        'failure unexplainable — the prompt says the file is back to spec'
    )
  })

  test('the restore is not a wildcard: an unrelated source edit is left alone', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const feature = () => null\n',
      'src/feature.test.ts': SPEC
    })
    const ctx = ctxFor(dir, redRunner())
    const baseline = await captureGateBaseline(ctx)

    write(dir, {
      'src/feature.ts': 'export const feature = () => 42\n',
      'src/feature.test.ts': WEAKENED
    })
    restorePacketTestFiles(ctx, baseline, ['src/feature.test.ts', 'src/feature.ts'])
    assert.equal(
      readFileSync(join(dir, 'src/feature.ts'), 'utf-8'),
      'export const feature = () => 42\n',
      'the implementation work of the failed attempt is never touched'
    )
    assert.ok(existsSync(join(dir, 'src/feature.test.ts')))
  })
})

describe('divergedPacketTestFiles — the net for exits that never produce a verdict', () => {
  const SPEC = "test('feature', () => { expect(feature()).toBe(42) })\n"
  const WEAKENED = "test('feature', () => {})\n"
  const TESTS = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts']

  test('reports weakened and deleted files, never an extension or a peer’s', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo(Object.fromEntries(TESTS.map((f) => [f, SPEC])))
    const ctx = ctxFor(dir, scriptedRunner({}), {
      packet: { allowedFiles: [], testFiles: TESTS },
      // c is declared by another in-flight task.
      exemptFiles: ['src/c.test.ts']
    })
    const baseline = await captureGateBaseline(ctx)

    write(dir, {
      'src/a.test.ts': WEAKENED,
      // Authoring: strictly MORE tests than the spec started with.
      'src/b.test.ts': `${SPEC}test('edge case', () => { expect(feature()).toBe(0) })\n`,
      'src/c.test.ts': WEAKENED
    })
    rmSync(join(dir, 'src/d.test.ts'))

    assert.deepEqual(
      divergedPacketTestFiles(ctx, baseline),
      ['src/a.test.ts', 'src/d.test.ts'],
      'the sweep is hash-and-count only: it must catch a weakening and a deletion ' +
        'while leaving an extension and a peer-declared file alone'
    )
  })

  test('an intact tree sweeps nothing', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/a.test.ts': SPEC })
    const ctx = ctxFor(dir, scriptedRunner({}), {
      packet: { allowedFiles: [], testFiles: ['src/a.test.ts'] }
    })
    const baseline = await captureGateBaseline(ctx)
    assert.deepEqual(divergedPacketTestFiles(ctx, baseline), [])
  })
})

describe('buildGateFixInstructions', () => {
  test('names the gate, the evidence and a mechanical instruction', () => {
    const text = buildGateFixInstructions({
      overall: 'fail',
      gates: [
        {
          name: 'write-set',
          verdict: 'fail',
          evidence: ['outside write-set: src/other.ts'],
          durationMs: 1
        }
      ]
    })
    assert.ok(text.includes('write-set'))
    assert.ok(text.includes('src/other.ts'))
    assert.ok(text.includes('Undo'))
  })

  test('P1c — every fix prompt carries the do-not-revert-what-you-do-not-own rule', () => {
    const text = buildGateFixInstructions({
      overall: 'fail',
      gates: [
        {
          name: 'write-set',
          verdict: 'fail',
          evidence: ['outside write-set: .env.example'],
          durationMs: 1
        }
      ]
    })
    assert.ok(text.includes('git checkout'), 'names the exact action that destroyed the work')
    assert.ok(/re-?apply/i.test(text), 'kills the “somebody else will re-apply it” assumption')
  })

  test('a restored test file is named, so the builder does not try to restore it again', () => {
    const report = {
      overall: 'fail' as const,
      gates: [
        {
          name: 'test-integrity' as const,
          verdict: 'fail' as const,
          evidence: [
            'test file modified (content differs from the pre-session spec): src/a.test.ts'
          ],
          files: ['src/a.test.ts'],
          durationMs: 1
        }
      ]
    }
    const text = buildGateFixInstructions(report, { restoredTestFiles: ['src/a.test.ts'] })
    assert.ok(/ALREADY restored/.test(text))
    assert.ok(text.includes('src/a.test.ts'))
    assert.ok(/Do not edit them again/.test(text))

    // And without a restore there is no claim that one happened.
    assert.ok(!/ALREADY restored/.test(buildGateFixInstructions(report)))
  })

  test('the scope rule carves out the task’s OWN packet test files', () => {
    const text = buildGateFixInstructions({
      overall: 'fail',
      gates: [
        {
          name: 'test-integrity',
          verdict: 'fail',
          evidence: ['test file deleted: t.ts'],
          durationMs: 1
        }
      ]
    })
    assert.ok(
      /Exception — the test files listed in YOUR OWN task packet/.test(text),
      'the rule that forbids reverting foreign files must not read as forbidding the packet spec'
    )
  })

  test('passing gates produce no fix prompt', () => {
    assert.equal(
      buildGateFixInstructions({
        overall: 'pass',
        gates: [{ name: 'lint', verdict: 'pass', evidence: [], durationMs: 1 }]
      }),
      ''
    )
  })

  // D2b — an import_env gate is `unverifiable`, so it never lands in `failed`;
  // it gets its own section whose instruction is the OPERATOR remedy, not a
  // code-fix instruction ("fix the import" was the T004 loop driver).
  test('D2b — import_env gate renders the environmental remedy, not a code-fix instruction', () => {
    const text = buildGateFixInstructions({
      overall: 'unverifiable',
      gates: [
        {
          name: 'task-tests',
          verdict: 'unverifiable',
          reason: 'import_env',
          evidence: [
            'pytest — the test suite could not be collected (missing module: crsos_ui)',
            'The test suite could not be COLLECTED because an import failed — this is an environment fault (missing PYTHONPATH / package root), not a code defect.'
          ],
          durationMs: 1
        }
      ]
    })
    assert.ok(text.length > 0, 'an import_env gate alone still produces instructions')
    assert.ok(/PYTHONPATH/.test(text), 'names the remedy the operator must apply')
    assert.ok(
      /override the workspace gate command/.test(text),
      'names the gate-command override alternative'
    )
    assert.ok(/No code action/.test(text), 'explicitly tells the builder not to fix it in code')
    assert.ok(
      !/Make the listed tests pass by changing the implementation/.test(text),
      'must NOT carry the task-tests code-fix instruction'
    )
  })
})

process.on('exit', cleanup)

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
