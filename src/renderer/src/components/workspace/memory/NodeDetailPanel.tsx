/**
 * NodeDetailPanel — right-side overlay showing full details for a selected graph node.
 *
 * Renders from a full MemoryFact (fetched via IPC) with loading shimmer,
 * action buttons for confirm/archive/delete, and a ConfirmDialog for delete.
 */

import { useState } from 'react'
import { X, CheckCircle, Archive, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@renderer/components/common'
import TierBadge from './TierBadge'
import CategoryBadge from './CategoryBadge'
import type {
  MemoryFact,
  MemoryFactCategory,
  MemoryFactTier
} from '../../../../../shared/types'

// ── Props ──

interface NodeDetailPanelProps {
  title: string
  category: MemoryFactCategory
  tier: number
  confidence: number
  status: string
  fact: MemoryFact | null
  factLoading: boolean
  onClose: () => void
  onConfirm: () => void
  onArchive: () => void
  onDelete: () => void
  actionsDisabled?: boolean
}

// ── Component ──

export default function NodeDetailPanel({
  title,
  category,
  tier,
  confidence,
  status,
  fact,
  factLoading,
  onClose,
  onConfirm,
  onArchive,
  onDelete,
  actionsDisabled = false
}: NodeDetailPanelProps): React.JSX.Element {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  return (
    <>
      <div className="absolute top-3 right-3 w-[300px] max-h-[calc(100%-24px)] overflow-y-auto bg-surface-float border border-border-default rounded-md shadow-lg p-4 space-y-3 z-40">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-medium text-text-primary leading-tight flex-1">
            {title}
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <CategoryBadge category={category} />
          <TierBadge tier={Math.min(tier, 3) as MemoryFactTier} confidence={confidence} />
        </div>

        {factLoading ? (
          <div className="space-y-2 animate-pulse">
            <div className="h-3 bg-surface-overlay rounded w-full" />
            <div className="h-3 bg-surface-overlay rounded w-4/5" />
            <div className="h-3 bg-surface-overlay rounded w-3/5" />
          </div>
        ) : fact ? (
          <>
            <p className="text-xs text-text-secondary leading-relaxed">{fact.content}</p>

            <div className="space-y-1 text-[10px] text-text-muted">
              <p>Confidence: {Math.round((fact.confidence ?? 0) * 100)}%</p>
              <p>Confirms: {fact.confirmationCount}</p>
              <p>Source: {fact.sourceType}{fact.sourceRef ? ` · ${fact.sourceRef.slice(0, 20)}` : ''}</p>
              {fact.scopePaths.length > 0 && (
                <p>Scope: {fact.scopePaths.slice(0, 3).join(', ')}</p>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-1 text-[10px] text-text-muted">
            <p>Confidence: {Math.round(confidence * 100)}%</p>
          </div>
        )}

        {status === 'active' && (
          <div className="flex items-center gap-2 pt-2 border-t border-border-default">
            <button
              onClick={onConfirm}
              disabled={actionsDisabled}
              className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-success hover:bg-success-muted rounded transition-colors disabled:opacity-40 disabled:pointer-events-none"
              title="Confirm this memory"
            >
              <CheckCircle className="w-3.5 h-3.5" /> Confirm
            </button>
            <button
              onClick={onArchive}
              disabled={actionsDisabled}
              className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-warning hover:bg-warning-muted rounded transition-colors disabled:opacity-40 disabled:pointer-events-none"
              title="Archive this memory"
            >
              <Archive className="w-3.5 h-3.5" /> Archive
            </button>
            <button
              onClick={() => setShowDeleteDialog(true)}
              disabled={actionsDisabled}
              className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-danger hover:bg-danger-muted rounded transition-colors disabled:opacity-40 disabled:pointer-events-none"
              title="Delete this memory"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Delete Memory Permanently"
        message={`Delete "${title}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setShowDeleteDialog(false)
          onDelete()
        }}
        onCancel={() => setShowDeleteDialog(false)}
      />
    </>
  )
}
