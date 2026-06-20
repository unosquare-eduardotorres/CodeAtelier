import { useState, type JSX } from 'react'
import { CheckCircle, MessageSquare, X } from 'lucide-react'

interface BlueprintApprovalGateProps {
  planSummary: string
  onApprove: () => void
  onReject: (feedback: string) => void
  onCancel: () => void
}

export default function BlueprintApprovalGate({
  planSummary,
  onApprove,
  onReject,
  onCancel
}: BlueprintApprovalGateProps): JSX.Element {
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">👤</span>
          <h3 className="text-sm font-semibold text-text-primary">Blueprint Review</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-medium">
            Approval Required
          </span>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-text-muted hover:text-text-secondary transition-colors"
          title="Cancel blueprint"
        >
          <X size={16} />
        </button>
      </div>

      {/* Plan Summary */}
      <div className="bg-surface-base rounded-lg border border-border-subtle p-3">
        <p className="text-xs font-medium text-text-secondary mb-1.5">Plan Summary</p>
        <p className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
          {planSummary}
        </p>
      </div>

      {/* Feedback Input */}
      {showFeedback && (
        <div className="space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should be changed? Be specific about what needs to be revised..."
            rows={3}
            autoFocus
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-emerald-500 resize-none"
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
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors"
          >
            <CheckCircle size={14} />
            Approve & Build
          </button>
        </div>
      )}
    </div>
  )
}
