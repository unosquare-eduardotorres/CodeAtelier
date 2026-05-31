/**
 * CompletedFindingsList — severity filter + fix queue + findings (issues + passed checks).
 * Extracted from HealthDetailPanel completed state.
 */

import { useMemo, useCallback } from 'react'
import { Wrench, Download, RefreshCw } from 'lucide-react'
import type { AuditTrackId, AuditFinding } from '../../../../shared/types'

type SeverityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low' | 'info'

const SEVERITY_ORDER: SeverityFilter[] = ['all', 'critical', 'high', 'medium', 'low', 'info']

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-danger/20 text-danger',
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning/20 text-warning',
  low: 'bg-info/10 text-info',
  info: 'bg-surface-overlay text-text-secondary'
}

interface CompletedFindingsListProps {
  activeTrackId: AuditTrackId
  trackName: string
  findings: AuditFinding[]
  selectedFindings: AuditFinding[]
  severityFilter: SeverityFilter
  onSeverityFilterChange: (filter: SeverityFilter) => void
  rerunningTrackId: AuditTrackId | null
  summary: string | null | undefined
  onToggleFinding: (finding: AuditFinding) => void
  onConvertToChat: () => void
  onRerunTrack: (trackId: AuditTrackId) => void
  onAutoFix: (finding: AuditFinding, trackName: string) => void
  onClearSelected?: () => void
  onExport?: () => void
}

