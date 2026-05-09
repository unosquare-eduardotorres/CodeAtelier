/**
 * AuditResultBubble — inline score + summary card for completed audit tracks.
 *
 * Appears after the audit stream completes. Shows auditor avatar, score gauge,
 * and summary — modeled after GrillEvaluationBubble.
 */

import { ShieldCheck } from 'lucide-react'
import { Avatar } from '@renderer/components/common'
import ScoreGauge from './ScoreGauge'

interface AuditResultBubbleProps {
  score: number
  summary: string
  trackName: string
  findingsCount: number
}

export default function AuditResultBubble({
  score,
  summary,
  trackName,
  findingsCount
}: AuditResultBubbleProps): React.JSX.Element {
  const hasStructuredScore = score > 0 || findingsCount > 0
  const borderColor = hasStructuredScore ? 'border-primary/30' : 'border-warning/30'
  const bgColor = hasStructuredScore ? 'bg-primary-muted/10' : 'bg-warning/5'

  return (
    <div className="flex gap-3 flex-row">
      {/* Avatar — same as message bubbles */}
      <div className="flex-shrink-0 mt-0.5">
        <Avatar avatarKey="atelier-auditor" size="xl" />
      </div>

      <div
        className={`flex-1 rounded-xl border ${borderColor} ${bgColor} overflow-hidden shadow-sm`}
      >
        <div className="flex items-center gap-4 px-5 py-4">
          {/* Score gauge or "no score" indicator */}
          <div className="flex-shrink-0">
            {hasStructuredScore ? (
              <ScoreGauge score={score} size={72} />
            ) : (
              <div className="w-[72px] h-[72px] rounded-full border-4 border-warning/30 flex items-center justify-center">
                <ShieldCheck size={24} className="text-warning" />
              </div>
            )}
          </div>

          {/* Summary */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <ShieldCheck
                size={14}
                className={hasStructuredScore ? 'text-primary-text' : 'text-warning'}
              />
              <span
                className={`text-sm font-semibold ${hasStructuredScore ? 'text-primary-text' : 'text-warning'}`}
              >
                {trackName} Audit {hasStructuredScore ? 'Result' : 'Complete'}
              </span>
              <span className="text-xs text-text-muted ml-auto">
                {findingsCount} finding{findingsCount !== 1 ? 's' : ''}
              </span>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed line-clamp-4">{summary}</p>
            {!hasStructuredScore && (
              <p className="text-[10px] text-text-muted mt-1.5 italic">
                Structured findings were not extracted. The analysis text above shows what was
                reviewed.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
