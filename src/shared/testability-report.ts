/**
 * The Testability Ledger report — what this blueprint did NOT prove.
 *
 * Motivating failure: a blueprint finishes "green" having only ever proven that
 * the code compiles. Components are created but never mounted, buttons are
 * wired to nothing, mock data is left in place, and the human discovers all of
 * it after every code phase has already run. The evidence needed to catch that
 * earlier already exists — it is just scattered across three places that are
 * only ever read one at a time:
 *
 *   - `blueprint_tasks.outcomeKind` — how each task was CLOSED, as opposed to
 *     merely that it closed (`unproven`, `preexisting`, `accepted_by_user`, …)
 *   - `blueprints.unverifiedJson`   — the gate ledger: checks that could not run
 *   - the REVIEW `preflight` artifact — environment blockers found before BUILD
 *
 * This module joins them into one ordered, exportable list of work whose
 * correctness nobody has demonstrated, so the human can turn it into follow-up
 * scope deliberately instead of discovering it by accident.
 *
 * Pure and dependency-free on purpose: the exporter (main) and any preview UI
 * (renderer) must render byte-identical text, and the whole matrix has to be
 * unit-testable without a database or an Electron dialog.
 */

import {
  VERIFICATION_DEPTHS,
  type BlueprintTask,
  type BlueprintTaskOutcomeKind,
  type VerificationDepth
} from './blueprint-types'
import type { GateName, UnverifiedItem } from './gate-types'
import type { PreflightCheck } from './preflight-types'

// ── Classification ──

/**
 * Why one entry landed in the report. Ordered by how much human attention it
 * deserves, strongest first — `SEVERITY_ORDER` below depends on this reading.
 */
export type TestabilityReason =
  /** The depth the human chose required this proof and it was not obtained. */
  | 'requested-proof-missing'
  /** The task failed outright, or was skipped without ever being proven. */
  | 'never-completed'
  /** An environment blocker made the work impossible to exercise. */
  | 'blocked-by-environment'
  /** The task closed, but nothing mechanically demonstrated it works. */
  | 'closed-unproven'
  /** A check could not run, for a reason that is neither of the above. */
  | 'check-could-not-run'

const SEVERITY_ORDER: readonly TestabilityReason[] = [
  'requested-proof-missing',
  'never-completed',
  'blocked-by-environment',
  'closed-unproven',
  'check-could-not-run'
]

const REASON_HEADINGS: Record<TestabilityReason, string> = {
  'requested-proof-missing': 'Requested proof never obtained',
  'never-completed': 'Never completed',
  'blocked-by-environment': 'Blocked by the environment',
  'closed-unproven': 'Closed without proof it works',
  'check-could-not-run': 'Checks that could not run'
}

const REASON_BLURBS: Record<TestabilityReason, string> = {
  'requested-proof-missing':
    'You asked for this level of verification and the pipeline could not deliver it. Nothing below was demonstrated to work end to end.',
  'never-completed':
    'These tasks did not finish. Anything depending on them is unimplemented, not merely untested.',
  'blocked-by-environment':
    'Real infrastructure was missing, so this work could never be exercised on this machine. These are setup tasks, not code defects.',
  'closed-unproven':
    'These tasks were closed, but no mechanical check demonstrated the result. This is where unwired components and placeholder data survive.',
  'check-could-not-run':
    'These checks were attempted and could not complete. Their subject matter is unproven either way.'
}

/** One row of the report. */
export interface TestabilityEntry {
  reason: TestabilityReason
  /** Task id ('T003'), gate name, or preflight check id. */
  ref: string
  /** One-line description of the thing that is unproven. */
  title: string
  /** Why it is unproven, in the user's terms. */
  detail: string
  /** Concrete next action, when one can be stated mechanically. */
  suggestedAction?: string
}

/**
 * Gate ledger reasons that describe a broken/absent ENVIRONMENT rather than a
 * check that merely had nothing to look at. These become follow-up setup work.
 */
