import { useState } from 'react'
import { CheckCircle, Trash2, Copy, Undo2 } from 'lucide-react'
import type { BugRecord } from '../../../../shared/types'

interface BugDetailProps {
  bug: BugRecord
  onResolve: (id: string) => void
  onUnresolve: (id: string) => void
  onDelete: (id: string) => void
  onUpdateNote: (id: string, note: string) => void
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString()
}

export default function BugDetail({
  bug,
  onResolve,
  onUnresolve,
  onDelete,
  onUpdateNote
}: BugDetailProps): React.JSX.Element {
  const [note, setNote] = useState(bug.note ?? '')
  const [isSavingNote, setIsSavingNote] = useState(false)

  const handleCopyStack = (): void => {
    if (bug.stackTrace) {
      navigator.clipboard.writeText(bug.stackTrace)
    }
  }

  const handleSaveNote = async (): Promise<void> => {
    setIsSavingNote(true)
    await onUpdateNote(bug.id, note)
    setIsSavingNote(false)
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`w-3 h-3 rounded-full flex-shrink-0 ${
                bug.severity === 'fatal' ? 'bg-red-500' : 'bg-orange-400'
              }`}
            />
            <span className="text-xs font-medium uppercase text-text-muted">
              {bug.severity} • {bug.process}
            </span>
          </div>
          <h2 className="text-base font-semibold text-text-primary mt-1 break-words">
            {bug.errorMessage}
          </h2>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {bug.isResolved ? (
          <button
            onClick={() => onUnresolve(bug.id)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-surface-overlay border border-border-subtle rounded-md hover:bg-surface-base text-text-secondary transition-colors"
          >
            <Undo2 size={14} /> Reopen
          </button>
        ) : (
          <button
            onClick={() => onResolve(bug.id)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-emerald-500/10 border border-emerald-500/20 rounded-md hover:bg-emerald-500/20 text-emerald-400 transition-colors"
          >
            <CheckCircle size={14} /> Mark Resolved
          </button>
        )}
        {bug.stackTrace && (
          <button
            onClick={handleCopyStack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-surface-overlay border border-border-subtle rounded-md hover:bg-surface-base text-text-secondary transition-colors"
            title="Copy stack trace"
          >
            <Copy size={14} /> Copy Stack
          </button>
        )}
        <button
          onClick={() => onDelete(bug.id)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-500/10 border border-red-500/20 rounded-md hover:bg-red-500/20 text-red-400 transition-colors ml-auto"
        >
          <Trash2 size={14} /> Delete
        </button>
      </div>

      {/* Stack trace */}
      {bug.stackTrace && (
        <div>
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
            Stack Trace
          </h3>
          <pre className="text-xs text-text-secondary bg-surface-base border border-border-subtle rounded-md p-3 overflow-x-auto max-h-48 font-mono whitespace-pre-wrap">
            {bug.stackTrace}
          </pre>
        </div>
      )}

      {/* Context info */}
      <div className="grid grid-cols-2 gap-3">
        <InfoItem
          label="Source"
          value={
            bug.sourceFile
              ? `${bug.sourceFile}:${bug.sourceLine ?? ''}:${bug.sourceColumn ?? ''}`
              : '—'
          }
        />
        <InfoItem label="Component" value={bug.componentName ?? '—'} />
        <InfoItem label="Active View" value={bug.activeView ?? '—'} />
        <InfoItem label="Workspace" value={bug.workspaceId ?? '—'} />
        <InfoItem label="Agent" value={bug.agentId ?? '—'} />
        <InfoItem label="App Version" value={bug.appVersion} />
        <InfoItem label="OS" value={bug.osInfo ?? '—'} />
        <InfoItem label="Occurrences" value={String(bug.occurrenceCount)} />
        <InfoItem label="First Seen" value={formatTimestamp(bug.timestamp)} />
        <InfoItem label="Last Seen" value={formatTimestamp(bug.lastSeenAt)} />
      </div>

      {/* Note */}
      <div>
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
          Note
        </h3>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note about this bug..."
          className="w-full px-3 py-2 text-sm bg-surface-overlay border border-border-subtle rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 resize-y min-h-[60px]"
          rows={3}
        />
        <button
          onClick={handleSaveNote}
          disabled={isSavingNote || note === (bug.note ?? '')}
          className="mt-1.5 px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSavingNote ? 'Saving...' : 'Save Note'}
        </button>
      </div>
    </div>
  )
}

function InfoItem({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-[10px] font-medium text-text-muted uppercase tracking-wide">{label}</dt>
      <dd className="text-xs text-text-secondary mt-0.5 truncate" title={value}>
        {value}
      </dd>
    </div>
  )
}
