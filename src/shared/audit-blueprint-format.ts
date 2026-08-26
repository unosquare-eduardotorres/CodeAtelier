/**
 * Pure formatting for the Audit → Blueprint handoff.
 *
 * The blueprint's Specify phase reads the description as the requirement, so
 * everything the pipeline needs about a finding — severity, file, the auditor's
 * recommendation — has to survive in the markdown. Nothing here touches the DB
 * or Electron, which keeps it unit-testable and usable from either process.
 */

import type { BlueprintPriority } from './blueprint-types'
import type { AuditFinding } from './types'

const SEVERITY_RANK: Record<AuditFinding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
}

/**
 * Worst severity in the set decides the blueprint priority.
 *
 * A batch containing one critical finding is a P1 regardless of how many low
 * ones came along with it — the batch is only done when the critical is fixed.
 */
export function deriveBlueprintPriority(findings: readonly AuditFinding[]): BlueprintPriority {
  if (findings.some((f) => f.severity === 'critical')) return 'P1'
  if (findings.some((f) => f.severity === 'high')) return 'P2'
  return 'P3'
}

/** Blueprint title for a batch of findings. Plain text — no emoji in branch names. */
export function buildAuditBlueprintTitle(findings: readonly AuditFinding[]): string {
  const count = findings.length
  return `Audit remediation: ${count} finding${count === 1 ? '' : 's'}`
}

/**
 * Markdown requirement document for a batch of findings, worst severity first.
 *
 * Ordering matters: BUILD works the list top-down, and a blueprint that runs out
 * of budget should have spent it on the critical findings.
 */
export function formatAuditFindingsBrief(
  findings: readonly AuditFinding[],
  opts: { auditRunId?: string } = {}
): string {
  const ordered = [...findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
  )

  const sections: string[] = [
    '## Audit remediation',
    `${ordered.length} finding${ordered.length === 1 ? '' : 's'} selected from a workspace health audit` +
      `${opts.auditRunId ? ` (run \`${opts.auditRunId}\`)` : ''}. ` +
      'Each item below is an independent defect — implement them all, and keep the existing behaviour intact.'
  ]

  sections.push(
    ordered
      .map((f, i) => {
        const lines = [`### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`, f.description]
        if (f.filePath) lines.push(`**File:** \`${f.filePath}\``)
        if (f.recommendation) lines.push(`**Auditor recommendation:** ${f.recommendation}`)
        return lines.join('\n\n')
      })
      .join('\n\n')
  )

  const files = [...new Set(ordered.map((f) => f.filePath).filter((p): p is string => !!p))]
  if (files.length > 0) {
    sections.push(`### Files in scope\n\n${files.map((p) => `- \`${p}\``).join('\n')}`)
  }

  return sections.join('\n\n')
}
