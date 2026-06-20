/**
 * PermissionToast — toast notification for permission requests from
 * background workspace sessions. Shows workspace name, permission type,
 * summary, and action buttons.
 *
 * Simple permissions (MPA approve/deny, basic elicitation) can be resolved
 * inline. Complex ones (multi-field forms, ask questions) show a "View"
 * button that switches to the workspace.
 */

import { X, Shield, MessageCircle, CheckCircle2 } from 'lucide-react'
import type { PendingPermission, PermissionType } from '../../../../shared/types'

interface PermissionToastProps {
  permission: PendingPermission
  onRespond: (response: 'approve' | 'deny') => void
  onView: () => void
  onDismiss: () => void
}

function TypeBadge({ type }: { type: PermissionType }): React.JSX.Element {
  const config: Record<PermissionType, { icon: typeof Shield; label: string; className: string }> =
    {
      elicitation: {
        icon: Shield,
        label: 'Permission',
        className: 'bg-blue-500/10 text-blue-400 border-blue-500/20'
      },
      askQuestion: {
        icon: MessageCircle,
        label: 'Question',
        className: 'bg-purple-500/10 text-purple-400 border-purple-500/20'
      },
      mpaApproval: {
        icon: CheckCircle2,
        label: 'Approval',
        className: 'bg-green-500/10 text-green-400 border-green-500/20'
      }
    }

  const { icon: Icon, label, className } = config[type]

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${className}`}
    >
      <Icon size={10} />
      {label}
    </span>
  )
}

export default function PermissionToast({
  permission,
  onRespond,
  onView,
  onDismiss
}: PermissionToastProps): React.JSX.Element {
  return (
    <div
      data-testid="permission-toast"
      className="w-96 bg-surface-raised border border-border-default rounded-xl shadow-xl p-4 animate-in slide-in-from-right-5 duration-300"
    >
      {/* Header: workspace name + type badge + dismiss */}
      <div className="flex items-center gap-2 mb-2">
        <span className="w-6 h-6 rounded bg-primary-subtle flex items-center justify-center text-xs font-bold text-primary-text">
          {permission.workspaceName.charAt(0).toUpperCase()}
        </span>
        <span className="text-sm font-medium text-text-primary truncate flex-1">
          {permission.workspaceName}
        </span>
        <TypeBadge type={permission.type} />
        <button
          onClick={onDismiss}
          className="p-1 rounded-md hover:bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>

      {/* Summary */}
      <p className="text-sm text-text-default mb-3 line-clamp-2">{permission.summary}</p>

      {/* Actions */}
      {permission.isSimple ? (
        <div className="flex gap-2">
          <button
            data-testid="permission-accept-btn"
            onClick={() => onRespond('approve')}
            className="flex-1 px-3 py-1.5 text-sm font-medium rounded-lg bg-primary text-primary-text hover:bg-primary/90 transition-colors"
          >
            Approve
          </button>
          <button
            onClick={() => onRespond('deny')}
            className="flex-1 px-3 py-1.5 text-sm font-medium rounded-lg bg-surface-overlay text-text-secondary hover:bg-surface-overlay/80 transition-colors"
          >
            Deny
          </button>
        </div>
      ) : (
        <button
          onClick={onView}
          className="w-full px-3 py-1.5 text-sm font-medium rounded-lg bg-surface-overlay text-text-secondary hover:bg-surface-overlay/80 transition-colors text-center"
        >
          View in {permission.workspaceName} →
        </button>
      )}
    </div>
  )
}
