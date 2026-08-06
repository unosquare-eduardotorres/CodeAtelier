import { AlertTriangle, ArrowRight, Square, X } from 'lucide-react'

interface BlockedByBannerProps {
  blockedConvTitle: string | undefined
  onSwitchTo: () => void
  onStopAndRetry: () => void
  onDismiss: () => void
}

/**
 * MULTI-CHAT-04: Actionable banner shown when sendMessage is rejected because
 * another conversation is still streaming. Offers three actions:
 * - Switch to the blocking chat
 * - Stop the blocking chat and auto-retry the message
 * - Dismiss the banner
 */
export default function BlockedByBanner({
  blockedConvTitle,
  onSwitchTo,
  onStopAndRetry,
  onDismiss
}: BlockedByBannerProps): React.JSX.Element {
  const chatLabel = blockedConvTitle ? `"${blockedConvTitle}"` : 'Another chat'

  return (
    <div
      data-testid="blocked-by-banner"
      className="
        mx-4 mt-2 flex flex-col gap-3 rounded-lg border px-4 py-3
        border-yellow-500/30 bg-yellow-500/5 text-text-primary
        animate-in fade-in slide-in-from-top-2 duration-300
      "
    >
      <div className="flex items-center gap-3">
        <AlertTriangle size={16} className="text-yellow-500 shrink-0" />
        <div className="flex flex-col gap-0.5 flex-1">
          <span className="text-sm font-medium">{chatLabel} is still processing</span>
          <span className="text-xs text-text-secondary">
            Only one chat can stream at a time. You can switch to the active chat or stop it to send
            your message here.
          </span>
        </div>
        <button
          onClick={onDismiss}
          className="p-1 rounded hover:bg-surface-overlay transition-colors text-text-secondary"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex items-center gap-2 ml-7">
        <button
          onClick={onStopAndRetry}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          <Square size={12} />
          Stop It & Retry
        </button>
        <button
          onClick={onSwitchTo}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border-subtle text-text-secondary text-xs font-medium hover:bg-surface-overlay transition-colors"
        >
          <ArrowRight size={12} />
          Switch to It
        </button>
      </div>
    </div>
  )
}
