/**
 * Pure label logic for the blueprint task-row chips.
 *
 * Split out of BlueprintExecutionPanel so the strings can be asserted directly
 * rather than mirrored in a test: these words are what a user reads to decide
 * what to do next, so they are worth pinning.
 *
 * The component keeps all JSX and styling; this module only decides text.
 */

import type {
  GateReport,
  GateResult,
  GateVerdict,
  UnverifiableReason
} from '../../../../../shared/gate-types'

// ── Description markers ─────────────────────────────────────────────────────

/**
 * Strip [US1]/[P]/[S] markers from a task description.
 *
 * The markers are planner bookkeeping, not content: only some planners prefix
 * descriptions with them, so they are never rendered. Parallelism comes from
 * the `isParallel` column, which is always populated.
 */
export function stripTaskMarkers(description: string): string {
  return description
    .replace(/\[US\d+\]/gi, '')
    .replace(/\[P\]/gi, '')
    .replace(/\[S\]/gi, '')
    .trim()
}

// ── Gate chip ───────────────────────────────────────────────────────────────

/**
 * Human words for the machine reasons that land in the unverified ledger.
 *
 * Typed against the full union so adding an `UnverifiableReason` fails the
 * typecheck here rather than silently rendering snake_case in the UI.
 */
const REASON_LABEL: Record<UnverifiableReason, string> = {
  no_command: 'no command',
  no_packet: 'no packet',
  no_git: 'no git',
  timeout: 'timed out',
  command_error: 'command error',
  command_missing: 'runner missing',
  no_tests: 'no tests',
  vacuous_test: 'already green',
  preexisting_failure: 'broken on arrival',
  analysis_unavailable: 'no analysis',
  finding_unresolved: 'finding unresolved',
  pass_error: 'review errored'
}

/** Humanise one reason. Unknown/absent values degrade to readable text, never `undefined`. */
export function describeReason(reason: UnverifiableReason | undefined): string {
  if (!reason) return 'unknown'
  const label: string | undefined = REASON_LABEL[reason]
  return label ?? String(reason).replace(/_/g, ' ')
}

/** Most common reason across a set of unverifiable gates; first-seen wins a tie. */
function dominantReason(gates: readonly GateResult[]): string {
  const counts = new Map<UnverifiableReason | undefined, number>()
  for (const g of gates) counts.set(g.reason, (counts.get(g.reason) ?? 0) + 1)

  let best: UnverifiableReason | undefined
  let bestCount = 0
  for (const [reason, count] of counts) {
    if (count > bestCount) {
      best = reason
      bestCount = count
    }
  }
  return describeReason(best)
}

export interface GateChip {
  verdict: GateVerdict
  label: string
  tip: string
}

/**
 * Derive the task-row gate chip.
 *
 * The label names the problem instead of counting it: which gate failed
 * (`write-set` and `test-integrity` are unrelated diagnoses), or why the amber
 * ones could not run (`no command` is a setup task; `no git`/`no packet` mean
 * the gate system itself was blind). `+N` carries the remainder.
 *
 * Mirrors aggregateVerdict: an empty report is `unverifiable`, never a silent
 * pass — nothing was checked.
 */
export function deriveGateChip(report: GateReport): GateChip {
  const failed = report.gates.filter((g) => g.verdict === 'fail')
  const unverifiable = report.gates.filter((g) => g.verdict === 'unverifiable')

  if (failed.length > 0) {
    const head = failed[0].name
    return {
      verdict: 'fail',
      label: failed.length > 1 ? `${head} +${failed.length - 1} ✗` : `${head} ✗`,
      tip: `Failed: ${failed.map((g) => g.name).join(', ')}`
    }
  }

  if (unverifiable.length === 0 && report.gates.length > 0) {
    return { verdict: 'pass', label: 'gates ✓', tip: 'All deterministic gates passed' }
  }

  if (unverifiable.length === 0) {
    return {
      verdict: 'unverifiable',
      label: 'unverifiable · no gates ran',
      tip: 'No gates ran for this task — nothing was verified'
    }
  }

  const head = dominantReason(unverifiable)
  return {
    verdict: 'unverifiable',
    label:
      unverifiable.length > 1
        ? `unverifiable · ${head} +${unverifiable.length - 1}`
        : `unverifiable · ${head}`,
    tip: `Unverifiable: ${unverifiable.map((g) => `${g.name} (${describeReason(g.reason)})`).join(', ')}`
  }
}
