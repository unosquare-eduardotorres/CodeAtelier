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
  Download
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  AuditTrackId,
  AuditRun,
  AuditMode,
  AuditFinding
} from '../../../../shared/types'
import { AUDIT_TRACKS } from '../../../../shared/constants'
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
  onExport
}: HealthDetailPanelProps): React.JSX.Element {
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')

  const selectedIds = useMemo(
    () => new Set(selectedFindings.map((f) => f.id)),
    [selectedFindings]
  )

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

  // ── D) Running ──
  if (status === 'running') {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <TrackHeader icon={Icon} name={track.name} description={track.description} badge="Running…" />
        <AuditStreamView trackId={activeTrackId} trackName={track.name} isStreaming />
      </div>
    )
  }

  // ── E) Completed ──
  if (status === 'completed') {
    const findings = result?.findings ?? []
    const filteredFindings = filterFindings(findings)
    const isAnyRerunning = !!rerunningTrackId

    // Severity counts for filter pills
    const severityCounts: Record<string, number> = {}
    for (const f of findings) {
      severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1
    }

    return (
      <div className="flex-1 flex flex-col min-h-0">
        {/* Track header with inline score */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border-subtle bg-surface-raised">
          <Icon size={20} className="text-primary-text flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold text-text-primary">{track.name}</h3>
            <p className="text-[10px] text-text-muted line-clamp-1">{track.description}</p>
          </div>
          {result?.score != null && (
            <ScoreGauge score={result.score} size={56} />
          )}
        </div>

        {/* Summary */}
        {result?.summary && (
          <div className="px-5 py-3 border-b border-border-subtle">
            <p className="text-xs text-text-secondary leading-relaxed">{result.summary}</p>
          </div>
        )}

        {/* Severity filter bar */}
        {findings.length > 0 && (
          <div className="px-5 py-2.5 border-b border-border-subtle flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mr-1">
              Severity
            </span>
            {SEVERITY_ORDER.map((sev) => {
              const count = sev === 'all' ? findings.length : (severityCounts[sev] ?? 0)
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
                  {count > 0 && (
                    <span className="ml-1 text-[10px] opacity-70">({count})</span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* Convert selected findings button */}
        {selectedFindings.length > 0 && (
          <div className="px-5 py-2 border-b border-border-subtle bg-primary-muted/20">
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
            const issues = filteredFindings.filter((f) => f.severity !== 'info')
            const passedChecks = findings.filter((f) => f.severity === 'info')
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
                        <button
                          onClick={() => onAutoFix(finding, track.name)}
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

                {/* Empty state — only when truly no results */}
                {issues.length === 0 && !showPassedChecks && (
                  <p className="text-xs text-text-muted italic py-4 text-center">
                    {findings.length === 0
                      ? 'No analysis results available. Try re-running this auditor.'
                      : 'No findings match the current filter.'}
                  </p>
                )}
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
            <RefreshCw size={10} className={rerunningTrackId === activeTrackId ? 'animate-spin' : ''} />
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
            <span className="text-[10px] font-medium text-info animate-pulse">{badge}</span>
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
