/**
 * SelectionTrayBar — sticky bottom bar shown while audit findings are selected.
 *
 * Summarizes the cross-track selection and offers Build Plan / Clear actions.
 */

import { Wand2, X, Loader2, MessageSquare } from 'lucide-react'

interface SelectionTrayBarProps {
  count: number
  auditorCount: number
  isGenerating: boolean
  onBuildPlan: () => void
  onFixInChat: () => void
  onClear: () => void
}

export default function SelectionTrayBar({
  count,
  auditorCount,
  isGenerating,
  onBuildPlan,
  onFixInChat,
  onClear
}: SelectionTrayBarProps): React.JSX.Element | null {
  if (count === 0) return null

  return (
    <div className="flex-shrink-0 border-t border-border-subtle bg-surface-raised px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-text-secondary">
          <span className="font-semibold text-text-primary">{count}</span> finding
          {count !== 1 ? 's' : ''} selected across{' '}
          <span className="font-semibold text-text-primary">{auditorCount}</span> auditor
          {auditorCount !== 1 ? 's' : ''}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={onClear}
            disabled={isGenerating}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-overlay transition-colors disabled:opacity-40"
          >
            <X size={13} />
            Clear
          </button>
          <button
            onClick={onFixInChat}
            disabled={isGenerating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded-lg bg-surface-overlay text-text-primary hover:bg-surface-float transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <MessageSquare size={14} />
            Fix in Chat
          </button>
          <button
            onClick={onBuildPlan}
            disabled={isGenerating}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold rounded-lg bg-primary/15 text-primary-text hover:bg-primary/25 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isGenerating ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Building plan…
              </>
            ) : (
              <>
                <Wand2 size={14} />
                Build Plan
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
