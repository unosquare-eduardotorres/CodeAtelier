/**
 * HealthDetailPanel — right detail panel in the unified health layout.
 *
 * Renders contextual content based on the selected track's status:
 *   - No selection: mode info + tech stack
 *   - No run yet: track description + scoring criteria
 *   - Pending: track header + "waiting in queue"
 *   - Running: AuditStreamView (chat-like streaming)
 *   - Completed: AuditScoreHero + CompletedFindingsList
 *   - Failed: error message + re-run button
 */

import { useState } from 'react'
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
  Zap,
  Microscope,
  ShieldCheck
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditTrackId, AuditRun, AuditMode, AuditFinding } from '../../../../shared/types'
import { AUDIT_TRACKS, deriveApplicability } from '../../../../shared/constants'
import AuditStreamView from './AuditStreamView'
import AuditScoreHero from './AuditScoreHero'
import CompletedFindingsList from './CompletedFindingsList'
import type { SeverityFilter } from './CompletedFindingsList'
import HealthOverview from './health/HealthOverview'

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
  onSelectTrack: (trackId: AuditTrackId) => void
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
  onSelectTrack,
  onConvertToChat,
  onRerunTrack,
  onAutoFix,
  onClearSelected,
  onExport
}: HealthDetailPanelProps): React.JSX.Element {
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')
  const [runningView, setRunningView] = useState<'stream' | 'findings'>('stream')

  // ── A) No track selected ──
  if (!activeTrackId) {
    // Default to the Overview dashboard once a run has produced results.
    if (currentRun && currentRun.results.some((r) => r.status === 'completed')) {
      return <HealthOverview currentRun={currentRun} onSelectTrack={onSelectTrack} />
    }
    return <EmptyState mode={mode} detectedTechs={currentRun?.detectedTechs ?? []} />
  }

  const track = AUDIT_TRACKS[activeTrackId]
  const result = currentRun?.results.find((r) => r.trackId === activeTrackId)
  const Icon = ICON_MAP[track?.icon ?? ''] ?? Code
  const status = result?.status

  // ── B) Track selected, no run exists yet ──
  if (!currentRun || !status) {
    return (
      <div data-testid="health-detail-panel" className="flex-1 flex flex-col items-center justify-center p-8 text-center">
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
      <div data-testid="health-detail-panel" className="flex-1 flex flex-col">
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
    const issues = findings.filter((f) => f.severity !== 'info')
    const passedChecks = findings.filter((f) => f.severity === 'info')

    return (
      <div data-testid="health-detail-panel" className="flex-1 flex flex-col min-h-0">
        <AuditScoreHero
          trackName={track.name}
          TrackIcon={Icon}
          score={result?.score}
          summary={result?.summary}
          applicability={result ? deriveApplicability(result) : 'ok'}
          coverageFileCount={result?.coverageStats?.fileCount ?? 0}
          issueCount={issues.length}
          passedCount={passedChecks.length}
        />

        <CompletedFindingsList
          activeTrackId={activeTrackId}
          trackName={track.name}
          findings={findings}
          selectedFindings={selectedFindings}
          severityFilter={severityFilter}
          onSeverityFilterChange={setSeverityFilter}
          rerunningTrackId={rerunningTrackId}
          summary={result?.summary}
          onToggleFinding={onToggleFinding}
          onConvertToChat={onConvertToChat}
          onRerunTrack={onRerunTrack}
          onAutoFix={onAutoFix}
          onClearSelected={onClearSelected}
          onExport={onExport}
        />
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
