/**
 * audit.adapter — Converts Audit results + findings into a HandoffEnvelope.
 *
 * Maps audit findings to remainingWork, severity to priority, and
 * track scores to completedWork.
 */

import { HandoffSourceAdapter } from './base.adapter'
import type {
  CompletedStep,
  RemainingStep,
  HandoffDecision,
  HandoffRisk,
  ArtifactRef,
  HandoffSource,
  HandoffPriority
} from '../../../shared/handoff-types'
import type { AuditResult } from '../../../shared/types'

// ── Input Shape ──────────────────────────────────────────────────────

export interface AuditAdapterInput {
  auditRunId: string
  results: AuditResult[]
  overallScore: number | null
  planRecordId?: string
}

// ── Severity Mapping ─────────────────────────────────────────────────

/** Maps audit severity → handoff priority / risk severity (same union type). */
const SEVERITY_MAP: Record<string, HandoffPriority> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'low'
}

// ── Adapter ──────────────────────────────────────────────────────────

class AuditHandoffAdapter extends HandoffSourceAdapter<AuditAdapterInput> {
  readonly source: HandoffSource = 'audit'

  extractIntent(input: AuditAdapterInput): string {
    const allFindings = input.results.flatMap((r) => r.findings)
    const critical = allFindings.filter((f) => f.severity === 'critical' || f.severity === 'high')
    if (critical.length > 0) {
      return `Fix ${critical.length} critical/high audit finding${critical.length === 1 ? '' : 's'}`
    }
    return `Address ${allFindings.length} audit finding${allFindings.length === 1 ? '' : 's'}`
  }

  extractOriginalGoal(input: AuditAdapterInput): string {
    return `Remediate findings from audit run ${input.auditRunId}`
  }

  extractContextSummary(input: AuditAdapterInput): string {
    const lines: string[] = []
    lines.push(`## Audit Summary`)
    if (input.overallScore !== null) {
      lines.push(`**Overall Score:** ${input.overallScore}/10`)
    }
    lines.push(`**Tracks evaluated:** ${input.results.length}`)

    const allFindings = input.results.flatMap((r) => r.findings)
    const bySeverity = groupBy(allFindings, (f) => f.severity)
    lines.push(`\n### Findings by Severity`)
    for (const [severity, findings] of Object.entries(bySeverity)) {
      lines.push(`- **${severity}**: ${findings.length}`)
    }

    for (const result of input.results) {
      if (result.findings.length === 0) continue
      lines.push(`\n### ${result.trackId} (${result.score ?? '—'}/10)`)
      lines.push(result.summary)
    }

    return lines.join('\n')
  }

  extractCompletedWork(input: AuditAdapterInput): CompletedStep[] {
    return input.results
      .filter((r) => r.status === 'completed')
      .map((r) => ({
        title: `Audited ${r.trackId}`,
        outcome: `Score: ${r.score ?? 'N/A'}/10, ${r.findings.length} finding(s)`
      }))
  }

  extractRemainingWork(input: AuditAdapterInput): RemainingStep[] {
    return input.results.flatMap((result) =>
      result.findings.map((finding) => ({
        title: finding.title,
        description: finding.recommendation
          ? `${finding.description}\n\n**Recommendation:** ${finding.recommendation}`
          : finding.description,
        priority: SEVERITY_MAP[finding.severity] ?? 'medium',
        estimatedComplexity:
          finding.severity === 'critical' ? 8 : finding.severity === 'high' ? 6 : 4
      }))
    )
  }

  extractDecisions(_input: AuditAdapterInput): HandoffDecision[] {
    // Audit doesn't produce decisions — only findings
    return []
  }

  extractConstraints(_input: AuditAdapterInput): string[] {
    return []
  }

  extractRisks(input: AuditAdapterInput): HandoffRisk[] {
    const critical = input.results.flatMap((r) =>
      r.findings.filter((f) => f.severity === 'critical' || f.severity === 'high')
    )
    return critical.map((f) => ({
      risk: f.title,
      severity: SEVERITY_MAP[f.severity] ?? 'medium',
      mitigation: f.recommendation
    }))
  }

  extractArtifacts(input: AuditAdapterInput): ArtifactRef[] {
    return [
      {
        type: 'finding',
        path: `audit-run:${input.auditRunId}`,
        description: `Audit run with ${input.results.flatMap((r) => r.findings).length} findings`
      }
    ]
  }

  extractFilesToReadFirst(input: AuditAdapterInput): string[] {
    const files = new Set<string>()
    for (const result of input.results) {
      for (const finding of result.findings) {
        if (finding.filePath) files.add(finding.filePath)
      }
    }
    return [...files]
  }

  extractStructuredPlanRef(input: AuditAdapterInput): string | undefined {
    return input.planRecordId
  }

  extractExtensions(input: AuditAdapterInput): Record<string, unknown> {
    return {
      auditRunId: input.auditRunId,
      overallScore: input.overallScore,
      trackCount: input.results.length,
      findingCount: input.results.flatMap((r) => r.findings).length
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {}
  for (const item of items) {
    const k = key(item)
    if (!groups[k]) groups[k] = []
    groups[k].push(item)
  }
  return groups
}

export const auditAdapter = new AuditHandoffAdapter()
