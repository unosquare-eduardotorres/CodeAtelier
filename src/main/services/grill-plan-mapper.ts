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
 * Convert a GrillStructuredPlan into a chat StructuredPlan. Intentionally
 * minimal — `constraints` and the verbose `requirementDocument` are left out;
 * the decisions + phases carry the substance the card renders. Severities are
 * faithful ("medium"), never fabricated as "high".
 */
export function grillPlanToStructuredPlan(grill: GrillStructuredPlan): StructuredPlan {
  const phases = grill.items.map((item, i) => ({
    id: i + 1,
    title: item.title,
    complexity: Math.min(10, Math.max(1, item.files.length + item.dependsOn.length)),
    fileCount: item.files.length,
    risk: (item.dependsOn.length > 2 ? 'high' : item.files.length > 5 ? 'medium' : 'low') as
      | 'low'
      | 'medium'
      | 'high',
    description: item.description,
    files: item.files.map((f) => ({ file: f, change: `[${item.scope}] ${item.title}` }))
  }))

  const decisions = grill.decisions.flatMap((t) =>
    t.items.map((d) => ({ what: `${d.question} → ${d.answer}`, why: d.rationale }))
  )

  return {
    type: GOAL_TYPE_MAP[grill.goalType],
    title: grill.title,
    summary: grill.summary,
    decisions: decisions.length ? decisions : undefined,
    phases: phases.length ? phases : undefined,
    files: [...new Set(grill.items.flatMap((i) => i.files))],
    risks: grill.risks.length
      ? grill.risks.map((r) => ({ risk: r, severity: 'medium' as const }))
      : undefined,
    expectedOutcome: grill.summary
  }
}
