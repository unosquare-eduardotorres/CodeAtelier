import { Play, Square, Timer } from 'lucide-react'

interface TurnLimitBannerProps {
  continuable: boolean
  continuationsUsed: number
  continuationsMax: number
  onContinue: () => void
  onDismiss: () => void
}

export default function TurnLimitBanner({
  continuable,
  continuationsUsed,
  continuationsMax,
  onContinue,
  onDismiss
}: TurnLimitBannerProps): React.JSX.Element {
  return (
    <div
      data-testid="turn-limit-banner"
      className="
        mx-4 mt-2 flex flex-col gap-3 rounded-lg border px-4 py-3
        border-primary/20 bg-primary/5 text-text-primary
        animate-in fade-in slide-in-from-top-2 duration-300
      "
    >
      <div className="flex items-center gap-3">
        <Timer size={16} className="text-primary shrink-0" />
        <div className="flex flex-col gap-0.5 flex-1">
          <span className="text-sm font-medium">Turn limit reached</span>
          <span className="text-xs text-text-secondary">
            Auto-continued {continuationsUsed}/{continuationsMax} times. Your progress is preserved
            — click Continue to keep going, or stop here and send a new message anytime.
          </span>
        </div>
      </div>
      {continuable && (
        <div className="flex items-center gap-2 ml-7">
          <button
            onClick={onContinue}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            <Play size={12} />
            Continue
          </button>
          <button
            onClick={onDismiss}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border-subtle text-text-secondary text-xs font-medium hover:bg-surface-overlay transition-colors"
          >
            <Square size={12} />
            Stop Here
          </button>
        </div>
      )}
    </div>
  )
}