const ENVIRONMENTAL_REASONS: ReadonlySet<string> = new Set([
  'command_missing',
  'import_env',
  'timeout',
  'command_error',
  'no_git'
])

/** Task outcomes that closed the task WITHOUT proving it works. */
const UNPROVEN_OUTCOMES: Record<Exclude<BlueprintTaskOutcomeKind, 'verified'>, string> = {
  unproven: 'Claimed files exist, but none could be proven written during this run.',
  preexisting: 'The agent declared the files already correct and did not rewrite them.',
  accepted_by_user: 'Closed by a human decision, not by a passing check.',
  needs_scope_amendment:
    'Parked: the fix lay outside the task’s write-set, so the gates would not let it land.',
  nudged: 'The turn produced no completion block; a recovery nudge rescued the result.'
}

/** Which gates a given depth demanded actually run. */
export function requiredGatesForDepth(depth: VerificationDepth): readonly GateName[] {
  if (depth === 'e2e') return ['smoke', 'e2e']
  if (depth === 'integration') return ['smoke']
  return []
}

export interface TestabilityReportInput {
  blueprint: {
    title: string
    status: string
    /** `blueprints.settingsJson` — read only for the depth. */
    verificationDepth: VerificationDepth
    unverifiedJson?: readonly UnverifiedItem[] | null
  }
  tasks?: readonly BlueprintTask[]
  /** Checks from the REVIEW-phase `preflight` artifact, when present. */
  preflight?: readonly PreflightCheck[]
  /** Injectable for deterministic tests. */
  generatedAt?: string
}

/**
 * Join the three evidence sources into a flat, severity-ordered entry list.
 *
 * Exported separately from the Markdown renderer so a UI can show the same
 * data without going through text.
 */
export function collectTestabilityEntries(input: TestabilityReportInput): TestabilityEntry[] {
  const entries: TestabilityEntry[] = []
  const depth = input.blueprint.verificationDepth
  const required = new Set<GateName>(requiredGatesForDepth(depth))

  // 1. Tasks that never finished, and tasks that closed without proof.
  for (const task of input.tasks ?? []) {
    const ref = task.taskId
    const title = firstLine(task.description)

    if (task.status === 'failed') {
      entries.push({
        reason: 'never-completed',
        ref,
        title,
        detail: task.failureReason
          ? `Failed: ${firstLine(task.failureReason)}`
          : 'Failed without a recorded reason.',
        suggestedAction: 'Re-run this task, or descope it explicitly.'
      })
      continue
    }

    if (task.status === 'skipped' || task.skippedByUserAt) {
      entries.push({
        reason: 'never-completed',
        ref,
        title,
        detail: task.skippedByUserAt
          ? 'Skipped by a human decision — never executed.'
          : 'Skipped by the failure cascade — never executed.',
        suggestedAction: 'Confirm this is genuinely out of scope, or schedule it.'
      })
      continue
    }

    if (task.status !== 'complete') continue

    // Completed. Was it PROVEN?
    if (task.outcomeKind === 'verified') continue

    if (task.outcomeKind && task.outcomeKind in UNPROVEN_OUTCOMES) {
      entries.push({
        reason: 'closed-unproven',
        ref,
        title,
        detail: UNPROVEN_OUTCOMES[task.outcomeKind as keyof typeof UNPROVEN_OUTCOMES],
        suggestedAction: 'Open the files this task claimed and confirm the behaviour by hand.'
      })
      continue
    }

    if (!task.outcomeKind) {
      entries.push({
        reason: 'closed-unproven',
        ref,
        title,
        detail: 'Completed with no recorded outcome — nothing attests to what it produced.',
        suggestedAction: 'Open the files this task claimed and confirm the behaviour by hand.'
      })
    }
  }

  // 2. The gate ledger.
  for (const item of input.blueprint.unverifiedJson ?? []) {
    const isRequired = required.has(item.gate)
    const reason: TestabilityReason = isRequired
      ? 'requested-proof-missing'
      : ENVIRONMENTAL_REASONS.has(item.reason)
        ? 'blocked-by-environment'
        : 'check-could-not-run'

    entries.push({
      reason,
      ref: item.gate,
      title: gateTitle(item.gate, item.taskId),
      detail: item.detail ? `${item.reason} — ${item.detail}` : String(item.reason),
      suggestedAction: isRequired
        ? `Provide a ${item.gate} command (workspace settings → Gate Commands) and re-run VERIFY.`
        : undefined
    })
  }

  // 3. Preflight blockers and warnings — real infrastructure that was absent.
  for (const check of input.preflight ?? []) {
    if (check.status === 'pass') continue
    entries.push({
      reason: 'blocked-by-environment',
      ref: check.id,
      title: `${check.name} (${check.kind})`,
      detail: check.message,
      suggestedAction: check.remediation
    })
  }

  entries.sort((a, b) => SEVERITY_ORDER.indexOf(a.reason) - SEVERITY_ORDER.indexOf(b.reason))
  return entries
}

