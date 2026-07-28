/**
 * PermissionApprovalModal — full-screen modal overlay for permission requests
 * from background workspace sessions. Replaces the previous PermissionToast
 * with a centered modal featuring animated header illustration.
 *
 * Shows one permission at a time (oldest first). When resolved, the next
 * queued permission appears. Simple permissions (MPA approve/deny, basic
 * elicitation) can be resolved inline. Complex ones show a "View" button
 * that switches to the workspace.
 */

import { Shield, MessageCircle, CheckCircle2, Terminal } from 'lucide-react'
import type { PendingPermission, PermissionType } from '../../../../shared/types'

// ── Type-specific theming ─────────────────────────────────────────────────

interface TypeTheme {
  icon: typeof Shield
  label: string
  badgeClass: string
  colorClass: string // text color for the icon + ring
  bgClass: string // gradient from-color
  iconBg: string // icon container bg
  iconBorder: string // icon container border
}

const TYPE_THEMES: Record<PermissionType, TypeTheme> = {
  elicitation: {
    icon: Shield,
    label: 'Permission',
    badgeClass: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    colorClass: 'text-blue-500',
    bgClass: 'from-blue-500/10',
    iconBg: 'bg-blue-500/15',
    iconBorder: 'border-blue-500/30'
  },
  askQuestion: {
    icon: MessageCircle,
    label: 'Question',
    badgeClass: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    colorClass: 'text-purple-500',
    bgClass: 'from-purple-500/10',
    iconBg: 'bg-purple-500/15',
    iconBorder: 'border-purple-500/30'
  },
  mpaApproval: {
    icon: CheckCircle2,
    label: 'Approval',
    badgeClass: 'bg-green-500/10 text-green-400 border-green-500/20',
    colorClass: 'text-green-500',
    bgClass: 'from-green-500/10',
    iconBg: 'bg-green-500/15',
    iconBorder: 'border-green-500/30'
  },
  toolPermission: {
    icon: Terminal,
    label: 'Tool Permission',
    badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    colorClass: 'text-amber-500',
    bgClass: 'from-amber-500/10',
    iconBg: 'bg-amber-500/15',
    iconBorder: 'border-amber-500/30'
  }
}

// ── Type Badge ────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: PermissionType }): React.JSX.Element {
  const { icon: Icon, label, badgeClass } = TYPE_THEMES[type]
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${badgeClass}`}
    >
      <Icon size={10} />
      {label}
    </span>
  )
}

// ── Component ─────────────────────────────────────────────────────────────

export interface PermissionApprovalModalProps {
  permission: PendingPermission
  queueCount: number
  onRespond: (response: 'approve' | 'deny') => void
  onView: () => void
  onDismiss: () => void
}

export default function PermissionApprovalModal({
  permission,
  queueCount,
  onRespond,
  onView,
  onDismiss
}: PermissionApprovalModalProps): React.JSX.Element {
  const theme = TYPE_THEMES[permission.type]
  const TypeIcon = theme.icon

  return (
    <div
      data-testid="permission-approval-modal"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm permission-modal-enter"
      role="alertdialog"
      aria-modal="true"
      aria-label={`${theme.label} request from ${permission.workspaceName}`}
      onClick={(e) => {
        // Dismiss on backdrop click
        if (e.target === e.currentTarget) onDismiss()
      }}
    >
      <div className="bg-surface-float border border-border-default rounded-xl shadow-2xl w-[440px] overflow-hidden permission-modal-card-enter">
        {/* ── Animated Header Illustration ── */}
        <div
          className={`relative h-32 flex items-center justify-center overflow-hidden bg-gradient-to-b ${theme.bgClass} to-transparent`}
        >
          {/* Radiating rings */}
          <div className={`permission-ring permission-ring-1 ${theme.colorClass}`} />
          <div className={`permission-ring permission-ring-2 ${theme.colorClass}`} />
          <div className={`permission-ring permission-ring-3 ${theme.colorClass}`} />

          {/* Central icon */}
          <div
            className={`permission-icon-pulse relative z-10 w-14 h-14 rounded-2xl ${theme.iconBg} border ${theme.iconBorder} flex items-center justify-center`}
          >
            <TypeIcon size={28} className={theme.colorClass} />
          </div>
        </div>

        {/* ── Content ── */}
        <div className="px-5 py-4 text-center">
          <TypeBadge type={permission.type} />
          <h3 className="text-sm font-semibold text-text-primary mt-2">
            {permission.workspaceName}
          </h3>
          <p className="text-sm text-text-default mt-1 line-clamp-3">{permission.summary}</p>
          {queueCount > 1 && (
            <span className="text-xs text-text-muted mt-2 inline-block">
              +{queueCount - 1} more pending
            </span>
          )}
        </div>

        {/* ── Actions ── */}
        <div className="flex gap-3 px-5 py-4 border-t border-border-default bg-surface-overlay">
          {permission.isSimple ? (
            <>
              <button
                onClick={() => onRespond('deny')}
                className="flex-1 px-3 py-2 text-sm font-medium rounded-lg text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 transition-colors"
              >
                Deny
              </button>
              <button
                data-testid="permission-accept-btn"
                onClick={() => onRespond('approve')}
                className="flex-1 px-3 py-2 text-sm font-medium rounded-lg text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 transition-colors"
              >
                Approve
              </button>
            </>
          ) : (
            <button
              onClick={onView}
              className="w-full px-3 py-2 text-sm font-medium rounded-lg bg-surface-raised text-text-secondary hover:bg-surface-raised/80 border border-border-subtle transition-colors text-center"
            >
              View in {permission.workspaceName} →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
