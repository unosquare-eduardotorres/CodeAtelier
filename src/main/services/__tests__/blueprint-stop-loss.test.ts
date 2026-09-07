/**
 * T003 fix — deterministic stop-loss exclusion from retryPhase resets.
 *
 * The B3 stop-loss means "the identical experiment already ran and failed":
 * identical gate fingerprint across attempts. Resetting such a task re-runs
 * the identical ladder for a verdict nothing in the code can change. These
 * tests pin the exclusion predicate AND its two lift conditions (changed
 * command; belt-and-braces attempts cap).
 *
 * The pipeline integration section (G1) drives the REAL retryPhase against a
 * temp workspace whose PLAN artifact declares a relative venv token: the
 * ladder writes the stop-loss suffix from the pipeline-rewritten command, and
 * retryPhase must resolve the SAME rewritten string or the exclusion lifts
 * and the identical experiment re-runs (the T003 loop).
 *
 * Run: tsx src/main/services/__tests__/blueprint-stop-loss.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

import {
  isDeterministicStopLoss,
  parseStopLossCommand,
  formatStopLossCommandSuffix,
  STOP_LOSS_REASON_RE,
  STOP_LOSS_EXCLUSION_ATTEMPT_CAP
} from '../blueprint-stop-loss'

/** The exact reason shape the B3 stop-loss writes (post-fix, with command suffix). */
const STOP_LOSS_REASON =
  'quality gate failed after escalation: task-tests, build — stop-loss after 2 identical ' +
  'gate failure(s) (task-tests) — skipped 1 builder attempt(s), escalated to ' +
  'blueprint:lead-review (command: multiplexer/.venv-mux/Scripts/python.exe -m unittest)'

describe('STOP_LOSS_REASON_RE — the wording contract with the B3 write site', () => {
  test('matches the current write-site wording', () => {
    assert.ok(STOP_LOSS_REASON_RE.test(STOP_LOSS_REASON))
  })
  test('matches case-insensitively and any count', () => {
    assert.ok(
      /stop-loss after \d+ identical gate failure/i.test(
        'Stop-Loss After 5 identical gate failure(s)'
      )
    )
  })
  test('does NOT match ordinary quality-gate failures', () => {
    assert.ok(!STOP_LOSS_REASON_RE.test('quality gate failed after escalation: task-tests'))
    assert.ok(!STOP_LOSS_REASON_RE.test('api terminal error: overload'))
    assert.ok(!STOP_LOSS_REASON_RE.test('blocked_by_scope: needs src/x.ts'))
  })
})

describe('command suffix round-trip', () => {
  test('format → parse round-trips a paren-free command', () => {
    const cmd = 'multiplexer/.venv-mux/Scripts/python.exe -m unittest discover -s tests'
    const reason = STOP_LOSS_REASON.replace(
      '(command: multiplexer/.venv-mux/Scripts/python.exe -m unittest)',
      formatStopLossCommandSuffix(cmd)
    )
    assert.equal(parseStopLossCommand(reason), cmd)
  })
  test('older rows without a suffix parse to null', () => {
    assert.equal(
      parseStopLossCommand('stop-loss after 3 identical gate failure(s) (task-tests)'),
      null
    )
  })
})

