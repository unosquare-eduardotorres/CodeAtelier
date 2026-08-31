/**
 * Regression guard for the Windows blueprint remediation loop.
 *
 * The verify service used to collapse Node's *string* spawn-failure codes
 * (ENOENT/EACCES/...) into `exitCode: 1`, so an unspawnable `npx.cmd` on Windows
 * looked identical to a failing typecheck with no error output. That forced
 * `gaps_found`, which manufactured an empty remediation task, which rebuilt and
 * re-failed — forever.
 *
 * M8.2/M8.3 moved verify onto the gate engine (`runVerifyGates`), where the
 * same invariant lives in `gateCommand`: a spawn failure is
 * `unverifiable`/`command_error` (ledger, never fail) and a genuine non-zero
 * exit is `fail` with the real exit code preserved.
 *
 * These tests pin the behaviours that break the loop:
 *   1. spawn failure → `unverifiable`/`command_error`, never `fail`
 *   2. genuine non-zero exit → `fail` with the real exit code in evidence
 *   3. an empty-bodied quality-gate finding never becomes a remediation task
 */
import assert from 'node:assert/strict'
import { describe, test } from './test-harness'
import { setupFullMock } from './setup-full-mock'

setupFullMock()

const mod = require('../blueprint-verify.service')
const { BlueprintVerifyService } = mod
const gates = require('../blueprint-gates.service') as typeof import('../blueprint-gates.service')
const { runVerifyGates } = gates

const svc = new BlueprintVerifyService() as unknown as {
  generateFallbackRemediationTasks: (
    completion: Record<string, unknown> | null,
    text: string,
    blueprintId: string
  ) => Array<{ taskId: string; description: string; files: string[] }>
}

/** A runner that answers every command from a scripted table (no real spawn). */
function scriptedRunner(
  script: Record<string, { exitCode?: number; output?: string[]; spawnError?: string }>
): Parameters<typeof runVerifyGates>[0]['runner'] {
  return async (command) => {
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
      timedOut: false,
      ...(entry.spawnError ? { spawnError: entry.spawnError } : {}),
      durationMs: 1
    }
  }
}

function verifyCtx(
  runner: Parameters<typeof runVerifyGates>[0]['runner'],
  commands: Parameters<typeof runVerifyGates>[0]['commands']
): Parameters<typeof runVerifyGates>[0] {
  return {
    blueprintId: 'bp-launch',
    taskId: 'verify',
    workspacePath: process.cwd(),
    executionPath: process.cwd(),
    plannedFiles: [],
    packet: null,
    commands,
    runner
  }
}

describe('verify gate launch classification (engine)', () => {
  test('unspawnable command ⇒ unverifiable/command_error, never fail', async () => {
    const report = await runVerifyGates(
      verifyCtx(
        scriptedRunner({
          'run-suite': { spawnError: 'spawn npx.cmd ENOENT' }
        }),
        { test: { command: 'run-suite', provenance: 'detected' } }
      )
    )
    const gate = report.gates.find((g) => g.name === 'full-suite')!
    assert.equal(gate.verdict, 'unverifiable', 'spawn failure must not be reported as a gate run')
    assert.equal(gate.reason, 'command_error')
    assert.notEqual(report.overall, 'fail')
  })

  test('genuine non-zero exit ⇒ fail with the real exit code preserved', async () => {
    const report = await runVerifyGates(
      verifyCtx(
        scriptedRunner({
          'run-suite': { exitCode: 2, output: ['1 failing'] }
        }),
        { test: { command: 'run-suite', provenance: 'detected' } }
      )
    )
    const gate = report.gates.find((g) => g.name === 'full-suite')!
    assert.equal(gate.verdict, 'fail')
    assert.ok(
      gate.evidence.some((e) => e.includes('exited 2')),
      'numeric exit code must be preserved, not collapsed to 1'
    )
  })

  test('successful command ⇒ pass', async () => {
    const report = await runVerifyGates(
      verifyCtx(
        scriptedRunner({
          'run-suite': { exitCode: 0, output: ['ok'] }
        }),
        { test: { command: 'run-suite', provenance: 'detected' } }
      )
    )
    const gate = report.gates.find((g) => g.name === 'full-suite')!
    assert.equal(gate.verdict, 'pass')
  })
})

describe('generateFallbackRemediationTasks — empty-bodied gate findings', () => {
  test('drops a quality-gate finding with no error text after the exit marker', () => {
    const tasks = svc.generateFallbackRemediationTasks(
      {
        findings: [
          {
            source: 'deterministic-quality-gate',
            severity: 'error',
            gate: 'tsc',
            description: 'TypeScript typecheck failed (exit 1): '
          }
        ]
      },
      '',
      'bp-test'
    )
    assert.equal(tasks.length, 0, 'an unactionable empty gate finding must not spawn a task')
  })

  test('keeps a quality-gate finding that carries real error output', () => {
    const tasks = svc.generateFallbackRemediationTasks(
      {
        findings: [
          {
            source: 'deterministic-quality-gate',
            severity: 'error',
            gate: 'tsc',
            description:
              'TypeScript typecheck failed (exit 2): \nsrc/App.tsx(83,7): error TS2345: bad arg'
          }
        ]
      },
      '',
      'bp-test'
    )
    assert.equal(tasks.length, 1)
    assert.ok(tasks[0].description.includes('TS2345'))
    assert.deepEqual(tasks[0].files, ['src/App.tsx'])
  })

  // ── REMEDIATION-SCRAPE FILTER (R005 incident, blueprint 718c wave 7) ──
  // The verify report cites the blueprint's own metadata files when describing
  // what was checked; the Strategy-2 regex turned `tasks.md` into a "create
  // tasks.md" build task that failed verification on every retry.

  test('Strategy 2 does not scrape blueprint metadata (tasks.md) into a task', () => {
    const text = [
      '## Verification report',
      'Checked plan against blueprints/abc/tasks.md and spec.md.',
      'MISSING — `tasks.md`',
      'MISSING — `src/feature/repo.ts`'
    ].join('\n')
    const tasks = svc.generateFallbackRemediationTasks(null, text, 'bp-test')
    assert.equal(tasks.length, 1, 'only the real code path may become a task')
    assert.deepEqual(tasks[0].files, ['src/feature/repo.ts'])
  })

  test('Strategy 2 filters plan/spec/build/verify/review markdown metadata', () => {
    const text = [
      'STUB — `plan.md`',
      'ORPHANED — `build-3.md`',
      'MISSING — `spec.md`',
      'MISSING — `verify.md`',
      'MISSING — `review.md`',
      'MISSING — `apps/web/src/lib/x.ts`'
    ].join('\n')
    const tasks = svc.generateFallbackRemediationTasks(null, text, 'bp-test')
    assert.equal(tasks.length, 1)
    assert.deepEqual(tasks[0].files, ['apps/web/src/lib/x.ts'])
  })

  test('a real code file named tasks.ts is NOT filtered', () => {
    const text = 'MISSING — `src/tasks.ts`'
    const tasks = svc.generateFallbackRemediationTasks(null, text, 'bp-test')
    assert.equal(tasks.length, 1)
    assert.deepEqual(tasks[0].files, ['src/tasks.ts'])
  })
})
