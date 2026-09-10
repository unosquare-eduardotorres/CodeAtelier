/**
 * Pure formatting for the Design-audit → Blueprint handoff.
 *
 * Mirrors audit-blueprint-format.ts: the blueprint's Specify phase reads the
 * description as the requirement, so the remediation brief carries everything
 * — goal, impeccable command routing, findings severity-ordered, files in
 * scope. Pure and process-agnostic; no DB, no Electron.
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

/** Worst severity decides the blueprint priority (same rule as audit). */
export function deriveBlueprintPriority(findings: readonly AuditFinding[]): BlueprintPriority {
  if (findings.some((f) => f.severity === 'critical')) return 'P1'
  if (findings.some((f) => f.severity === 'high')) return 'P2'
  return 'P3'
}

/** Blueprint title for a design remediation batch. Plain text — no emoji. */
export function buildDesignBlueprintTitle(commands: readonly string[], scopeLabel: string): string {
  const cmds = commands.length > 0 ? commands.slice(0, 3).join('+') : 'design'
  const more = commands.length > 3 ? `+${commands.length - 3}` : ''
  return `Design remediation (${cmds}${more}) — ${scopeLabel}`
}

// ── Finding → remediation cluster → impeccable command routing ──

export type DesignCluster =
  'safety' | 'theming' | 'typography' | 'performance' | 'slop' | 'copy' | 'motion' | 'general'

const CLUSTER_PATTERNS: [DesignCluster, RegExp][] = [
  [
    'safety',
    /accessib|a11y|contrast|wcag|keyboard|focus|aria|screen.?reader|alt.?text|lang=|danger|destructive|confirm/i
  ],
  [
    'theming',
    /theme|token|color|colour|palette|dark.?mode|light.?mode|porcelain|contrast ratio|hex|hard.?coded/i
  ],
  [
    'typography',
    /typograph|font|text size|text-\[|px text|line.?length|measure|heading|hierarchy|tracking|letter.?spacing/i
  ],
  [
    'performance',
    /performance|render|re.?render|memo|lazy|bundle|startup|virtualiz|layout thrash|will-change/i
  ],
  ['motion', /animation|motion|easing|bounce|transition|marquee|reduced.?motion/i],
  ['copy', /copy|label|wording|message|jargon|placeholder|tooltip|error text|empty state text/i],
  ['slop', /slop|ai.?tell|side.?tab|gradient text|overused|generic|interchangeable|em.?dash/i]
]

/**
 * Classify a finding into a remediation cluster. Detector findings (source
 * 'impeccable-detector') are slop-pattern hits by construction — they route
 * to polish/distill without pattern inspection.
 */
export function classifyFinding(f: AuditFinding): DesignCluster {
  if (f.source === 'impeccable-detector') return 'slop'
  const text = `${f.title} ${f.description} ${f.recommendation ?? ''}`
  for (const [cluster, re] of CLUSTER_PATTERNS) {
    if (re.test(text)) return cluster
  }
  return 'general'
}

/** Impeccable's own command vocabulary, per the design-audit plan (P6.1). */
export const CLUSTER_COMMANDS: Record<DesignCluster, readonly string[]> = {
  safety: ['harden'],
  theming: ['polish', 'colorize'],
  typography: ['typeset'],
  performance: ['optimize'],
  slop: ['polish', 'distill'],
  copy: ['clarify'],
  motion: ['animate'],
  general: ['polish']
}

/** Severity-first ordering; BUILD works the list top-down. */
function bySeverity(a: AuditFinding, b: AuditFinding): number {
  return (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
}

export interface DesignRemediationBriefInput {
  brief: string
  commandIds: readonly string[]
  findings: readonly AuditFinding[]
  scopeLabel: string
  runId?: string
}

/**
 * Markdown remediation brief for the blueprint. Sections: goal (from the
 * user's own brief), command routing table (cluster → impeccable command),
 * findings severity-ordered, files in scope, and a note that the impeccable
 * skill guidance rides with BUILD for design-sourced blueprints.
 */
export function formatDesignRemediationBrief(input: DesignRemediationBriefInput): string {
  const { brief, commandIds, scopeLabel, runId } = input
  const ordered = [...input.findings].sort(bySeverity)

  const clustered = new Map<DesignCluster, AuditFinding[]>()
  for (const f of ordered) {
    const c = classifyFinding(f)
    const list = clustered.get(c) ?? []
    list.push(f)
    clustered.set(c, list)
  }

  const sections: string[] = [
    '## Design remediation',
    `Fix the design-audit findings below${runId ? ` from run \`${runId}\`` : ''} ` +
      `in \`${scopeLabel}\`, applying the matching impeccable command's guidance to each cluster. ` +
      'Keep behaviour intact — this is a visual/UX remediation pass, not a rewrite.'
  ]

  if (brief.trim().length > 0) {
    sections.push(`### Goal (user brief)\n\n> ${brief.trim()}`)
  }

  const routingRows = [...clustered.entries()].map(([cluster, list]) => {
    const cmds = CLUSTER_COMMANDS[cluster].join(' + ')
    return `| ${cmds} | ${cluster} | ${list.length} |`
  })
  sections.push(
    '### Command routing\n\n' +
      '| Impeccable command | Cluster | Findings |\n|---|---|---|\n' +
      routingRows.join('\n')
  )

  sections.push(
    ordered
      .map((f, i) => {
        const lines = [`### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`, f.description]
        if (f.filePath) lines.push(`**File:** \`${f.filePath}\``)
        if (f.recommendation) lines.push(`**Recommendation:** ${f.recommendation}`)
        if (f.source) lines.push(`**Source:** ${f.source}`)
        return lines.join('\n\n')
      })
      .join('\n\n')
  )

  const files = [...new Set(ordered.map((f) => f.filePath).filter((p): p is string => !!p))]
  if (files.length > 0) {
    sections.push(`### Files in scope\n\n${files.map((p) => `- \`${p}\``).join('\n')}`)
  }

  if (commandIds.length > 0) {
    sections.push(
      `### Audited by\n\n\`${commandIds.join('`, `')}\` — the run's refine selections ` +
        `(${commandIds.filter((c) => c !== 'audit' && c !== 'critique').join(', ') || 'none'}) ` +
        'indicate the intended remediation vocabulary.'
    )
  }

  return sections.join('\n\n')
}
