import { useState, useMemo, useCallback } from 'react'
import {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  Zap,
  Microscope,
  Play,
  Wrench,
  Download,
  RefreshCw
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  AuditRun,
  AuditResult,
  AuditFinding,
  AuditTrackId
} from '../../../../shared/types'
import { AUDIT_TRACKS } from '../../../../shared/constants'
import ScoreGauge from './ScoreGauge'

const ICON_MAP: Record<string, LucideIcon> = {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette
}

type SeverityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low' | 'info'

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-danger/20 text-danger',
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning/20 text-warning',
  low: 'bg-info/10 text-info',
  info: 'bg-surface-overlay text-text-secondary'
}

const SEVERITY_ORDER: SeverityFilter[] = ['all', 'critical', 'high', 'medium', 'low', 'info']

function getScoreColor(score: number): string {
  if (score <= 20) return 'text-danger'
  if (score <= 40) return 'text-danger'
  if (score <= 60) return 'text-warning'
  if (score <= 80) return 'text-success'
  return 'text-success'
}

function formatDuration(startStr: string, endStr: string): string {
  const start = new Date(startStr).getTime()
  const end = new Date(endStr).getTime()
  const diffMs = end - start
  if (diffMs < 0) return '—'
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSecs = seconds % 60
  return `${minutes}m ${remainingSecs}s`
}

interface HealthReportViewProps {
  currentRun: AuditRun
  previousScore?: number | null
  rerunningTrackId?: AuditTrackId | null
  onBack: () => void
  onRerunAll: () => void
  onRerunTrack?: (trackId: AuditTrackId) => void
  onAutoFix?: (finding: AuditFinding, trackName: string) => void
  onExport?: () => void
  selectedFindings: AuditFinding[]
  onToggleFinding: (finding: AuditFinding) => void
  onConvertToChat: () => void
}

