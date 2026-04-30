/**
 * AuditResultBubble — inline score + summary card for completed audit tracks.
 *
 * Appears after the audit stream completes. Shows auditor avatar, score gauge,
 * and summary — modeled after GrillEvaluationBubble.
 */

import { HeartPulse } from 'lucide-react'
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
  return (
    <div className="flex gap-3 flex-row">
      {/* Avatar — same as message bubbles */}
      <div className="flex-shrink-0 mt-0.5">
        <Avatar avatarKey="atelier-auditor" size="xl" />
      </div>

      <div className="flex-1 rounded-xl border border-primary/30 bg-primary-muted/10 overflow-hidden shadow-sm">
        <div className="flex items-center gap-4 px-5 py-4">
          {/* Score gauge */}
          <div className="flex-shrink-0">
            <ScoreGauge score={score} size={72} />
          </div>

          {/* Summary */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <HeartPulse size={14} className="text-primary-text flex-shrink-0" />
              <span className="text-sm font-semibold text-primary-text">
                {trackName} Audit Result
              </span>
              <span className="text-xs text-text-muted ml-auto">
                {findingsCount} finding{findingsCount !== 1 ? 's' : ''}
              </span>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">{summary}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
