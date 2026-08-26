/**
 * SelectionTrayBar — sticky bottom bar shown while audit findings are selected.
 *
 * Summarizes the cross-track selection and offers Build Plan / Clear actions.
 */

import { Wand2, X, Loader2, MessageSquare, BookOpen, CheckCircle2 } from 'lucide-react'

interface SelectionTrayBarProps {
  count: number
  auditorCount: number
  /** How many of the selected findings were already routed somewhere. */
  handedOffCount: number
  isGenerating: boolean
  /** True while the blueprint is being created. */
  isHandingOff: boolean
  /** Why the last blueprint handoff failed, if it did. */
  handoffError?: string | null
  onBuildPlan: () => void
  onFixInChat: () => void
  onFixInBlueprint: () => void
  onClear: () => void
}

export default function SelectionTrayBar({
  count,
  auditorCount,
  handedOffCount,
  isGenerating,
  isHandingOff,
  handoffError,
  onBuildPlan,
  onFixInChat,
  onFixInBlueprint,
  onClear
}: SelectionTrayBarProps): React.JSX.Element | null {
  if (count === 0) return null

  return (
    <div className="flex-shrink-0 border-t border-border-subtle bg-surface-raised px-4 py-2.5">
      {handoffError && (
        <p data-testid="handoff-error" className="mb-1.5 text-[11px] text-danger">
          {handoffError}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-text-secondary">
          <span className="font-semibold text-text-primary">{count}</span> finding
          {count !== 1 ? 's' : ''} selected across{' '}
          <span className="font-semibold text-text-primary">{auditorCount}</span> auditor
          {auditorCount !== 1 ? 's' : ''}
          {handedOffCount > 0 && (
            <span
              data-testid="selection-handed-off-count"
              className="ml-2 inline-flex items-center gap-1 text-[10px] text-text-muted"
            >
              <CheckCircle2 size={11} />
              {handedOffCount} already handed off
            </span>
          )}
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
            data-testid="fix-in-blueprint"
            onClick={onFixInBlueprint}
            disabled={isGenerating || isHandingOff}
            title="Create a blueprint from these findings — planned, tasked and verified before build"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isHandingOff ? <Loader2 size={14} className="animate-spin" /> : <BookOpen size={14} />}
            {isHandingOff ? 'Creating…' : 'Fix in Blueprint'}
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