export default function HealthReportView({
  currentRun,
  previousScore,
  rerunningTrackId,
  onBack,
  onRerunAll,
  onRerunTrack,
  onAutoFix,
  onExport,
  selectedFindings,
  onToggleFinding,
  onConvertToChat
}: HealthReportViewProps): React.JSX.Element {
  const isAnyRerunning = !!rerunningTrackId
  const [expandedTracks, setExpandedTracks] = useState<Set<AuditTrackId>>(new Set())
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')

  const selectedIds = useMemo(() => new Set(selectedFindings.map((f) => f.id)), [selectedFindings])

  // Count findings per severity across all results
  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const result of currentRun.results) {
      for (const f of result.findings) {
        counts[f.severity] = (counts[f.severity] ?? 0) + 1
      }
    }
    return counts
  }, [currentRun.results])

  const totalFindings = useMemo(
    () => currentRun.results.reduce((acc, r) => acc + r.findings.length, 0),
    [currentRun.results]
  )

  const toggleExpanded = useCallback((trackId: AuditTrackId) => {
    setExpandedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) {
        next.delete(trackId)
      } else {
        next.add(trackId)
      }
      return next
    })
  }, [])

  const filterFindings = useCallback(
    (findings: AuditFinding[]): AuditFinding[] => {
      if (severityFilter === 'all') return findings
      return findings.filter((f) => f.severity === severityFilter)
    },
    [severityFilter]
  )

  const completedResults = currentRun.results.filter((r) => r.status === 'completed')
  const auditDate = new Date(currentRun.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })

  // Trend delta from previous run
  const scoreDelta = (() => {
    if (
      currentRun.overallScore === null ||
      previousScore === undefined ||
      previousScore === null
    ) {
      return null
    }
    return currentRun.overallScore - previousScore
  })()

  // Calculate total duration
  const duration = (() => {
    const lastResult = [...currentRun.results]
      .filter((r) => r.completedAt)
      .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())[0]
    if (!lastResult?.completedAt) return '—'
    return formatDuration(currentRun.createdAt, lastResult.completedAt)
  })()

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Report header */}
      <div className="px-6 py-4 border-b border-border-subtle bg-surface-raised sticky top-0 z-10">
        <div className="flex items-start gap-6">
          {/* Score gauge + trend delta */}
          <div className="flex-shrink-0 flex flex-col items-center gap-1">
            {currentRun.overallScore !== null ? (
              <ScoreGauge score={currentRun.overallScore} size={80} />
            ) : (
              <div className="w-20 h-20 rounded-full border-4 border-surface-overlay flex items-center justify-center">
                <span className="text-lg text-text-muted">—</span>
              </div>
            )}
            {scoreDelta !== null && (
              <span
                className={`text-[10px] font-semibold ${
                  scoreDelta > 0
                    ? 'text-success'
                    : scoreDelta < 0
                      ? 'text-danger'
                      : 'text-text-muted'
                }`}
              >
                {scoreDelta > 0 ? '↑' : scoreDelta < 0 ? '↓' : '→'}
                {Math.abs(scoreDelta)} from last run
              </span>
            )}
          </div>

          {/* Header info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-base font-bold text-text-primary">Audit Report</h2>
              <span className="text-xs text-text-muted">—</span>
              <span className="text-xs text-text-secondary capitalize">{currentRun.mode} Mode</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-text-muted">
              {currentRun.mode === 'light' ? (
                <Zap size={12} className="text-warning" />
              ) : (
                <Microscope size={12} className="text-info" />
              )}
              <span>{currentRun.mode === 'light' ? 'Light' : 'Deep'} audit</span>
              <span>•</span>
              <span>{completedResults.length} auditor{completedResults.length !== 1 ? 's' : ''}</span>
              <span>•</span>
              <span>{duration}</span>
              <span>•</span>
              <span>{auditDate}</span>
              <span>•</span>
              <span>{totalFindings} finding{totalFindings !== 1 ? 's' : ''}</span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {onExport && (
              <button
                onClick={onExport}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border-subtle hover:bg-surface-overlay text-text-secondary transition-colors"
              >
                <Download size={12} />
                Export
              </button>
            )}
            <button
              onClick={onRerunAll}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-success/10 text-success hover:bg-success/20 transition-colors"
            >
              <Play size={12} />
              Re-run All
            </button>
            <button
              onClick={onBack}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border-subtle hover:bg-surface-overlay text-text-secondary transition-colors"
            >
              <ArrowLeft size={12} />
              Back
            </button>
          </div>
        </div>
      </div>

      {/* Severity filter bar */}
      <div className="px-6 py-3 border-b border-border-subtle bg-surface-base sticky top-[105px] z-10">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mr-1">
            Severity
          </span>
          {SEVERITY_ORDER.map((sev) => {
            const count = sev === 'all' ? totalFindings : (severityCounts[sev] ?? 0)
            const isActive = severityFilter === sev
            return (
              <button
                key={sev}
                onClick={() => setSeverityFilter(sev)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-colors capitalize ${
                  isActive
                    ? 'bg-primary-muted text-primary-text'
                    : 'bg-surface-overlay text-text-secondary hover:text-text-primary hover:bg-surface-overlay/80'
                }`}
              >
                {sev}
                {count > 0 && (
                  <span className="ml-1 text-[10px] opacity-70">({count})</span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Convert selected findings button */}
      {selectedFindings.length > 0 && (
        <div className="px-6 py-2 border-b border-border-subtle bg-primary-muted/20 sticky top-[146px] z-10">
          <button
            onClick={onConvertToChat}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-primary/10 text-primary-text hover:bg-primary/20 transition-colors"
          >
            <Wrench size={12} />
            Fix {selectedFindings.length} Selected in Chat
          </button>
        </div>
      )}

      {/* Accordion sections */}
      <div className="px-6 py-4 space-y-3">
        {currentRun.selectedTracks.map((trackId) => {
          const track = AUDIT_TRACKS[trackId]
          const result = currentRun.results.find((r) => r.trackId === trackId)
          if (!track || !result) return null

          const Icon = ICON_MAP[track.icon] ?? Code
          const isExpanded = expandedTracks.has(trackId)
          const filteredFindings = filterFindings(result.findings)

          return (
            <ReportAccordionSection
              key={trackId}
              trackId={trackId}
              track={track}
              result={result}
              Icon={Icon}
              isExpanded={isExpanded}
              onToggle={() => toggleExpanded(trackId)}
              filteredFindings={filteredFindings}
              severityFilter={severityFilter}
              selectedIds={selectedIds}
              onToggleFinding={onToggleFinding}
              onRerunTrack={onRerunTrack}
              onAutoFix={onAutoFix}
              isRerunning={rerunningTrackId === trackId}
              isAnyRerunning={isAnyRerunning}
            />
          )
        })}
      </div>
    </div>
  )
}

// ── Accordion Section ──────────────────────────────────────────────────────

interface ReportAccordionSectionProps {
  trackId: AuditTrackId
  track: { name: string; icon: string; description: string }
  result: AuditResult
  Icon: LucideIcon
  isExpanded: boolean
  onToggle: () => void
  filteredFindings: AuditFinding[]
  severityFilter: SeverityFilter
  selectedIds: Set<string>
  onToggleFinding: (finding: AuditFinding) => void
  onRerunTrack?: (trackId: AuditTrackId) => void
  onAutoFix?: (finding: AuditFinding, trackName: string) => void
  isRerunning?: boolean
  isAnyRerunning?: boolean
}

function ReportAccordionSection({
  trackId,
  track,
  result,
  Icon,
  isExpanded,
  onToggle,
  filteredFindings,
  severityFilter,
  selectedIds,
  onToggleFinding,
  onRerunTrack,
  onAutoFix,
  isRerunning,
  isAnyRerunning
}: ReportAccordionSectionProps): React.JSX.Element {
  const score = result.score ?? 0
  const scoreColor = getScoreColor(score)

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-raised overflow-hidden transition-all">
      {/* Accordion header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-overlay/30 transition-colors"
      >
        <Icon size={18} className="text-primary-text flex-shrink-0" />
        <span className="text-sm font-semibold text-text-primary">{track.name}</span>
        {isRerunning ? (
          <span className="flex items-center gap-1.5 text-xs text-info">
            <RefreshCw size={12} className="animate-spin" />
            Re-running…
          </span>
        ) : (
          <>
            {result.score !== null && (
              <span className={`text-sm font-bold ${scoreColor}`}>{result.score}/100</span>
            )}
            <span className="text-[10px] text-text-muted ml-1">
              {result.findings.length} finding{result.findings.length !== 1 ? 's' : ''}
            </span>
          </>
        )}
        <div className="flex-1" />
        {isExpanded ? (
          <ChevronDown size={16} className="text-text-muted" />
        ) : (
          <ChevronRight size={16} className="text-text-muted" />
        )}
      </button>

      {/* Accordion body */}
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-border-subtle pt-3 space-y-3">
          {/* Summary */}
          {result.summary && (
            <p className="text-xs text-text-secondary leading-relaxed">{result.summary}</p>
          )}

          {/* Findings list — split into Issues and Passed Checks */}
          {(() => {
            const issues = filteredFindings.filter((f) => f.severity !== 'info')
            const passedChecks = result.findings.filter((f) => f.severity === 'info')
            const showPassedChecks =
              passedChecks.length > 0 && (severityFilter === 'all' || severityFilter === 'info')

            return (
              <>
                {/* Issues section */}
                {issues.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                      Issues ({issues.length})
                    </span>
                    {issues.map((finding) => (
                      <div
                        key={finding.id}
                        className="flex items-start gap-2 p-2.5 rounded-lg hover:bg-surface-overlay/50 transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(finding.id)}
                          onChange={() => onToggleFinding(finding)}
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
                        {onAutoFix && (
                          <button
                            onClick={() => onAutoFix(finding, track.name)}
                            className="flex-shrink-0 p-1.5 rounded-lg hover:bg-surface-overlay text-text-muted hover:text-primary-text transition-colors"
                            title="Auto-fix suggestion"
                          >
                            <Wrench size={12} />
                          </button>
                        )}
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
                          <span className="text-xs font-medium text-text-primary">
                            {finding.title}
                          </span>
                          <p className="text-[11px] text-text-secondary mt-0.5">
                            {finding.description}
                          </p>
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

                {/* Empty state */}
                {issues.length === 0 && !showPassedChecks && (
                  <p className="text-xs text-text-muted italic py-2">
                    {result.findings.length === 0
                      ? 'No analysis results available. Try re-running this auditor.'
                      : 'No findings match the current filter.'}
                  </p>
                )}
              </>
            )
          })()}

          {/* Section actions */}
          <div className="flex items-center gap-2 pt-2 border-t border-border-subtle">
            {onRerunTrack && (
              <button
                onClick={() => onRerunTrack(trackId)}
                disabled={isAnyRerunning}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-border-subtle transition-colors ${
                  isAnyRerunning
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:bg-surface-overlay text-text-secondary'
                }`}
              >
                <RefreshCw size={10} className={isRerunning ? 'animate-spin' : ''} />
                {isRerunning ? 'Re-running…' : 'Re-run'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