describe('isDeterministicStopLoss — the retryPhase exclusion predicate', () => {
  test('stop-loss + identical current command → EXCLUDED (the T003 loop)', () => {
    const recorded = parseStopLossCommand(STOP_LOSS_REASON)!
    assert.equal(isDeterministicStopLoss(STOP_LOSS_REASON, 3, recorded), true)
  })

  test('stop-loss + CHANGED current command → NOT excluded (new experiment)', () => {
    assert.equal(
      isDeterministicStopLoss(
        STOP_LOSS_REASON,
        3,
        'uv run pytest tests/' // operator override or PLAN re-declaration
      ),
      false
    )
  })

  test('stop-loss + no current command resolvable → excluded (conservative)', () => {
    assert.equal(isDeterministicStopLoss(STOP_LOSS_REASON, 3, null), true)
  })

  test('older stop-loss row (no recorded command) → excluded (plain fallback)', () => {
    const legacy =
      'quality gate failed after escalation: task-tests — stop-loss after 2 identical gate failure(s) (task-tests) — skipped 1 builder attempt(s)'
    assert.equal(isDeterministicStopLoss(legacy, 3, 'pytest'), true)
  })

  test('NON-stop-loss failure → still reset (the ordinary retry path is intact)', () => {
    assert.equal(
      isDeterministicStopLoss('quality gate failed after escalation: task-tests', 3, 'pytest'),
      false
    )
    assert.equal(isDeterministicStopLoss('api terminal error: overload', 1, null), false)
  })

  test('belt-and-braces: attempts >= cap excludes even without matching wording', () => {
    assert.equal(
      isDeterministicStopLoss('some future wording drift', STOP_LOSS_EXCLUSION_ATTEMPT_CAP, 'x'),
      true
    )
    assert.equal(
      isDeterministicStopLoss(
        'some future wording drift',
        STOP_LOSS_EXCLUSION_ATTEMPT_CAP - 1,
        'x'
      ),
      false
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// G1+G7 — the shared pipeline integration. retryPhase's stop-loss comparison
// and the verify service's quality-gates resolution both consume
// `resolveBlueprintGateCommands`; the ladder's write site records the command
// the same pipeline produced. These drive the REAL modules against a temp
// workspace whose PLAN declares a relative venv token.
// ═══════════════════════════════════════════════════════════════════════

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintPhaseRepository: any
let blueprintTaskRepository: any
let blueprintTelemetryRepository: any
let blueprintService: any
let workspaceRepository: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
  blueprintTaskRepository = repos.blueprintTaskRepository
  blueprintTelemetryRepository =
    require('../../db/repositories/blueprint-telemetry.repository').blueprintTelemetryRepository
  blueprintService = require('../blueprint.service').blueprintService
  workspaceRepository = require('../../db/repositories/workspace.repository').workspaceRepository
} catch (err) {
  console.log(`⚠ stop-loss pipeline setup failed — integration tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (env) {
  const GIT_AVAILABLE = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  /**
   * A temp workspace whose PLAN artifact declares a RELATIVE venv test token,
   * with the venv present in the workspace root. Returns everything the
   * pipeline needs plus the rewritten command it must produce.
   */
  function seedVenvDeclaredWorkspace(): {
    blueprintId: string
    taskId: string
    workspacePath: string
    rewrittenCommand: string
    declaredCommand: string
  } {
    const workspacePath = mkdtempSync(join(tmpdir(), 'stop-loss-pipeline-'))
    // The venv the rewrite must rebind to — gitignored in real repos, present
    // in the SOURCE checkout.
    const venvRel = join('multiplexer', '.venv-mux', 'Scripts', 'python.exe')
    mkdirSync(join(workspacePath, venvRel, '..'), { recursive: true })
    writeFileSync(join(workspacePath, venvRel), '#!/bin/sh\n# stub interpreter\n')

    // The workspace ROW the blueprint points at must carry THIS repoPath —
    // retryPhase resolves the pipeline from `workspace.repoPath`.
    const ws = workspaceRepository.create('Stop-loss pipeline ws ' + Date.now(), workspacePath)

    const declaredCommand = `${venvRel.split(/[\\/]/).join('/')} -m unittest discover -s tests`
    const bp = blueprintRepository.create({
      workspaceId: ws.id,
      title: 'Stop-loss pipeline'
    })
    blueprintPhaseRepository.createAllPhases(bp.id)
    const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'plan')
    blueprintPhaseRepository.appendArtifact(planPhase.id, {
      type: 'plan',
      contentMd:
        '# Plan\n\n```gate-commands\n' +
        JSON.stringify({ test: declaredCommand }, null, 2) +
        '\n```\n'
    })

    const task = blueprintTaskRepository.create({
      blueprintId: bp.id,
      taskId: 'T001',
      wave: 1,
      description: 'Venv task',
      filePathsJson: ['src/a.ts']
    })
    blueprintTaskRepository.updateStatus(task.id, 'failed')
    const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'build')
    blueprintPhaseRepository.updateStatus(buildPhase.id, 'failed')
    blueprintRepository.update(bp.id, { currentPhase: 'build', status: 'failed' })

    return {
      blueprintId: bp.id,
      taskId: task.id,
      workspacePath,
      declaredCommand,
      rewrittenCommand: `${join(workspacePath, venvRel)} -m unittest discover -s tests`
    }
  }

  function withStubbedMachine<T>(fn: () => T): T {
    const original = blueprintService.getMachine
    blueprintService.getMachine = (): unknown => ({
      isTerminal: () => true,
      isIdle: () => true,
      isRunning: () => false,
      transition: () => {},
      forceReset: () => {}
    })
    try {
      return fn()
    } finally {
      blueprintService.getMachine = original
    }
  }

  describe('G7 — resolveBlueprintGateCommands applies the venv rewrite to a PLAN declaration', () => {
    test(
      'declared relative venv token → rewritten to the absolute source path (verify consumes this)',
      () => {
        const seed = seedVenvDeclaredWorkspace()
        try {
          const { resolveBlueprintGateCommands } =
            require('../blueprint-gate-command-pipeline') as {
              resolveBlueprintGateCommands: (
                blueprintId: string,
                workspacePath: string,
                opts?: { scanRoot?: string }
              ) => { commands: { test?: { command: string; provenance: string } } }
            }
          // Same call the verify service makes (scanRoot = executionPath); the
          // execution tree is a second temp dir WITHOUT the venv — exactly the
          // worktree situation the rewrite exists for.
          const executionTree = mkdtempSync(join(tmpdir(), 'stop-loss-exec-'))
          try {
            const { commands } = resolveBlueprintGateCommands(
              seed.blueprintId,
              seed.workspacePath,
              { scanRoot: executionTree }
            )
            assert.equal(commands.test?.provenance, 'declared')
            assert.equal(
              commands.test?.command,
              seed.rewrittenCommand,
              'verify-phase resolution must grade the REWRITTEN command — before G7 it ran the raw relative token and failed environmentally'
            )
          } finally {
            rmSync(executionTree, { recursive: true, force: true })
          }
        } finally {
          rmSync(seed.workspacePath, { recursive: true, force: true })
        }
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )
  })

  describe('G1 — retryPhase stop-loss exclusion holds across the shared pipeline', () => {
    test(
      'stop-loss recorded on the REWRITTEN command → retryPhase resolves the SAME string → exclusion holds',
      () => {
        const seed = seedVenvDeclaredWorkspace()
        try {
          // The WRITE site: the ladder records `gateCtx.commands.test.command`,
          // which came through the same pipeline — i.e. the REWRITTEN string.
          const reason =
            'quality gate failed after escalation: task-tests — stop-loss after 2 identical ' +
            'gate failure(s) (task-tests) — skipped 1 builder attempt(s), escalated to ' +
            'blueprint:lead-review' +
            formatStopLossCommandSuffix(seed.rewrittenCommand)
          blueprintTaskRepository.setOutcome(seed.taskId, {
            failureReason: reason,
            outcomeKind: null
          })
          blueprintTaskRepository.recordAttempt(seed.taskId)
          blueprintTaskRepository.recordAttempt(seed.taskId)

          withStubbedMachine(() => blueprintService.retryPhase(seed.blueprintId))

          const after = blueprintTaskRepository.findById(seed.taskId)
          assert.equal(
            after.status,
            'failed',
            'byte-identical pipeline resolution must keep the exclusion — a local un-rewritten comparison lifted it before G1'
          )
          assert.ok(after.failureReason?.includes('stop-loss'), 'the reason survives for the UI')

          // Fix 6 observability: the exclusion is recorded with BOTH commands.
          const rows = blueprintTelemetryRepository
            .findByBlueprint(seed.blueprintId)
            .filter((r: any) => r.kind === 'stop_loss_exclusion')
          assert.equal(rows.length, 1, 'one telemetry row per excluded task')
          const data = rows[0].dataJson ?? rows[0].data
          assert.equal(data.recordedCommand, seed.rewrittenCommand)
          assert.equal(
            data.currentCommand,
            seed.rewrittenCommand,
            'retryPhase resolves through the same pipeline as the write site'
          )
        } finally {
          rmSync(seed.workspacePath, { recursive: true, force: true })
        }
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )

    test(
      'the ladder-rewrite equivalence: a stop-loss recorded on the RAW declared token is lifted (new experiment)',
      () => {
        const seed = seedVenvDeclaredWorkspace()
        try {
          // The pre-G1 world: the write site recorded the raw declared token
          // (no pipeline). The pipeline now resolves differently — that IS a
          // changed command, and the exclusion must lift so the task re-runs
          // against the now-rewritten (working) command.
          const legacyReason =
            'quality gate failed after escalation: task-tests — stop-loss after 2 identical ' +
            'gate failure(s) (task-tests) — skipped 1 builder attempt(s), escalated to ' +
            'blueprint:lead-review' +
            formatStopLossCommandSuffix(seed.declaredCommand)
          blueprintTaskRepository.setOutcome(seed.taskId, {
            failureReason: legacyReason,
            outcomeKind: null
          })
          blueprintTaskRepository.recordAttempt(seed.taskId)
          blueprintTaskRepository.recordAttempt(seed.taskId)

          withStubbedMachine(() => blueprintService.retryPhase(seed.blueprintId))

          const after = blueprintTaskRepository.findById(seed.taskId)
          assert.equal(
            after.status,
            'pending',
            'a recorded command that differs from the current resolution is a new experiment — the task retries'
          )
        } finally {
          rmSync(seed.workspacePath, { recursive: true, force: true })
        }
      },
      { skipReason: GIT_AVAILABLE ? undefined : 'git not available' }
    )
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
