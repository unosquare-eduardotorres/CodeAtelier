import { useState, useEffect, useCallback } from 'react'
import { X, Download, Check, Loader2, ExternalLink, AlertTriangle, RefreshCw } from 'lucide-react'
import type { OllamaStatus, PullProgress } from '../../../../shared/types'

interface OllamaSetupModalProps {
  onClose: () => void
  model?: string
}

type SetupState = 'checking' | 'not-installed' | 'not-running' | 'pulling' | 'ready'

export default function OllamaSetupModal({
  onClose,
  model = 'qwen3-embedding:4b'
}: OllamaSetupModalProps): React.JSX.Element {
  const [state, setState] = useState<SetupState>('checking')
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const startPull = useCallback(async (): Promise<void> => {
    setState('pulling')
    setPullProgress(null)
    setError(null)
    try {
      await window.api.ollamaPullModel({ model })
    } catch (e) {
      setError((e as Error).message)
    }
  }, [model])

  const checkStatus = useCallback(async () => {
    setState('checking')
    setError(null)
    try {
      const result = await window.api.ollamaCheckStatus()
      setStatus(result)

      if (!result.installed) {
        setState('not-installed')
      } else if (!result.running) {
        setState('not-running')
      } else {
        // Check if model is available
        const hasModel = result.models.some(
          (m) => m === model || m === `${model}:latest` || m.startsWith(`${model}:`)
        )
        if (hasModel) {
          setState('ready')
        } else {
          // Auto-start pull
          startPull()
        }
      }
    } catch (e) {
      setError((e as Error).message)
      setState('not-installed')
    }
  }, [model, startPull])

  const cancelPull = (): void => {
    window.api.ollamaCancelPull()
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- checkStatus sets state from async IPC result
    checkStatus()
  }, [checkStatus])

  // Subscribe to pull progress events
  useEffect(() => {
    const unsubProgress = window.api.onOllamaPullProgress((data) => {
      setPullProgress(data)
    })
    const unsubComplete = window.api.onOllamaPullComplete(() => {
      setState('ready')
      setPullProgress(null)
    })
    const unsubError = window.api.onOllamaPullError((err) => {
      setError(err)
      setState('not-running') // Allow retry
    })

    return () => {
      unsubProgress()
      unsubComplete()
      unsubError()
    }
  }, [])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-raised border border-border-default rounded-xl shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">Ollama Setup</h2>
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
              <span className="text-sm">Checking Ollama status...</span>
            </div>
          )}

          {state === 'not-installed' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="text-warning mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-text-body font-medium">Ollama not found</p>
                  <p className="text-xs text-text-secondary mt-1">
                    Semantic search requires Ollama to generate embeddings locally. Install it in 3
                    steps:
                  </p>
                </div>
              </div>

              {/* Step-by-step guide */}
              <ol className="space-y-2 pl-6 text-xs text-text-body list-decimal">
                <li>
                  <button
                    onClick={() => window.open('https://ollama.com/download', '_blank')}
                    className="text-primary hover:text-primary-hover underline inline-flex items-center gap-1"
                  >
                    Download Ollama <ExternalLink size={10} />
                  </button>
                </li>
                <li>
                  Install it (drag to Applications on macOS, or run the installer on Windows/Linux)
                </li>
                <li>
                  Click <strong>Re-check</strong> below once installed
                </li>
              </ol>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.open('https://ollama.com/download', '_blank')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
                >
                  <Download size={12} />
                  Download Ollama
                  <ExternalLink size={10} />
                </button>
                <button
                  onClick={checkStatus}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-lg transition-colors"
                >
                  <RefreshCw size={12} />
                  Re-check
                </button>
              </div>
            </div>
          )}

          {state === 'not-running' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="text-warning mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-text-body font-medium">Ollama is not running</p>
                  <p className="text-xs text-text-secondary mt-1">
                    Ollama is installed{status?.version ? ` (v${status.version})` : ''} but not
                    running.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    setState('checking')
                    const started = await window.api.ollamaStart()
                    if (started) {
                      await checkStatus()
                    } else {
                      setState('not-running')
                      setError(
                        'Could not start Ollama automatically. Try running "ollama serve" manually.'
                      )
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
                >
                  <RefreshCw size={12} />
                  Start Ollama
                </button>
                <button
                  onClick={checkStatus}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-lg transition-colors"
                >
                  <RefreshCw size={12} />
                  Re-check
                </button>
              </div>
              <p className="text-xs text-text-muted font-mono">Or run manually: ollama serve</p>
            </div>
          )}

          {state === 'pulling' && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Loader2 size={16} className="animate-spin text-primary" />
                <div className="flex-1">
                  <p className="text-sm text-text-body font-medium">Downloading {model}</p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {pullProgress?.status || 'Starting download...'}
                  </p>
                </div>
              </div>

              {/* Progress bar */}
              {pullProgress && pullProgress.total > 0 && (
                <div className="space-y-1">
                  <div className="w-full bg-surface-base rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-primary h-full rounded-full transition-all duration-300"
                      style={{ width: `${pullProgress.percent}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-text-secondary">
                    <span>{pullProgress.percent}%</span>
                    <span>
                      {formatBytes(pullProgress.completed)} / {formatBytes(pullProgress.total)}
                    </span>
                  </div>
                </div>
              )}

              <button
                onClick={cancelPull}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-lg transition-colors"
              >
                Cancel
              </button>
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
                  {model} is available. Semantic search is ready to use.
                </p>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-danger flex items-center gap-1">
              <AlertTriangle size={10} />
              {error}
            </p>
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
