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

import {
  runE2EGate,
  runVerifyGates,
  runWaveCommandGates,
  type CommandRunner,
  type GateTaskContext
} from '../blueprint-gates.service'

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

  test('the wave gates never run the e2e suite — 45min per wave would dominate the run', async () => {
    const report = await runWaveCommandGates({
      ...gateCtx(scriptedRunner({}), 'npm run test'),
      commands: {
        lint: { command: 'npm run lint', provenance: 'detected' },
        build: { command: 'npm run build', provenance: 'detected' },
        test: { command: 'npm run test', provenance: 'detected' },
        e2e: { command: 'npm run test:e2e', provenance: 'detected' }
      }
    })
    assert.equal(
      report.gates.find((g) => g.name === 'e2e'),
      undefined
    )
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

// ── Verification depth: which gates actually run ──

describe('verification depth gating', () => {
  const withE2E = (runner: CommandRunner): GateTaskContext => ({
    ...gateCtx(runner, 'npm run test'),
    taskId: 'verify',
    commands: {
      test: { command: 'npm run test', provenance: 'detected' },
      smoke: { command: 'npm run smoke', provenance: 'detected' },
      e2e: { command: 'npm run test:e2e', provenance: 'detected' }
    }
  })

  test('VERIFY omits the e2e gate at standard depth, even when a command exists', async () => {
    const report = await runVerifyGates(withE2E(scriptedRunner({})), { depth: 'standard' })
    assert.equal(
      report.gates.find((g) => g.name === 'e2e'),
      undefined,
      'a 45-minute suite nobody asked for must not run'
    )
  })

  test('VERIFY runs the e2e gate at e2e depth', async () => {
    const report = await runVerifyGates(withE2E(scriptedRunner({})), { depth: 'e2e' })
    assert.equal(report.gates.find((g) => g.name === 'e2e')?.verdict, 'pass')
  })

  test('VERIFY does NOT re-run the suite when BUILD proved the same HEAD', async () => {
    // D2: at 45 min a second run doubles the cost of the depth setting to
    // re-prove a tree nothing has touched. The verdict is still REPORTED.
    const spawned: string[] = []
    const spy: CommandRunner = async (command) => {
      spawned.push(command)
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    const report = await runVerifyGates(withE2E(spy), {
      depth: 'e2e',
      e2eProvenAt: 'abc1234567890'
    })
    const e2e = report.gates.find((g) => g.name === 'e2e')
    assert.equal(e2e?.verdict, 'pass', 'the gate is reported, not silently dropped')
    assert.ok(
      e2e?.evidence.some((line) => line.includes('abc12345')),
      'the evidence names the commit the pass belongs to'
    )
    assert.ok(
      !spawned.includes('npm run test:e2e'),
      `the e2e command must not be spawned again (spawned: ${spawned.join(', ')})`
    )
  })

  test('a BUILD proof does not suppress the e2e gate at standard depth', async () => {
    // Nothing to suppress: the gate was never planned at this depth.
    const report = await runVerifyGates(withE2E(scriptedRunner({})), {
      depth: 'standard',
      e2eProvenAt: 'abc1234567890'
    })
    assert.equal(
      report.gates.find((g) => g.name === 'e2e'),
      undefined
    )
  })

  test('a red e2e suite is a fail — it ran and the user path did not work', async () => {
    const report = await runE2EGate(
      withE2E(
        scriptedRunner({
          'npm run test:e2e': { exitCode: 1, output: ['1 failed', 'expected button to navigate'] }
        })
      )
    )
    assert.equal(report.overall, 'fail')
  })

  test('a missing e2e command ledgers as unverifiable and says the depth required it', async () => {
    // Doctrine: `unverifiable` never becomes `fail`. The depth annotation is
    // what stops "we could not check" reading like "there was nothing to check".
    const report = await runE2EGate({
      ...gateCtx(scriptedRunner({}), 'npm run test'),
      taskId: 'E2E',
      commands: { test: { command: 'npm run test', provenance: 'detected' } }
    })
    const gate = report.gates[0]
    assert.equal(gate.verdict, 'unverifiable')
    assert.equal(gate.reason, 'no_command')
    assert.ok(gate.evidence.some((e) => e.includes('REQUIRED by verification depth')))
  })
})

// ── T2: the BUILD-final e2e backstop (runFinalE2EBackstop) ──
//
// Tested at the SERVICE level, not through `runE2EGate` in isolation: the
// defect this suite exists to catch was an artifact written with the wrong key
// (`taskId` instead of `wave`), which the gate function knows nothing about and
// which made a 45-minute run render nowhere.

if (!env) {
  describe('T2 — runFinalE2EBackstop (skipped — no DB)', () => {
    test('backstop persists an E2E wave-gates artifact', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId
  const backstopLive = (() => {
    try {
      return typeof (blueprintBuildService as any).runFinalE2EBackstop === 'function'
    } catch {
      return false
    }
  })()

  if (!backstopLive) {
    describe('T2 — runFinalE2EBackstop (skipped — service mock-bound)', () => {
      test('backstop persists an E2E wave-gates artifact', () => {}, {
        skipReason: 'blueprintBuildService singleton is mock-bound in this process'
      })
    })
  } else {
    const runBackstop = async (blueprintId: string, dir: string): Promise<any> => {
      const result: any = { failed: false, waveGateFailures: [] }
      await (blueprintBuildService as any).runFinalE2EBackstop({
        blueprintId,
        workspaceId: wsId,
        workspacePath: dir,
        executionPath: dir,
        result
      })
      return result
    }

    const e2eArtifacts = (blueprintId: string): any[] => {
      const rec = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
      return (rec?.artifactsJson ?? []).filter(
        (a: any) => a.type === 'wave-gates' && a.contentJson?.wave === 'E2E'
      )
    }

    describe('T2 — runFinalE2EBackstop', () => {
      test('does nothing at standard depth — no artifact, no ledger', async () => {
        const dir = makeDir()
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Backstop standard' })
        blueprintPhaseRepository.createAllPhases(bp.id)

        await runBackstop(bp.id, dir)

        assert.equal(e2eArtifacts(bp.id).length, 0, 'the suite is opt-in, per depth')
        assert.equal((blueprintRepository.findById(bp.id)?.unverifiedJson ?? []).length, 0)
      })

      test('at e2e depth writes a wave-gates artifact keyed by wave, not taskId', async () => {
        // The regression guard: `BuildDeliverable` filters on `wave`, so an
        // artifact without it is silently discarded and the evidence for a
        // 45-minute run renders nowhere.
        const dir = makeDir() // empty dir → no e2e command resolves
        const bp = blueprintRepository.create({
          workspaceId: wsId,
          title: 'Backstop e2e',
          settingsJson: { verificationDepth: 'e2e' }
        })
        blueprintPhaseRepository.createAllPhases(bp.id)

        await runBackstop(bp.id, dir)

        const artifacts = e2eArtifacts(bp.id)
        assert.equal(artifacts.length, 1, 'exactly one E2E artifact per backstop run')
        const content = artifacts[0].contentJson
        assert.equal(content.wave, 'E2E')
        assert.ok(Array.isArray(content.report?.gates) && content.report.gates.length > 0)
        assert.equal(content.report.gates[0].name, 'e2e')
        assert.ok('headSha' in content, 'the proved commit rides along for VERIFY')
      })

      test('a missing e2e command ledgers under the shared E2E task id and blocks nothing', async () => {
        const dir = makeDir()
        const bp = blueprintRepository.create({
          workspaceId: wsId,
          title: 'Backstop ledger',
          settingsJson: { verificationDepth: 'e2e' }
        })
        blueprintPhaseRepository.createAllPhases(bp.id)

        const result = await runBackstop(bp.id, dir)

        assert.equal(result.failed, false, 'a missing command is an environment fact, not a defect')
        const ledger = blueprintRepository.findById(bp.id)?.unverifiedJson ?? []
        const entry = ledger.find((i: any) => i.gate === 'e2e')
        assert.ok(entry, 'the unproven e2e gate reaches the ledger')
        assert.equal(entry.taskId, 'E2E', 'one task id for the gate, wherever it runs')
      })
    })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
