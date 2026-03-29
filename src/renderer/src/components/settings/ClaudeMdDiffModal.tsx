import { useState, useMemo } from 'react'
import { Check, X, FileText, FilePlus, ArrowLeftRight, Loader2 } from 'lucide-react'
import CodeEditor from './CodeEditor'

interface ClaudeMdDiffModalProps {
  existing: string | null
  proposed: string
  workspacePath: string
  onConfirm: (content: string) => void
  onDismiss: () => void
  isConfirming: boolean
}

export default function ClaudeMdDiffModal({
  existing,
  proposed,
  workspacePath,
  onConfirm,
  onDismiss,
  isConfirming
}: ClaudeMdDiffModalProps): React.JSX.Element {
  const [editedContent, setEditedContent] = useState(proposed)

  const stats = useMemo(() => {
    const existingLines = existing ? existing.split('\n').length : 0
    const proposedLines = editedContent.split('\n').length
    const existingChars = existing ? existing.length : 0
    const proposedChars = editedContent.length
    return {
      existingLines,
      proposedLines,
      lineDelta: proposedLines - existingLines,
      existingChars,
      proposedChars,
      charDelta: proposedChars - existingChars
    }
  }, [existing, editedContent])

  const formatDelta = (delta: number): string => {
    if (delta > 0) return `+${delta}`
    return `${delta}`
  }

  return (
    <div className="flex-1 flex flex-col bg-surface-base min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-surface-base">
        <div className="flex items-center gap-3">
          <ArrowLeftRight size={16} className="text-primary-text" />
          <span className="text-sm font-semibold text-text-primary">Review CLAUDE.md Changes</span>
          <span className="text-xs text-text-muted font-mono truncate max-w-[300px]">
            {workspacePath}/CLAUDE.md
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onDismiss}
            disabled={isConfirming}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors disabled:opacity-50"
          >
            <X size={14} />
            Cancel
          </button>
          <button
            onClick={() => onConfirm(editedContent)}
            disabled={isConfirming}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-success hover:bg-success/90 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isConfirming ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Writing...
              </>
            ) : (
              <>
                <Check size={14} />
                Approve &amp; Write
              </>
            )}
          </button>
        </div>
      </div>

      {/* Info bar */}
      <div className="flex items-center gap-4 px-6 py-2 border-b border-border-default bg-surface-base/50 text-xs text-text-muted">
        <span>
          Lines: {stats.existingLines} {'\u2192'} {stats.proposedLines}{' '}
          <span
            className={
              stats.lineDelta > 0
                ? 'text-success'
                : stats.lineDelta < 0
                  ? 'text-danger'
                  : 'text-text-muted'
            }
          >
            ({formatDelta(stats.lineDelta)})
          </span>
        </span>
        <span>
          Chars: {stats.existingChars.toLocaleString()} {'\u2192'}{' '}
          {stats.proposedChars.toLocaleString()}{' '}
          <span
            className={
              stats.charDelta > 0
                ? 'text-success'
                : stats.charDelta < 0
                  ? 'text-danger'
                  : 'text-text-muted'
            }
          >
            ({formatDelta(stats.charDelta)})
          </span>
        </span>
        <span className="ml-auto text-text-secondary">
          You can edit the proposed content before approving
        </span>
      </div>

      {/* Side-by-side panels */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left panel — Current */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-border-default">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border-default bg-surface-base/30">
            <FileText size={13} className="text-text-muted" />
            <span className="text-xs font-medium text-text-muted">Current</span>
            {!existing && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-raised text-text-muted">
                No file
              </span>
            )}
          </div>
          <div className="flex-1 overflow-auto p-2">
            {existing ? (
              <CodeEditor
                value={existing}
                onChange={() => {}}
                language="markdown"
                readOnly
                className="h-full min-h-full !border-border-default"
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <FilePlus size={28} className="text-border-default mx-auto mb-2" />
                  <p className="text-sm text-text-secondary">No CLAUDE.md exists</p>
                  <p className="text-xs text-border-default mt-1">A new file will be created</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right panel — Proposed (editable) */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border-default bg-surface-base/30">
            <FilePlus size={13} className="text-success" />
            <span className="text-xs font-medium text-success">Proposed</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-success-muted text-success border border-success/20">
              Editable
            </span>
          </div>
          <div className="flex-1 overflow-auto p-2">
            <CodeEditor
              value={editedContent}
              onChange={setEditedContent}
              language="markdown"
              className="h-full min-h-full !border-border-default"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
