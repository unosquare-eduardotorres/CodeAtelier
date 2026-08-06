/**
 * Regression guard for the Windows blueprint remediation loop.
 *
 * `execGateCommand` used to collapse Node's *string* spawn-failure codes
 * (ENOENT/EACCES/...) into `exitCode: 1`, so an unspawnable `npx.cmd` on Windows
 * looked identical to a failing typecheck with no error output. That forced
 * `gaps_found`, which manufactured an empty remediation task, which rebuilt and
 * re-failed — forever.
 *
 * These tests pin the two behaviours that break the loop:
 *   1. spawn failure → `launched: false` (gate skipped, no finding)
 *   2. genuine non-zero exit → `launched: true` with the real exit code
 *   3. an empty-bodied quality-gate finding never becomes a remediation task
 */
import assert from 'node:assert/strict'
import { describe, test } from './test-harness'
import { setupFullMock } from './setup-full-mock'

setupFullMock()

const mod = require('../blueprint-verify.service')
const { BlueprintVerifyService } = mod

type GateResult = { exitCode: number; output: string; launched: boolean }

const svc = new BlueprintVerifyService() as unknown as {
  execGateCommand: (
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ) => Promise<GateResult>
  generateFallbackRemediationTasks: (
    completion: Record<string, unknown> | null,
    text: string,
    blueprintId: string
  ) => Array<{ taskId: string; description: string; files: string[] }>
}

// On win32 the gate runs through `shell: true`, so a missing binary surfaces as
// a cmd.exe exit code with output rather than a spawn-level ENOENT, and args are
// passed unquoted. Both make these process-level assertions platform-specific.
const isWin = process.platform === 'win32'
const winSkip = isWin ? { skipReason: 'shell:true changes spawn semantics on win32' } : undefined

describe('execGateCommand — launch classification', () => {
  test(
    'unspawnable command reports launched:false (not a failing gate)',
    async () => {
      const res = await svc.execGateCommand(
        'definitely-not-a-real-binary-xyz',
        ['--version'],
        process.cwd(),
        10_000
      )
      assert.equal(res.launched, false, 'spawn failure must not be reported as a gate run')
      assert.equal(res.exitCode, 1)
    },
    winSkip
  )

  test(
    'genuine non-zero exit reports launched:true with the real exit code',
    async () => {
      const res = await svc.execGateCommand(
        process.execPath,
        ['-e', 'process.exit(2)'],
        process.cwd(),
        10_000
      )
      assert.equal(res.launched, true)
      assert.equal(res.exitCode, 2, 'numeric exit code must be preserved, not collapsed to 1')
    },
    winSkip
  )

  test(
    'successful command reports launched:true with exit code 0',
    async () => {
      const res = await svc.execGateCommand(
        process.execPath,
        ['-e', 'process.stdout.write("ok")'],
        process.cwd(),
        10_000
      )
      assert.equal(res.launched, true)
      assert.equal(res.exitCode, 0)
      assert.ok(res.output.includes('ok'))
    },
    winSkip
  )
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
})
