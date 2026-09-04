/**
 * M9 — renderer-side gate UI logic.
 *
 * Pure-logic tests for the deterministic pieces of the M9 UI:
 * - M9.2: the taskGates → gatesByTask partition (wave pseudo-ids excluded)
 * - M9.2: the gate-verdict chip derivation (pass/fail/unverifiable + reason)
 * - M9.2: the chip LABEL derivation (names the gate/reason, not a count)
 * - M9.4: the unverified-banner visibility rule (unverifiedJson non-empty)
 * - task-row description marker stripping ([US1]/[P]/[S])
 *
 * The chip and marker helpers are imported from `task-chips.ts` (the real
 * shipped code); only the store/banner rules are mirrored here, since those
 * live inside components that cannot be loaded outside React.
 *
 * The store subscription and React components themselves are covered by the
 * type-checked wiring; these tests pin the decision logic they share.
 *
 * Run: tsx src/renderer/src/store/__tests__/blueprint-gates-ui.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import type { GateReport, GateResult } from '../../../../shared/gate-types'
import {
  deriveGateChip,
  describeReason,
  stripTaskMarkers
} from '../../components/workspace/blueprints/task-chips'

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

// ── The chip derivation — the real thing, not a mirror ──

const chipVerdict = (report: GateReport): GateReport['overall'] => deriveGateChip(report).verdict
const chipLabel = (report: GateReport): string => deriveGateChip(report).label
const chipTip = (report: GateReport): string => deriveGateChip(report).tip

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

describe('M9.2 — gate-chip label names the problem, not a count', () => {
  test('all green → the plain pass chip', () => {
    assert.equal(chipLabel(report(gate('lint', 'pass'), gate('build', 'pass'))), 'gates ✓')
  })

  test('a single failure names the gate — write-set and test-integrity are different diagnoses', () => {
    assert.equal(chipLabel(report(gate('write-set', 'fail'))), 'write-set ✗')
    assert.equal(chipLabel(report(gate('test-integrity', 'fail'))), 'test-integrity ✗')
  })

  test('multiple failures name the first and carry +N for the rest', () => {
    assert.equal(
      chipLabel(report(gate('write-set', 'fail'), gate('lint', 'fail'), gate('build', 'fail'))),
      'write-set +2 ✗'
    )
  })

  test('a fail alongside unverifiable gates still labels the failure', () => {
    assert.equal(
      chipLabel(report(gate('build', 'fail'), gate('task-tests', 'unverifiable', 'no_command'))),
      'build ✗'
    )
  })

  test('the amber state is spelled out as a word, not a bare ?', () => {
    const label = chipLabel(report(gate('task-tests', 'unverifiable', 'no_command')))
    assert.ok(label.startsWith('unverifiable'), `expected a worded amber chip, got "${label}"`)
    assert.ok(!label.includes('?'), 'the ? glyph is gone from the amber chip')
  })

  test('unverifiable surfaces the reason — no command is a setup task, no git is a blind gate', () => {
    assert.equal(
      chipLabel(report(gate('task-tests', 'unverifiable', 'no_command'))),
      'unverifiable · no command'
    )
    assert.equal(
      chipLabel(report(gate('write-set', 'unverifiable', 'no_git'))),
      'unverifiable · no git'
    )
  })

  test('reasons are humanised — no snake_case ever reaches the chip', () => {
    assert.equal(
      chipLabel(report(gate('task-tests', 'unverifiable', 'vacuous_test'))),
      'unverifiable · already green'
    )
    assert.equal(
      chipLabel(report(gate('lint', 'unverifiable', 'command_missing'))),
      'unverifiable · runner missing'
    )
  })

  test('several unverifiable gates surface the DOMINANT reason plus +N', () => {
    assert.equal(
      chipLabel(
        report(
          gate('write-set', 'unverifiable', 'no_packet'),
          gate('lint', 'unverifiable', 'no_command'),
          gate('build', 'unverifiable', 'no_command')
        )
      ),
      'unverifiable · no command +2',
      'no_command (2) outranks no_packet (1) even though no_packet came first'
    )
  })

  test('a tie between reasons keeps the first-seen one — deterministic label', () => {
    assert.equal(
      chipLabel(
        report(gate('lint', 'unverifiable', 'timeout'), gate('build', 'unverifiable', 'no_command'))
      ),
      'unverifiable · timed out +1'
    )
  })

  test('an unverifiable gate with no reason at all degrades to a word, not undefined', () => {
    const label = chipLabel(report(gate('structural', 'unverifiable')))
    assert.equal(label, 'unverifiable · unknown')
    assert.ok(!label.includes('undefined'))
  })

  test('an empty report says no gates ran, never a pass', () => {
    assert.equal(chipLabel(report()), 'unverifiable · no gates ran')
  })
})

describe('gate reasons are humanised for display', () => {
  test('every reason renders as spaced words, never snake_case', () => {
    const reasons: GateResult['reason'][] = [
      'no_command',
      'no_packet',
      'no_git',
      'timeout',
      'command_error',
      'command_missing',
      'no_tests',
      'vacuous_test',
      'preexisting_failure',
      'analysis_unavailable',
      'finding_unresolved',
      'pass_error'
    ]
    for (const reason of reasons) {
      const label = describeReason(reason)
      assert.ok(!label.includes('_'), `${reason} still renders with an underscore: ${label}`)
      assert.ok(label.length > 0)
    }
  })

  test('an absent reason is "unknown", not empty or undefined', () => {
    assert.equal(describeReason(undefined), 'unknown')
  })

  test('the tooltip humanises too — it lists gate + worded reason', () => {
    assert.equal(
      chipTip(report(gate('lint', 'unverifiable', 'no_command'))),
      'Unverifiable: lint (no command)'
    )
  })
})

describe('task-row description marker stripping', () => {
  test('[US1][P] prefixes never reach the row text', () => {
    assert.equal(stripTaskMarkers('[US1][P] Add the login form'), 'Add the login form')
  })

  test('sequential markers strip regardless of case or order', () => {
    assert.equal(stripTaskMarkers('[p][us12] Wire the store'), 'Wire the store')
    assert.equal(stripTaskMarkers('[S] Serial task'), 'Serial task')
  })

  test('a description with no markers is returned intact', () => {
    assert.equal(stripTaskMarkers('Refactor the gate chip'), 'Refactor the gate chip')
  })

  test('bracketed text that is not a marker survives', () => {
    assert.equal(stripTaskMarkers('[US1] Fix the [P0] regression'), 'Fix the [P0] regression')
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
