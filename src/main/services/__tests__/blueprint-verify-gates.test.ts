/**
 * VERIFY-phase gate tests (M8.2/M8.3) — `runVerifyGates` + `runStructuralGate`.
 *
 * Guards the wiring invariants the plan doc demands:
 *   - a missing smoke command ⇒ `unverifiable`/`no_command` (ledger, never fail)
 *   - a red full-suite or red smoke ⇒ `fail` (backstop parity with the wave level)
 *   - structural findings are WARNINGS: verdict stays `pass` with evidence
 *   - a graph that cannot be built/queried ⇒ `unverifiable`/`analysis_unavailable`
 *   - the reindex budget (60s) overrun ⇒ `unverifiable`, never a hang
 *
 * Diff semantics use a real temp git repo (same style as blueprint-gates.test.ts);
 * everything else runs against injectable fakes.
 *
 * Run: tsx src/main/services/__tests__/blueprint-verify-gates.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'

import {
  runVerifyGates,
  runStructuralGate,
  STRUCTURAL_REINDEX_BUDGET_MS,
  defaultCommandRunner,
  type CommandOutcome,
  type CommandRunner,
  type GateTaskContext,
  type StructuralGateDeps
} from '../blueprint-gates.service'
import type { GateName, GateVerdict } from '../../../shared/gate-types'

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
  const dir = mkdtempSync(join(tmpdir(), 'verify-gates-test-'))
  tempDirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'verify@test.local'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Verify Test'], { cwd: dir })
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

/** Git goes to the real binary; other commands answer from a scripted table. */
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

