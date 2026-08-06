import { CheckCircle, Copy, Download, Trash2, X } from 'lucide-react'

interface BulkActionBarProps {
  selectedCount: number
  onResolveAll: () => void
  onDeleteAll: () => void
  onExport: () => void
  onCopyErrors: () => void
  onClearSelection: () => void
}

export default function BulkActionBar({
  selectedCount,
  onResolveAll,
  onDeleteAll,
  onExport,
  onCopyErrors,
  onClearSelection
}: BulkActionBarProps): React.JSX.Element {
  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 bg-surface-overlay border border-border-default rounded-xl shadow-lg z-50"
      data-testid="bug-bulk-action-bar"
    >
      {/* Selection count */}
      <span className="text-sm font-medium text-text-primary">{selectedCount} selected</span>

      <div className="w-px h-5 bg-border-subtle" />

      {/* Resolve */}
      <button
        data-testid="bug-bulk-resolve"
        onClick={onResolveAll}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
      >
        <CheckCircle size={14} /> Resolve
      </button>

      {/* Copy Errors */}
      <button
        data-testid="bug-bulk-copy"
        onClick={onCopyErrors}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-surface-base text-text-secondary hover:bg-surface-hover transition-colors"
      >
        <Copy size={14} /> Copy Errors
      </button>

      {/* Export */}
      <button
        data-testid="bug-bulk-export"
        onClick={onExport}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-surface-base text-text-secondary hover:bg-surface-hover transition-colors"
      >
        <Download size={14} /> Export
      </button>

      {/* Delete */}
      <button
        data-testid="bug-bulk-delete"
        onClick={onDeleteAll}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
      >
        <Trash2 size={14} /> Delete
      </button>

      <div className="w-px h-5 bg-border-subtle" />

      {/* Clear selection */}
      <button
        onClick={onClearSelection}
        className="p-1.5 rounded-md hover:bg-surface-base text-text-muted transition-colors"
        aria-label="Clear selection"
      >
        <X size={14} />
      </button>
    </div>
  )
}
