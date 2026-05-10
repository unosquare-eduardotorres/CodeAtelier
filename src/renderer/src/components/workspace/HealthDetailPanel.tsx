/**
 * HealthDetailPanel — right detail panel in the unified health layout.
 *
 * Renders contextual content based on the selected track's status:
 *   - No selection: mode info + tech stack
 *   - No run yet: track description + scoring criteria
 *   - Pending: track header + "waiting in queue"
 *   - Running: AuditStreamView (chat-like streaming)
 *   - Completed: score + summary + severity filter + findings
 *   - Failed: error message + re-run button
 */

import { useState, useMemo, useCallback } from 'react'
import {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette,
  XCircle,
  Clock,
  RefreshCw,
  Wrench,
  Zap,
  Microscope,
  Download,
  ShieldCheck,
  AlertTriangle
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditTrackId, AuditRun, AuditMode, AuditFinding } from '../../../../shared/types'
import { AUDIT_TRACKS } from '../../../../shared/constants'
import { AVATAR_IMAGES } from '@renderer/assets/avatars'
import ScoreGauge from './ScoreGauge'
import AuditStreamView from './AuditStreamView'

const ICON_MAP: Record<string, LucideIcon> = {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette
}

const MODE_INFO: Record<
  AuditMode,
  { icon: LucideIcon; title: string; bullets: string[]; estimate: string; color: string }
> = {
  light: {
    icon: Zap,
    title: 'Light Audit',
    bullets: [
      'Quick pattern-based analysis',
      'Checks naming, structure, and common anti-patterns',
      'No additional skills or tools used',
      'Best for: daily check-ins and quick health snapshots'
    ],
    estimate: '~30 seconds per auditor',
    color: 'text-warning'
  },
  deep: {
    icon: Microscope,
    title: 'Deep Audit',
    bullets: [
      'Full codebase analysis using code-graph & semantic search',
      'Cross-file dependency and impact analysis',
      'Detects complex issues: N+1 queries, circular deps, dead code',
      'Best for: pre-release reviews and thorough health assessments'
    ],
    estimate: '~2–5 minutes per auditor',
    color: 'text-info'
  }
}

type SeverityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low' | 'info'

const SEVERITY_ORDER: SeverityFilter[] = ['all', 'critical', 'high', 'medium', 'low', 'info']

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-danger/20 text-danger',
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning/20 text-warning',
  low: 'bg-info/10 text-info',
  info: 'bg-surface-overlay text-text-secondary'
}

interface HealthDetailPanelProps {
  activeTrackId: AuditTrackId | null
  currentRun: AuditRun | null
  mode: AuditMode
  rerunningTrackId: AuditTrackId | null
  selectedFindings: AuditFinding[]
  onToggleFinding: (finding: AuditFinding) => void
  onConvertToChat: () => void
  onRerunTrack: (trackId: AuditTrackId) => void
  onAutoFix: (finding: AuditFinding, trackName: string) => void
  onClearSelected?: () => void
  onExport?: () => void
}

