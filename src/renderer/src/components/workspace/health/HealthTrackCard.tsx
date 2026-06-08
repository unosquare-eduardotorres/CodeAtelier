/**
 * HealthTrackCard — compact per-track summary card for the Overview dashboard.
 *
 * Shows a score gauge ring (or an adaptive N/A badge for excluded tracks),
 * the track name, issue count, and a short summary. Clicking drills into the
 * track's detail view.
 */

import { Database, Code, TestTube, Building2, Shield, FileText, Palette } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditTrack, AuditResult } from '../../../../../shared/types'
import { deriveApplicability } from '../../../../../shared/constants'
import ScoreGauge from '../ScoreGauge'

const ICON_MAP: Record<string, LucideIcon> = {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette
}

interface HealthTrackCardProps {
  track: AuditTrack
  result: AuditResult | undefined
  onSelect: () => void
}

export default function HealthTrackCard({
  track,
  result,
  onSelect
}: HealthTrackCardProps): React.JSX.Element {
  const Icon = ICON_MAP[track.icon] ?? Code
  const applicability = result ? deriveApplicability(result) : 'ok'
  const excluded = applicability !== 'ok'
  const status = result?.status
  const findings = result?.findings ?? []
  const issueCount = findings.filter((f) => f.severity !== 'info').length
  const score = result?.score ?? null

  return (
    <button
      onClick={onSelect}
      className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border-subtle bg-surface-raised hover:bg-surface-overlay/60 hover:border-border-default transition-all duration-200 text-center group"
    >
      {/* Gauge / badge */}
      <div className="h-[72px] flex items-center justify-center">
        {status === 'completed' && !excluded && score !== null ? (
          <ScoreGauge score={score} size={72} label=" " />
        ) : excluded ? (
          <div className="flex flex-col items-center justify-center gap-1">
            <span className="text-base font-bold text-text-muted px-2.5 py-1 rounded-lg bg-surface-overlay">
              N/A
            </span>
            <span className="text-[9px] text-text-muted">
              {applicability === 'not-applicable' ? 'no files' : 'low coverage'}
            </span>
          </div>
        ) : (
          <div className="w-[72px] h-[72px] rounded-full border-[6px] border-surface-overlay flex items-center justify-center">
            <Icon size={24} className="text-text-muted" />
          </div>
        )}
      </div>

      {/* Name */}
      <div className="flex items-center gap-1.5">
        <Icon size={14} className="text-primary-text flex-shrink-0" />
        <span className="text-sm font-bold text-text-primary">{track.name}</span>
      </div>

      {/* Stats line */}
      <span className="text-[11px] text-text-muted">
        {status === 'completed'
          ? `${issueCount} issue${issueCount !== 1 ? 's' : ''}`
          : status === 'running'
            ? 'Analyzing…'
            : status === 'failed'
              ? 'Failed'
              : 'Not run'}
      </span>

      {/* Short summary */}
      {result?.summary && (
        <p className="text-[10px] text-text-secondary leading-snug line-clamp-2">
          {result.summary}
        </p>
      )}
    </button>
  )
}
