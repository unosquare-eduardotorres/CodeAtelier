import { useEffect, useRef } from 'react'
import { Minimize2, X, Sparkles, Zap } from 'lucide-react'

interface CompactContextModalProps {
  isOpen: boolean
  inputTokens: number
  level: string
  onExtractNuance: () => void
  onQuickCompact: () => void
  onCancel: () => void
}

const CONTEXT_WINDOW_SIZE = 1_000_000
const QUALITY_WINDOW_SIZE = 200_000

function getBarColor(level: string): string {
  switch (level) {
    case 'critical':
      return 'bg-danger'
    case 'suggest':
      return 'bg-warning'
    case 'warning':
      return 'bg-info'
    default:
      return 'bg-success'
  }
}

export default function CompactContextModal({
  isOpen,
  inputTokens,
  level,
  onExtractNuance,
  onQuickCompact,
  onCancel
}: CompactContextModalProps): React.JSX.Element | null {
  const nuanceRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (isOpen) {
      nuanceRef.current?.focus()
    }
  }, [isOpen])

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

  const tokensK = (inputTokens / 1000).toFixed(1)
  const windowK = (CONTEXT_WINDOW_SIZE / 1000).toFixed(1)
  const percentage = Math.min(Math.round((inputTokens / CONTEXT_WINDOW_SIZE) * 100), 100)
  // Quality is based on the effective 200K window (quality degrades past this)
  const qualityPercentage = Math.min(Math.round((inputTokens / QUALITY_WINDOW_SIZE) * 100), 100)
  const qualityLabel =
    qualityPercentage <= 40
      ? 'Excellent'
      : qualityPercentage <= 60
        ? 'Good'
        : qualityPercentage <= 80
          ? 'Moderate'
          : 'Low'
  const barColor = getBarColor(level)

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compact-dialog-title"
      aria-describedby="compact-dialog-description"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[rgba(15,21,23,0.85)] backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div className="relative bg-surface-float border border-border-default rounded-lg shadow-2xl max-w-md w-full mx-4 animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-3">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-warning/10 flex items-center justify-center">
              <Minimize2 size={18} className="text-warning" />
            </div>
            <div>
              <h3 id="compact-dialog-title" className="text-base font-semibold text-text-primary">
                Compact Context
              </h3>
              <p className="text-xs text-text-secondary mt-0.5">
                Choose how to compact your conversation
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-text-muted hover:text-text-primary p-1 rounded transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Context Usage Bar */}
        <div className="px-5 pb-4">
          <div className="flex items-center justify-between text-xs text-text-secondary mb-1.5">
            <span>Context usage</span>
            <span className="font-mono">
              {tokensK}K / {windowK}K ({percentage}%) — Quality: {qualityLabel}
            </span>
          </div>
          <div className="w-full h-2 bg-surface-overlay rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${barColor}`}
              style={{ width: `${qualityPercentage}%` }}
            />
          </div>
        </div>

        {/* Warning Note */}
        <div className="px-5 pb-4">
          <div className="px-3 py-2.5 rounded-lg bg-warning/5 border border-warning/20">
            <p className="text-xs text-text-secondary leading-relaxed">
              Standard compaction may lose important context and nuance.{' '}
              <span className="text-warning font-medium">&quot;Extract Nuance&quot;</span> preserves
              critical details before compacting.
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="px-5 pb-3 space-y-2.5">
          {/* Extract Nuance — Recommended */}
          <button
            ref={nuanceRef}
            onClick={onExtractNuance}
            className="w-full flex items-center gap-3 p-3 rounded-lg border-2 border-warning/40 bg-warning/5 hover:bg-warning/10 transition-colors text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-warning"
          >
            <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-warning/10 flex items-center justify-center">
              <Sparkles size={16} className="text-warning" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary">
                  Extract Nuance &amp; Compact
                </span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning/15 text-warning">
                  Recommended
                </span>
              </div>
              <p className="text-xs text-text-secondary mt-0.5">
                Preserves decisions, preferences, and key details before compacting
              </p>
            </div>
          </button>

          {/* Quick Compact */}
          <button
            onClick={onQuickCompact}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-border-default bg-surface-overlay hover:bg-surface-raised transition-colors text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
          >
            <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-surface-raised flex items-center justify-center">
              <Zap size={16} className="text-text-secondary" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">Quick Compact</span>
              <p className="text-xs text-text-secondary mt-0.5">
                Summarizes older messages — faster but may lose some context
              </p>
            </div>
          </button>
        </div>

        {/* Cancel */}
        <div className="px-5 pb-5 pt-1 text-center">
          <button
            onClick={onCancel}
            className="text-xs text-text-muted hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
