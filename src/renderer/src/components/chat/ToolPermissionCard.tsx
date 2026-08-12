/**
 * ToolPermissionCard — a read-only receipt for a tool permission in the transcript.
 *
 * The decision lives in PermissionApprovalModal: it queues, has no accidental
 * dismiss path and cannot be scrolled past. Two decision surfaces for one
 * request would let the user answer twice, so the card keeps no buttons. What it
 * keeps is evidence: a toast that is dismissed or collapsed to a badge leaves no
 * trace, so an approval that fails to resume the turn looked identical to the
 * agent simply going quiet. The card stays put, flips to "waiting", and is only
 * removed when the stream actually moves.
 */

import { Shield } from 'lucide-react'
import ToolInputPreview from '@renderer/components/notifications/ToolInputPreview'
import type { PendingToolPermission } from '@renderer/store/chat.store'

interface ToolPermissionCardProps {
  pending: PendingToolPermission
}

const STATUS_TEXT: Record<PendingToolPermission['decision'], string> = {
  pending: 'Waiting for your decision in the approval dialog…',
  approved: 'Approved — waiting for the agent to continue…',
  denied: 'Denied.'
}

export default function ToolPermissionCard({
  pending
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

      {/* Status — the modal decides, this records */}
      <div
        data-testid="tool-permission-status"
        className="px-4 py-3 border-t border-border-subtle bg-surface-base/50 text-sm text-text-muted"
      >
        {STATUS_TEXT[decision]}
      </div>
    </div>
  )
}