export default function HealthDetailPanel({
  activeTrackId,
  currentRun,
  mode,
  rerunningTrackId,
  selectedFindings,
  onToggleFinding,
  onConvertToChat,
  onRerunTrack,
  onAutoFix,
  onClearSelected,
  onExport
}: HealthDetailPanelProps): React.JSX.Element {
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')
  const [runningView, setRunningView] = useState<'stream' | 'findings'>('stream')

  const selectedIds = useMemo(() => new Set(selectedFindings.map((f) => f.id)), [selectedFindings])

  const filterFindings = useCallback(
    (findings: AuditFinding[]): AuditFinding[] => {
      if (severityFilter === 'all') return findings
      return findings.filter((f) => f.severity === severityFilter)
    },
    [severityFilter]
  )

  // ── A) No track selected ──
  if (!activeTrackId) {
    return <EmptyState mode={mode} detectedTechs={currentRun?.detectedTechs ?? []} />
  }

  const track = AUDIT_TRACKS[activeTrackId]
  const result = currentRun?.results.find((r) => r.trackId === activeTrackId)
  const Icon = ICON_MAP[track?.icon ?? ''] ?? Code
  const status = result?.status

  // ── B) Track selected, no run exists yet ──
  if (!currentRun || !status) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <div className="w-16 h-16 rounded-2xl bg-surface-overlay flex items-center justify-center mb-4">
          <Icon size={32} className="text-text-muted" />
        </div>
        <h3 className="text-sm font-bold text-text-primary mb-1">{track.name}</h3>
        <p className="text-xs text-text-secondary max-w-sm mb-4">{track.description}</p>

        {/* Scoring focus pills */}
        <div className="flex flex-wrap justify-center gap-1.5 mb-6">
          {track.scoringFocus.map((focus, i) => (
            <span
              key={i}
              className="px-2 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded-full"
            >
              {focus}
            </span>
          ))}
        </div>

        <p className="text-[11px] text-text-muted italic">
          Run an audit to see results for this track
        </p>
      </div>
    )
  }

  // ── C) Pending ──
  if (status === 'pending') {
    return (
      <div className="flex-1 flex flex-col">
        <TrackHeader icon={Icon} name={track.name} description={track.description} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Clock size={16} className="text-text-muted" />
            Waiting in queue…
          </div>
        </div>
      </div>
    )
  }

  // ── D) Running — show live findings if available ──
  if (status === 'running') {
    const liveFindings = result?.findings ?? []
    const rp = result?.roundProgress
    const filesInspected = result?.coverageStats?.fileCount ?? 0
    const totalFiles = rp?.totalFiles ?? 0
    const coveragePct = totalFiles > 0 ? Math.round((filesInspected / totalFiles) * 100) : 0

    return (
      <div className="flex-1 flex flex-col min-h-0">
        <TrackHeader
          icon={Icon}
          name={track.name}
          description={track.description}
          badge={rp ? `Round ${rp.roundNumber}/${rp.totalRounds}` : 'Running…'}
        />

        {/* Progress bar — shown after first intermediate event */}
        {rp && (
          <div className="px-5 py-2.5 border-b border-border-subtle bg-surface-overlay/30 space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(coveragePct, 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-text-muted font-mono w-8 text-right">
                {Math.min(coveragePct, 100)}%
              </span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-text-muted">
              <button
                onClick={() => setRunningView('stream')}
                className={`px-2 py-0.5 rounded-full transition-colors ${
                  runningView === 'stream'
                    ? 'bg-primary-muted text-primary-text font-semibold'
                    : 'hover:text-text-secondary'
                }`}
              >
                Stream
              </button>
              <button
                onClick={() => setRunningView('findings')}
                className={`px-2 py-0.5 rounded-full transition-colors ${
                  runningView === 'findings'
                    ? 'bg-primary-muted text-primary-text font-semibold'
                    : 'hover:text-text-secondary'
                }`}
              >
                📊 {liveFindings.length} finding(s)
              </button>
              <span className="ml-auto">{filesInspected} files inspected</span>
              <span>•</span>
              <span>
                Round {rp.roundNumber}/{rp.totalRounds}
              </span>
            </div>
          </div>
        )}

        {/* Fallback for before first intermediate event arrives */}
        {!rp && liveFindings.length > 0 && (
          <div className="px-5 py-2 border-b border-border-subtle bg-surface-overlay/30">
            <button
              onClick={() => setRunningView('findings')}
              className="text-[10px] text-text-muted hover:text-primary-text transition-colors"
            >
              📊 {liveFindings.length} finding(s) so far • {filesInspected} files inspected
            </button>
          </div>
        )}

        {runningView === 'stream' ? (
          <AuditStreamView trackId={activeTrackId} trackName={track.name} isStreaming />
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5">
            {liveFindings.length === 0 ? (
              <p className="text-xs text-text-muted italic py-4 text-center">
                No findings yet — the auditor is still analyzing…
              </p>
            ) : (
              liveFindings.map((finding) => (
                <div
                  key={finding.id}
                  className="flex items-start gap-2 p-2.5 rounded-lg hover:bg-surface-overlay/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded ${SEVERITY_COLORS[finding.severity] ?? SEVERITY_COLORS.info}`}
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
                </div>
              ))
            )}
          </div>
        )}
      </div>
    )
  }

  // ── D-alt) Cancelled / Interrupted ──
  if (status === 'cancelled') {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <TrackHeader
          icon={Icon}
          name={track.name}
          description={track.description}
          badge="Interrupted"
        />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
          <ShieldCheck size={28} className="text-warning" />
          <p className="text-sm text-text-secondary">
            This auditor was interrupted before completing.
          </p>
          <p className="text-xs text-text-muted">
            Use the <strong>Resume</strong> button in the header to re-run this track, or re-run it
            individually below.
          </p>
          <button
            onClick={() => onRerunTrack(activeTrackId)}
            className="mt-1 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-colors"
          >
            Re-run this track
          </button>
        </div>
      </div>
    )
  }

  // ── E) Completed ──
  if (status === 'completed') {
    const findings = result?.findings ?? []
    const filteredFindings = filterFindings(findings)
    const isAnyRerunning = !!rerunningTrackId

    // Severity counts for filter pills — only count visible (non-selected) findings
    const visibleFindings = findings.filter((f) => !selectedIds.has(f.id))
    const severityCounts: Record<string, number> = {}
    for (const f of visibleFindings) {
      severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1
    }

    const issues = findings.filter((f) => f.severity !== 'info')
    const passedChecks = findings.filter((f) => f.severity === 'info')

    return (
      <div className="flex-1 flex flex-col min-h-0">
        {/* Auditor hero — portrait + score + summary (like GrillSidebar) */}
        <div className="border-b border-border-subtle bg-surface-raised">
          <div className="flex items-start gap-4 px-5 py-4">
            {/* Auditor portrait — square, like GrillSidebar */}
            <div className="flex-shrink-0">
              <img
                src={AVATAR_IMAGES['atelier-auditor']}
                alt={`${track.name} Auditor`}
                className="w-24 h-24 rounded-xl object-cover border border-border-subtle shadow-sm"
              />
            </div>

            {/* Score + track info */}
            <div className="flex-1 min-w-0 flex flex-col items-center">
              {result?.coverageSufficient === false ? (
                <div className="flex flex-col items-center gap-2 py-2">
                  <AlertTriangle size={24} className="text-warning" />
                  <span className="text-xs text-warning font-semibold">Insufficient Data</span>
                  <span className="text-[10px] text-text-muted">
                    {result.coverageStats?.fileCount ?? 0} files inspected
                  </span>
                </div>
              ) : result?.score != null ? (
                <ScoreGauge score={result.score} size={80} />
              ) : (
                <div className="flex flex-col items-center gap-2 py-2">
                  <ShieldCheck size={24} className="text-text-muted" />
                  <span className="text-xs text-text-muted">Scoring…</span>
                </div>
              )}
              <div className="flex items-center gap-1.5 mt-2">
                <Icon size={14} className="text-primary-text flex-shrink-0" />
                <span className="text-sm font-bold text-text-primary">{track.name}</span>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-text-muted">
                <span>
                  {issues.length} issue{issues.length !== 1 ? 's' : ''}
                </span>
                <span>•</span>
                <span>{passedChecks.length} passed</span>
                {result?.coverageStats && (
                  <>
                    <span>•</span>
                    <span>{result.coverageStats.fileCount} files inspected</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Summary */}
          {result?.summary && (
            <div className="px-5 pb-3">
              <p className="text-xs text-text-secondary leading-relaxed">{result.summary}</p>
            </div>
          )}
        </div>

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
                  onClick={() => setSeverityFilter(sev)}
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
                {selectedFindings.length} finding{selectedFindings.length !== 1 ? 's' : ''} added to fix queue
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
          {(() => {
            const filteredIssues = filteredFindings.filter(
              (f) => f.severity !== 'info' && !selectedIds.has(f.id)
            )
            const showPassedChecks =
              passedChecks.length > 0 && (severityFilter === 'all' || severityFilter === 'info')

            return (
              <>
                {/* Issues section */}
                {filteredIssues.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                      Issues ({filteredIssues.length})
                    </span>
                    {filteredIssues.map((finding) => (
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
                          onClick={(e) => { e.stopPropagation(); onAutoFix(finding, track.name) }}
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

                {/* Empty state — show analysis text if available, otherwise generic message */}
                {filteredIssues.length === 0 &&
                  !showPassedChecks &&
                  (findings.length === 0 && result?.summary && result.summary.length > 100 ? (
                    /* Show the raw analysis text as a readable report */
                    <div className="space-y-3 py-2">
                      <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                        Analysis Report
                      </span>
                      <div className="rounded-lg bg-surface-overlay border border-border-subtle p-4">
                        <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
                          {result.summary}
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
              </>
            )
          })()}
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
      </div>
    )
  }

  // ── F) Failed ──
  if (status === 'failed' || status === 'cancelled') {
    return (
      <div className="flex-1 flex flex-col">
        <TrackHeader icon={Icon} name={track.name} description={track.description} />
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4">
          <XCircle size={32} className="text-danger" />
          <div className="text-center max-w-md">
            <p className="text-sm font-medium text-text-primary mb-1">
              {status === 'failed' ? 'Audit Failed' : 'Audit Cancelled'}
            </p>
            {result?.summary && (
              <div className="mt-2 px-4 py-3 rounded-lg bg-danger/10 border border-danger/20">
                <p className="text-xs text-danger">{result.summary}</p>
              </div>
            )}
          </div>
          <button
            onClick={() => onRerunTrack(activeTrackId)}
            disabled={!!rerunningTrackId}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-success/10 text-success hover:bg-success/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={12} />
            Re-run
          </button>
        </div>
      </div>
    )
  }

  // Fallback — should not reach here
  return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-text-muted">Select an auditor to view details</p>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function TrackHeader({
  icon: Icon,
  name,
  description,
  badge
}: {
  icon: LucideIcon
  name: string
  description: string
  badge?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-border-subtle bg-surface-raised">
      <Icon size={20} className="text-primary-text flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-text-primary">{name}</h3>
          {badge && (
            <span
              className={`text-[10px] font-medium ${
                badge === 'Interrupted' ? 'text-warning' : 'text-info animate-pulse'
              }`}
            >
              {badge}
            </span>
          )}
        </div>
        <p className="text-[10px] text-text-muted line-clamp-1">{description}</p>
      </div>
    </div>
  )
}

function EmptyState({
  mode,
  detectedTechs
}: {
  mode: AuditMode
  detectedTechs: string[]
}): React.JSX.Element {
  const modeInfo = MODE_INFO[mode]
  const ModeIcon = modeInfo.icon

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="max-w-md w-full space-y-6">
        {/* Mode info card */}
        <div
          className={`rounded-xl border bg-surface-overlay p-5 ${
            mode === 'light' ? 'border-warning/20' : 'border-info/20'
          }`}
        >
          <div className="flex items-center gap-2 mb-3">
            <ModeIcon size={18} className={modeInfo.color} />
            <span className={`text-sm font-semibold ${modeInfo.color}`}>{modeInfo.title}</span>
            <span className="text-xs text-text-muted ml-auto">{modeInfo.estimate}</span>
          </div>
          <ul className="space-y-1.5">
            {modeInfo.bullets.map((bullet, i) => (
              <li key={i} className="text-xs text-text-secondary flex items-start gap-1.5">
                <span className="text-text-muted mt-0.5">•</span>
                {bullet}
              </li>
            ))}
          </ul>
        </div>

        {/* Tech stack badges */}
        {detectedTechs.length > 0 && (
          <div>
            <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
              Detected Technologies
            </span>
            <div className="flex flex-wrap gap-1 mt-2">
              {detectedTechs.map((tech) => (
                <span
                  key={tech}
                  className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded"
                >
                  {tech}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Hint */}
        <p className="text-xs text-text-muted text-center italic">
          Select an auditor to view details
        </p>
      </div>
    </div>
  )
}
