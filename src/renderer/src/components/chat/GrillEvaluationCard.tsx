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
  const scoreColor = score >= 70 ? 'text-success' : score >= 40 ? 'text-accent' : 'text-danger'
  const scoreBg =
    score >= 70
      ? 'bg-success-muted border-success/30'
      : score >= 40
        ? 'bg-accent-muted border-accent/30'
        : 'bg-danger-muted border-danger/30'

  return (
    <div className="rounded-xl border border-grill/30 bg-grill-muted overflow-hidden">
      {/* Header with score */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-grill/15 border-b border-grill/20">
        <Flame size={14} className="text-accent" />
        <span className="text-sm font-medium text-accent">Grill Evaluation</span>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={`text-lg font-bold ${scoreColor} px-2 py-0.5 rounded-md border ${scoreBg}`}
          >
            {score}/100
          </span>
          {scoreLabel && <span className="text-xs text-accent/70 font-medium">{scoreLabel}</span>}
        </div>
      </div>

      {/* Feedback */}
      {feedback && (
        <div className="px-5 py-3 border-b border-grill/10">
          <p className="text-sm text-text-body leading-relaxed">{feedback}</p>
        </div>
      )}

      {/* Questions */}
      {questions?.length > 0 && (
        <div className="px-5 py-3 space-y-3">
          <span className="text-xs font-medium text-accent uppercase tracking-wide">
            Questions ({questions.length})
          </span>
          {questions.map((q, i) => (
            <div key={q.id} className="text-sm">
              <span className="font-medium text-text-primary">
                {i + 1}. {q.header || q.question}
              </span>
              {q.options?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {q.options?.map((o) => (
                    <span
                      key={o.label}
                      className={`px-2 py-0.5 text-xs rounded-full border ${
                        o.recommended
                          ? 'border-success/30 bg-success-muted text-success'
                          : 'border-border-subtle bg-surface-base text-text-muted'
                      }`}
                      title={o.recommendedReason || undefined}
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
