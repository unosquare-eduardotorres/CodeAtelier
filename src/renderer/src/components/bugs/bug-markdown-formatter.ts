import type { BugRecord } from '../../../../shared/types'

function severityIcon(severity: string): string {
  return severity === 'fatal' ? '🔴' : '🟠'
}

/** Escape pipe characters so they don't break markdown table cells */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|')
}

function formatIsoTimestamp(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

export function formatBugsAsMarkdown(bugs: BugRecord[]): string {
  const resolved = bugs.filter((b) => b.isResolved).length
  const unresolved = bugs.length - resolved
  const now = formatIsoTimestamp(new Date().toISOString())

  const lines: string[] = [
    '# Bug Report',
    '',
    `**Generated:** ${now}`,
    `**Total:** ${bugs.length} bug${bugs.length !== 1 ? 's' : ''} (${unresolved} unresolved, ${resolved} resolved)`,
    ''
  ]

  for (const bug of bugs) {
    lines.push('---', '')
    lines.push(`## ${severityIcon(bug.severity)} ${escapeCell(bug.errorMessage)}`, '')
    lines.push('| Field | Value |')
    lines.push('|---|---|')
    lines.push(`| **Severity** | ${bug.severity} |`)
    lines.push(`| **Process** | ${bug.process} |`)
    lines.push(`| **Status** | ${bug.isResolved ? 'Resolved' : 'Open'} |`)
    lines.push(`| **Occurrences** | ${bug.occurrenceCount} |`)
    lines.push(`| **First seen** | ${formatIsoTimestamp(bug.timestamp)} |`)
    lines.push(`| **Last seen** | ${formatIsoTimestamp(bug.lastSeenAt)} |`)

    const source = bug.sourceFile
      ? `${bug.sourceFile}${bug.sourceLine ? `:${bug.sourceLine}` : ''}${bug.sourceColumn ? `:${bug.sourceColumn}` : ''}`
      : '—'
    lines.push(`| **Source** | ${escapeCell(source)} |`)
    lines.push(`| **Component** | ${escapeCell(bug.componentName ?? '—')} |`)
    lines.push(`| **App Version** | ${escapeCell(bug.appVersion)} |`)

    if (bug.stackTrace) {
      lines.push('')
      lines.push('<details><summary>Stack Trace</summary>')
      lines.push('')
      lines.push('```')
      lines.push(bug.stackTrace)
      lines.push('```')
      lines.push('')
      lines.push('</details>')
    }

    lines.push('')
  }

  return lines.join('\n')
}
