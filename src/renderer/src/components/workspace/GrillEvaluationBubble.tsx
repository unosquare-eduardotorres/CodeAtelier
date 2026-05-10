/**
 * GrillEvaluationBubble — inline score + feedback card in the grill chat stream.
 *
 * Appears after DaVinci finishes analysis, before questions. Shows a compact
 * score gauge alongside feedback text, indented to align with the message bubbles.
 */

import { Flame } from 'lucide-react'
import ScoreGauge from './ScoreGauge'

interface GrillEvaluationBubbleProps {
  score: number
  scoreLabel: string
  feedback: string
  trackName?: string
}

export default function GrillEvaluationBubble({
  score,
  scoreLabel,
  feedback,
  trackName
}: GrillEvaluationBubbleProps): React.JSX.Element {
  return (
    <div className="ml-11 rounded-xl border border-accent/30 bg-accent-muted/10 overflow-hidden shadow-sm">
      <div className="flex items-center gap-4 px-5 py-4">
        {/* Compact score gauge */}
        <div className="flex-shrink-0">
          <ScoreGauge score={score} size={72} label={scoreLabel} />
        </div>

        {/* Feedback */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <Flame size={14} className="text-accent flex-shrink-0" />
            <span className="text-sm font-semibold text-accent">
              {trackName ? `${trackName} Evaluation` : 'Grill Evaluation'}
            </span>
          </div>
          <p className="text-sm text-text-secondary leading-relaxed">{feedback}</p>
        </div>
      </div>
    </div>
  )
}
