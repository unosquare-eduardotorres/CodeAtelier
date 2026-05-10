import { useMemo } from 'react'
import { FileCode, Loader2 } from 'lucide-react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'

interface FileDiffViewProps {
  filePath: string | null
  diff: { oldContent: string; newContent: string; language: string } | null
  isLoading: boolean
}

/** Custom theme matching Code Atelier's dark palette */
const codeAtelierDiffStyles = {
  variables: {
    dark: {
      diffViewerBackground: '#1a1b26',
      diffViewerColor: '#c0caf5',
      addedBackground: 'rgba(46, 160, 67, 0.15)',
      addedColor: '#c0caf5',
      removedBackground: 'rgba(248, 81, 73, 0.15)',
      removedColor: '#c0caf5',
      wordAddedBackground: 'rgba(46, 160, 67, 0.40)',
      wordRemovedBackground: 'rgba(248, 81, 73, 0.40)',
      addedGutterBackground: 'rgba(46, 160, 67, 0.20)',
      removedGutterBackground: 'rgba(248, 81, 73, 0.20)',
      gutterBackground: '#16161e',
      gutterColor: '#565f89',
      codeFoldBackground: '#1e1f2e',
      codeFoldGutterBackground: '#1e1f2e',
      codeFoldContentColor: '#565f89',
      emptyLineBackground: '#1a1b26'
    }
  },
  line: {
    padding: '2px 10px',
    fontSize: '12px',
    lineHeight: '1.6'
  },
  gutter: {
    padding: '0 8px',
    minWidth: '40px'
  },
  contentText: {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '12px',
    lineHeight: '1.6'
  }
}

export default function FileDiffView({
  filePath,
  diff,
  isLoading
}: FileDiffViewProps): React.JSX.Element {
  // Compute line stats
  const stats = useMemo(() => {
    if (!diff) return null
    const oldLines = diff.oldContent.split('\n')
    const newLines = diff.newContent.split('\n')
    const added = Math.max(0, newLines.length - oldLines.length)
    const removed = Math.max(0, oldLines.length - newLines.length)
    return { added, removed }
  }, [diff])

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

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Diff header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-surface-overlay/50 shrink-0">
        <span className="text-xs font-medium text-text-primary truncate">{filePath}</span>
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

      {/* Diff viewer */}
      <div className="flex-1 overflow-auto">
        <ReactDiffViewer
          oldValue={diff.oldContent}
          newValue={diff.newContent}
          splitView={true}
          useDarkTheme={true}
          compareMethod={DiffMethod.WORDS}
          leftTitle="Previous (HEAD)"
          rightTitle="Current (Working Tree)"
          styles={codeAtelierDiffStyles}
        />
      </div>
    </div>
  )
}
