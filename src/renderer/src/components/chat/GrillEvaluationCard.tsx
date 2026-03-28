import { Flame } from 'lucide-react'
import type { GrillQuestion } from '../../../../shared/types'

interface GrillEvaluationCardProps {
  score: number
  scoreLabel: string
  feedback: string
  questions: GrillQuestion[]
}

export default function GrillEvaluationCard({
  score,
  scoreLabel,
  feedback,
  questions
}: GrillEvaluationCardProps): React.JSX.Element {
  const scoreColor =
    score >= 70 ? 'text-green-400' : score >= 40 ? 'text-orange-400' : 'text-red-400'
  const scoreBg =
    score >= 70
      ? 'bg-green-500/10 border-green-500/30'
      : score >= 40
        ? 'bg-orange-500/10 border-orange-500/30'
        : 'bg-red-500/10 border-red-500/30'

  return (
    <div className="rounded-xl border border-orange-500/30 bg-orange-950/20 overflow-hidden">
      {/* Header with score */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-orange-900/30 border-b border-orange-500/20">
        <Flame size={14} className="text-orange-400" />
        <span className="text-sm font-medium text-orange-300">Grill Evaluation</span>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={`text-lg font-bold ${scoreColor} px-2 py-0.5 rounded-md border ${scoreBg}`}
          >
            {score}/100
          </span>
          {scoreLabel && (
            <span className="text-xs text-orange-300/70 font-medium">{scoreLabel}</span>
          )}
        </div>
      </div>

      {/* Feedback */}
      {feedback && (
        <div className="px-5 py-3 border-b border-orange-500/10">
          <p className="text-sm text-text-body leading-relaxed">{feedback}</p>
        </div>
      )}

      {/* Questions */}
      {questions.length > 0 && (
        <div className="px-5 py-3 space-y-3">
          <span className="text-xs font-medium text-orange-400 uppercase tracking-wide">
            Questions ({questions.length})
          </span>
          {questions.map((q, i) => (
            <div key={q.id} className="text-sm">
              <span className="font-medium text-text-primary">
                {i + 1}. {q.header || q.question}
              </span>
              {q.options.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {q.options.map((o) => (
                    <span
                      key={o.label}
                      className={`px-2 py-0.5 text-xs rounded-full border ${
                        o.recommended
                          ? 'border-green-500/30 bg-green-500/10 text-green-300'
                          : 'border-border-subtle bg-surface-base text-text-muted'
                      }`}
                    >
                      {o.label}
                      {o.recommended ? ' ✓' : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
