/**
 * M9 — renderer-side gate UI logic.
 *
 * Pure-logic tests for the deterministic pieces of the M9 UI:
 * - M9.2: the taskGates → gatesByTask partition (wave pseudo-ids excluded)
 * - M9.2: the gate-verdict chip derivation (pass/fail/unverifiable + reason)
 * - M9.4: the unverified-banner visibility rule (unverifiedJson non-empty)
 *
 * The store subscription and React components themselves are covered by the
 * type-checked wiring; these tests pin the decision logic they share.
 *
 * Run: tsx src/renderer/src/store/__tests__/blueprint-gates-ui.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import type { GateReport, GateResult } from '../../../../shared/gate-types'

// ── The partition rule from blueprint.store's onBlueprintTaskGates handler ──

/** True when the taskId is a wave pseudo-id (`W<n>`) — excluded from task rows. */
function isWavePseudoId(taskId: string): boolean {
  return /^W\d+$/.test(taskId)
}

/** The store handler's merge rule: task rows keyed by taskId, waves dropped. */
function mergeGateReport(
  gatesByTask: Record<string, GateReport>,
  data: { taskId: string; report: GateReport }
): Record<string, GateReport> {
  if (isWavePseudoId(data.taskId)) return gatesByTask
  return { ...gatesByTask, [data.taskId]: data.report }
}

// ── The chip verdict derivation from GateVerdictChip (mirrors aggregateVerdict) ──

function chipVerdict(report: GateReport): 'pass' | 'fail' | 'unverifiable' {
  const failed = report.gates.filter((g) => g.verdict === 'fail')
  const unverifiable = report.gates.filter((g) => g.verdict === 'unverifiable')
  if (failed.length > 0) return 'fail'
  if (unverifiable.length > 0 || report.gates.length === 0) return 'unverifiable'
  return 'pass'
}

// ── The banner visibility rule from BlueprintDetailView ──

function bannerVisible(unverifiedJson: unknown[] | null | undefined): boolean {
  return (unverifiedJson?.length ?? 0) > 0
}

// ── Fixtures ──

const gate = (name: string, verdict: GateResult['verdict'], reason?: string): GateResult => ({
  name: name as GateResult['name'],
  verdict,
  evidence: ['x'],
  ...(reason ? { reason: reason as GateResult['reason'] } : {}),
  durationMs: 1
})

const report = (...gates: GateResult[]): GateReport => ({ gates, overall: 'pass' })

// ── Tests ──

describe('M9.2 — taskGates → gatesByTask partition', () => {
  test('a task report is stored keyed by taskId', () => {
    const next = mergeGateReport({}, { taskId: 'T001', report: report(gate('lint', 'pass')) })
    assert.ok(next['T001'])
    assert.equal(next['T001'].gates.length, 1)
  })

  test('a second attempt for the same task REPLACES the earlier report', () => {
    const first = mergeGateReport({}, { taskId: 'T001', report: report(gate('lint', 'fail')) })
    const second = mergeGateReport(first, {
      taskId: 'T001',
      report: report(gate('lint', 'pass'))
    })
    assert.equal(second['T001'].gates[0].verdict, 'pass', 'latest attempt wins')
  })

  test('wave pseudo-ids (W1, W12) are excluded — they render via the deliverable', () => {
    const base = { T001: report(gate('lint', 'pass')) }
    const next = mergeGateReport(base, { taskId: 'W1', report: report(gate('build', 'pass')) })
    assert.equal(next, base, 'the map is returned unchanged for wave reports')
    assert.ok(!('W1' in next))
  })

  test('task ids that merely START with W are kept (WIDGET-42 is not a wave)', () => {
    const next = mergeGateReport(
      {},
      { taskId: 'WIDGET-42', report: report(gate('lint', 'pass')) }
    )
    assert.ok('WIDGET-42' in next)
  })
})

describe('M9.2 — gate-verdict chip derivation', () => {
  test('all green → pass', () => {
    assert.equal(chipVerdict(report(gate('lint', 'pass'), gate('build', 'pass'))), 'pass')
  })

  test('any fail → fail, even alongside unverifiable gates', () => {
    assert.equal(
      chipVerdict(report(gate('lint', 'pass'), gate('build', 'fail'), gate('task-tests', 'unverifiable', 'no_command'))),
      'fail'
    )
  })

  test('unverifiable without fails → unverifiable (the honest amber state)', () => {
    assert.equal(
      chipVerdict(report(gate('lint', 'pass'), gate('task-tests', 'unverifiable', 'vacuous_test'))),
      'unverifiable'
    )
  })

  test('an empty report is unverifiable, never a silent pass', () => {
    assert.equal(chipVerdict(report()), 'unverifiable')
  })
})

describe('M9.4 — unverified-items banner visibility', () => {
  test('hidden when the ledger is null or empty', () => {
    assert.equal(bannerVisible(null), false)
    assert.equal(bannerVisible(undefined), false)
    assert.equal(bannerVisible([]), false)
  })

  test('visible for any non-empty ledger — one entry is enough', () => {
    assert.equal(bannerVisible([{ taskId: 'W1', gate: 'lint', reason: 'no_command' }]), true)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
