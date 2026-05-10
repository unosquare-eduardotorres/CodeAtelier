import { useState, useEffect, useCallback } from 'react'
import { Loader2, Check, X, Network } from 'lucide-react'
import type { CodeGraphIndexingState } from '../../../../shared/types'

interface CodeGraphProgressPanelProps {
  workspaceId: string
}

export default function CodeGraphProgressPanel({
  workspaceId
}: CodeGraphProgressPanelProps): React.JSX.Element {
  const [state, setState] = useState<CodeGraphIndexingState | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const status = await window.api.codeGraphGetStatus({ workspaceId })
      setState(status)
    } catch {
      // Workspace may not have code graph yet
    }
  }, [workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch + event subscription both set state
    fetchStatus()
    const unsub = window.api.onCodeGraphProgress((progress) => {
      if (progress.workspaceId === workspaceId) setState(progress)
    })
    return unsub
  }, [fetchStatus, workspaceId])

  if (!state || state.status === 'idle') return <div />

  const isActive = ['scanning', 'parsing', 'ranking', 'persisting'].includes(state.status)
  const isComplete = state.status === 'complete'
  const isError = state.status === 'error'

  // Calculate progress percentage
  let percent = 0
  let progressLabel = ''

  if (state.status === 'scanning') {
    progressLabel = 'Discovering source files...'
  } else if (state.status === 'parsing') {
    percent = state.totalFiles > 0 ? Math.round((state.processedFiles / state.totalFiles) * 100) : 0
    progressLabel = `Parsing files... ${state.processedFiles} / ${state.totalFiles}`
  } else if (state.status === 'ranking') {
    percent = 85 // ranking is fast, show near-complete
    progressLabel = `Computing PageRank... ${state.totalEdges.toLocaleString()} edges`
  } else if (state.status === 'persisting') {
    percent = 95
    progressLabel = 'Saving to database...'
  } else if (state.status === 'complete') {
    percent = 100
    progressLabel = `Complete: ${state.totalFiles} files, ${state.totalTags.toLocaleString()} tags, ${state.totalEdges.toLocaleString()} edges`
  } else if (state.status === 'error') {
    progressLabel = `Error: ${state.error ?? 'Unknown error'}`
  }

  return (
    <div className="mt-3 rounded-lg bg-surface-base border border-border-subtle p-3 space-y-2">
      {/* Status line */}
      <div className="flex items-center gap-2">
        {isActive && <Loader2 size={12} className="animate-spin text-primary" />}
        {isComplete && <Check size={12} className="text-success" />}
        {isError && <X size={12} className="text-danger" />}
        <Network size={12} className="text-text-secondary" />
        <span className="text-xs text-text-body font-medium">
          {state.status === 'scanning'
            ? 'Scanning'
            : state.status === 'parsing'
              ? 'Parsing'
              : state.status === 'ranking'
                ? 'Computing graph'
                : state.status === 'persisting'
                  ? 'Saving'
                  : state.status === 'complete'
                    ? 'Code Graph ready'
                    : state.status === 'error'
                      ? 'Error'
                      : 'Indexing'}
        </span>
      </div>

      {/* Progress bar */}
      {isActive && (
        <div className="w-full bg-surface-raised rounded-full h-1.5 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300 bg-primary"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {/* Details */}
      <div className="text-xs text-text-secondary space-y-0.5">
        <p>{progressLabel}</p>
        {state.currentFile && isActive && (
          <p className="truncate font-mono text-text-muted">{state.currentFile}</p>
        )}
      </div>
    </div>
  )
}
