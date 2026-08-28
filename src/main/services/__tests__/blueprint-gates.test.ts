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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'

import {
  buildGateFixInstructions,
  captureGateBaseline,
  defaultCommandRunner,
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
    assert.ok(text.includes('Revert'))
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
})

process.on('exit', cleanup)

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
