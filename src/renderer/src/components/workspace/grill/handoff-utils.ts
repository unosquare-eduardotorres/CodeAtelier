import type { GrillStructuredPlan, DecisionEntry } from '../../../../../shared/types'
import type { GrillDecision } from '../../../../../shared/mpa-types'

/** Map grill decisions for MPA handoff. Prefer live session decisions;
 *  fall back to the persisted plan's decisions (review/recovery path). */
export function deriveGrillDecisions(
  plan: GrillStructuredPlan,
  sessionDecisions: DecisionEntry[]
): GrillDecision[] {
  if (sessionDecisions.length > 0) {
    return sessionDecisions.map((d) => ({
      header: d.question,
      selectedOption: d.answer,
      reason: d.questionFull ?? ''
    }))
  }
  return plan.decisions.flatMap((t) =>
    t.items.map((i) => ({ header: i.question, selectedOption: i.answer, reason: i.rationale }))
  )
}
