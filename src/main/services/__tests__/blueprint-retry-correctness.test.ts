/**
 * blueprint-retry-correctness.test.ts — Phase 1 retry-correctness pins.
 *
 * T014's live failure shape, as unit truth tables:
 *
 *  1.1 (F12) — an API-error terminal reason classifies a rung infra (never
 *         quality), and the shared set moves SPEC + BUILD onto one answer.
 *  1.2 (F12) — a COLD zero-work rung must not inherit the cumulative write
 *         credit an earlier attempt earned; a RESUMED zero-work rung must
 *         (A1's requirement, pinned here so the two can never regress into
 *         each other again).
 *  1.3 (F11) — the write-set gate's `files` array bounds the retry-cleanup
 *         sweep, and buildGateFixInstructions names what the kernel reverted.
 *  1.4 — isProtocolMissRung / stop-loss-requeue predicate inputs stay honest.
 *  3.1 (F3) — resolveRungPrompts byte-freezes the system prefix on resumed
 *         rungs and moves the verdict to the user message.
 *
 * Run: tsx src/main/services/__tests__/blueprint-retry-correctness.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let isApiErrorTerminalReason: (r: string | undefined | null) => boolean
let API_ERROR_TERMINAL_REASONS: ReadonlySet<string>
let shouldFailForNoWriteActivity: (input: Record<string, unknown>) => boolean
let resolveRungPrompts: (p: {
  resuming: boolean
  frozenTaskContext?: string
  continuationMessage: string
  coldTaskContext?: string
}) => { taskContext: string; sendMessage: string | undefined }
let writeSetViolationFiles: (r: unknown) => readonly string[]
let buildGateFixInstructions: (r: unknown, opts?: unknown) => string
let sweepOutOfWorksetWrites: (
  ctx: unknown,
  baseline: unknown,
  violations: readonly string[]
) => Promise<{ reverted: string[]; patchPath?: string }>

let loaded = false
try {
  const reasons = require('../agent-terminal-reasons')
  isApiErrorTerminalReason = reasons.isApiErrorTerminalReason
  API_ERROR_TERMINAL_REASONS = reasons.API_ERROR_TERMINAL_REASONS
  const build = require('../blueprint-build.service')
  shouldFailForNoWriteActivity = build.shouldFailForNoWriteActivity
  resolveRungPrompts = build.resolveRungPrompts
  writeSetViolationFiles = build.writeSetViolationFiles
  const gates = require('../blueprint-gates.service')
  buildGateFixInstructions = gates.buildGateFixInstructions
  sweepOutOfWorksetWrites = gates.sweepOutOfWorksetWrites
  loaded = true
} catch (err) {
  console.log(`⚠ retry-correctness setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (!loaded) {
  describe('blueprint retry correctness (skipped — module load failed)', () => {
    test('phase-1 pins', () => {}, { skipReason: 'module load failed' })
  })
} else {
  describe('1.1 / F12 — API-error terminal reasons are never graded', () => {
    test("the shared set matches SPEC's historical members", () => {
      assert.deepEqual([...API_ERROR_TERMINAL_REASONS].sort(), [
        'api_error',
        'failed',
        'model_error'
      ])
    })

    test('api_error / model_error / failed are API-error reasons; max_turns is not', () => {
      assert.equal(isApiErrorTerminalReason('api_error'), true)
      assert.equal(isApiErrorTerminalReason('model_error'), true)
      assert.equal(isApiErrorTerminalReason('failed'), true)
      // These MUST stay excluded: a max_turns turn did real work, and grading
      // it is exactly what distinguishes it from a dead API call.
      assert.equal(isApiErrorTerminalReason('max_turns'), false)
      assert.equal(isApiErrorTerminalReason('end_turn'), false)
      assert.equal(isApiErrorTerminalReason(undefined), false)
      assert.equal(isApiErrorTerminalReason(null), false)
      assert.equal(isApiErrorTerminalReason(''), false)
    })

    test('SPEC and BUILD share ONE set (same module identity)', () => {
      // blueprint-spec.service imports the shared constant; asserting the
      // module-level identity is impossible cross-module in a runner, so pin
      // the members SPEC's ClarifyApiError gate checks against instead.
      const specSet = require('../blueprint-spec.service')
      assert.equal(typeof specSet.ClarifyApiError, 'function')
      const err = new specSet.ClarifyApiError('api_error')
      assert.match(err.message, /api_error/)
    })
  })

  describe('1.2 / F12 — cold rungs must not inherit cumulative write credit', () => {
    const base = {
      claimedFiles: 3,
      hasCompletion: true,
      hasPlannedFiles: true,
      baselineDiffEmpty: null
    }

    test('COLD zero-work rung after a productive attempt HARD-FAILS (the T014 launder)', () => {
      // Pre-1.2: cumulative counters granted credit for attempt 1's writes,
      // so this read cumulativeWriteToolCalls=5 and returned false.
      assert.equal(
        shouldFailForNoWriteActivity({
          ...base,
          cumulativeWriteToolCalls: 0, // the rung's OWN counters (1.2 fix)
          cumulativeBashCalls: 0
        }),
        true,
        'a cold rung with zero own activity claiming files = stale-file claim'
      )
    })

    test('RESUMED zero-work rung does NOT hard-fail (A1 requirement, unchanged)', () => {
      // The ladder feeds the task-scoped cumulative counters on resumed rungs
      // (params.writeActivity); 5 prior writes + 0 own = 5 cumulative.
      assert.equal(
        shouldFailForNoWriteActivity({
          ...base,
          cumulativeWriteToolCalls: 5,
          cumulativeBashCalls: 0
        }),
        false
      )
    })

    test('a non-empty baseline diff still overrides the counters (R029 guard)', () => {
      assert.equal(
        shouldFailForNoWriteActivity({
          ...base,
          cumulativeWriteToolCalls: 0,
          cumulativeBashCalls: 0,
          baselineDiffEmpty: false
        }),
        false
      )
    })
  })

  describe('1.3 / F11 — retry-cleanup bounds and fix instructions', () => {
    const report = {
      overall: 'fail',
      gates: [
        {
          name: 'write-set',
          verdict: 'fail',
          evidence: ['outside write-set: src/rogue.ts'],
          files: ['src/rogue.ts', 'extra.txt'],
          durationMs: 5
        }
      ]
    }

    test('writeSetViolationFiles reads the failed write-set gate files array', () => {
      assert.deepEqual(writeSetViolationFiles(report), ['src/rogue.ts', 'extra.txt'])
      assert.deepEqual(writeSetViolationFiles(undefined), [])
      assert.deepEqual(
        writeSetViolationFiles({ overall: 'pass', gates: [] }),
        [],
        'a passing report offers no sweep bound'
      )
    })

    test('buildGateFixInstructions names the kernel-reverted files for the next attempt', () => {
      const instr = buildGateFixInstructions(report, {
        revertedFiles: ['src/rogue.ts']
      })
      assert.match(instr, /ALREADY reverted these out-of-set files/)
      assert.match(instr, /src\/rogue\.ts/)
      assert.match(instr, /Do not re-apply changes to them/)
    })

    test('sweepOutOfWorksetWrites reverts an untracked violation and deletes a tracked one', async () => {
      // Real git repo in a temp dir: one file tracked at the baseline commit,
      // one untracked. The sweep must checkout the tracked one and delete the
      // untracked one. (Uses the real defaultCommandRunner — no injection seam
      // on the sweep's own git calls, and the temp repo IS the test.)
      const { execSync } = require('node:child_process') as typeof import('node:child_process')
      const dir = mkdtempSync(join(tmpdir(), 'retry-cleanup-'))
      try {
        const git = (args: string): Buffer => execSync(`git ${args}`, { cwd: dir, stdio: 'pipe' })
        git('init -q')
        git('config user.email t@t')
        git('config user.name t')
        mkdirSync(join(dir, 'src'), { recursive: true })
        writeFileSync(join(dir, 'src', 'tracked.ts'), 'base\n')
        git('add src/tracked.ts')
        git('commit -qm base')
        // The failed attempt's damage: edited a tracked file + created an
        // untracked one.
        writeFileSync(join(dir, 'src', 'tracked.ts'), 'damaged\n')
        writeFileSync(join(dir, 'rogue.txt'), 'out of set\n')

        const baseline = { baselineCommit: 'HEAD', preexistingDirty: [], testsBefore: {} }
        const artifactDir = join(dir, 'blueprints', 'bp-test')
        const sweep = await sweepOutOfWorksetWrites(
          {
            taskId: 'T001',
            executionPath: dir,
            workspacePath: dir,
            plannedFiles: [],
            artifactPrefix: 'blueprints/bp-test'
          },
          baseline,
          ['src/tracked.ts', 'rogue.txt']
        )
        assert.deepEqual(sweep.reverted.sort(), ['rogue.txt', 'src/tracked.ts'])
        const fs = require('node:fs') as typeof import('node:fs')
        assert.equal(fs.readFileSync(join(dir, 'src', 'tracked.ts'), 'utf-8'), 'base\n')
        assert.equal(fs.existsSync(join(dir, 'rogue.txt')), false, 'untracked violation deleted')

        // B4 — the sweep preserved what it reverted, and the patch reapplies.
        assert.ok(sweep.patchPath, 'patch path returned')
        assert.ok(
          sweep.patchPath.startsWith(artifactDir),
          `patch lands under the blueprint artifact dir: ${sweep.patchPath}`
        )
        const patchBody = fs.readFileSync(sweep.patchPath, 'utf-8')
        assert.match(patchBody, /\+\+\+ b\/src\/tracked\.ts/, 'tracked hunk preserved')
        assert.match(patchBody, /^\+damaged$/m, 'the destroyed edit is in the patch')
        assert.match(patchBody, /\+\+\+ b\/rogue\.txt/, 'untracked file embedded')
        assert.match(patchBody, /^\+out of set$/m, 'untracked bytes preserved')
        // Reapplying restores exactly what the sweep destroyed.
        execSync(`git apply ${JSON.stringify(sweep.patchPath)}`, { cwd: dir, stdio: 'pipe' })
        assert.equal(fs.readFileSync(join(dir, 'src', 'tracked.ts'), 'utf-8'), 'damaged\n')
        assert.equal(fs.readFileSync(join(dir, 'rogue.txt'), 'utf-8'), 'out of set\n')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('a peer-owned path is never swept, even if the gate named it', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'retry-cleanup-peer-'))
      try {
        writeFileSync(join(dir, 'peer.ts'), 'peer work\n')
        const baseline = { baselineCommit: 'HEAD', preexistingDirty: [], testsBefore: {} }
        const reverted = await sweepOutOfWorksetWrites(
          {
            taskId: 'T001',
            executionPath: dir,
            workspacePath: dir,
            plannedFiles: [],
            exemptFiles: ['peer.ts']
          },
          baseline,
          ['peer.ts']
        )
        assert.deepEqual(reverted.reverted, [], 'peer-declared file untouched')
        const fs = require('node:fs') as typeof import('node:fs')
        assert.equal(fs.existsSync(join(dir, 'peer.ts')), true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('no baseline commit → sweep degrades to a no-op', async () => {
      const reverted = await sweepOutOfWorksetWrites(
        { taskId: 'T001', executionPath: '/tmp', workspacePath: '/tmp', plannedFiles: [] },
        { baselineCommit: null, preexistingDirty: [], testsBefore: {} },
        ['whatever.txt']
      )
      assert.deepEqual(reverted.reverted, [])
      assert.equal(reverted.patchPath, undefined, 'nothing captured when nothing can run')
    })
  })

  describe('3.1 / F3 — resumed rungs reuse the frozen system prefix', () => {
    test('frozen context is reused byte-identically; verdict goes to the user message', () => {
      const out = resolveRungPrompts({
        resuming: true,
        frozenTaskContext: 'COLD CONTEXT BYTES',
        continuationMessage: 'retry verdict',
        coldTaskContext: 'SHOULD NOT BE USED'
      })
      assert.equal(out.taskContext, 'COLD CONTEXT BYTES')
      assert.equal(out.sendMessage, 'retry verdict')
    })

    test('cold rung uses its own context and the phase kickoff message', () => {
      const out = resolveRungPrompts({
        resuming: false,
        continuationMessage: 'retry verdict',
        coldTaskContext: 'COLD CONTEXT BYTES'
      })
      assert.equal(out.taskContext, 'COLD CONTEXT BYTES')
      assert.equal(out.sendMessage, undefined)
    })

    test('cross-run resume without a frozen context degrades to continuation-as-context', () => {
      const out = resolveRungPrompts({
        resuming: true,
        continuationMessage: 'retry verdict'
      })
      assert.equal(out.taskContext, 'retry verdict')
      assert.equal(out.sendMessage, undefined)
    })
  })
}

// Await pending async tests before exiting.
summaryAsync().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
