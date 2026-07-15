/**
 * Pure-logic functions extracted from blueprint.ipc.ts for testability.
 *
 * No Electron, no I/O, no service references — only computation over plain data.
 */

import type {
  BlueprintPhaseType,
  BlueprintPhase,
  GrillDecisionForBlueprint
} from '../../shared/blueprint-types'

// ── Valid Phase Set ──────────────────────────────────────────────────────────

/** The ordered set of valid blueprint phases. */
export const VALID_BLUEPRINT_PHASES: readonly BlueprintPhaseType[] = [
  'specify',
  'clarify',
  'plan',
  'tasks',
  'review',
  'build',
  'verify'
] as const

/**
 * Validate that a string is a valid BlueprintPhaseType.
 * Returns the typed value on success, null on failure.
 */
export function validateBlueprintPhase(phase: string): BlueprintPhaseType | null {
  return (VALID_BLUEPRINT_PHASES as readonly string[]).includes(phase)
    ? (phase as BlueprintPhaseType)
    : null
}

// ── Phase-to-Retry Selection ─────────────────────────────────────────────────

/**
 * Determine which phase to retry when a blueprint is in failed state.
 *
 * Priority: failed phase > active phase > currentPhase fallback.
 * Returns null if no candidate is found.
 */
export function selectPhaseToRetry(
  phases: BlueprintPhase[],
  currentPhase: BlueprintPhaseType | null
): BlueprintPhaseType | null {
  const failedPhase =
    phases.find((p) => p.status === 'failed') ?? phases.find((p) => p.status === 'active')
  return (failedPhase?.phase ?? currentPhase) as BlueprintPhaseType | null
}

// ── Grill Decision Extraction ────────────────────────────────────────────────

/**
 * Safely extract grill decisions from a blueprint's settingsJson.
 * Returns undefined when settingsJson is null/missing or has no grillDecisions.
 */
export function extractGrillDecisions(
  settingsJson: Record<string, unknown> | null | undefined
): GrillDecisionForBlueprint[] | undefined {
  if (!settingsJson) return undefined
  const decisions = settingsJson.grillDecisions
  if (!Array.isArray(decisions)) return undefined
  return decisions as GrillDecisionForBlueprint[]
}

// ── Reference Document Extraction ───────────────────────────────────────────

/** Inline type — matches the shape stored in settingsJson.referenceDocuments */
interface ReferenceDocument {
  type: string
  path: string
  name?: string
}

/**
 * Safely extract reference documents from a blueprint's settingsJson.
 * Validates each entry has a `path` string. Returns undefined when
 * settingsJson is null/missing or contains no valid documents.
 */
export function extractReferenceDocuments(
  settingsJson: Record<string, unknown> | null | undefined
): ReferenceDocument[] | undefined {
  if (!settingsJson) return undefined
  const docs = settingsJson.referenceDocuments
  if (!Array.isArray(docs)) return undefined
  const valid = docs.filter(
    (d) => d && typeof d === 'object' && typeof (d as { path?: unknown }).path === 'string'
  )
  return valid.length > 0 ? (valid as ReferenceDocument[]) : undefined
}

// ── Approval Response Action ─────────────────────────────────────────────────

export type ApprovalAction =
  | { kind: 'build' }
  | { kind: 'rewind'; toPhase: BlueprintPhaseType }

/**
 * Determine the action to take based on an approval response.
 * Approved → trigger build. Rejected → rewind to plan phase.
 */
export function determineApprovalAction(approved: boolean): ApprovalAction {
  return approved ? { kind: 'build' } : { kind: 'rewind', toPhase: 'plan' }
}
