/**
 * CompletionToast — notification for important completions or failures
 * from background workspace sessions. Shows workspace name, service type,
 * outcome, and a summary.
 *
 * - Audit/MPA completions always show.
 * - Chat completions are silent (sidebar badge only).
 * - All failures show regardless of service.
 */

import { X, CheckCircle2, XCircle, Zap, Shield, Target } from 'lucide-react'
import type { CompletionNotification } from '../../../../shared/types'

interface CompletionToastProps {
  notification: CompletionNotification
  onView: () => void
  onDismiss: () => void
}

function ServiceIcon({ service }: { service: string }): React.JSX.Element {
  const iconMap: Record<string, typeof Zap> = {
    grill: Zap,
    audit: Shield,
    mpa: Target
  }
  const Icon = iconMap[service] ?? Zap
  return <Icon size={14} />
}

export default function CompletionToast({
  notification,
  onView,
  onDismiss
}: CompletionToastProps): React.JSX.Element {
  const isSuccess = notification.status === 'completed'

  return (
    <div data-testid="completion-toast" className="w-96 bg-surface-raised border border-border-default rounded-xl shadow-xl p-4 animate-in slide-in-from-right-5 duration-300">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className="w-6 h-6 rounded bg-primary-subtle flex items-center justify-center text-xs font-bold text-primary-text">
          {notification.workspaceName.charAt(0).toUpperCase()}
        </span>
        <span className="text-sm font-medium text-text-primary truncate flex-1">
          {notification.workspaceName}
        </span>
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${
            isSuccess
              ? 'bg-green-500/10 text-green-400 border-green-500/20'
              : 'bg-red-500/10 text-red-400 border-red-500/20'
          }`}
        >
          {isSuccess ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
          <ServiceIcon service={notification.service} />
        </span>
        <button
          onClick={onDismiss}
          className="p-1 rounded-md hover:bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>

      {/* Summary */}
      <p className="text-sm text-text-default mb-3 line-clamp-2">{notification.summary}</p>

      {/* View button */}
      <button
        onClick={onView}
        className="w-full px-3 py-1.5 text-sm font-medium rounded-lg bg-surface-overlay text-text-secondary hover:bg-surface-overlay/80 transition-colors text-center"
      >
        View in {notification.workspaceName} →
      </button>
    </div>
  )
}