function verifyCtx(
  dir: string,
  runner: CommandRunner,
  over: Partial<GateTaskContext> = {}
): GateTaskContext {
  return {
    blueprintId: 'bp-1',
    taskId: 'verify',
    workspacePath: dir,
    executionPath: dir,
    plannedFiles: [],
    packet: null,
    commands: {},
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

/** Fake graph deps with call recording, so tests assert the reindex happened. */
function fakeGraphDeps(over: {
  deadCode?: Array<{ file: string; line: number; name: string }>
  cycles?: string[][]
  indexThrows?: boolean
  indexNeverResolves?: boolean
  queryThrows?: boolean
}): StructuralGateDeps & { indexed: string[] } {
  const state = { indexed: [] as string[] }
  const deps: StructuralGateDeps & { indexed: string[] } = {
    indexed: state.indexed,
    indexWorkspace: async (wsId, wsPath) => {
      if (over.indexNeverResolves) await new Promise(() => {}) // never settles
      if (over.indexThrows) throw new Error('parser exploded')
      state.indexed.push(`${wsId}:${wsPath}`)
    },
    findDeadCode: async () => {
      if (over.queryThrows) throw new Error('query failed')
      return (over.deadCode ?? []).map((d) => ({ ...d, symbolKind: 'function' }))
    },
    findCircularDependencies: () => {
      if (over.queryThrows) throw new Error('query failed')
      return over.cycles ?? []
    }
  }
  return deps
}

// ── runVerifyGates (M8.2) ──

describe('runVerifyGates — command gates', () => {
  test('missing smoke command ⇒ unverifiable/no_command, never fail', async () => {
    const dir = makeRepo({ 'README.md': 'x\n' })
    const ctx = verifyCtx(dir, scriptedRunner({ 'run-suite': {} }), {
      commands: { test: { command: 'run-suite', provenance: 'detected' } }
    })

    const report = await runVerifyGates(ctx)
    assert.equal(verdictOf(report.gates, 'full-suite'), 'pass')
    const smoke = report.gates.find((g) => g.name === 'smoke')!
    assert.equal(smoke.verdict, 'unverifiable')
    assert.equal(smoke.reason, 'no_command')
    assert.notEqual(report.overall, 'fail', 'a missing smoke command must never fail the run')
  })

  test('red full-suite ⇒ fail (backstop parity with the wave level)', async () => {
    const dir = makeRepo({ 'README.md': 'x\n' })
    const ctx = verifyCtx(
      dir,
      scriptedRunner({ 'run-suite': { exitCode: 1, output: ['1 failing'] } }),
      { commands: { test: { command: 'run-suite', provenance: 'detected' } } }
    )

    const report = await runVerifyGates(ctx)
    assert.equal(verdictOf(report.gates, 'full-suite'), 'fail')
    assert.equal(report.overall, 'fail')
  })

  test('red smoke ⇒ fail', async () => {
    const dir = makeRepo({ 'README.md': 'x\n' })
    const ctx = verifyCtx(
      dir,
      scriptedRunner({
        'run-suite': {},
        'run-smoke': { exitCode: 2, output: ['app failed to boot'] }
      }),
      {
        commands: {
          test: { command: 'run-suite', provenance: 'detected' },
          smoke: { command: 'run-smoke', provenance: 'override' }
        }
      }
    )

    const report = await runVerifyGates(ctx)
    assert.equal(verdictOf(report.gates, 'full-suite'), 'pass')
    assert.equal(verdictOf(report.gates, 'smoke'), 'fail')
    assert.equal(report.overall, 'fail')
  })

  test('green suite + green smoke ⇒ overall pass', async () => {
    const dir = makeRepo({ 'README.md': 'x\n' })
    const ctx = verifyCtx(dir, scriptedRunner({ 'run-suite': {}, 'run-smoke': {} }), {
      commands: {
        test: { command: 'run-suite', provenance: 'detected' },
        smoke: { command: 'run-smoke', provenance: 'override' }
      }
    })

    const report = await runVerifyGates(ctx)
    assert.equal(report.overall, 'pass')
  })

  test('no commands resolved at all ⇒ both unverifiable, overall unverifiable (not fail)', async () => {
    const dir = makeRepo({ 'README.md': 'x\n' })
    const ctx = verifyCtx(dir, scriptedRunner({}))

    const report = await runVerifyGates(ctx)
    assert.equal(verdictOf(report.gates, 'full-suite'), 'unverifiable')
    assert.equal(verdictOf(report.gates, 'smoke'), 'unverifiable')
    assert.equal(report.overall, 'unverifiable')
  })
})

// ── runStructuralGate (M8.3) ──

describe('runStructuralGate — scoping & verdicts', () => {
  test('dead code in changed files ⇒ pass with warning evidence naming the finding', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/feature.ts': 'export const a = 1\n' })
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8'
    }).trim()
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: dir })

    const deps = fakeGraphDeps({
      deadCode: [
        { file: 'src/feature.ts', line: 3, name: 'unusedFn' },
        { file: 'src/untouched.ts', line: 1, name: 'oldFn' } // outside the diff — must be filtered
      ]
    })
    const gate = await runStructuralGate(
      { ...verifyCtx(dir, scriptedRunner({})), workspaceId: 'ws-1', baselineCommit: baseline },
      deps
    )

    assert.equal(gate.verdict, 'pass', 'structural findings are warnings, never fail')
    assert.ok(gate.evidence.some((e) => e.includes('src/feature.ts') && e.includes('unusedFn')))
    assert.ok(
      !gate.evidence.some((e) => e.includes('oldFn')),
      'dead code outside the feature diff must not warn'
    )
    assert.equal(gate.counts?.deadCode, 1)
    assert.equal(gate.counts?.changedFiles, 1)
    assert.ok(deps.indexed.length === 1, 'the graph must be reindexed before querying')
  })

  test('import cycle touching a changed file ⇒ pass with cycle evidence; untouched cycles filtered', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export const b = 1\n'
    })
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8'
    }).trim()
    write(dir, { 'src/a.ts': 'export const a = 2\n' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: dir })

    const deps = fakeGraphDeps({
      cycles: [
        ['src/a.ts', 'src/b.ts', 'src/a.ts'],
        ['src/x.ts', 'src/y.ts', 'src/x.ts'] // untouched — must be filtered
      ]
    })
    const gate = await runStructuralGate(
      { ...verifyCtx(dir, scriptedRunner({})), workspaceId: 'ws-1', baselineCommit: baseline },
      deps
    )

    assert.equal(gate.verdict, 'pass')
    assert.ok(gate.evidence.some((e) => e.includes('src/a.ts') && e.includes('src/b.ts')))
    assert.ok(!gate.evidence.some((e) => e.includes('src/x.ts')))
    assert.equal(gate.counts?.cycles, 1)
  })

  test('clean graph ⇒ pass with a clean-evidence line', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/feature.ts': 'export const a = 1\n' })
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8'
    }).trim()
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: dir })

    const gate = await runStructuralGate(
      { ...verifyCtx(dir, scriptedRunner({})), workspaceId: 'ws-1', baselineCommit: baseline },
      fakeGraphDeps({})
    )

    assert.equal(gate.verdict, 'pass')
    assert.ok(gate.evidence.some((e) => e.includes('no new dead code')))
  })

  test('no baseline commit ⇒ unverifiable/no_git', async () => {
    const dir = makeRepo({ 'README.md': 'x\n' })
    const gate = await runStructuralGate(
      { ...verifyCtx(dir, scriptedRunner({})), workspaceId: 'ws-1', baselineCommit: null },
      fakeGraphDeps({})
    )
    assert.equal(gate.verdict, 'unverifiable')
    assert.equal(gate.reason, 'no_git')
  })

  test('empty feature diff ⇒ clean pass without touching the graph', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'README.md': 'x\n' })
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8'
    }).trim()

    const deps = fakeGraphDeps({})
    const gate = await runStructuralGate(
      { ...verifyCtx(dir, scriptedRunner({})), workspaceId: 'ws-1', baselineCommit: baseline },
      deps
    )
    assert.equal(gate.verdict, 'pass')
    assert.ok(deps.indexed.length === 0, 'an empty diff must not pay for a reindex')
  })

  test('graph unavailable (index throws) ⇒ unverifiable/analysis_unavailable', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/feature.ts': 'export const a = 1\n' })
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8'
    }).trim()
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: dir })

    const gate = await runStructuralGate(
      { ...verifyCtx(dir, scriptedRunner({})), workspaceId: 'ws-1', baselineCommit: baseline },
      fakeGraphDeps({ indexThrows: true })
    )
    assert.equal(gate.verdict, 'unverifiable')
    assert.equal(gate.reason, 'analysis_unavailable')
  })

  test('graph query throws ⇒ unverifiable/analysis_unavailable', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/feature.ts': 'export const a = 1\n' })
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8'
    }).trim()
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: dir })

    const gate = await runStructuralGate(
      { ...verifyCtx(dir, scriptedRunner({})), workspaceId: 'ws-1', baselineCommit: baseline },
      fakeGraphDeps({ queryThrows: true })
    )
    assert.equal(gate.verdict, 'unverifiable')
    assert.equal(gate.reason, 'analysis_unavailable')
  })

  test('reindex budget overrun ⇒ unverifiable/analysis_unavailable, never a hang', async () => {
    if (!GIT_AVAILABLE) return
    const dir = makeRepo({ 'src/feature.ts': 'export const a = 1\n' })
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8'
    }).trim()
    write(dir, { 'src/feature.ts': 'export const a = 2\n' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: dir })

    // Never-resolving index + a 50ms injected budget: the race must reject on
    // the budget, not wait for the index. A wall-clock guard proves the gate
    // actually returned instead of hanging.
    const started = Date.now()
    const gate = await runStructuralGate(
      {
        ...verifyCtx(dir, scriptedRunner({})),
        workspaceId: 'ws-1',
        baselineCommit: baseline,
        reindexBudgetMs: 50
      },
      fakeGraphDeps({ indexNeverResolves: true })
    )
    assert.ok(Date.now() - started < 5_000, 'gate must return promptly on budget overrun')
    assert.equal(gate.verdict, 'unverifiable')
    assert.equal(gate.reason, 'analysis_unavailable')
    assert.ok(gate.evidence[0].includes('budget'))
  })
})

process.on('exit', cleanup)

// Budget constant sanity — the mechanism test above relies on it being finite.
test('STRUCTURAL_REINDEX_BUDGET_MS is a finite positive budget', () => {
  assert.ok(Number.isFinite(STRUCTURAL_REINDEX_BUDGET_MS))
  assert.ok(STRUCTURAL_REINDEX_BUDGET_MS > 0)
})

summaryAsync()
