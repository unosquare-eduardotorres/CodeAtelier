/**
 * ModelConfigPopover — shows and edits the frozen model configuration for a conversation.
 *
 * Displays which models are assigned to plan/build/background roles and their
 * provenance (workspace roles, manual override, or default).
 *
 * "Switch Model" button lets users re-route an existing conversation to a different
 * model without affecting other chats (calls CHAT_UPDATE_ROUTING IPC).
 *
 * Triggered by an info icon in the chat panel header.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Info, X, RefreshCw } from 'lucide-react'
import { AVAILABLE_MODELS } from '../../../../shared/constants'
import type {
  Conversation,
  ConversationModelSnapshot,
  LLMProvider,
  ModelRoleAssignment,
  ModelRoleMap,
  ResolvedAssignment
} from '../../../../shared/types'

interface ModelConfigPopoverProps {
  /** The frozen model snapshot (null for legacy conversations) */
  snapshot: ConversationModelSnapshot | null
  /** Provider display name */
  providerLabel?: string
  /** Conversation ID — required for editing */
  conversationId?: string
  /** Workspace ID — required for editing */
  workspaceId?: string
  /** Called when routing is updated so parent can refresh state */
  onRoutingUpdated?: (updated: Conversation) => void
}

function sourceLabel(source: ResolvedAssignment['source']): string {
  switch (source) {
    case 'roles':
      return 'workspace roles'
    case 'override':
      return 'manual override'
    case 'default':
      return 'default'
    case 'fallback':
      return 'fallback'
  }
}

function modelLabel(modelId: string): string {
  const claude = AVAILABLE_MODELS.find((m) => m.id === modelId)
  if (claude) return claude.label
  // Local/custom models — show as-is but truncate
  return modelId.length > 20 ? `${modelId.slice(0, 18)}…` : modelId
}

function AssignmentRow({
  label,
  assignment
}: {
  label: string
  assignment: ResolvedAssignment
}): React.JSX.Element {
  const providerBadge =
    assignment.provider === 'claude' ? (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-muted/50 text-primary-text font-medium">
        Claude
      </span>
    ) : (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-mode-build-muted/50 text-mode-build-text font-medium">
        Local
      </span>
    )

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-text-secondary">{label}</span>
      <div className="flex items-center gap-2">
        {providerBadge}
        <span className="text-xs text-text-primary font-medium">
          {modelLabel(assignment.modelId)}
        </span>
        <span className="text-[10px] text-text-muted">({sourceLabel(assignment.source)})</span>
      </div>
    </div>
  )
}

// ── Model selector for editing ──

const EDITABLE_ROLES: { label: string; action: keyof ModelRoleMap }[] = [
  { label: 'Plan', action: 'specialist:plan' },
  { label: 'Build', action: 'specialist:build' }
]

