/**
 * audit-handoff-formatter — Client-side formatters for building audit findings
 * context for the pendingFixContext pattern (pre-filling new chat).
 *
 * These mirror the backend formatters in audit-handoff.service.ts but run in
 * the renderer process for the "Send All to Chat" consolidated flow that goes
 * through the NewChatPage UI path (vs. the direct IPC "split" path).
 */

import { AUDIT_TRACKS } from '../../../shared/constants'
import type { AuditRun, AuditTrackId, AuditFinding, AuditResult } from '../../../shared/types'

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
}

/** Maximum findings to include inline per track to avoid oversized messages. */
const MAX_FINDINGS_PER_TRACK = 30

function sortBySeverity(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5)
  )
}

/**
 * Format findings from a single track with full detail.
 */
export function formatDirectFindings(result: AuditResult): string {
  const track = AUDIT_TRACKS[result.trackId]
  const trackName = track?.name ?? result.trackId
  const actionable = result.findings.filter((f) => f.severity !== 'info')
  const sorted = sortBySeverity(actionable)

  const lines: string[] = [
    `# 🔍 Audit Findings: ${trackName}`,
    '',
    `**Score:** ${result.score != null ? `${result.score}/100` : 'N/A'} | **${sorted.length} issue${sorted.length !== 1 ? 's' : ''} found**`,
    '',
    '## Issues to Fix',
    ''
  ]

  const capped = sorted.slice(0, MAX_FINDINGS_PER_TRACK)
  for (let i = 0; i < capped.length; i++) {
    const f = capped[i]
    lines.push(`### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`)
    lines.push(f.description)
    if (f.filePath) lines.push(`**File:** \`${f.filePath}\``)
    if (f.recommendation) lines.push(`**Recommendation:** ${f.recommendation}`)
    lines.push('')
  }
  if (sorted.length > MAX_FINDINGS_PER_TRACK) {
    lines.push(
      `*…and ${sorted.length - MAX_FINDINGS_PER_TRACK} more findings omitted for brevity.*`
    )
    lines.push('')
  }

  lines.push('---')
  lines.push(
    'Please analyze these findings and create an implementation plan with ordered steps to fix them.'
  )

  return lines.join('\n')
}

/**
 * Format findings from multiple tracks into a consolidated overview.
 */
export function formatConsolidatedPlan(run: AuditRun): string {
  const completedResults = run.results.filter((r) => r.status === 'completed')
  const allFindings = completedResults.flatMap((r) =>
    r.findings.filter((f) => f.severity !== 'info')
  )
  const totalIssues = allFindings.length

  const lines: string[] = [
    `# 🔍 Audit Health Report — ${run.overallScore != null ? `${run.overallScore}/100` : 'N/A'}`,
    '',
    `**${totalIssues} total issue${totalIssues !== 1 ? 's' : ''}** across ${completedResults.length} auditor${completedResults.length !== 1 ? 's' : ''}`,
    ''
  ]

  for (const result of completedResults) {
    const track = AUDIT_TRACKS[result.trackId]
    const trackName = track?.name ?? result.trackId
    const actionable = result.findings.filter((f) => f.severity !== 'info')
    if (actionable.length === 0) continue

    const sorted = sortBySeverity(actionable)
    const scoreLabel = result.score != null ? `${result.score}/100` : 'N/A'
    lines.push(
      `## ${trackName} (${scoreLabel}) — ${sorted.length} issue${sorted.length !== 1 ? 's' : ''}`
    )

    const capped = sorted.slice(0, MAX_FINDINGS_PER_TRACK)
    for (const f of capped) {
      const fileSuffix = f.filePath ? ` — \`${f.filePath}\`` : ''
      lines.push(`- [${f.severity.toUpperCase()}] ${f.title}: ${f.description}${fileSuffix}`)
    }
    if (sorted.length > MAX_FINDINGS_PER_TRACK) {
      lines.push(
        `- …and ${sorted.length - MAX_FINDINGS_PER_TRACK} more findings (omitted for brevity)`
      )
    }
    lines.push('')
  }

  // Key recommendations from highest-severity findings
  const topFindings = sortBySeverity(allFindings).slice(0, 5)
  if (topFindings.length > 0) {
    lines.push('## Key Recommendations')
    for (let i = 0; i < topFindings.length; i++) {
      const f = topFindings[i]
      lines.push(`${i + 1}. ${f.recommendation ?? f.title}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push(
    'Please synthesize an implementation plan that addresses these findings in priority order. Group related fixes, identify dependencies between them, and estimate relative effort.'
  )

  return lines.join('\n')
}

/**
 * Build the title for a handoff conversation.
 */
export function buildHandoffTitle(
  mode: 'consolidated' | 'split',
  trackId?: AuditTrackId,
  issueCount?: number
): string {
  if (mode === 'split' && trackId) {
    const track = AUDIT_TRACKS[trackId]
    const trackName = track?.name ?? trackId
    return `🔍 Audit: ${trackName} — Fix ${issueCount ?? 0} issue${issueCount !== 1 ? 's' : ''}`
  }
  return `🔍 Audit Health Report — Fix ${issueCount ?? 0} issue${issueCount !== 1 ? 's' : ''}`
}
