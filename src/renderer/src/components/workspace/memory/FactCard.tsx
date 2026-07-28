import { useState } from 'react'
import { CheckCircle, Archive, Trash2, Globe, Clock } from 'lucide-react'

import { ConfirmDialog } from '@renderer/components/common'
import TierBadge from './TierBadge'
import CategoryBadge from './CategoryBadge'
import type { MemoryFact } from '../../../../../shared/types'

// ── Helpers ──

function relativeDate(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

// ── Component ──

interface FactCardProps {
  fact: MemoryFact
  onConfirm?: () => void
  onArchive?: () => void
  onDelete?: () => void
  onScopeToggle?: () => void
  dimmed?: boolean
}

export default function FactCard({
  fact,
  onConfirm,
  onArchive,
  onDelete,
  onScopeToggle,
  dimmed
}: FactCardProps): React.JSX.Element {
  const [showArchiveDialog, setShowArchiveDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  return (
    <>
      <div
        className={`group border border-border-default rounded-md p-3 space-y-2 transition-colors hover:border-border-strong ${
          dimmed ? 'opacity-50' : ''
        }`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <CategoryBadge category={fact.category} />
            <TierBadge tier={fact.tier} confidence={fact.confidence} />
            {onScopeToggle ? (
              <button
                onClick={onScopeToggle}
                className="flex items-center gap-0.5 text-xs text-text-muted hover:text-info transition-colors"
                title={fact.workspaceId ? 'Make global' : 'Scope to workspace'}
                aria-label={fact.workspaceId ? 'Make this memory global' : 'Scope this memory to workspace'}
              >
                <Globe className="w-3 h-3" />
                {fact.workspaceId ? 'Workspace' : 'Global'}
              </button>
            ) : (
              !fact.workspaceId && (
                <span className="flex items-center gap-0.5 text-xs text-text-muted">
                  <Globe className="w-3 h-3" /> Global
                </span>
              )
            )}
            {fact.embeddingPending && (
              <span className="flex items-center gap-1 text-xs text-warning">
                <Clock className="w-3 h-3" /> pending
              </span>
            )}
          </div>

          {/* Action buttons — revealed on hover (progressive disclosure) */}
          <div
            className={`flex items-center gap-1 shrink-0 transition-opacity ${
              isHovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {onConfirm && fact.status === 'active' && (
              <button
                onClick={onConfirm}
                className="inline-flex items-center gap-1 px-2 py-1 min-h-[2.75rem] min-w-[2.75rem] text-xs text-text-muted hover:text-success hover:bg-success-muted rounded transition-colors"
                title="Vouch for this memory — 3 confirms promote it to the next tier"
                aria-label="Confirm this memory"
              >
                <CheckCircle className="w-4 h-4" />
                <span className="hidden sm:inline">Confirm</span>
              </button>
            )}
            {onArchive && fact.status === 'active' && (
              <button
                onClick={() => setShowArchiveDialog(true)}
                className="inline-flex items-center gap-1 px-2 py-1 min-h-[2.75rem] min-w-[2.75rem] text-xs text-text-muted hover:text-warning hover:bg-warning-muted rounded transition-colors"
                title="Hide from retrieval — reversible"
                aria-label="Archive this memory"
              >
                <Archive className="w-4 h-4" />
                <span className="hidden sm:inline">Archive</span>
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => setShowDeleteDialog(true)}
                className="inline-flex items-center gap-1 px-2 py-1 min-h-[2.75rem] min-w-[2.75rem] text-xs text-text-muted hover:text-danger hover:bg-danger-muted rounded transition-colors"
                title="Permanently remove — cannot be undone"
                aria-label="Delete this memory permanently"
              >
                <Trash2 className="w-4 h-4" />
                <span className="hidden sm:inline">Delete</span>
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <h4 className="text-sm font-medium text-text-primary">{fact.title}</h4>
        <p className="text-xs text-text-secondary leading-relaxed">{fact.content}</p>

        {/* Metadata footer */}
        <div className="flex items-center gap-3 text-[10px] text-text-muted">
          <span>
            {fact.sourceType}
            {fact.sourceRef ? ` · ${fact.sourceRef.slice(0, 20)}` : ''}
          </span>
          <span>Confirms: {fact.confirmationCount}</span>
          {fact.scopePaths.length > 0 && (
            <span>Scope: {fact.scopePaths.slice(0, 2).join(', ')}</span>
          )}
          <span>{relativeDate(fact.createdAt)}</span>
        </div>
      </div>

      {/* Archive confirmation dialog */}
      <ConfirmDialog
        isOpen={showArchiveDialog}
        title="Archive Memory"
        message={`Archive "${fact.title}"? This hides it from retrieval but can be reversed.`}
        confirmLabel="Archive"
        cancelLabel="Cancel"
        variant="default"
        onConfirm={() => {
          setShowArchiveDialog(false)
          onArchive?.()
        }}
        onCancel={() => setShowArchiveDialog(false)}
      />

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Delete Memory Permanently"
        message={`Delete "${fact.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setShowDeleteDialog(false)
          onDelete?.()
        }}
        onCancel={() => setShowDeleteDialog(false)}
      />
    </>
  )
}
