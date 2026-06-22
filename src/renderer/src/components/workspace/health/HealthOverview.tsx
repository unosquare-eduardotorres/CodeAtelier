/**
 * HealthOverview — dashboard shown when a completed audit run is open and no
 * single track is selected. Renders the overall score with a plain-language
 * interpretation, a responsive grid of per-track cards, and a preview of the
 * top issues across all tracks. Clicking a card or issue drills into the track.
 */

import { useMemo } from 'react'
import { ShieldCheck, CheckCheck } from 'lucide-react'
import { useAuditStore } from '@renderer/store'
import type { AuditRun, AuditTrackId, AuditFinding } from '../../../../../shared/types'
import { AUDIT_TRACKS, deriveApplicability } from '../../../../../shared/constants'
import ScoreGauge from '../ScoreGauge'
import HealthTrackCard from './HealthTrackCard'

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-danger/20 text-danger',
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning/20 text-warning',
  low: 'bg-info/10 text-info',
  info: 'bg-surface-overlay text-text-secondary'
}

function getScoreLabel(score: number): string {
  if (score >= 85) return 'Excellent'
  if (score >= 70) return 'Good'
  if (score >= 50) return 'Fair'
  if (score >= 30) return 'Needs Work'
  return 'Critical'
}

function getInterpretation(score: number): string {
  if (score >= 85) return 'Your codebase is in great shape across the audited areas.'
  if (score >= 70) return 'Solid overall — a few areas could use some attention.'
  if (score >= 50) return 'Fair — several issues are worth addressing soon.'
  if (score >= 30) return 'Multiple significant issues were found. Prioritise the criticals.'
  return 'Major issues need attention before this codebase is healthy.'
}

interface HealthOverviewProps {
  currentRun: AuditRun
  onSelectTrack: (trackId: AuditTrackId) => void
}

export default function HealthOverview({
  currentRun,
  onSelectTrack
}: HealthOverviewProps): React.JSX.Element {
  const tracks = currentRun.selectedTracks

  const { topIssues, completedCount, excludedCount } = useMemo(() => {
    const issues: Array<{ finding: AuditFinding; trackId: AuditTrackId }> = []
    let completed = 0
    let excluded = 0
    for (const r of currentRun.results) {
      if (r.status !== 'completed') continue
      completed++
      if (deriveApplicability(r) !== 'ok') {
        excluded++
        continue
      }
      for (const f of r.findings) {
        if (f.severity !== 'info') issues.push({ finding: f, trackId: r.trackId })
      }
    }
    issues.sort(
      (a, b) =>
        (SEVERITY_ORDER[a.finding.severity] ?? 5) - (SEVERITY_ORDER[b.finding.severity] ?? 5)
    )
    return { topIssues: issues.slice(0, 6), completedCount: completed, excludedCount: excluded }
  }, [currentRun.results])

  const overall = currentRun.overallScore
  const selectAllAcrossTracks = useAuditStore((s) => s.selectAllAcrossTracks)

  return (
    <div data-testid="health-overview" className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-8">
        {/* ── Overall score hero ── */}
        <div className="flex flex-col items-center text-center gap-3">
          {overall != null ? (
            <ScoreGauge score={overall} size={140} label={getScoreLabel(overall)} />
          ) : (
            <div className="flex flex-col items-center gap-2 py-4">
              <div className="w-[120px] h-[120px] rounded-full border-[8px] border-surface-overlay flex items-center justify-center">
                <ShieldCheck size={40} className="text-text-muted" />
              </div>
              <span className="text-sm font-semibold text-text-secondary">Not enough data yet</span>
            </div>
          )}
          <div className="max-w-md">
            <h2 className="text-base font-bold text-text-primary">Workspace Health</h2>
            <p className="text-sm text-text-secondary mt-1">
              {overall != null
                ? getInterpretation(overall)
                : 'No auditor produced a trustworthy score. Run more auditors or a deeper pass to get an overall rating.'}
            </p>
            <p className="text-[11px] text-text-muted mt-2">
              {completedCount} auditor{completedCount !== 1 ? 's' : ''} completed
              {excludedCount > 0 && ` · ${excludedCount} excluded (insufficient coverage)`}
            </p>
          </div>
        </div>

        {/* ── Per-track grid ── */}
        <div>
          <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-3">
            Auditors
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {tracks.map((trackId) => {
              const track = AUDIT_TRACKS[trackId]
              if (!track) return null
              const result = currentRun.results.find((r) => r.trackId === trackId)
              return (
                <HealthTrackCard
                  key={trackId}
                  track={track}
                  result={result}
                  onSelect={() => onSelectTrack(trackId)}
                />
              )
            })}
          </div>
        </div>

        {/* ── Top issues across all tracks ── */}
        {topIssues.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
                Top issues across all auditors
              </h3>
              <button
                onClick={selectAllAcrossTracks}
                className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-primary-text transition-colors"
                title="Select every issue across all auditors"
              >
                <CheckCheck size={12} />
                Select all issues
              </button>
            </div>
            <div className="space-y-1.5">
              {topIssues.map(({ finding, trackId }) => (
                <button
                  key={finding.id}
                  onClick={() => onSelectTrack(trackId)}
                  className="w-full flex items-start gap-2 p-2.5 rounded-lg border border-border-subtle bg-surface-raised hover:bg-surface-overlay/60 transition-colors text-left"
                >
                  <span
                    className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded flex-shrink-0 ${SEVERITY_COLORS[finding.severity] ?? SEVERITY_COLORS.info}`}
                  >
                    {finding.severity}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-text-primary truncate">
                        {finding.title}
                      </span>
                      <span className="text-[10px] text-text-muted flex-shrink-0">
                        {AUDIT_TRACKS[trackId]?.name}
                      </span>
                    </div>
                    {finding.filePath && (
                      <span className="text-[10px] text-text-muted font-mono block truncate mt-0.5">
                        {finding.filePath}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
