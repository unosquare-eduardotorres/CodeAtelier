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
    <div className="flex-1 flex flex-col bg-gray-900 min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-700 bg-gray-900">
        <div className="flex items-center gap-3">
          <ArrowLeftRight size={16} className="text-indigo-400" />
          <span className="text-sm font-semibold text-gray-200">Review CLAUDE.md Changes</span>
          <span className="text-xs text-gray-500 font-mono truncate max-w-[300px]">
            {workspacePath}/CLAUDE.md
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onDismiss}
            disabled={isConfirming}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            <X size={14} />
            Cancel
          </button>
          <button
            onClick={() => onConfirm(editedContent)}
            disabled={isConfirming}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
      <div className="flex items-center gap-4 px-6 py-2 border-b border-gray-800 bg-gray-900/50 text-xs text-gray-500">
        <span>
          Lines: {stats.existingLines} {'\u2192'} {stats.proposedLines}{' '}
          <span
            className={
              stats.lineDelta > 0
                ? 'text-emerald-400'
                : stats.lineDelta < 0
                  ? 'text-red-400'
                  : 'text-gray-500'
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
                ? 'text-emerald-400'
                : stats.charDelta < 0
                  ? 'text-red-400'
                  : 'text-gray-500'
            }
          >
            ({formatDelta(stats.charDelta)})
          </span>
        </span>
        <span className="ml-auto text-gray-600">
          You can edit the proposed content before approving
        </span>
      </div>

      {/* Side-by-side panels */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left panel — Current */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-gray-800">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/30">
            <FileText size={13} className="text-gray-500" />
            <span className="text-xs font-medium text-gray-400">Current</span>
            {!existing && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">
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
                className="h-full min-h-full !border-gray-800"
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <FilePlus size={28} className="text-gray-700 mx-auto mb-2" />
                  <p className="text-sm text-gray-600">No CLAUDE.md exists</p>
                  <p className="text-xs text-gray-700 mt-1">A new file will be created</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right panel — Proposed (editable) */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/30">
            <FilePlus size={13} className="text-emerald-500" />
            <span className="text-xs font-medium text-emerald-400">Proposed</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
              Editable
            </span>
          </div>
          <div className="flex-1 overflow-auto p-2">
            <CodeEditor
              value={editedContent}
              onChange={setEditedContent}
              language="markdown"
              className="h-full min-h-full !border-gray-800"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
