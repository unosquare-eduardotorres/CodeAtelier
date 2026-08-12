import { useMemo } from 'react'
import { AlertTriangle, FileCode, FileQuestion, Loader2 } from 'lucide-react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { codeAtelierDiffStyles } from './diff-theme'
import { describeIdenticalReason, resolveDiffState } from './file-diff-state'
import type { FileDiffResult } from '../../../../shared/types'

interface FileDiffViewProps {
  filePath: string | null
  diff: FileDiffResult | null
  isLoading: boolean
  leftLabel?: string
  rightLabel?: string
}

export default function FileDiffView({
  filePath,
  diff,
  isLoading,
  leftLabel = 'Previous (HEAD)',
  rightLabel = 'Current (Working Tree)'
}: FileDiffViewProps): React.JSX.Element {
  // Compute line stats — count lines present in one version but not the other
  const stats = useMemo(() => {
    if (!diff) return null
    const oldLines = diff.oldContent.split('\n')
    const newLines = diff.newContent.split('\n')
    const oldSet = new Set(oldLines)
    const newSet = new Set(newLines)
    const added = newLines.filter((l) => !oldSet.has(l)).length
    const removed = oldLines.filter((l) => !newSet.has(l)).length
    return { added, removed, totalLines: oldLines.length + newLines.length }
  }, [diff])

  // Small files read better with full context; only collapse unchanged
  // regions once the file is large enough for it to matter.
  const isLargeFile = (stats?.totalLines ?? 0) > 400

  if (!filePath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
        <FileCode size={40} className="text-text-muted/30 mb-3" />
        <p className="text-sm text-text-secondary">Select a file to view changes</p>
        <p className="text-xs text-text-muted mt-1">
          Click on any file in the list to see the diff
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="text-text-muted animate-spin" />
      </div>
    )
  }

  if (!diff) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-text-secondary">Unable to load diff</p>
      </div>
    )
  }

  const diffState = resolveDiffState(diff)
  const identicalReason = describeIdenticalReason(diff)

  return (
    <div data-testid="file-diff-view" className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Diff header */}
      <div
        data-testid="file-diff-header"
        className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-surface-overlay/50 shrink-0"
      >
        <span className="text-xs font-medium text-text-primary truncate">{filePath}</span>
        {/* The exact commit both sides are measured from — answers "what actually ships". */}
        {diff.baseSha && (
          <span
            data-testid="file-diff-base"
            title={`Comparison base: ${leftLabel} @ ${diff.baseSha}`}
            className="text-[10px] font-mono text-text-muted truncate mx-3 shrink-0"
          >
            {leftLabel} @ {diff.baseSha}
          </span>
        )}
        {stats && (
          <div className="flex items-center gap-2 shrink-0">
            {stats.added > 0 && (
              <span className="text-[10px] font-mono text-success">+{stats.added}</span>
            )}
            {stats.removed > 0 && (
              <span className="text-[10px] font-mono text-danger">-{stats.removed}</span>
            )}
          </div>
        )}
      </div>

      {/* Non-fatal git problem — one side of the diff may be wrong or empty */}
      {diff.warning && (
        <div
          data-testid="file-diff-warning"
          className="flex items-start gap-2 px-4 py-2 border-b border-warning/30 bg-warning/10 shrink-0"
        >
          <AlertTriangle size={14} className="text-warning mt-px shrink-0" />
          <span className="text-[11px] text-text-secondary break-words">
            Could not load one side of the diff — {diff.warning}
          </span>
        </div>
      )}

      {/* Explicit states — ReactDiffViewer renders nothing when both sides match,
          which is indistinguishable from a broken pane. */}
      {diffState === 'binary' ? (
        <div
          data-testid="file-diff-binary"
          className="flex-1 flex flex-col items-center justify-center text-center px-8"
        >
          <FileCode size={32} className="text-text-muted/30 mb-3" />
          <p className="text-sm text-text-secondary">Binary file — diff not available</p>
        </div>
      ) : diffState === 'identical' ? (
        <div
          data-testid="file-diff-identical"
          className="flex-1 flex flex-col items-center justify-center text-center px-8"
        >
          <FileQuestion size={32} className="text-text-muted/30 mb-3" />
          <p className="text-sm text-text-secondary">
            {identicalReason?.title ?? `No differences between ${leftLabel} and ${rightLabel}`}
          </p>
          <p className="text-xs text-text-muted mt-1 max-w-md">
            {identicalReason?.detail ??
              'This file changed relative to the comparison base, but the two sides shown are identical.'}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <ReactDiffViewer
            oldValue={diff.oldContent}
            newValue={diff.newContent}
            splitView={true}
            useDarkTheme={true}
            compareMethod={DiffMethod.WORDS}
            leftTitle={leftLabel}
            rightTitle={rightLabel}
            showDiffOnly={isLargeFile}
            styles={codeAtelierDiffStyles}
          />
        </div>
      )}
    </div>
  )
}
