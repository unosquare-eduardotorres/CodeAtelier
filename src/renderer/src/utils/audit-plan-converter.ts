/**
 * Converts an AuditPlan (from the auditor) into a StructuredPlan (for TaskPlanCard).
 * This allows audit plans to render as rich cards in chat using the existing
 * plan card infrastructure with type: 'audit' section sequencing.
 */
import type { AuditPlan, StructuredPlan, PlanPhase } from '../../../shared/types'

export function auditPlanToStructuredPlan(plan: AuditPlan): StructuredPlan {
  const severityToComplexity: Record<string, number> = {
    critical: 9,
    high: 7,
    medium: 5,
    low: 3,
    info: 1
  }
  const severityToRisk: Record<string, 'low' | 'medium' | 'high'> = {
    critical: 'high',
    high: 'high',
    medium: 'medium',
    low: 'low',
    info: 'low'
  }

  // Map audit items to phases
  const phases: PlanPhase[] = plan.items.map((item, i) => ({
    id: i + 1,
    title: item.title,
    description: item.description + (item.recommendation ? `\n\n💡 ${item.recommendation}` : ''),
    complexity: severityToComplexity[item.severity ?? 'medium'] ?? 5,
    risk: severityToRisk[item.severity ?? 'medium'] ?? 'medium',
    fileCount: item.files.length,
    files: item.files.map((f) => ({ file: f, change: item.scope }))
  }))

  // Map risks
  const risks = plan.risks.map((risk) => ({
    risk,
    severity: 'medium' as const
  }))

  // Build decisions from scope groupings
  const scopeGroups = new Map<string, string[]>()
  for (const item of plan.items) {
    const existing = scopeGroups.get(item.scope) ?? []
    existing.push(item.title)
    scopeGroups.set(item.scope, existing)
  }
  const decisions = Array.from(scopeGroups.entries()).map(([scope, titles]) => ({
    what: `${scope}: ${titles.join(', ')}`,
    why: `${titles.length} remediation item${titles.length !== 1 ? 's' : ''} in ${scope} scope`
  }))

  return {
    type: 'audit',
    title: plan.title,
    summary: plan.summary,
    phases,
    risks,
    decisions,
    implementationOrder: phases.map((p) => p.id),
    filesChanged: plan.items.flatMap((item) =>
      item.files.map((f) => ({ file: f, change: `${item.title} (${item.scope})` }))
    )
  }
}
