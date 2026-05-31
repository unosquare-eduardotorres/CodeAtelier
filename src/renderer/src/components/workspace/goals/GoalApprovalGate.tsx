import { useState } from 'react'
import { CheckCircle, MessageSquare, X } from 'lucide-react'
import type { MpaPlanArtifact } from '../../../../../shared/mpa-types'

const SCOPE_COLORS: Record<string, string> = {
  backend: 'text-green-400 bg-green-400/10',
  frontend: 'text-blue-400 bg-blue-400/10',
  database: 'text-purple-400 bg-purple-400/10',
  shared: 'text-cyan-400 bg-cyan-400/10',
  tests: 'text-yellow-400 bg-yellow-400/10'
}

interface GoalApprovalGateProps {
  plan: MpaPlanArtifact
  onApprove: () => void
  onReject: (feedback: string) => void
  onCancel: () => void
}

export default function GoalApprovalGate({
  plan,
  onApprove,
  onReject,
  onCancel
}: GoalApprovalGateProps): JSX.Element {
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">👤</span>
          <h3 className="text-sm font-semibold text-text-primary">Plan Review</h3>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-text-muted hover:text-text-secondary transition-colors"
          title="Cancel goal"
        >
          <X size={16} />
        </button>
      </div>

      {/* Summary */}
      <div className="bg-surface-base rounded-lg border border-border-subtle p-3">
        <p className="text-sm text-text-primary">{plan.summary}</p>
        {plan.risks.length > 0 && (
          <div className="mt-2 space-y-1">
            <p className="text-xs font-medium text-warning">Risks:</p>
            {plan.risks.map((risk, i) => (
              <p key={i} className="text-xs text-text-muted">
                ⚠ {risk}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Plan Items */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-text-secondary">
          Implementation Items ({plan.items.length})
        </h4>
        {plan.items.map((item) => (
          <div
            key={item.id}
            className="bg-surface-base rounded-lg border border-border-subtle p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-text-muted">{item.id}</span>
                  <span className="text-sm font-medium text-text-primary">{item.title}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${SCOPE_COLORS[item.scope] ?? 'text-text-muted bg-surface-hover'}`}
                  >
                    {item.scope}
                  </span>
                  {item.includesTests && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded text-success bg-success/10">
                      tests
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-secondary mt-1">{item.description}</p>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {item.files.map((f) => (
                    <span
                      key={f}
                      className="text-[10px] font-mono text-text-muted bg-surface-hover px-1.5 py-0.5 rounded"
                    >
                      {f}
                    </span>
                  ))}
                </div>
                {item.dependsOn.length > 0 && (
                  <p className="text-[10px] text-text-muted mt-1">
                    Depends on: {item.dependsOn.join(', ')}
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Existing Patterns */}
      {plan.existingPatterns.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-text-secondary">Patterns to Follow</h4>
          {plan.existingPatterns.map((pattern, i) => (
            <p key={i} className="text-xs text-text-muted">
              • {pattern}
            </p>
          ))}
        </div>
      )}

      {/* Feedback Input */}
      {showFeedback && (
        <div className="space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should be changed? Be specific..."
            rows={3}
            autoFocus
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowFeedback(false)}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => feedback.trim() && onReject(feedback.trim())}
              disabled={!feedback.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-purple-500 hover:bg-purple-600 rounded-lg transition-colors disabled:opacity-50"
            >
              Send Feedback & Revise
            </button>
          </div>
        </div>
      )}

      {/* Action Buttons */}
      {!showFeedback && (
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-subtle">
          <button
            type="button"
            onClick={() => setShowFeedback(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary bg-surface-base hover:bg-surface-hover border border-border-subtle rounded-lg transition-colors"
          >
            <MessageSquare size={14} />
            Request Changes
          </button>
          <button
            type="button"
            onClick={onApprove}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold text-white bg-success hover:bg-success/80 rounded-lg transition-colors"
          >
            <CheckCircle size={14} />
            Approve & Execute
          </button>
        </div>
      )}
    </div>
  )
}
