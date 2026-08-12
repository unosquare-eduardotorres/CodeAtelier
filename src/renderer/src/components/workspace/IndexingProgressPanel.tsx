import { useEffect } from 'react'
import { Loader2, Pause, Play, X, Check } from 'lucide-react'
import { useIndexingStore } from '@renderer/store'
import type { IndexingState } from '../../../../shared/types'

// ── Pure progress computation ──────────────────────────────────────

interface IndexingProgress {
  isActive: boolean
  isPaused: boolean
  isComplete: boolean
  isError: boolean
  percent: number
  progressLabel: string
  statusLabel: string
}

function computeIndexingProgress(state: IndexingState): IndexingProgress {
  const isActive =
    state.status === 'scanning' ||
    state.status === 'preprocessing' ||
    state.status === 'indexing-files' ||
    state.status === 'indexing-chunks'
  const isPaused = state.status === 'paused'
  const isComplete = state.status === 'complete'
  const isError = state.status === 'error'

  let percent = 0
  let progressLabel = ''

  if (state.status === 'scanning') {
    progressLabel = 'Scanning files...'
  } else if (state.status === 'preprocessing') {
    const etaLabel = state.estimatedRemaining ? ` (${state.estimatedRemaining})` : ''
    const isDescriptionPhase =
      state.descriptionsTotal > 0 && state.descriptionsProcessed < state.descriptionsTotal

    if (isDescriptionPhase) {
      const descDone = state.descriptionsProcessed
      const descTotal = state.descriptionsTotal
      percent = descTotal > 0 ? Math.round((descDone / descTotal) * 100) : 0

      const cached = state.descriptionsCached
      progressLabel = `Generating AI descriptions... ${descDone}/${descTotal}${etaLabel}`
      if (cached > 0) {
        progressLabel += ` · ${cached} from cache`
      }
    } else {
      percent =
        state.preprocessTotal > 0
          ? Math.round((state.preprocessComplete / state.preprocessTotal) * 100)
          : 0
      progressLabel = `Preprocessing code... ${state.preprocessComplete} / ${state.preprocessTotal} chunks`
    }
  } else if (state.status === 'indexing-chunks') {
    percent =
      state.totalChunks > 0 ? Math.round((state.processedChunks / state.totalChunks) * 100) : 0
    progressLabel = `Embedding chunks... ${state.processedChunks} / ${state.totalChunks}`
  } else if (state.status === 'paused') {
    percent =
      state.totalChunks > 0 ? Math.round((state.processedChunks / state.totalChunks) * 100) : 0
    progressLabel = 'Paused'
  } else if (state.status === 'complete') {
    percent = 100
    progressLabel = `Complete: ${state.processedChunks} chunks indexed`
  } else if (state.status === 'error') {
    progressLabel = `Error: ${state.error ?? 'Unknown error'}`
  }

  const STATUS_LABELS: Partial<Record<IndexingState['status'], string>> = {
    scanning: 'Scanning',
    preprocessing: 'Preprocessing',
    'indexing-chunks': 'Embedding',
    paused: 'Paused',
    complete: 'Complete',
    error: 'Error'
  }
  const statusLabel = STATUS_LABELS[state.status] ?? 'Indexing'

  return { isActive, isPaused, isComplete, isError, percent, progressLabel, statusLabel }
}

// ── Component ──────────────────────────────────────────────────────

interface IndexingProgressPanelProps {
  workspaceId: string
}

export default function IndexingProgressPanel({
  workspaceId
}: IndexingProgressPanelProps): React.JSX.Element {
  const state = useIndexingStore((s) => s.indexingState)
  const refreshStatus = useIndexingStore((s) => s.refreshStatus)
  const pauseIndexing = useIndexingStore((s) => s.pauseIndexing)
  const resumeIndexing = useIndexingStore((s) => s.resumeIndexing)
  const cancelIndexing = useIndexingStore((s) => s.cancelIndexing)

  useEffect(() => {
    refreshStatus(workspaceId)
  }, [workspaceId, refreshStatus])

  const handlePause = (): void => {
    pauseIndexing(workspaceId)
  }

  const handleResume = (): void => {
    resumeIndexing(workspaceId)
  }

  const handleCancel = (): void => {
    cancelIndexing(workspaceId)
  }

  if (!state || state.status === 'idle') return <div />

  const { isActive, isPaused, isComplete, isError, percent, progressLabel, statusLabel } =
    computeIndexingProgress(state)

  return (
    <div
      data-testid="indexing-progress-panel"
      className="mt-3 rounded-lg bg-surface-base border border-border-subtle p-3 space-y-2"
    >
      {/* Status line */}
      <div className="flex items-center gap-2">
        {isActive && <Loader2 size={12} className="animate-spin text-primary" />}
        {isPaused && <Pause size={12} className="text-warning" />}
        {isComplete && <Check size={12} className="text-success" />}
        {isError && <X size={12} className="text-danger" />}
        <span className="text-xs text-text-body font-medium">{statusLabel}</span>
      </div>

      {/* Progress bar */}
      {(isActive || isPaused) && (
        <div className="w-full bg-surface-raised rounded-full h-1.5 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              isPaused ? 'bg-warning' : 'bg-primary'
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {/* Details */}
      <div className="text-xs text-text-secondary space-y-0.5">
        <p>{progressLabel}</p>
        {state.preprocessSkipped > 0 && <p>{state.preprocessSkipped} files skipped</p>}
        {state.currentFile && (isActive || isPaused) && (
          <p className="truncate font-mono text-text-muted">{state.currentFile}</p>
        )}
        {(state.descriptionsGenerated > 0 || state.descriptionsCached > 0) && (
          <p>
            AI descriptions: {state.descriptionsGenerated} generated
            {state.descriptionsCached > 0 && ` · ${state.descriptionsCached} from cache`}
          </p>
        )}
      </div>

      {/* Controls */}
      {(isActive || isPaused) && (
        <div className="flex items-center gap-2 pt-1">
          {isActive && (
            <button
              onClick={handlePause}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded transition-colors"
            >
              <Pause size={10} />
              Pause
            </button>
          )}
          {isPaused && (
            <button
              onClick={handleResume}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded transition-colors"
            >
              <Play size={10} />
              Resume
            </button>
          )}
          <button
            onClick={handleCancel}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-danger border border-danger/30 hover:bg-danger-muted rounded transition-colors"
          >
            <X size={10} />
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
