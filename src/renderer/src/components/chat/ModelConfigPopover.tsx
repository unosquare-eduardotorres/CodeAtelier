/**
 * ModelConfigPopover — shows the frozen model configuration for a conversation.
 *
 * Displays which models are assigned to plan/build/background roles and their
 * provenance (workspace roles, manual override, or default). Read-only.
 *
 * Triggered by an info icon in the chat panel header.
 */

import { useState, useRef, useEffect } from 'react'
import { Info, X } from 'lucide-react'
import type { ConversationModelSnapshot, ResolvedAssignment } from '../../../../shared/types'

interface ModelConfigPopoverProps {
  /** The frozen model snapshot (null for legacy conversations) */
  snapshot: ConversationModelSnapshot | null
  /** Provider display name */
  providerLabel?: string
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
  if (modelId.includes('opus')) return 'Opus 4.8'
  if (modelId.includes('sonnet')) return 'Sonnet 4.6'
  if (modelId.includes('haiku')) return 'Haiku 4.5'
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

export default function ModelConfigPopover({
  snapshot,
  providerLabel
}: ModelConfigPopoverProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false)
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
              onClick={() => setIsOpen(false)}
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
              <p className="text-[10px] text-text-muted mt-3">
                Frozen at conversation creation · {new Date(snapshot.snapshotAt).toLocaleDateString()}
              </p>
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
