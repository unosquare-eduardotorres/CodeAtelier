import { useState, useEffect } from 'react'
import { History, AlertTriangle, Loader2, GitCommit } from 'lucide-react'

interface Checkpoint {
  id: string
  label: string
  gitBranch?: string
  gitCommitSha?: string
  createdAt: string
}

interface RewindDialogProps {
  isOpen: boolean
  conversationId: string
  onCancel: () => void
  onComplete: () => void
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function RewindDialog({
  isOpen,
  conversationId,
  onCancel,
  onComplete
}: RewindDialogProps): React.JSX.Element | null {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isRewinding, setIsRewinding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen && conversationId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional loading state before async fetch
      setLoading(true)
      setError(null)
      setSelectedId(null)
      setIsRewinding(false)
      window.api
        .listCheckpoints({ conversationId })
        .then((result) => {
          setCheckpoints(result)
          setLoading(false)
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        })
    }
  }, [isOpen, conversationId])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onCancel()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  const handleRewind = async (): Promise<void> => {
    if (!selectedId) return
    setIsRewinding(true)
    setError(null)

    try {
      const result = await window.api.rewindToCheckpoint({
        checkpointId: selectedId,
        conversationId
      })
      if (result.success) {
        // Reload the page to reflect the rewound state
        onComplete()
        // Force page reload to sync UI with truncated messages
        window.location.reload()
      } else {
        setError(result.message)
        setIsRewinding(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsRewinding(false)
    }
  }

  // Show checkpoints in reverse chronological order (newest first)
  const sortedCheckpoints = [...checkpoints].reverse()

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      {/* Dialog */}
      <div
        data-testid="rewind-dialog"
        className="relative bg-surface-float border border-border-default rounded-xl shadow-2xl p-6 max-w-lg w-full mx-4 animate-in fade-in zoom-in-95"
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-orange-500/10 flex items-center justify-center">
            <History size={20} className="text-orange-400" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-text-primary">Rewind Conversation</h3>
            <p className="text-xs text-text-secondary">Select a checkpoint to rewind to</p>
          </div>
        </div>

        {/* Warning */}
        <div className="mb-4 p-3 bg-warning-muted border border-warning/20 rounded-lg">
          <div className="flex items-start gap-2 text-warning text-sm">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <div>
              <span className="font-medium">This will:</span>
              <ul className="mt-1 space-y-0.5 text-text-secondary">
                <li>• Revert all file changes made after that point</li>
                <li>• Remove messages sent after that point</li>
                <li>• Auto-stash any uncommitted work</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Checkpoint list */}
        <div className="mb-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 size={16} className="animate-spin text-primary-text" />
              <span className="text-sm text-text-secondary">Loading checkpoints...</span>
            </div>
          ) : sortedCheckpoints.length === 0 ? (
            <div className="py-8 text-center text-sm text-text-secondary">
              No checkpoints found for this conversation.
              <br />
              <span className="text-xs">Checkpoints are created during build-mode executions.</span>
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-1">
              {sortedCheckpoints.map((cp) => (
                <button
                  key={cp.id}
                  data-testid="rewind-checkpoint-item"
                  onClick={() => setSelectedId(cp.id)}
                  disabled={isRewinding}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                    selectedId === cp.id
                      ? 'border-orange-400/50 bg-orange-500/10'
                      : 'border-transparent hover:bg-surface-overlay/50'
                  } disabled:opacity-50`}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${
                        selectedId === cp.id
                          ? 'border-orange-400 bg-orange-400'
                          : 'border-border-default'
                      }`}
                    />
                    <span className="text-sm font-medium text-text-primary truncate">
                      {cp.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 ml-5 mt-0.5">
                    {cp.gitCommitSha && (
                      <span className="flex items-center gap-1 text-xs font-mono text-text-secondary">
                        <GitCommit size={10} />
                        {cp.gitCommitSha.slice(0, 7)}
                      </span>
                    )}
                    <span className="text-xs text-text-secondary">
                      {formatRelativeTime(cp.createdAt)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-danger-muted border border-danger/20 rounded-lg">
            <div className="flex items-start gap-2 text-danger text-sm">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        )}

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isRewinding}
            className="px-4 py-2 text-sm font-medium text-text-body hover:text-text-primary bg-surface-overlay hover:bg-surface-raised rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-default disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            data-testid="rewind-confirm-btn"
            onClick={handleRewind}
            disabled={isRewinding || !selectedId}
            className="px-4 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 bg-orange-500 hover:brightness-110 text-white disabled:opacity-50 flex items-center gap-2"
          >
            {isRewinding ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Rewinding...
              </>
            ) : (
              <>
                <History size={14} />
                Rewind to Here
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
