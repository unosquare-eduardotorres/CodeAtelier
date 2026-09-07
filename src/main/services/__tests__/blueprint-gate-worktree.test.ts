/**
 * B2 — gate the worktree on demand.
 *
 * The affordance that would have caught both W16 cascade bugs before they
 * landed: a manual "Run gates now" that exercises the same wave command gates
 * (lint/build/full-suite) against the blueprint's execution tree between
 * waves. These tests pin the service method the IPC handler calls:
 *   - green tree → pass
 *   - red suite → fail
 *   - missing command → unverifiable/command_missing
 *   - lock contention serialises against a live wave gate
 *   - the report is persisted as a `wave-gates` artifact with wave 'MANUAL'
 *
 * Run: tsx src/main/services/__tests__/blueprint-gate-worktree.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import { runWaveCommandGates, type CommandRunner, type GateTaskContext } from '../blueprint-gates.service'

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintPhaseRepository: any
let blueprintBuildService: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
  blueprintBuildService = require('../blueprint-build.service').blueprintBuildService
} catch (err) {
  console.log(`⚠ gate-worktree setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

const tempDirs: string[] = []
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-worktree-'))
  tempDirs.push(dir)
  return dir
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

/** A runner that answers every command from a scripted table. */
function scriptedRunner(
  script: Record<string, { exitCode: number; output: string[] }>
): CommandRunner {
  return async (command) => {
    const entry = script[command]
    if (!entry) {
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    return { exitCode: entry.exitCode, output: entry.output, timedOut: false, durationMs: 1 }
  }
}

function gateCtx(runner: CommandRunner, testCommand: string): GateTaskContext {
  return {
    blueprintId: 'bp-1',
    taskId: 'MANUAL',
    workspacePath: '/repo',
    executionPath: '/repo',
    plannedFiles: [],
    packet: null,
    commands: {
      // All three wave commands: a manual run grades the whole tree, exactly
      // like a wave run, and the overall verdict aggregates over all of them.
      lint: { command: 'npm run lint', provenance: 'detected' },
      build: { command: 'npm run build', provenance: 'detected' },
      test: { command: testCommand, provenance: 'detected' }
    },
    runner
  }
}

// ── Command-level behaviour via the same engine a manual run uses ──

describe('B2 — runWaveCommandGates with taskId MANUAL (the manual-run engine)', () => {
  test('green tree → pass', async () => {
    const report = await runWaveCommandGates(
      gateCtx(
        scriptedRunner({
          'npm run test': { exitCode: 0, output: ['10 passed'] }
        }),
        'npm run test'
      )
    )
    const fullSuite = report.gates.find((g) => g.name === 'full-suite')
    assert.equal(fullSuite?.verdict, 'pass')
    assert.equal(report.overall, 'pass')
  })

  test('red suite → fail', async () => {
    const report = await runWaveCommandGates(
      gateCtx(
        scriptedRunner({
          'npm run test': {
            exitCode: 1,
            output: ['FAILED test/foo.test.ts > bar', '1 failed, 9 passed']
          }
        }),
        'npm run test'
      )
    )
    const fullSuite = report.gates.find((g) => g.name === 'full-suite')
    assert.equal(fullSuite?.verdict, 'fail', 'a red suite is never softened')
    assert.equal(report.overall, 'fail')
  })

  test('missing command → unverifiable/command_missing, not fail', async () => {
    const report = await runWaveCommandGates(
      gateCtx(
        scriptedRunner({
          pytest: {
            exitCode: 1,
            output: ["'pytest' is not recognized as an internal or external command"]
          }
        }),
        'pytest'
      )
    )
    const fullSuite = report.gates.find((g) => g.name === 'full-suite')
    assert.equal(fullSuite?.verdict, 'unverifiable')
    assert.equal(fullSuite?.reason, 'command_missing')
    assert.equal(report.overall, 'unverifiable', 'environmental — never fails the run')
  })

  test('lock contention serialises a manual run behind a live wave gate', async () => {
    // Two runs against the same executionPath. The first holds the worktree
    // lock; the second must queue, not interleave. We detect interleaving by
    // having the first runner block until the second HAS NOT started.
    const order: string[] = []
    let releaseFirst: (() => void) | null = null
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r
    })
    const release = (): void => {
      releaseFirst?.()
    }

    const slowRunner: CommandRunner = async () => {
      order.push('first:start')
      await firstGate
      order.push('first:end')
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    const spyRunner: CommandRunner = async () => {
      order.push('second:start')
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }

    const dir = '/shared-tree'
    const run1 = runWaveCommandGates({
      ...gateCtx(slowRunner, 'npm run test'),
      executionPath: dir
    })
    const run2 = runWaveCommandGates({
      ...gateCtx(spyRunner, 'npm run test'),
      executionPath: dir
    })
    // Give run2 a chance to (wrongly) start while run1 holds the lock.
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(order.filter((s) => s === 'second:start').length, 0,
      'the second run must not start while the first holds the worktree lock')
    release()
    await Promise.all([run1, run2])
    assert.ok(order.includes('second:start'), 'the queued run starts after the lock releases')
    assert.ok(order.indexOf('first:end') < order.indexOf('second:start'),
      'the first run completes before the second begins')
  })
})

// ── Service-level: persistence + wiring of the public method ──

if (!env) {
  describe('B2 — gateWorktreeOnDemand (skipped — no DB)', () => {
    test('manual run persisted as wave-gates artifact', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  const serviceIsLive = (() => {
    try {
      const probe = blueprintRepository.create({ workspaceId: wsId, title: 'liveness probe' })
      const blueprintService = require('../blueprint.service').blueprintService
      return blueprintService.getBlueprint(probe.id)?.id === probe.id
    } catch {
      return false
    }
  })()

  if (!serviceIsLive) {
    describe('B2 — gateWorktreeOnDemand (skipped — service mock-bound)', () => {
      test('manual run persisted as wave-gates artifact', () => {}, {
        skipReason: 'blueprintBuildService singleton is mock-bound in this process'
      })
    })
  } else {
    describe('B2 — gateWorktreeOnDemand persists a MANUAL wave-gates artifact', () => {
      test('an empty repo dir → unverifiable report persisted with wave MANUAL', async () => {
        const dir = makeDir() // no commands resolve → no spawns, all no_command
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Gate worktree' })
        blueprintPhaseRepository.createAllPhases(bp.id)

        const report = await blueprintBuildService.gateWorktreeOnDemand({
          blueprintId: bp.id,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(report.overall, 'unverifiable', 'no commands resolved in an empty dir')

        const rec = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'build')
        const artifact = rec?.artifactsJson?.findLast(
          (a: any) => a.type === 'wave-gates' && a.contentJson?.wave === 'MANUAL'
        )
        assert.ok(artifact, 'a MANUAL wave-gates artifact is persisted')
        assert.equal(artifact.contentJson.report.overall, report.overall)
        assert.ok(
          Array.isArray(artifact.contentJson.report.gates) &&
            artifact.contentJson.report.gates.length > 0,
          'the full gate report is embedded'
        )
      })

      test('a manual run does not touch the ledger or task state', async () => {
        const dir = makeDir()
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Gate worktree ledger' })
        blueprintPhaseRepository.createAllPhases(bp.id)

        await blueprintBuildService.gateWorktreeOnDemand({
          blueprintId: bp.id,
          workspaceId: wsId,
          workspacePath: dir
        })

        const after = blueprintRepository.findById(bp.id)
        const ledger = (after?.settingsJson as Record<string, unknown>)?.unverifiedItems
        assert.equal(ledger, undefined, 'a manual run is a probe, not a grading event')
      })
    })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
