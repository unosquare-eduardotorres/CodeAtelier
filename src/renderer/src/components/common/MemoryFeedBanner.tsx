import { Database, CheckCircle2, AlertCircle, Loader2, X } from 'lucide-react'
import { useEffect } from 'react'
import { useMemoryStore } from '@renderer/store'

const SOURCE_LABELS: Record<string, string> = {
  'claude-md': 'CLAUDE.md ingestion',
  codebase: 'Codebase scan',
  document: 'Document ingestion'
}

export default function MemoryFeedBanner(): React.JSX.Element | null {
  const { feedStatus, feedSource, feedMessage, feedError, dismissFeed } = useMemoryStore()

  // Auto-dismiss after 8s on success
  useEffect(() => {
    if (feedStatus === 'completed') {
      const timer = setTimeout(dismissFeed, 8000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [feedStatus, dismissFeed])

  if (feedStatus === 'idle') return null

  const label = feedSource ? (SOURCE_LABELS[feedSource] ?? 'Memory feed') : 'Memory feed'

  if (feedStatus === 'error') {
    return (
      <div
        data-testid="memory-feed-banner"
        className="flex items-center gap-3 px-4 py-2.5 bg-danger-muted border-b border-danger/50 text-sm"
      >
        <AlertCircle size={14} className="text-danger shrink-0" />
        <span className="text-danger flex-1">
          {label} failed: {feedError}
        </span>
        <button
          onClick={dismissFeed}
          className="p-1 rounded hover:bg-danger-muted text-danger hover:text-danger transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  if (feedStatus === 'completed') {
    return (
      <div
        data-testid="memory-feed-banner"
        className="flex items-center gap-3 px-4 py-2.5 bg-success-muted border-b border-success/50 text-sm"
      >
        <CheckCircle2 size={14} className="text-success shrink-0" />
        <span className="text-success flex-1">{feedMessage}</span>
        <button
          onClick={dismissFeed}
          className="p-1 rounded hover:bg-success-muted text-success hover:text-success transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  // feedStatus === 'running'
  return (
    <div
      data-testid="memory-feed-banner"
      className="flex items-center gap-3 px-4 py-2.5 bg-mode-plan-muted border-b border-mode-plan/50 text-sm"
    >
      <Loader2 size={14} className="text-mode-plan-text shrink-0 animate-spin" />
      <Database size={14} className="text-mode-plan-text shrink-0" />
      <span className="text-mode-plan-text flex-1">
        {label}: {feedMessage ?? 'Processing...'}
        <span className="text-mode-plan-text ml-2 text-xs">
          You can continue working in the meantime.
        </span>
      </span>
      <button
        onClick={() => {
          window.api.memoryFeedCancel()
          dismissFeed()
        }}
        className="px-2 py-0.5 rounded text-xs bg-mode-plan-muted text-mode-plan-text hover:bg-mode-plan-muted hover:text-mode-plan-text transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}
