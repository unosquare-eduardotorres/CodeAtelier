/**
 * P1 — evidence survives reload; caches help retries.
 *
 * P1.1 — runWaveGates persists its report as a `wave-gates` artifact on the
 *        build phase record, so wave-gate evidence survives an app reload
 *        (the in-memory `taskGates` event is transient).
 * P1.2 — readManifestsCached honours R2.1 invalidation: after the cache entry
 *        is dropped mid-ladder, the next read returns fresh disk content, so
 *        retry attempt 2+ sees a toolchain attempt 1's session scaffolded.
 *
 * Run: tsx src/main/services/__tests__/blueprint-wave-gates-persist.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

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
  console.log(`⚠ wave-gates persist setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

const tempDirs: string[] = []
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wave-gates-persist-'))
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

if (!env) {
  describe('wave-gates persistence (skipped — no DB)', () => {
    test('wave report persisted as artifact', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  /**
   * P1.2 needs no repositories (pure fs + internal Map) — it runs whenever the
   * service module loaded, DB or mock-bound alike.
   */
  describe('P1.2 — gate context refresh per retry iteration', () => {
    test('readManifestsCached returns fresh content after R2.1 invalidation', () => {
      const dir = makeDir()
      writeFileSync(join(dir, 'package.json'), '{"name":"before"}')
      const svc = blueprintBuildService

      const first = svc.readManifestsCached('bp-p12-cache', dir)
      assert.ok(
        String(first.packageJson).includes('"before"'),
        'first read snapshots the disk state'
      )
      // Same key without invalidation → cached snapshot, even though disk changed.
      writeFileSync(join(dir, 'package.json'), '{"name":"mid"}')
      assert.ok(
        String(svc.readManifestsCached('bp-p12-cache', dir).packageJson).includes('"before"'),
        'cache serves the stale snapshot until invalidated'
      )

      // R2.1 invalidation fires mid-ladder (no_command / manifest write-set) —
      // P1.2's per-iteration refresh then re-reads from disk.
      svc.manifestCache.delete('bp-p12-cache')
      writeFileSync(join(dir, 'package.json'), '{"name":"after"}')
      const second = svc.readManifestsCached('bp-p12-cache', dir)
      assert.ok(
        String(second.packageJson).includes('"after"'),
        'after invalidation the next read must see fresh disk content'
      )
    })
  })

  /**
   * Shared-runner guard (same rationale as blueprint-code-review-skip.test.ts):
   * files that run setupFullMock() can leave the service singletons mock-bound
   * for the rest of the process, in which case artifacts seeded through the
   * real repositories never appear. Probe via blueprintService (the build
   * service shares its module graph): if it cannot read back a row we just
   * wrote, skip with a reason.
   */
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
    describe('wave-gates persistence (skipped — service mock-bound)', () => {
      test('wave report persisted as artifact', () => {}, {
        skipReason: 'blueprintBuildService singleton is mock-bound in this process'
      })
    })
  } else {
    describe('P1.1 — runWaveGates persists the wave report', () => {
      test('after runWaveGates, the build phase artifact list contains the wave report', async () => {
        const dir = makeDir() // empty dir → no commands resolve → no spawns
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Wave persist test' })
        blueprintPhaseRepository.createAllPhases(bp.id)

        const report = await blueprintBuildService.runWaveGates({
          blueprintId: bp.id,
          workspaceId: wsId,
          workspacePath: dir,
          executionPath: dir,
          waveNum: 2
        })

        const rec = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'build')
        const artifact = rec?.artifactsJson?.findLast((a: any) => a.type === 'wave-gates')
        assert.ok(artifact, 'build phase must carry a wave-gates artifact')
        assert.equal(artifact.contentJson.wave, 2, 'artifact names its wave')
        assert.equal(artifact.contentJson.report.overall, report.overall)
        assert.ok(
          Array.isArray(artifact.contentJson.report.gates) &&
            artifact.contentJson.report.gates.length > 0,
          'the full gate report is embedded, not just a verdict'
        )
      })

      test('a second wave appends a second artifact — evidence accumulates per wave', async () => {
        const dir = makeDir()
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Two waves' })
        blueprintPhaseRepository.createAllPhases(bp.id)

        for (const waveNum of [1, 2]) {
          await blueprintBuildService.runWaveGates({
            blueprintId: bp.id,
            workspaceId: wsId,
            workspacePath: dir,
            executionPath: dir,
            waveNum
          })
        }

        const rec = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'build')
        const waves = rec.artifactsJson
          .filter((a: any) => a.type === 'wave-gates')
          .map((a: any) => a.contentJson.wave)
        assert.deepEqual(waves, [1, 2], 'one artifact per wave, in order')
      })
    })

    /**
     * F4 — environmental failure classification + retry gating.
     *
     * A failing wave report that ALSO contains command_missing/command_error
     * means part of the failure is deterministic on this machine: no retry can
     * make the missing tool appear (incident 2026-08, ~20 blind retries).
     * pushWaveGateFailure must tag the BuildResult, saveRetryContext must
     * persist the tag, and the escalation emit must fire for it.
     */
    describe('F4 — environmental failure classification', () => {
      const mkResult = (): any => ({
        tasksCompleted: 0,
        tasksResumed: 0,
        filesCreated: [],
        filesModified: [],
        failed: false,
        discoveries: [],
        taskTimings: [],
        taskFailures: []
      })

      test('command_missing beside a red gate → environmentalFailure set, red entry unflagged', () => {
        const result = mkResult()
        ;(blueprintBuildService as any).pushWaveGateFailure(result, 'W10', {
          gates: [
            {
              name: 'full-suite',
              verdict: 'unverifiable',
              reason: 'command_missing',
              evidence: ['pytest — the runner is not installed on this machine'],
              durationMs: 76
            },
            {
              name: 'lint',
              verdict: 'fail',
              evidence: ['src/x.ts:1:1 — semicolon expected'],
              durationMs: 50
            }
          ],
          overall: 'fail'
        })

        assert.equal(result.taskFailures.length, 1, 'only the failed gate becomes a taskFailure')
        assert.equal(result.taskFailures[0].taskId, 'W10')
        assert.equal(
          result.taskFailures[0].environmental,
          undefined,
          'a genuinely-red gate is agent-fixable, not environmental'
        )
        assert.ok(
          typeof result.environmentalFailure === 'string' &&
            result.environmentalFailure.includes('full-suite gate could not run'),
          `environmentalFailure names the gate — got: ${result.environmentalFailure}`
        )
        assert.ok(
          result.environmentalFailure.includes('pytest'),
          'environmentalFailure carries the first evidence line'
        )
      })

      test('a red suite with no environmental reason → environmentalFailure stays unset', () => {
        const result = mkResult()
        ;(blueprintBuildService as any).pushWaveGateFailure(result, 'W9', {
          gates: [
            {
              name: 'full-suite',
              verdict: 'fail',
              evidence: ['2 failed, 82 passed in 1.36s'],
              durationMs: 1360
            }
          ],
          overall: 'fail'
        })

        assert.equal(result.taskFailures.length, 1)
        assert.equal(
          result.environmentalFailure,
          undefined,
          'a red suite is agent-fixable — retry remains enabled'
        )
      })

      test('saveRetryContext persists environmentalFailure into the phase snapshot', () => {
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'F4 env persist' })
        blueprintPhaseRepository.createAllPhases(bp.id)
        const blueprintService = require('../blueprint.service').blueprintService

        blueprintService.saveRetryContext(bp.id, 'build', {
          error: 'W10: gate lint failed — semicolon expected',
          environmentalFailure: 'full-suite gate could not run — pytest is not installed'
        })

        const rec = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'build')
        const snap = JSON.parse(rec.contextSnapshot)
        assert.equal(snap.attempt, 1)
        assert.equal(
          snap.environmentalFailure,
          'full-suite gate could not run — pytest is not installed',
          'the snapshot carries the environmental tag so the UI can gate Retry after reload'
        )
      })

      test('environmental failure emits the specific escalation on the FIRST attempt', () => {
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'F4 env emit' })
        blueprintPhaseRepository.createAllPhases(bp.id)
        const blueprintService = require('../blueprint.service').blueprintService

        const events: Array<Record<string, unknown>> = []
        const handler = (e: Record<string, unknown>): void => {
          if (e.blueprintId === bp.id) events.push(e)
        }
        blueprintService.on('phaseProgress', handler)
        try {
          blueprintService.saveRetryContext(bp.id, 'build', {
            error: 'W10: gate lint failed',
            environmentalFailure: 'full-suite gate could not run — pytest is not installed'
          })
        } finally {
          blueprintService.off('phaseProgress', handler)
        }

        assert.equal(events.length, 1, 'environmental failure escalates immediately, not at recurrence 3')
        const text = String(events[0].text)
        assert.ok(text.includes('retrying cannot fix this'), `emit says retry cannot help — got: ${text}`)
        assert.ok(text.includes('pytest'), 'emit names the missing tool')
      })

      test('recurrence >= 3 without environmental tag still escalates (pre-existing path intact)', () => {
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'F4 recurrence' })
        blueprintPhaseRepository.createAllPhases(bp.id)
        const blueprintService = require('../blueprint.service').blueprintService

        const events: Array<Record<string, unknown>> = []
        const handler = (e: Record<string, unknown>): void => {
          if (e.blueprintId === bp.id) events.push(e)
        }
        blueprintService.on('phaseProgress', handler)
        try {
          for (let i = 0; i < 3; i++) {
            blueprintService.saveRetryContext(bp.id, 'build', {
              error: 'R045: verification failed — 2 planned missing'
            })
          }
        } finally {
          blueprintService.off('phaseProgress', handler)
        }

        assert.equal(events.length, 1, 'first escalation lands at recurrence 3, not before')
        const snap = JSON.parse(
          blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'build').contextSnapshot
        )
        assert.equal(snap.recurrence, 3)
        assert.equal(
          snap.environmentalFailure,
          undefined,
          'no environmental tag when the failure is agent-fixable'
        )
        assert.ok(
          String(events[0].text).includes('recurred 3 times'),
          'recurrence emit keeps its original wording'
        )
      })
    })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
