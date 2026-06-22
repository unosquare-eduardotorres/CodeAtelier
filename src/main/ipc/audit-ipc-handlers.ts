/**
 * Pure-logic functions extracted from audit.ipc.ts for testability.
 *
 * These functions contain no Electron, no I/O, and no service references —
 * only computation over plain data. The IPC handler wrappers delegate here
 * after validating the sender and fetching data from repositories.
 */

import { AUDIT_TRACKS } from '../../shared/constants'
import type {
  AuditFinding,
  AuditResult,
  AuditRun,
  AuditPlan
} from '../../shared/types'

// ── Overall Score ────────────────────────────────────────────────────────────

export interface OverallScoreResult {
  overallScore: number | null
  status: 'completed' | 'partial'
}

/**
 * Compute the weighted overall score from a set of audit results.
 * Mirrors the post-rerun recalculation in audit:rerunTrack.
 *
 * - Only completed results with non-null scores and sufficient coverage count.
 * - Uses AUDIT_TRACKS weights (default 1.0).
 * - Returns 'partial' status if any track failed.
 */
export function computeAuditOverallScore(results: AuditResult[]): OverallScoreResult {
  const completed = results.filter(
    (r) => r.status === 'completed' && r.score !== null && r.coverageSufficient !== false
  )
  const hasFailed = results.some((r) => r.status === 'failed')

  let overallScore: number | null = null
  if (completed.length > 0) {
    let weightedSum = 0
    let totalWeight = 0
    for (const r of completed) {
      const w = AUDIT_TRACKS[r.trackId]?.weight ?? 1.0
      weightedSum += (r.score ?? 0) * w
      totalWeight += w
    }
    overallScore = Math.round(weightedSum / totalWeight)
  }

  const status = hasFailed ? 'partial' : 'completed'
  return { overallScore, status }
}

// ── Stale Run Reconciliation ─────────────────────────────────────────────────

export interface StaleReconciliation {
  /** Result IDs whose status should be set to 'cancelled'. */
  resultIdsToCancel: string[]
  /** Final run status after reconciliation. */
  finalStatus: 'partial' | 'cancelled'
}

/**
 * Determine what needs to change when a "running" audit is detected but the
 * agent process is no longer active (e.g. after an app restart).
 *
 * Returns the list of result IDs to cancel and the final run status.
 */
export function computeStaleAuditReconciliation(results: AuditResult[]): StaleReconciliation {
  const resultIdsToCancel = results
    .filter((r) => r.status === 'running' || r.status === 'pending')
    .map((r) => r.id)

  const hasCompleted = results.some((r) => r.status === 'completed')
  const finalStatus: 'partial' | 'cancelled' = hasCompleted ? 'partial' : 'cancelled'

  return { resultIdsToCancel, finalStatus }
}

// ── Markdown: Health Report ──────────────────────────────────────────────────

/**
 * Build a Markdown health-report document from an audit run.
 * Pure string construction — no I/O.
 */
export function generateAuditReportMarkdown(run: AuditRun, workspaceName: string): string {
  const date = new Date(run.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })

  const lines: string[] = [
    `# Workspace Health Report`,
    `**Workspace:** ${workspaceName} | **Mode:** ${run.mode === 'light' ? 'Light' : 'Deep'} | **Date:** ${date} | **Overall Score:** ${run.overallScore ?? '—'}/100`,
    ''
  ]

  for (const trackId of run.selectedTracks) {
    const track = AUDIT_TRACKS[trackId]
    const result = run.results.find((r) => r.trackId === trackId)
    if (!track || !result) continue

    lines.push(`## ${track.name} — ${result.score ?? '—'}/100`)
    if (result.summary) {
      lines.push(result.summary)
    }
    lines.push('')

    if (result.findings.length > 0) {
      lines.push('### Findings')
      lines.push('| Severity | Title | File | Recommendation |')
      lines.push('|----------|-------|------|----------------|')
      for (const f of result.findings) {
        lines.push(
          `| ${f.severity.toUpperCase()} | ${f.title} | ${f.filePath ?? '—'} | ${f.recommendation ?? '—'} |`
        )
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

// ── Markdown: Remediation Plan ───────────────────────────────────────────────

/**
 * Build a Markdown remediation-plan document from a structured AuditPlan.
 * Used as fallback when `plan.requirementDocument` is empty.
 */
export function generateRemediationPlanMarkdown(
  plan: AuditPlan,
  workspaceName: string,
  createdAt: string
): string {
  const date = new Date(createdAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })

  const lines: string[] = [
    `# ${plan.title}`,
    '',
    `**Workspace:** ${workspaceName} | **Date:** ${date} | **Items:** ${plan.items.length} | **Findings addressed:** ${plan.sourceFindingIds.length}`,
    '',
    plan.summary,
    ''
  ]

  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i]
    const severity = item.severity ? ` \`${item.severity.toUpperCase()}\`` : ''
    lines.push(`## ${i + 1}. ${item.title}${severity}`)
    lines.push('')
    lines.push(`**Scope:** ${item.scope}`)
    lines.push('')
    lines.push(item.description)
    lines.push('')
    if (item.recommendation) {
      lines.push(`> 💡 ${item.recommendation}`)
      lines.push('')
    }
    if (item.files.length > 0) {
      lines.push(`**Files:** ${item.files.map((f) => '\`' + f + '\`').join(', ')}`)
      lines.push('')
    }
    if (item.dependsOn && item.dependsOn.length > 0) {
      lines.push(`**Depends on:** ${item.dependsOn.join(', ')}`)
      lines.push('')
    }
  }

  if (plan.risks.length > 0) {
    lines.push('## ⚠️ Risks')
    lines.push('')
    for (const risk of plan.risks) {
      lines.push(`- ${risk}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ── Findings Context Formatting ──────────────────────────────────────────────

/**
 * Format audit findings as numbered markdown sections for use as conversation
 * context when routing findings to plan-mode chat.
 */
export function formatFindingsAsContext(findings: AuditFinding[]): string {
  return findings
    .map(
      (f, i) =>
        `### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}\n${f.description}` +
        (f.filePath ? `\n**File:** \`${f.filePath}\`` : '') +
        (f.recommendation ? `\n**Recommendation:** ${f.recommendation}` : '')
    )
    .join('\n\n')
}
