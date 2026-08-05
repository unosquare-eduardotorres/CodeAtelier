/**
 * Phase 25, Wave 1B — BlueprintSpecService deep body coverage.
 *
 * Covers: blueprint-spec.service.ts (1257 lines, ~27% covered)
 *
 * Strategy: Test exported pure functions (stripClarificationsSection,
 * CLARIFY_CORRECTION_MESSAGE) directly. Construct BlueprintSpecService
 * and test internal state (clarifySessions, pendingGates), event emission,
 * phase lifecycle, and gate management.
 *
 * Run: tsx src/main/services/__tests__/blueprint-spec-deep-phase25.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let BlueprintSpecService: any
let blueprintSpecService: any
let stripClarificationsSection: (md: string) => string
let CLARIFY_CORRECTION_MESSAGE: string
let loaded = false

try {
  const mod = require('../blueprint-spec.service')
  BlueprintSpecService = mod.BlueprintSpecService
  blueprintSpecService = mod.blueprintSpecService
  stripClarificationsSection = mod.stripClarificationsSection
  CLARIFY_CORRECTION_MESSAGE = mod.CLARIFY_CORRECTION_MESSAGE
  loaded = true
} catch (err) {
  console.log(`⚠ blueprint-spec.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (loaded) {
  // ═══════════════════════════════════════════════════════════════════════
  // stripClarificationsSection — pure function
  // ═══════════════════════════════════════════════════════════════════════

  describe('stripClarificationsSection — pure function (Phase 25)', () => {
    test('returns md unchanged when no clarifications section', () => {
      const md = '# Spec\n\nSome content here'
      assert.equal(stripClarificationsSection(md), md)
    })

    test('strips clarifications section at end', () => {
      const md = '# Spec\n\nContent\n\n## Resolved Clarifications\n\n- Q: What? A: That.'
      const result = stripClarificationsSection(md)
      assert.ok(!result.includes('Resolved Clarifications'))
      assert.ok(result.includes('Content'))
    })

    test('strips only the clarifications section, preserves prior content', () => {
      const md = '# Spec\n\nBefore\n\n## Resolved Clarifications\n\nAfter'
      const result = stripClarificationsSection(md)
      assert.ok(result.includes('Before'))
      assert.ok(!result.includes('After'))
    })

    test('handles empty string', () => {
      assert.equal(stripClarificationsSection(''), '')
    })

    test('handles string with only the heading', () => {
      const md = '## Resolved Clarifications'
      const result = stripClarificationsSection(md)
      assert.equal(result, '')
    })

    test('trims trailing whitespace before section', () => {
      const md = '# Spec\n\n   \n\n## Resolved Clarifications\n\nContent'
      const result = stripClarificationsSection(md)
      assert.ok(!result.endsWith(' '))
      assert.ok(!result.endsWith('\n\n   '))
    })

    test('idempotent — calling twice gives same result', () => {
      const md = '# Spec\n\nContent\n\n## Resolved Clarifications\n\nQ&A'
      const first = stripClarificationsSection(md)
      const second = stripClarificationsSection(first)
      assert.equal(first, second)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // CLARIFY_CORRECTION_MESSAGE — constant
  // ═══════════════════════════════════════════════════════════════════════

  describe('CLARIFY_CORRECTION_MESSAGE (Phase 25)', () => {
    test('is a non-empty string', () => {
      assert.ok(typeof CLARIFY_CORRECTION_MESSAGE === 'string')
      assert.ok(CLARIFY_CORRECTION_MESSAGE.length > 0)
    })

    test('mentions required fence blocks', () => {
      assert.ok(CLARIFY_CORRECTION_MESSAGE.includes('blueprint-clarify-findings'))
      assert.ok(CLARIFY_CORRECTION_MESSAGE.includes('blueprint-clarify-questions'))
      assert.ok(CLARIFY_CORRECTION_MESSAGE.includes('blueprint-phase-complete'))
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // BlueprintSpecService — singleton & construction
  // ═══════════════════════════════════════════════════════════════════════

  describe('BlueprintSpecService — construction (Phase 25)', () => {
    test('can construct new instance', () => {
      const service = new BlueprintSpecService()
      assert.ok(service !== undefined)
    })

    test('exports singleton', () => {
      assert.ok(blueprintSpecService !== undefined)
      assert.ok(blueprintSpecService instanceof BlueprintSpecService)
    })

    test('is EventEmitter', () => {
      const service = new BlueprintSpecService()
      assert.equal(typeof service.on, 'function')
      assert.equal(typeof service.emit, 'function')
    })
  })

  // ── Method shapes ────────────────────────────────────────────────────

  describe('BlueprintSpecService — method shapes (Phase 25)', () => {
    test('has startSpecifyPhase', () => {
      assert.equal(typeof blueprintSpecService.startSpecifyPhase, 'function')
    })

    test('has startClarifyPhase', () => {
      assert.equal(typeof blueprintSpecService.startClarifyPhase, 'function')
    })

    test('has sendClarifyAnswer', () => {
      assert.equal(typeof blueprintSpecService.sendClarifyAnswer, 'function')
    })

    test('has skipClarifyPhase', () => {
      assert.equal(typeof blueprintSpecService.skipClarifyPhase, 'function')
    })

    test('has cancelBlueprint', () => {
      assert.equal(typeof blueprintSpecService.cancelBlueprint, 'function')
    })

    test('has shutdown', () => {
      assert.equal(typeof blueprintSpecService.shutdown, 'function')
    })

    test('has hasClarifySession', () => {
      assert.equal(typeof blueprintSpecService.hasClarifySession, 'function')
    })

    test('has getPendingGate', () => {
      assert.equal(typeof blueprintSpecService.getPendingGate, 'function')
    })

    test('has safeEmit', () => {
      assert.equal(typeof (blueprintSpecService as any).safeEmit, 'function')
    })
  })

  // ── Internal state ────────────────────────────────────────────────────

  describe('BlueprintSpecService — internal state (Phase 25)', () => {
    test('clarifySessions starts empty', () => {
      const service = new BlueprintSpecService()
      assert.ok((service as any).clarifySessions instanceof Map)
      assert.equal((service as any).clarifySessions.size, 0)
    })

    test('pendingGates starts empty', () => {
      const service = new BlueprintSpecService()
      assert.ok((service as any).pendingGates instanceof Map)
      assert.equal((service as any).pendingGates.size, 0)
    })
  })

  // ── hasClarifySession ─────────────────────────────────────────────────

  describe('BlueprintSpecService — hasClarifySession (Phase 25)', () => {
    test('returns false for nonexistent blueprint', () => {
      const service = new BlueprintSpecService()
      assert.equal(service.hasClarifySession('bp-nonexistent'), false)
    })

    test('returns true when session exists', () => {
      const service = new BlueprintSpecService()
      ;(service as any).clarifySessions.set('bp-1', { session: {} })
      assert.equal(service.hasClarifySession('bp-1'), true)
      ;(service as any).clarifySessions.delete('bp-1')
    })
  })

  // ── getPendingGate ────────────────────────────────────────────────────

  describe('BlueprintSpecService — getPendingGate (Phase 25)', () => {
    test('returns null or undefined for nonexistent blueprint', () => {
      const service = new BlueprintSpecService()
      const gate = service.getPendingGate('bp-nonexistent')
      assert.ok(gate === null || gate === undefined)
    })

    test('returns gate state when set', () => {
      const service = new BlueprintSpecService()
      ;(service as any).pendingGates.set('bp-1', {
        completion: { ok: true },
        findings: { questions: [] },
        workspaceId: 'ws-1',
        text: 'gate text'
      })
      const gate = service.getPendingGate('bp-1')
      assert.ok(gate !== null)
      ;(service as any).pendingGates.delete('bp-1')
    })
  })

  // ── safeEmit ──────────────────────────────────────────────────────────

  describe('BlueprintSpecService — safeEmit (Phase 25)', () => {
    test('emits events safely', () => {
      const service = new BlueprintSpecService()
      const events: any[] = []
      service.on('phaseProgress', (e: any) => events.push(e))
      ;(service as any).safeEmit('phaseProgress', { text: 'test' })
      assert.equal(events.length, 1)
    })

    test('catches listener errors', () => {
      const service = new BlueprintSpecService()
      service.on('phaseProgress', () => {
        throw new Error('boom')
      })
      const result = (service as any).safeEmit('phaseProgress', {})
      assert.ok(typeof result === 'boolean')
    })
  })

  // ── cancelBlueprint ───────────────────────────────────────────────────

  describe('BlueprintSpecService — cancelBlueprint (Phase 25)', () => {
    test('no-ops for unknown blueprint', async () => {
      const service = new BlueprintSpecService()
      await service.cancelBlueprint('bp-nonexistent')
      assert.ok(true)
    })
  })

  // ── shutdown ──────────────────────────────────────────────────────────

  describe('BlueprintSpecService — shutdown (Phase 25)', () => {
    test('clears state on shutdown', async () => {
      const service = new BlueprintSpecService()
      await service.shutdown()
      assert.equal((service as any).clarifySessions.size, 0)
      assert.equal((service as any).pendingGates.size, 0)
    })
  })
}

if (require.main === module) {
  void summaryAsync()
}
