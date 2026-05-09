import { useState, useEffect, useCallback } from 'react'
import { X, Check, Loader2, AlertTriangle, Download } from 'lucide-react'
import type { EmbeddingModelProgress } from '../../../../shared/types'

interface EmbeddingModelSetupModalProps {
  onClose: () => void
}

type SetupState = 'checking' | 'downloading' | 'ready' | 'error'

export default function EmbeddingModelSetupModal({
  onClose
}: EmbeddingModelSetupModalProps): React.JSX.Element {
  const [state, setState] = useState<SetupState>('checking')
  const [progress, setProgress] = useState<EmbeddingModelProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const checkAndInit = useCallback(async (): Promise<void> => {
    setState('checking')
    setError(null)
    try {
      const status = await window.api.embeddingCheckStatus()
      if (status.ready) {
        setState('ready')
        return
      }

      // Model not ready — start initialization (downloads if needed)
      setState('downloading')
      await window.api.embeddingInitialize()
      // If we get here without error, model is ready
      setState('ready')
    } catch (e) {
      setError((e as Error).message)
      setState('error')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async IPC result drives state
    checkAndInit()
  }, [checkAndInit])

  // Subscribe to download progress events
  useEffect(() => {
    const unsubProgress = window.api.onEmbeddingModelProgress((data) => {
      setProgress(data)
    })
    const unsubReady = window.api.onEmbeddingModelReady(() => {
      setState('ready')
      setProgress(null)
    })
    const unsubError = window.api.onEmbeddingModelError((err) => {
      setError(err)
      setState('error')
    })

    return () => {
      unsubProgress()
      unsubReady()
      unsubError()
    }
  }, [])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-raised border border-border-default rounded-xl shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">Embedding Model Setup</h2>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-5 space-y-4">
          {state === 'checking' && (
            <div className="flex items-center gap-3 text-text-secondary">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Checking embedding model status…</span>
            </div>
          )}

          {state === 'downloading' && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Download size={16} className="text-primary" />
                <div className="flex-1">
                  <p className="text-sm text-text-body font-medium">
                    Downloading embedding model
                  </p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    nomic-embed-text-v1.5 (~270 MB, one-time download)
                  </p>
                </div>
              </div>

              {/* Progress bar */}
              {progress && progress.total > 0 && (
                <div className="space-y-1">
                  <div className="w-full bg-surface-base rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-primary h-full rounded-full transition-all duration-300"
                      style={{ width: `${Math.round(progress.progress)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-text-secondary">
                    <span>{Math.round(progress.progress)}%</span>
                    <span>
                      {formatBytes(progress.loaded)} / {formatBytes(progress.total)}
                    </span>
                  </div>
                </div>
              )}

              {!progress && (
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  <Loader2 size={12} className="animate-spin" />
                  <span>Preparing download…</span>
                </div>
              )}
            </div>
          )}

          {state === 'ready' && (
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-success-muted flex items-center justify-center shrink-0">
                <Check size={14} className="text-success" />
              </div>
              <div>
                <p className="text-sm text-text-body font-medium">Model ready</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  Embedding model is available — semantic search is ready to use.
                </p>
              </div>
            </div>
          )}

          {state === 'error' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="text-danger mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-text-body font-medium">
                    Failed to initialize embedding model
                  </p>
                  <p className="text-xs text-text-secondary mt-1">
                    {error ?? 'An unknown error occurred.'}
                  </p>
                </div>
              </div>
              <button
                onClick={checkAndInit}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
              >
                Retry
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-subtle flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium bg-surface-hover hover:bg-surface-base text-text-body rounded-lg transition-colors"
          >
            {state === 'ready' ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}