/**
 * Stable identity for one ledger row, used to remember which rows already became
 * follow-up ideas.
 *
 * Lives here rather than beside the exporter because BOTH sides need it: main
 * writes the entryKey → ideaId map, and the renderer decides which checkboxes to
 * disable. Two implementations of the same key would drift and silently offer
 * the same row twice.
 *
 * `ref` alone is not unique — two gate rows can share a gate name — so the
 * reason and title participate.
 */
export function testabilityEntryKey(entry: TestabilityEntry): string {
  return `${entry.reason}::${entry.ref}::${entry.title.slice(0, 120)}`
}

/** Render the ledger as a self-contained Markdown document. */
export function buildTestabilityReportMarkdown(input: TestabilityReportInput): string {
  const entries = collectTestabilityEntries(input)
  const depth = input.blueprint.verificationDepth
  const depthMeta = VERIFICATION_DEPTHS.find((d) => d.value === depth)
  const generatedAt = input.generatedAt ?? new Date().toISOString()

  const lines: string[] = []
  lines.push(`# Testability Ledger — ${input.blueprint.title}`)
  lines.push('')
  lines.push(`- **Blueprint status:** ${input.blueprint.status}`)
  lines.push(`- **Verification depth:** ${depthMeta?.label ?? depth} — ${depthMeta?.caveat ?? ''}`)
  lines.push(`- **Generated:** ${generatedAt}`)
  lines.push(`- **Open items:** ${entries.length}`)
  lines.push('')

  if (entries.length === 0) {
    lines.push(
      'Every task closed with a verified outcome and no check was left unrun at this depth.'
    )
    lines.push('')
    lines.push(
      `Note that "${depthMeta?.label ?? depth}" still leaves things unproven: ${depthMeta?.caveat ?? 'see the depth setting.'}`
    )
    lines.push('')
    return lines.join('\n')
  }

  lines.push(
    'Everything below is work whose correctness was **not demonstrated**. It is not a list of known bugs — it is the list of places a bug could be hiding unseen.'
  )
  lines.push('')

  for (const reason of SEVERITY_ORDER) {
    const group = entries.filter((e) => e.reason === reason)
    if (group.length === 0) continue

    lines.push(`## ${REASON_HEADINGS[reason]} (${group.length})`)
    lines.push('')
    lines.push(`> ${REASON_BLURBS[reason]}`)
    lines.push('')

    for (const entry of group) {
      lines.push(`- [ ] **${entry.ref}** — ${entry.title}`)
      lines.push(`  - ${entry.detail}`)
      if (entry.suggestedAction) lines.push(`  - _Next:_ ${entry.suggestedAction}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ── helpers ──

function firstLine(text: string): string {
  const line = text.split('\n')[0].trim()
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

function gateTitle(gate: GateName, taskId: string): string {
  const scope = taskId === 'verify' ? 'blueprint' : taskId
  return `${gate} gate (${scope})`
}
