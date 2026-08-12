import { RotateCcw, ShieldAlert, X } from 'lucide-react'

interface PermissionRetryBannerProps {
  onRetry: () => void
  onDismiss: () => void
}

/**
 * Shown when a tool-permission request ended without an answer — the turn was
 * stopped, failed, or the CLI child died while the prompt was open.
 *
 * Retry deliberately does NOT re-approve: the process that owed the tool result
 * is gone and the requestId is meaningless. It re-sends the last user message as
 * a new turn (prompt caching absorbs most of the cost), which the copy says
 * plainly so nobody expects the interrupted turn to resume where it stopped.
 */
export default function PermissionRetryBanner({
  onRetry,
  onDismiss
}: PermissionRetryBannerProps): React.JSX.Element {
  return (
    <div
      data-testid="permission-retry-banner"
      className="
        mx-4 mt-2 flex flex-col gap-3 rounded-lg border px-4 py-3
        border-blue-500/30 bg-blue-500/5 text-text-primary
        animate-in fade-in slide-in-from-top-2 duration-300
      "
    >
      <div className="flex items-center gap-3">
        <ShieldAlert size={16} className="text-blue-400 shrink-0" />
        <div className="flex flex-col gap-0.5 flex-1">
          <span className="text-sm font-medium">The permission request ended unanswered</span>
          <span className="text-xs text-text-secondary">
            The tool never ran. Retry re-sends your last message as a new turn — it cannot resume
            the interrupted one.
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
          onClick={onRetry}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          <RotateCcw size={12} />
          Retry as a New Turn
        </button>
      </div>
    </div>
  )
}
