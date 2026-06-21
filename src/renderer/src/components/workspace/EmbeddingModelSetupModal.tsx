import { useState, useEffect, useCallback } from 'react'
import { X, Check, Loader2, AlertTriangle, ExternalLink, Play } from 'lucide-react'
import { OMLX_EMBEDDING } from '../../../../shared/constants'

interface EmbeddingModelSetupModalProps {
  onClose: () => void
  isAppleSilicon: boolean
}

type SetupState = 'checking' | 'not-running' | 'no-model' | 'ready' | 'error'

export default function EmbeddingModelSetupModal({
  onClose,
  isAppleSilicon
}: EmbeddingModelSetupModalProps): React.JSX.Element {
  const [state, setState] = useState<SetupState>('checking')
  const [error, setError] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)

  const checkStatus = useCallback(async (): Promise<void> => {
    setState('checking')
    setError(null)
    try {
      const status = await window.api.embeddingCheckStatus()

      if (status.ready) {
        setState('ready')
        return
      }

      if (!status.omlxRunning) {
        setState('not-running')
        return
      }

      if (!status.omlxEmbeddingModelLoaded) {
        setState('no-model')
        return
      }

      // oMLX running + model loaded but provider not ready — try initializing
      await window.api.embeddingInitialize()
      setState('ready')
    } catch (e) {
      setError((e as Error).message)
      setState('error')
    }
  }, [])

  useEffect(() => {
    if (isAppleSilicon) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async IPC result drives state
      checkStatus()
    }
  }, [checkStatus, isAppleSilicon])

  // Subscribe to embedding events
  useEffect(() => {
    const unsubReady = window.api.onEmbeddingModelReady(() => {
      setState('ready')
    })
    const unsubError = window.api.onEmbeddingModelError((err) => {
      setError(err)
      setState('error')
    })

    return () => {
      unsubReady()
      unsubError()
    }
  }, [])

  const handleStartOmlx = async (): Promise<void> => {
    setIsStarting(true)
    try {
      const started = await window.api.omlxStart()
      if (started) {
        // Re-check after starting
        await checkStatus()
      } else {
        setError('oMLX did not start. Please start it manually or download it from omlx.ai.')
        setState('error')
      }
    } catch (e) {
      setError((e as Error).message)
      setState('error')
    }
    setIsStarting(false)
  }

  const handleOpenDashboard = async (): Promise<void> => {
    const url = await window.api.omlxAdminUrl()
    window.open(url, '_blank')
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        data-testid="embedding-setup-modal"
        className="bg-surface-raised border border-border-default rounded-xl shadow-xl w-full max-w-md mx-4"
      >
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
          {!isAppleSilicon && (
            <div className="flex items-start gap-3">
              <AlertTriangle size={16} className="text-warning mt-0.5 shrink-0" />
              <div>
                <p className="text-sm text-text-body font-medium">Apple Silicon required</p>
                <p className="text-xs text-text-secondary mt-1">
                  Semantic search embeddings require oMLX, which only runs on Apple Silicon
                  (M1/M2/M3/M4) Macs. This feature is not available on Intel-based Macs.
                </p>
              </div>
            </div>
          )}

          {isAppleSilicon && state === 'checking' && (
            <div
              data-testid="embedding-status"
              className="flex items-center gap-3 text-text-secondary"
            >
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Checking oMLX connection…</span>
            </div>
          )}

          {isAppleSilicon && state === 'not-running' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="text-warning mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-text-body font-medium">oMLX is not running</p>
                  <p className="text-xs text-text-secondary mt-1">
                    Start oMLX to enable semantic search. If you don&apos;t have it installed, download
                    it from{' '}
                    <a
                      href="https://omlx.ai"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary-hover underline"
                    >
                      omlx.ai
                    </a>
                    .
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleStartOmlx}
                  disabled={isStarting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {isStarting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Play size={12} />
                  )}
                  Start oMLX
                </button>
                <button
                  data-testid="embedding-download-btn"
                  onClick={checkStatus}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-lg transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {isAppleSilicon && state === 'no-model' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="text-warning mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-text-body font-medium">
                    No embedding model loaded
                  </p>
                  <p className="text-xs text-text-secondary mt-1">
                    oMLX is running but no embedding model is loaded. Open the oMLX admin dashboard
                    to download and load a model.
                  </p>
                  <p className="text-xs text-text-muted mt-2">
                    Recommended:{' '}
                    <span className="font-mono text-text-secondary">
                      {OMLX_EMBEDDING.recommendedModel.id}
                    </span>{' '}
                    (~{OMLX_EMBEDDING.recommendedModel.estimatedSizeMB} MB)
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleOpenDashboard}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
                >
                  <ExternalLink size={12} />
                  Open oMLX Dashboard
                </button>
                <button
                  onClick={checkStatus}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-lg transition-colors"
                >
                  Check Again
                </button>
              </div>
            </div>
          )}

          {isAppleSilicon && state === 'ready' && (
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-success-muted flex items-center justify-center shrink-0">
                <Check size={14} className="text-success" />
              </div>
              <div>
                <p className="text-sm text-text-body font-medium">Embedding model ready</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  oMLX is running with an embedding model loaded — semantic search is ready to use.
                </p>
              </div>
            </div>
          )}

          {isAppleSilicon && state === 'error' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="text-danger mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-text-body font-medium">
                    Failed to connect to oMLX
                  </p>
                  <p className="text-xs text-text-secondary mt-1">
                    {error ?? 'An unknown error occurred.'}
                  </p>
                </div>
              </div>
              <button
                data-testid="embedding-download-btn"
                onClick={checkStatus}
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
