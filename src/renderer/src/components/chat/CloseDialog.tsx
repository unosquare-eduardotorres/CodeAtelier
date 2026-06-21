import { useState, useEffect } from 'react'
import { Trash2, AlertTriangle } from 'lucide-react'
import InsightsSummary, { type ConversationInsights } from './InsightsSummary'

interface CloseDialogProps {
  isOpen: boolean
  conversationId: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export default function CloseDialog({
  isOpen,
  conversationId,
  onConfirm,
  onCancel
}: CloseDialogProps): React.JSX.Element | null {
  const [insights, setInsights] = useState<ConversationInsights | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (isOpen && conversationId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional loading state before async fetch
      setInsightsLoading(true)
      setIsSubmitting(false)
      window.api
        .getConversationInsights({ conversationId })
        .then((result) => {
          setInsights(result)
          setInsightsLoading(false)
        })
        .catch((err) => {
          console.warn('[CloseDialog] Non-fatal: insights load failed:', err)
          setInsightsLoading(false)
        })
    }
  }, [isOpen, conversationId])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onCancel()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  const handleConfirm = async (): Promise<void> => {
    setIsSubmitting(true)
    try {
      await onConfirm()
    } catch {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      {/* Dialog */}
      <div data-testid="close-dialog" className="relative bg-surface-float border border-border-default rounded-xl shadow-2xl p-6 max-w-md w-full mx-4 animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-danger-muted flex items-center justify-center">
            <Trash2 size={20} className="text-danger" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-text-primary">Close Conversation</h3>
            <p className="text-xs text-text-secondary">Permanently delete this conversation</p>
          </div>
        </div>

        {/* Warning */}
        <div className="mb-4 p-3 bg-warning-muted border border-warning/20 rounded-lg">
          <div className="flex items-start gap-2 text-warning text-sm">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <span>
              This will permanently delete this conversation, all messages, and tracked file
              changes. Uncommitted changes in your workspace will NOT be affected.
            </span>
          </div>
        </div>

        {/* Session Insights */}
        <InsightsSummary insights={insights} loading={insightsLoading} />

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-text-body hover:text-text-primary bg-surface-overlay hover:bg-surface-raised rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-default disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            data-testid="close-dialog-confirm"
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-danger bg-danger hover:brightness-110 text-white disabled:opacity-50"
          >
            {isSubmitting ? 'Closing...' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
