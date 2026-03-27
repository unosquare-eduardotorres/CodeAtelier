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
      <div className="flex items-center gap-3 px-4 py-2.5 bg-danger-muted border-b border-red-800/50 text-sm">
        <AlertCircle size={14} className="text-red-400 shrink-0" />
        <span className="text-red-300 flex-1">
          {label} failed: {feedError}
        </span>
        <button
          onClick={dismissFeed}
          className="p-1 rounded hover:bg-red-800/40 text-red-400 hover:text-red-300 transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  if (feedStatus === 'completed') {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-success-muted border-b border-emerald-800/50 text-sm">
        <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
        <span className="text-emerald-200 flex-1">{feedMessage}</span>
        <button
          onClick={dismissFeed}
          className="p-1 rounded hover:bg-emerald-800/40 text-emerald-400 hover:text-emerald-300 transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  // feedStatus === 'running'
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-purple-900/30 border-b border-purple-800/50 text-sm">
      <Loader2 size={14} className="text-purple-400 shrink-0 animate-spin" />
      <Database size={14} className="text-purple-400 shrink-0" />
      <span className="text-purple-200 flex-1">
        {label}: {feedMessage ?? 'Processing...'}
        <span className="text-purple-400 ml-2 text-xs">
          You can continue working in the meantime.
        </span>
      </span>
      <button
        onClick={() => {
          window.api.memoryFeedCancel()
          dismissFeed()
        }}
        className="px-2 py-0.5 rounded text-xs bg-purple-800/50 text-purple-300 hover:bg-purple-700/50 hover:text-purple-200 transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}
