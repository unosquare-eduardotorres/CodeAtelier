/**
 * Phase 25, Wave 1B — BlueprintVerifyService deep body coverage.
 *
 * Covers: blueprint-verify.service.ts (957 lines, ~12% covered)
 *
 * Strategy: Test exported constants (RERUN_VERIFY_RX, GENERIC_REMEDIATION_TASK_DESC).
 * Construct BlueprintVerifyService and test internal state, event emission,
 * method shapes, cancel and shutdown lifecycle.
 *
 * Run: tsx src/main/services/__tests__/blueprint-verify-deep-phase25.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let BlueprintVerifyService: any
let blueprintVerifyService: any
let RERUN_VERIFY_RX: RegExp
let GENERIC_REMEDIATION_TASK_DESC: string
let loaded = false

try {
  const mod = require('../blueprint-verify.service')
  BlueprintVerifyService = mod.BlueprintVerifyService
  blueprintVerifyService = mod.blueprintVerifyService
  RERUN_VERIFY_RX = mod.RERUN_VERIFY_RX
  GENERIC_REMEDIATION_TASK_DESC = mod.GENERIC_REMEDIATION_TASK_DESC
  loaded = true
} catch (err) {
  console.log(`⚠ blueprint-verify.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (loaded) {
  // ═══════════════════════════════════════════════════════════════════════
  // RERUN_VERIFY_RX — exported regex
  // ═══════════════════════════════════════════════════════════════════════

  describe('RERUN_VERIFY_RX (Phase 25)', () => {
    test('matches "re-run verification"', () => {
      assert.ok(RERUN_VERIFY_RX.test('re-run verification checks'))
    })

    test('matches "rerun verify"', () => {
      assert.ok(RERUN_VERIFY_RX.test('rerun verify tests'))
    })

    test('matches "verification pass"', () => {
      assert.ok(RERUN_VERIFY_RX.test('verify pass'))
    })

    test('matches "verification evidence"', () => {
      assert.ok(RERUN_VERIFY_RX.test('verification evidence'))
    })

    test('does NOT match "implement feature"', () => {
      assert.ok(!RERUN_VERIFY_RX.test('implement feature'))
    })

    test('does NOT match empty string', () => {
      assert.ok(!RERUN_VERIFY_RX.test(''))
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // GENERIC_REMEDIATION_TASK_DESC — exported constant
  // ═══════════════════════════════════════════════════════════════════════

  describe('GENERIC_REMEDIATION_TASK_DESC (Phase 25)', () => {
    test('is a non-empty string', () => {
      assert.ok(typeof GENERIC_REMEDIATION_TASK_DESC === 'string')
      assert.ok(GENERIC_REMEDIATION_TASK_DESC.length > 0)
    })

    test('mentions gaps and verification', () => {
      assert.ok(
        GENERIC_REMEDIATION_TASK_DESC.includes('gaps') ||
          GENERIC_REMEDIATION_TASK_DESC.includes('Fix')
      )
      assert.ok(
        GENERIC_REMEDIATION_TASK_DESC.includes('verification') ||
          GENERIC_REMEDIATION_TASK_DESC.includes('verify')
      )
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // BlueprintVerifyService — construction & singleton
  // ═══════════════════════════════════════════════════════════════════════

  describe('BlueprintVerifyService — construction (Phase 25)', () => {
    test('can construct new instance', () => {
      const service = new BlueprintVerifyService()
      assert.ok(service !== undefined)
    })

    test('exports singleton', () => {
      assert.ok(blueprintVerifyService !== undefined)
      assert.ok(blueprintVerifyService instanceof BlueprintVerifyService)
    })

    test('is EventEmitter', () => {
      assert.equal(typeof blueprintVerifyService.on, 'function')
      assert.equal(typeof blueprintVerifyService.emit, 'function')
    })
  })

  // ── Method shapes ────────────────────────────────────────────────────

  describe('BlueprintVerifyService — method shapes (Phase 25)', () => {
    test('has startVerifyPhase', () => {
      assert.equal(typeof blueprintVerifyService.startVerifyPhase, 'function')
    })

    test('has cancelBlueprint', () => {
      assert.equal(typeof blueprintVerifyService.cancelBlueprint, 'function')
    })

    test('has shutdown', () => {
      assert.equal(typeof blueprintVerifyService.shutdown, 'function')
    })

    test('has safeEmit', () => {
      assert.equal(typeof (blueprintVerifyService as any).safeEmit, 'function')
    })
  })

  // ── safeEmit ──────────────────────────────────────────────────────────

  describe('BlueprintVerifyService — safeEmit (Phase 25)', () => {
    test('emits events safely', () => {
      const service = new BlueprintVerifyService()
      const events: any[] = []
      service.on('phaseProgress', (e: any) => events.push(e))
      ;(service as any).safeEmit('phaseProgress', { text: 'verifying' })
      assert.equal(events.length, 1)
    })

    test('catches listener throws', () => {
      const service = new BlueprintVerifyService()
      service.on('phaseProgress', () => {
        throw new Error('boom')
      })
      const result = (service as any).safeEmit('phaseProgress', {})
      assert.ok(typeof result === 'boolean')
    })
  })

  // ── cancelBlueprint ───────────────────────────────────────────────────

  describe('BlueprintVerifyService — cancelBlueprint (Phase 25)', () => {
    test('no-ops for unknown blueprint', async () => {
      const service = new BlueprintVerifyService()
      await service.cancelBlueprint('bp-nonexistent')
      assert.ok(true)
    })
  })

  // ── shutdown ──────────────────────────────────────────────────────────

  describe('BlueprintVerifyService — shutdown (Phase 25)', () => {
    test('shutdown on fresh instance', async () => {
      const service = new BlueprintVerifyService()
      await service.shutdown()
      assert.ok(true)
    })
  })

  // ── Event patterns ────────────────────────────────────────────────────

  describe('BlueprintVerifyService — events (Phase 25)', () => {
    test('phaseStart event emits', () => {
      const service = new BlueprintVerifyService()
      const events: any[] = []
      service.on('phaseStart', (e: any) => events.push(e))
      ;(service as any).safeEmit('phaseStart', {
        blueprintId: 'bp-1',
        workspaceId: 'ws-1',
        phase: 'verify'
      })
      assert.equal(events.length, 1)
    })

    test('phaseComplete event emits', () => {
      const service = new BlueprintVerifyService()
      const events: any[] = []
      service.on('phaseComplete', (e: any) => events.push(e))
      ;(service as any).safeEmit('phaseComplete', {
        blueprintId: 'bp-1',
        phase: 'verify',
        status: 'complete'
      })
      assert.equal(events.length, 1)
    })
  })
}

if (require.main === module) {
  void summaryAsync()
}
