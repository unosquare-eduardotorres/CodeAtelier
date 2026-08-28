/**
 * R1.3 — interim code-review skip guard in BlueprintService.advancePhase,
 * plus the R1.3 re-wire: settleOptionalPhases + retryPhase skip-and-advance.
 *
 * `code-review` is an optional quality layer: OFF until a model is bound to
 * `blueprint:code-review`. Advancing from `build` with the role disabled must
 * land on `verify` and mark the code-review phase record `skipped` — never
 * strand the blueprint in a phase that has no runner. The re-wire extends
 * the same guarantee to the build→verify boundary (which bypasses
 * advancePhase) and to retryPhase resolution (which previously returned
 * `code-review` and died silently in the IPC dispatch map).
 *
 * Run: tsx src/main/services/__tests__/blueprint-code-review-skip.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintPhaseRepository: any
let blueprintService: any
let modelConfigService: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
  blueprintService = require('../blueprint.service').blueprintService
  modelConfigService = require('../model-config.service').modelConfigService
} catch (err) {
  console.log(`⚠ code-review skip-guard setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('code-review skip guard (skipped — no DB)', () => {
    test('advancePhase skips disabled code-review', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  /**
   * Shared-runner guard: files that run a setupFullMock() episode can leave
   * the blueprintService singleton mock-bound for the rest of the process
   * (see restoreFullMock's doc comment). A mock-bound service cannot see rows
   * seeded through the real repositories, so every assertion below would fail
   * with "Blueprint not found" for reasons unrelated to the guard. Probe once:
   * if the service cannot read back a row we just wrote, skip with a reason.
   */
  const serviceIsLive = (() => {
    try {
      const probe = blueprintRepository.create({ workspaceId: wsId, title: 'liveness probe' })
      return blueprintService.getBlueprint(probe.id)?.id === probe.id
    } catch {
      return false
    }
  })()

  if (!serviceIsLive) {
    describe('code-review skip guard (skipped — service mock-bound)', () => {
      test('advancePhase skips disabled code-review', () => {}, {
        skipReason: 'blueprintService singleton is mock-bound in this process'
      })
    })
  } else {
    /** Force `isRoleEnabled('blueprint:code-review')` to the given value. */
  function withRoleEnabled<T>(enabled: boolean, fn: () => T): T {
    const original = modelConfigService.isRoleEnabled
    modelConfigService.isRoleEnabled = (_ws: string | undefined, action: string) =>
      action === 'blueprint:code-review' ? enabled : original(_ws, action)
    try {
      return fn()
    } finally {
      modelConfigService.isRoleEnabled = original
    }
  }

  /** A blueprint whose build phase is active and every earlier phase complete. */
  function seedAtBuild(): string {
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Skip guard test' })
    blueprintPhaseRepository.createAllPhases(bp.id)
    const phases = blueprintPhaseRepository.findByBlueprint(bp.id)
    for (const p of phases) {
      if (p.phase === 'build') {
        blueprintPhaseRepository.updateStatus(p.id, 'active')
      } else if (p.phase !== 'code-review' && p.phase !== 'verify') {
        blueprintPhaseRepository.updateStatus(p.id, 'complete')
      }
    }
    blueprintRepository.update(bp.id, { currentPhase: 'build', status: 'building' })
    return bp.id
  }

  function phaseRec(blueprintId: string, phase: string): any {
    return blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, phase)
  }

  describe('R1.3 — advancePhase code-review skip guard', () => {
    test('role DISABLED: advancing from build lands on verify, code-review marked skipped', () => {
      const blueprintId = seedAtBuild()

      const next = withRoleEnabled(false, () => blueprintService.advancePhase(blueprintId))

      assert.equal(next?.phase, 'verify', 'must land on verify, not code-review')
      const bp = blueprintRepository.findById(blueprintId)
      assert.equal(bp.currentPhase, 'verify')
      assert.equal(bp.status, 'verifying')
      assert.equal(phaseRec(blueprintId, 'build').status, 'complete')
      assert.equal(
        phaseRec(blueprintId, 'code-review').status,
        'skipped',
        'the skipped layer must be visible in the phase journey'
      )
      assert.equal(phaseRec(blueprintId, 'verify').status, 'active')
    })

    test('role ENABLED: advancing from build lands on code-review normally', () => {
      const blueprintId = seedAtBuild()

      const next = withRoleEnabled(true, () => blueprintService.advancePhase(blueprintId))

      assert.equal(next?.phase, 'code-review')
      assert.equal(blueprintRepository.findById(blueprintId).currentPhase, 'code-review')
      assert.equal(phaseRec(blueprintId, 'code-review').status, 'active')
      assert.equal(phaseRec(blueprintId, 'verify').status, 'pending')
    })

    test('role DISABLED and code-review is the LAST phase: the run completes instead of stranding', () => {
      // Simulate a future phase order where code-review is terminal: advance
      // from verify with the role off must complete the blueprint, not strand it.
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Terminal skip' })
      blueprintPhaseRepository.createAllPhases(bp.id)
      const phases = blueprintPhaseRepository.findByBlueprint(bp.id)
      for (const p of phases) {
        if (p.phase === 'verify') blueprintPhaseRepository.updateStatus(p.id, 'active')
        else if (p.phase !== 'code-review') blueprintPhaseRepository.updateStatus(p.id, 'complete')
      }
      blueprintRepository.update(bp.id, { currentPhase: 'verify', status: 'verifying' })

      // verify is terminal in the real order; advancing completes the blueprint.
      const next = withRoleEnabled(false, () => blueprintService.advancePhase(bp.id))
      assert.equal(next, null)
      assert.equal(blueprintRepository.findById(bp.id).status, 'complete')
    })

    test('the guard is scoped to code-review — advancing from review never consults the role', () => {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Scoped guard' })
      blueprintPhaseRepository.createAllPhases(bp.id)
      const phases = blueprintPhaseRepository.findByBlueprint(bp.id)
      for (const p of phases) {
        if (p.phase === 'review') blueprintPhaseRepository.updateStatus(p.id, 'active')
        else if (p.phase !== 'build' && p.phase !== 'code-review' && p.phase !== 'verify') {
          blueprintPhaseRepository.updateStatus(p.id, 'complete')
        }
      }
      blueprintRepository.update(bp.id, { currentPhase: 'review', status: 'reviewing' })

      let roleChecked = false
      const original = modelConfigService.isRoleEnabled
      modelConfigService.isRoleEnabled = (_ws: string | undefined, action: string) => {
        if (action === 'blueprint:code-review') roleChecked = true
        return false
      }
      try {
        const next = blueprintService.advancePhase(bp.id)
        assert.equal(next?.phase, 'build', 'review → build is unconditional')
      } finally {
        modelConfigService.isRoleEnabled = original
      }
      assert.equal(roleChecked, false, 'the role must only be consulted for code-review')
    })
  })

  describe('R1.3 re-wire — settleOptionalPhases', () => {
    test('role DISABLED: pending code-review record is marked skipped', () => {
      const blueprintId = seedAtBuild()

      withRoleEnabled(false, () => blueprintService.settleOptionalPhases(blueprintId))

      assert.equal(
        phaseRec(blueprintId, 'code-review').status,
        'skipped',
        'pending record must be settled as skipped'
      )
      // Scoped: only the code-review record is touched.
      assert.equal(phaseRec(blueprintId, 'verify').status, 'pending')
      assert.equal(phaseRec(blueprintId, 'build').status, 'active')
    })

    test('role ENABLED: no-op — the pending record is left for the M7 runner', () => {
      const blueprintId = seedAtBuild()

      withRoleEnabled(true, () => blueprintService.settleOptionalPhases(blueprintId))

      assert.equal(phaseRec(blueprintId, 'code-review').status, 'pending')
    })

    test('an ACTIVE code-review record is never cancelled underneath its owner', () => {
      const blueprintId = seedAtBuild()
      blueprintPhaseRepository.updateStatus(phaseRec(blueprintId, 'code-review').id, 'active')

      withRoleEnabled(false, () => blueprintService.settleOptionalPhases(blueprintId))

      assert.equal(phaseRec(blueprintId, 'code-review').status, 'active')
    })

    test('missing code-review record is backfilled as skipped (pre-phase blueprints)', () => {
      // Blueprints created before the phase existed have no row for it.
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Backfill settle' })
      blueprintPhaseRepository.create({ blueprintId: bp.id, phase: 'build' })

      withRoleEnabled(false, () => blueprintService.settleOptionalPhases(bp.id))

      const rec = phaseRec(bp.id, 'code-review')
      assert.ok(rec, 'record must be backfilled')
      assert.equal(rec.status, 'skipped')
    })

    test('unknown blueprint is a silent no-op (defensive)', () => {
      assert.doesNotThrow(() =>
        withRoleEnabled(false, () => blueprintService.settleOptionalPhases('no-such-blueprint'))
      )
    })
  })

  describe('R1.3 re-wire — retryPhase skip-and-advance', () => {
    /** Failed blueprint whose first pending phase is code-review (verify also pending). */
    function seedFailedBeforeCodeReview(): string {
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Retry skip test' })
      blueprintPhaseRepository.createAllPhases(bp.id)
      const phases = blueprintPhaseRepository.findByBlueprint(bp.id)
      for (const p of phases) {
        // code-review + verify stay pending; everything before them is complete.
        if (p.phase !== 'code-review' && p.phase !== 'verify') {
          blueprintPhaseRepository.updateStatus(p.id, 'complete')
        }
      }
      blueprintRepository.update(bp.id, { currentPhase: 'build', status: 'failed' })
      return bp.id
    }

    test('role DISABLED: resolution lands on code-review → returns verify, record skipped', () => {
      const blueprintId = seedFailedBeforeCodeReview()

      // Pre-fix behaviour: retryPhase returned 'code-review', the IPC dispatch
      // map had no entry, and the retry died with "Unknown phase: code-review".
      const { phase } = withRoleEnabled(false, () => blueprintService.retryPhase(blueprintId))

      assert.equal(phase, 'verify', 'must resolve to verify, not the dead code-review layer')
      assert.equal(phaseRec(blueprintId, 'code-review').status, 'skipped')
      assert.equal(phaseRec(blueprintId, 'verify').status, 'pending')
      const bp = blueprintRepository.findById(blueprintId)
      assert.equal(bp.currentPhase, 'verify')
      assert.equal(bp.status, 'verifying')
    })

    test('role ENABLED: code-review resolves normally (M7 runner owns it)', () => {
      const blueprintId = seedFailedBeforeCodeReview()

      const { phase } = withRoleEnabled(true, () => blueprintService.retryPhase(blueprintId))

      assert.equal(phase, 'code-review')
      assert.equal(phaseRec(blueprintId, 'code-review').status, 'pending')
    })
  })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
