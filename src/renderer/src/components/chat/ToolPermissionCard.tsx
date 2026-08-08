/**
 * ToolPermissionCard — an inline approve/deny prompt in the transcript.
 *
 * Tool permissions used to surface only as a toast. A toast that is dismissed,
 * missed, or collapsed to a badge leaves no trace, so an approval that fails to
 * resume the turn looked identical to the agent simply going quiet. Rendering
 * the prompt in the transcript makes that failure legible: the card stays put,
 * flips to "waiting", and is only removed when the stream actually moves.
 */

import { Shield, Check, X } from 'lucide-react'
import ToolInputPreview from '@renderer/components/notifications/ToolInputPreview'
import type { PendingToolPermission } from '@renderer/store/chat.store'

interface ToolPermissionCardProps {
  pending: PendingToolPermission
  onResolve: (approved: boolean) => void
}

export default function ToolPermissionCard({
  pending,
  onResolve
}: ToolPermissionCardProps): React.JSX.Element {
  const { permission, decision } = pending
  const toolName = permission.toolName ?? 'a tool'

  return (
    <div
      data-testid="tool-permission-card"
      className="rounded-xl border border-border-subtle bg-surface-overlay overflow-hidden shadow-sm"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-surface-base/60 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-text-secondary" />
          <span className="text-sm font-semibold text-text-primary">
            Permission needed — {toolName}
          </span>
        </div>
        {permission.mode && (
          <span className="text-xs text-text-muted uppercase tracking-wider">
            {permission.mode}
          </span>
        )}
      </div>

      {/* Tool input */}
      {permission.toolInput && Object.keys(permission.toolInput).length > 0 && (
        <div className="px-4 py-3">
          <ToolInputPreview toolName={toolName} input={permission.toolInput} />
        </div>
      )}

      {/* Actions or resolved state */}
      {decision === 'pending' ? (
        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-border-subtle bg-surface-base/50">
          <button
            onClick={() => onResolve(false)}
            data-testid="tool-permission-deny"
            className="flex items-center gap-1.5 px-4 py-2 text-text-muted hover:text-text-secondary rounded-lg text-sm font-medium transition-colors border border-transparent hover:border-border-subtle focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <X size={14} />
            Deny
          </button>
          <button
            onClick={() => onResolve(true)}
            data-testid="tool-permission-approve"
            className="flex items-center gap-1.5 px-5 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 press-scale"
          >
            <Check size={14} />
            Approve
          </button>
        </div>
      ) : (
        <div
          data-testid="tool-permission-resolved"
          className="px-4 py-3 border-t border-border-subtle bg-surface-base/50 text-sm text-text-muted"
        >
          {decision === 'approved' ? 'Approved — waiting for the agent to continue…' : 'Denied.'}
        </div>
      )}
    </div>
  )
}
