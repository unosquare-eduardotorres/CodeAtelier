import { useState, type JSX } from 'react'
import { CheckCircle, MessageSquare, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { GATE_ICON } from './phase-icons'

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
          <GATE_ICON.icon size={18} className="text-info" />
          <h3 className="text-sm font-semibold text-text-primary">Blueprint Review</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-info-muted text-info font-medium">
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
      <div className="bg-surface-base rounded-lg border border-info/20 p-3 max-h-80 overflow-y-auto">
        <p className="text-xs font-medium text-text-secondary mb-1.5">Plan Summary</p>
        <div className="prose prose-sm max-w-none text-text-body
          prose-headings:text-text-primary prose-headings:font-semibold prose-headings:text-sm
          prose-p:leading-relaxed prose-p:text-sm
          prose-code:font-mono prose-code:text-xs prose-code:bg-surface-overlay prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-accent prose-code:before:content-none prose-code:after:content-none
          prose-strong:text-text-primary prose-strong:font-semibold
          prose-li:text-sm prose-li:text-text-body
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
            {planSummary}
          </ReactMarkdown>
        </div>
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
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-info resize-none"
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
              className="px-3 py-1.5 text-xs font-medium text-white bg-button-primary-bg hover:bg-button-primary-hover rounded-lg transition-colors disabled:opacity-50"
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
            Approve & Build
          </button>
        </div>
      )}
    </div>
  )
}