function ModelSelector({
  snapshot,
  conversationId,
  workspaceId,
  onDone,
  onRoutingUpdated
}: {
  snapshot: ConversationModelSnapshot | null
  conversationId: string
  workspaceId: string
  onDone: () => void
  onRoutingUpdated?: (updated: Conversation) => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [overrides, setOverrides] = useState<Partial<ModelRoleMap>>({})

  const handleAssign = (action: keyof ModelRoleMap, modelId: string): void => {
    const claude = AVAILABLE_MODELS.find((m) => m.id === modelId)
    const assignment: ModelRoleAssignment = claude
      ? { provider: 'claude' as LLMProvider, modelId }
      : { provider: 'local-llm' as LLMProvider, modelId, localBackend: 'omlx' as const }
    setOverrides((prev) => ({ ...prev, [action]: assignment }))
  }

  const handleSave = useCallback(async () => {
    if (Object.keys(overrides).length === 0) {
      onDone()
      return
    }
    setSaving(true)
    try {
      const updated = await window.api.updateConversationRouting({
        conversationId,
        workspaceId,
        routingOverrides: overrides
      })
      onRoutingUpdated?.(updated)
      onDone()
    } catch (err) {
      console.error('[ModelConfigPopover] Failed to update routing:', err)
    } finally {
      setSaving(false)
    }
  }, [overrides, conversationId, workspaceId, onDone, onRoutingUpdated])

  return (
    <div className="mt-3 pt-3 border-t border-border-subtle">
      <p className="text-[10px] text-text-muted mb-2">
        Changes only affect this conversation.
      </p>
      {EDITABLE_ROLES.map((role) => {
        const current =
          overrides[role.action]?.modelId ??
          (role.action === 'specialist:plan'
            ? snapshot?.plan.modelId
            : snapshot?.build.modelId) ??
          ''
        return (
          <div key={role.action} className="flex items-center justify-between gap-3 py-1">
            <span className="text-xs text-text-secondary">{role.label}</span>
            <select
              value={current}
              onChange={(e) => handleAssign(role.action, e.target.value)}
              className="bg-surface-base border border-border-subtle rounded px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50 max-w-[180px]"
              aria-label={`${role.label} model`}
            >
              {AVAILABLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )
      })}
      <div className="flex items-center justify-end gap-2 mt-2">
        <button
          onClick={onDone}
          className="text-xs text-text-muted hover:text-text-secondary transition-colors px-2 py-1"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || Object.keys(overrides).length === 0}
          className="text-xs font-medium text-primary-text bg-primary-muted hover:bg-primary-muted/80 disabled:opacity-50 rounded px-3 py-1 transition-colors"
        >
          {saving ? 'Saving…' : 'Apply'}
        </button>
      </div>
    </div>
  )
}

// ── Main popover ──

export default function ModelConfigPopover({
  snapshot,
  providerLabel,
  conversationId,
  workspaceId,
  onRoutingUpdated
}: ModelConfigPopoverProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  const canEdit = !!conversationId && !!workspaceId

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setIsEditing(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-1 rounded hover:bg-surface-overlay transition-colors text-text-muted hover:text-text-secondary"
        title="View model configuration"
        aria-label="Model configuration info"
      >
        <Info size={14} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-8 z-50 w-80 rounded-lg border border-border-default bg-surface-raised shadow-lg p-4 animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-text-primary">Model Configuration</h4>
            <button
              onClick={() => {
                setIsOpen(false)
                setIsEditing(false)
              }}
              className="p-0.5 rounded hover:bg-surface-overlay text-text-muted"
            >
              <X size={12} />
            </button>
          </div>

          {snapshot ? (
            <>
              <div className="divide-y divide-border-subtle">
                <AssignmentRow label="Plan" assignment={snapshot.plan} />
                <AssignmentRow label="Build" assignment={snapshot.build} />
                <AssignmentRow label="Background" assignment={snapshot.background} />
              </div>
              <div className="flex items-center justify-between mt-3">
                <p className="text-[10px] text-text-muted">
                  Frozen at creation · {new Date(snapshot.snapshotAt).toLocaleDateString()}
                </p>
                {canEdit && !isEditing && (
                  <button
                    onClick={() => setIsEditing(true)}
                    className="flex items-center gap-1 text-[10px] text-primary-text hover:text-primary-text/80 transition-colors"
                  >
                    <RefreshCw size={10} />
                    Switch model
                  </button>
                )}
              </div>

              {isEditing && canEdit && (
                <ModelSelector
                  snapshot={snapshot}
                  conversationId={conversationId!}
                  workspaceId={workspaceId!}
                  onDone={() => setIsEditing(false)}
                  onRoutingUpdated={onRoutingUpdated}
                />
              )}
            </>
          ) : (
            <div className="text-xs text-text-muted py-2">
              <p>Using live workspace settings{providerLabel ? ` (${providerLabel})` : ''}.</p>
              <p className="mt-1 text-[10px]">
                Legacy conversation — model config will be frozen for new conversations.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
