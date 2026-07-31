/**
 * audit-plan-mapper — Pure transform from an AuditPlan (produced by
 * auditPlanGeneratorService) to the chat StructuredPlan shape rendered by
 * TaskPlanCard.
 *
 * Mirrors grill-plan-mapper.ts in structure and intent. Used by the Plan Hub
 * registry when normalizing audit plans for the unified plans table.
 */

import type { AuditPlan, StructuredPlan } from '../../shared/types'

/** Audit severity → plan phase risk mapping */
const SEVERITY_TO_RISK: Record<string, 'low' | 'medium' | 'high'> = {
  info: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  critical: 'high'
}

/**
 * Convert an AuditPlan into a chat StructuredPlan. Items become phases,
 * severity maps to risk, and the audit-specific `recommendation` field is
 * folded into the phase description.
 */
export function auditPlanToStructuredPlan(audit: AuditPlan): StructuredPlan {
  const phases = audit.items.map((item, i) => ({
    id: i + 1,
    title: item.title,
    complexity: Math.min(10, Math.max(1, item.files.length + (item.dependsOn?.length ?? 0))),
    fileCount: item.files.length,
    risk: SEVERITY_TO_RISK[item.severity ?? 'medium'] ?? ('medium' as const),
    description: item.recommendation
      ? `${item.description}\n\n**Recommendation:** ${item.recommendation}`
      : item.description,
    files: item.files.map((f) => ({ file: f, change: `[${item.scope}] ${item.title}` }))
  }))

  const allFiles = [...new Set(audit.items.flatMap((i) => i.files))]

  return {
    type: 'audit',
    title: audit.title,
    summary: audit.summary,
    goal: `Resolve all ${audit.items.length} audit findings: ${audit.items.map((i) => i.title).join(', ')}`,
    phases: phases.length ? phases : undefined,
    files: allFiles.length ? allFiles : undefined,
    risks: audit.risks.length
      ? audit.risks.map((r) => ({ risk: r, severity: 'medium' as const }))
      : undefined,
    expectedOutcome: audit.summary
  }
}