export default function CompletedFindingsList({
  activeTrackId,
  trackName,
  findings,
  selectedFindings,
  severityFilter,
  onSeverityFilterChange,
  rerunningTrackId,
  summary,
  onToggleFinding,
  onConvertToChat,
  onRerunTrack,
  onAutoFix,
  onClearSelected,
  onExport
}: CompletedFindingsListProps): React.JSX.Element {
  const selectedIds = useMemo(() => new Set(selectedFindings.map((f) => f.id)), [selectedFindings])
  const isAnyRerunning = !!rerunningTrackId

  const filterFindings = useCallback(
    (items: AuditFinding[]): AuditFinding[] => {
      if (severityFilter === 'all') return items
      return items.filter((f) => f.severity === severityFilter)
    },
    [severityFilter]
  )

  const filteredFindings = filterFindings(findings)
  const visibleFindings = findings.filter((f) => !selectedIds.has(f.id))
  const severityCounts: Record<string, number> = {}
  for (const f of visibleFindings) {
    severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1
  }

  const issues = filteredFindings.filter((f) => f.severity !== 'info' && !selectedIds.has(f.id))
  const passedChecks = findings.filter((f) => f.severity === 'info')
  const showPassedChecks =
    passedChecks.length > 0 && (severityFilter === 'all' || severityFilter === 'info')

  return (
    <>
      {/* Severity filter bar */}
      {findings.length > 0 && (
        <div className="px-5 py-2.5 border-b border-border-subtle flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mr-1">
            Severity
          </span>
          {SEVERITY_ORDER.map((sev) => {
            const count = sev === 'all' ? visibleFindings.length : (severityCounts[sev] ?? 0)
            const isActive = severityFilter === sev
            return (
              <button
                key={sev}
                onClick={() => onSeverityFilterChange(sev)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-full transition-colors capitalize ${
                  isActive
                    ? 'bg-primary-muted text-primary-text'
                    : 'bg-surface-overlay text-text-secondary hover:text-text-primary hover:bg-surface-overlay/80'
                }`}
              >
                {sev}
                {count > 0 && <span className="ml-1 text-[10px] opacity-70">({count})</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* Selected findings queue bar + convert button */}
      {selectedFindings.length > 0 && (
        <div className="px-5 py-2 border-b border-border-subtle bg-primary-muted/20 space-y-2">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-primary/5 border border-primary/20 text-xs">
            <Wrench size={12} className="text-primary-text flex-shrink-0" />
            <span className="text-primary-text font-medium">
              {selectedFindings.length} finding{selectedFindings.length !== 1 ? 's' : ''} added to
              fix queue
            </span>
            {onClearSelected && (
              <button
                onClick={onClearSelected}
                className="ml-auto text-[10px] text-text-muted hover:text-text-secondary transition-colors"
              >
                Show all
              </button>
            )}
          </div>
          <button
            onClick={onConvertToChat}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-primary/10 text-primary-text hover:bg-primary/20 transition-colors"
          >
            <Wrench size={12} />
            Fix {selectedFindings.length} Selected in Chat
          </button>
        </div>
      )}

      {/* Findings list — split into Issues and Passed Checks */}
      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5">
        {/* Issues section */}
        {issues.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
              Issues ({issues.length})
            </span>
            {issues.map((finding) => (
              <div
                key={finding.id}
                onClick={() => onToggleFinding(finding)}
                className={`flex items-start gap-2 p-2.5 rounded-lg cursor-pointer transition-colors ${
                  selectedIds.has(finding.id)
                    ? 'bg-primary/10 border border-primary/30'
                    : 'hover:bg-surface-overlay/50 border border-transparent'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(finding.id)}
                  onChange={() => onToggleFinding(finding)}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-0.5 rounded border-border-subtle text-primary focus:ring-primary/50"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded ${
                        SEVERITY_COLORS[finding.severity] ?? SEVERITY_COLORS.info
                      }`}
                    >
                      {finding.severity}
                    </span>
                    <span className="text-xs font-medium text-text-primary truncate">
                      {finding.title}
                    </span>
                  </div>
                  <p className="text-[11px] text-text-secondary mt-0.5 line-clamp-2">
                    {finding.description}
                  </p>
                  {finding.filePath && (
                    <span className="text-[10px] text-text-muted font-mono mt-0.5 block truncate">
                      {finding.filePath}
                    </span>
                  )}
                  {finding.recommendation && (
                    <p className="text-[10px] text-text-muted mt-1 italic">
                      💡 {finding.recommendation}
                    </p>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onAutoFix(finding, trackName)
                  }}
                  className="flex-shrink-0 p-1.5 rounded-lg hover:bg-surface-overlay text-text-muted hover:text-primary-text transition-colors"
                  title="Auto-fix suggestion"
                >
                  <Wrench size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Passed Checks section */}
        {showPassedChecks && (
          <div className="space-y-1.5 mt-4">
            <span className="text-[10px] font-semibold text-success uppercase tracking-wider">
              ✓ Passed Checks ({passedChecks.length})
            </span>
            {passedChecks.map((finding) => (
              <div
                key={finding.id}
                className="flex items-start gap-2 p-2.5 rounded-lg bg-success/5"
              >
                <span className="text-success mt-0.5 flex-shrink-0">✓</span>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-text-primary">{finding.title}</span>
                  <p className="text-[11px] text-text-secondary mt-0.5">{finding.description}</p>
                  {finding.filePath && (
                    <span className="text-[10px] text-text-muted font-mono mt-0.5 block truncate">
                      {finding.filePath}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state — show analysis text if available, otherwise generic message */}
        {issues.length === 0 &&
          !showPassedChecks &&
          (findings.length === 0 && summary && summary.length > 100 ? (
            <div className="space-y-3 py-2">
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                Analysis Report
              </span>
              <div className="rounded-lg bg-surface-overlay border border-border-subtle p-4">
                <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
                  {summary}
                </p>
              </div>
              <p className="text-[10px] text-text-muted italic text-center">
                Structured findings were not extracted. Re-run this auditor for a detailed
                breakdown.
              </p>
            </div>
          ) : (
            <p className="text-xs text-text-muted italic py-4 text-center">
              {findings.length === 0
                ? 'No analysis results available. Try re-running this auditor.'
                : 'No findings match the current filter.'}
            </p>
          ))}
      </div>

      {/* Bottom actions: export + re-run */}
      <div className="flex items-center gap-2 px-5 py-3 border-t border-border-subtle bg-surface-raised">
        {onExport && (
          <button
            onClick={onExport}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-border-subtle hover:bg-surface-overlay text-text-secondary transition-colors"
          >
            <Download size={10} />
            Export
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={() => onRerunTrack(activeTrackId)}
          disabled={isAnyRerunning}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-border-subtle transition-colors ${
            isAnyRerunning
              ? 'opacity-50 cursor-not-allowed'
              : 'hover:bg-surface-overlay text-text-secondary'
          }`}
        >
          <RefreshCw
            size={10}
            className={rerunningTrackId === activeTrackId ? 'animate-spin' : ''}
          />
          {rerunningTrackId === activeTrackId ? 'Re-running…' : 'Re-run'}
        </button>
      </div>
    </>
  )
}

export type { SeverityFilter }
