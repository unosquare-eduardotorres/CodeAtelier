/**
 * BlueprintFindingsCard — renders the parsed findings block from the clarify phase.
 * Shows severity-grouped findings with category icons, status chips, and spec refs.
 */

import { useState, type JSX } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileQuestion,
  MessageSquareWarning,
  Eye,
  GitCompareArrows,
  TriangleAlert,
  BookOpen,
  Target,
  ShieldAlert,
  Gauge,
  CheckCircle2,
  AlertCircle,
  Circle
} from 'lucide-react'
import type {
  ClarifyFinding,
  ClarifyFindingsBlock,
  ClarifyFindingCategory,
  ClarifyFindingSeverity,
  ClarifyFindingStatus
} from '../../../../../shared/blueprint-clarify-parsers'

// ── Category Icons ──

const CATEGORY_ICONS: Record<ClarifyFindingCategory, typeof FileQuestion> = {
  missing_requirements: FileQuestion,
  ambiguous_language: MessageSquareWarning,
  unstated_assumptions: Eye,
  conflicting_requirements: GitCompareArrows,
  missing_edge_cases: TriangleAlert,
  incomplete_user_stories: BookOpen,
  missing_success_criteria: Target,
  security_gaps: ShieldAlert,
  performance_gaps: Gauge
}

export const CATEGORY_LABELS: Record<ClarifyFindingCategory, string> = {
  missing_requirements: 'Missing Requirements',
  ambiguous_language: 'Ambiguous Language',
  unstated_assumptions: 'Unstated Assumptions',
  conflicting_requirements: 'Conflicting Requirements',
  missing_edge_cases: 'Missing Edge Cases',
  incomplete_user_stories: 'Incomplete User Stories',
  missing_success_criteria: 'Missing Success Criteria',
  security_gaps: 'Security Gaps',
  performance_gaps: 'Performance Gaps'
}

// ── Severity Colors ──

const SEVERITY_COLORS: Record<ClarifyFindingSeverity, string> = {
  critical: 'bg-red-500/20 text-red-400 border-red-500/30',
  high: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  medium: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/30'
}

// ── Status Chips ──

const STATUS_CONFIG: Record<
  ClarifyFindingStatus,
  { icon: typeof CheckCircle2; color: string; label: string }
> = {
  resolved: { icon: CheckCircle2, color: 'text-green-400', label: 'Resolved' },
  outstanding: { icon: AlertCircle, color: 'text-amber-400', label: 'Outstanding' },
  deferred: { icon: Circle, color: 'text-slate-400', label: 'Deferred' }
}

// ── Component ──

interface BlueprintFindingsCardProps {
  findings: ClarifyFindingsBlock
}

export function BlueprintFindingsCard({ findings }: BlueprintFindingsCardProps): JSX.Element {
  const { findings: items, summary } = findings

  // The clarify prompt asks for auto-resolved items to be shown separately, so
  // they don't sit inline with things that still need the user's attention.
  const autoResolved = items.filter((f) => f.status === 'resolved')
  const outstanding = items.filter((f) => f.status !== 'resolved')

  // Group by severity (outstanding/deferred only)
  const grouped = groupBySeverity(outstanding)
  const severityOrder: ClarifyFindingSeverity[] = ['critical', 'high', 'medium', 'low']

  return (
    <div
      data-testid="blueprint-findings-card"
      className="bg-surface-raised rounded-xl border border-border/50 overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-text-primary">Findings</h3>
        <span className="text-[10px] text-text-muted">{items.length} total</span>
      </div>

      {/* Summary */}
      {summary && (
        <div className="px-4 py-2 text-xs text-text-secondary border-b border-border/20">
          {summary}
        </div>
      )}

      {/* Auto-resolved — collapsed by default: the count is the signal */}
      {autoResolved.length > 0 && <AutoResolvedGroup findings={autoResolved} />}

      {/* Findings Table */}
      <div className="divide-y divide-border/20">
        {severityOrder.map((severity) => {
          const group = grouped[severity]
          if (!group || group.length === 0) return null
          return (
            <div key={severity} className="px-4 py-2">
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${SEVERITY_COLORS[severity]}`}
                >
                  {severity.toUpperCase()}
                </span>
                <span className="text-[10px] text-text-muted">
                  {group.length} finding{group.length > 1 ? 's' : ''}
                </span>
              </div>
              <div className="space-y-2">
                {group.map((finding) => (
                  <FindingRow key={finding.id} finding={finding} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Auto-Resolved Group ──

function AutoResolvedGroup({ findings }: { findings: ClarifyFinding[] }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <div
      data-testid="blueprint-findings-auto-resolved"
      className="border-b border-border/20 bg-surface-inset/30"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full px-4 py-2 flex items-center gap-1.5 text-left hover:bg-surface-inset/50"
      >
        <Chevron size={12} className="text-text-muted shrink-0" />
        <CheckCircle2 size={12} className="text-green-400 shrink-0" />
        <span className="text-[10px] font-medium text-text-secondary">
          Auto-resolved ({findings.length})
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-2 space-y-1.5">
          {findings.map((finding) => (
            <div key={finding.id} className="pl-5">
              <p className="text-xs text-text-primary truncate">{finding.title}</p>
              {finding.resolvedBy && (
                <p className="text-[10px] text-green-400/80">Resolved by: {finding.resolvedBy}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Finding Row ──

function FindingRow({ finding }: { finding: ClarifyFinding }): JSX.Element {
  const CategoryIcon = CATEGORY_ICONS[finding.category] ?? FileQuestion
  const statusConfig = STATUS_CONFIG[finding.status]
  const StatusIcon = statusConfig.icon

  return (
    <div className="flex items-start gap-2 py-1">
      <CategoryIcon size={14} className="text-text-muted mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-primary truncate">{finding.title}</span>
          <span className={`flex items-center gap-0.5 text-[10px] ${statusConfig.color}`}>
            <StatusIcon size={10} />
            {statusConfig.label}
          </span>
        </div>
        <p className="text-[11px] text-text-secondary mt-0.5 line-clamp-2">{finding.description}</p>
        {finding.resolvedBy && (
          <p className="text-[10px] text-green-400/80 mt-0.5">Resolved by: {finding.resolvedBy}</p>
        )}
        {finding.specRefs.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {finding.specRefs.map((ref) => (
              <span
                key={ref}
                className="text-[9px] font-mono bg-surface-inset px-1 py-0.5 rounded text-text-muted"
              >
                {ref}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Helpers ──

function groupBySeverity(
  items: ClarifyFinding[]
): Partial<Record<ClarifyFindingSeverity, ClarifyFinding[]>> {
  const groups: Partial<Record<ClarifyFindingSeverity, ClarifyFinding[]>> = {}
  for (const item of items) {
    if (!groups[item.severity]) groups[item.severity] = []
    groups[item.severity]!.push(item)
  }
  return groups
}
