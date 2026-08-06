/**
 * grill-plan-mapper — Pure transform from a GrillStructuredPlan (produced by
 * grillPlanGeneratorService) to the chat StructuredPlan shape rendered by the
 * TaskPlanCard.
 *
 * Used by the grill→chat handoff to seed an already-generated plan as a real
 * assistant message instead of asking the LLM to re-derive one. Deterministic
 * and side-effect free.
 */

import type { GrillStructuredPlan, StructuredPlan, PlanType } from '../../shared/types'

/** Map the grill goal classification onto the chat plan `type`. */
const GOAL_TYPE_MAP: Record<GrillStructuredPlan['goalType'], PlanType> = {
  feature: 'feature',
  refactor: 'refactor',
  bugfix: 'bug',
  tests: 'refactor'
}

/**
 * Convert a GrillStructuredPlan into a chat StructuredPlan.
 * PLAN-GEN-05: Now includes `constraints` in the output so downstream agents
 * (Council, MPA) retain architectural constraints from the grill session.
 * The verbose `requirementDocument` is still omitted.
 */
export function grillPlanToStructuredPlan(grill: GrillStructuredPlan): StructuredPlan {
  // GRILL-MAP-01: Guard all item.files and item.dependsOn accesses against
  // undefined (malformed LLM output where fields may be missing)
  const phases = grill.items.map((item, i) => {
    const files = item.files ?? []
    const deps = item.dependsOn ?? []
    return {
      id: i + 1,
      title: item.title,
      complexity: Math.min(10, Math.max(1, files.length + deps.length)),
      fileCount: files.length,
      risk: (deps.length > 2 ? 'high' : files.length > 5 ? 'medium' : 'low') as
        'low' | 'medium' | 'high',
      description: item.description,
      files: files.map((f) => ({ file: f, change: `[${item.scope}] ${item.title}` }))
    }
  })

  const decisions = grill.decisions.flatMap((t) =>
    t.items.map((d) => ({ what: `${d.question} → ${d.answer}`, why: d.rationale }))
  )

  return {
    type: GOAL_TYPE_MAP[grill.goalType],
    title: grill.title,
    summary: grill.summary,
    goal: `Complete ${grill.title}: ${grill.items.map((i) => i.title).join(', ')}`,
    decisions: decisions.length ? decisions : undefined,
    phases: phases.length ? phases : undefined,
    // GRILL-MAP-01: Guard against undefined files in items (malformed LLM output)
    files: [...new Set(grill.items.flatMap((i) => i.files ?? []))],
    // PLAN-GEN-05: Include constraints so downstream agents retain them
    constraints: grill.constraints?.length ? grill.constraints : undefined,
    risks: grill.risks.length
      ? grill.risks.map((r) => ({ risk: r, severity: 'medium' as const }))
      : undefined,
    expectedOutcome: grill.summary
  }
}
