/**
 * AuditScoreHero — auditor portrait + score gauge + track stats + summary.
 * Extracted from HealthDetailPanel completed state.
 */

import { MinusCircle, AlertTriangle, ShieldCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditApplicability } from '../../../../shared/types'
import Avatar from '@renderer/components/common/Avatar'
import ScoreGauge from './ScoreGauge'

interface AuditScoreHeroProps {
  trackName: string
  TrackIcon: LucideIcon
  score: number | null | undefined
  summary: string | null | undefined
  applicability: AuditApplicability
  coverageFileCount: number
  issueCount: number
  passedCount: number
}

export default function AuditScoreHero({
  trackName,
  TrackIcon,
  score,
  summary,
  applicability,
  coverageFileCount,
  issueCount,
  passedCount
}: AuditScoreHeroProps): React.JSX.Element {
  return (
    <div className="border-b border-border-subtle bg-surface-raised">
      <div className="flex items-start gap-4 px-5 py-4">
        {/* Auditor portrait — square, like GrillSidebar */}
        <div className="flex-shrink-0">
          <Avatar
            avatarKey="atelier-auditor"
            size="xxl"
            className="!rounded-xl border border-border-subtle shadow-sm"
          />
        </div>

        {/* Score + track info */}
        <div className="flex-1 min-w-0 flex flex-col items-center">
          {applicability === 'not-applicable' ? (
            <div className="flex flex-col items-center gap-2 py-2">
              <MinusCircle size={24} className="text-text-muted" />
              <span className="text-xs text-text-secondary font-semibold">Not applicable</span>
              <span className="text-[10px] text-text-muted text-center">
                No {trackName.toLowerCase()} files found in this workspace
              </span>
            </div>
          ) : applicability === 'insufficient' ? (
            <div className="flex flex-col items-center gap-2 py-2">
              <AlertTriangle size={24} className="text-warning" />
              <span className="text-xs text-warning font-semibold">Insufficient data</span>
              <span className="text-[10px] text-text-muted text-center">
                Only {coverageFileCount} file{coverageFileCount !== 1 ? 's' : ''} inspected — not
                enough to score
              </span>
            </div>
          ) : score != null ? (
            <ScoreGauge score={score} size={80} />
          ) : (
            <div className="flex flex-col items-center gap-2 py-2">
              <ShieldCheck size={24} className="text-text-muted" />
              <span className="text-xs text-text-muted">Scoring…</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 mt-2">
            <TrackIcon size={14} className="text-primary-text flex-shrink-0" />
            <span className="text-sm font-bold text-text-primary">{trackName}</span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-[10px] text-text-muted">
            <span>
              {issueCount} issue{issueCount !== 1 ? 's' : ''}
            </span>
            <span>•</span>
            <span>{passedCount} passed</span>
            {coverageFileCount > 0 && (
              <>
                <span>•</span>
                <span>{coverageFileCount} files inspected</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Summary */}
      {summary && (
        <div className="px-5 pb-3">
          <p className="text-xs text-text-secondary leading-relaxed">{summary}</p>
        </div>
      )}
    </div>
  )
}
