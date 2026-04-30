import { useState } from 'react'
import { Cloud, Monitor, Play, X, HeartPulse } from 'lucide-react'
import type { LLMProvider, AuditMode } from '../../../../shared/types'

interface AuditModelModalProps {
  open: boolean
  defaultProvider: LLMProvider
  selectedTrackCount: number
  mode: AuditMode
  onConfirm: (provider: LLMProvider) => void
  onCancel: () => void
}

export default function AuditModelModal({
  open,
  defaultProvider,
  selectedTrackCount,
  mode,
  onConfirm,
  onCancel
}: AuditModelModalProps): React.JSX.Element | null {
  const [provider, setProvider] = useState<LLMProvider>(defaultProvider)

  if (!open) return null

  const estimatePerAuditor = mode === 'light' ? 30 : 150 // seconds
  const totalSeconds = estimatePerAuditor * selectedTrackCount
  const estimateText =
    totalSeconds < 60
      ? `~${totalSeconds} seconds`
      : `~${(totalSeconds / 60).toFixed(1)} minutes`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface-raised border border-border-subtle rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <HeartPulse size={20} className="text-success" />
            <h2 className="text-base font-bold text-text-primary">Run Workspace Audit</h2>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Provider selection */}
          <div>
            <label className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3 block">
              Provider
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setProvider('claude')}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                  provider === 'claude'
                    ? 'border-primary bg-primary-muted/40'
                    : 'border-border-subtle hover:border-primary/30 hover:bg-surface-overlay'
                }`}
              >
                <Cloud
                  size={24}
                  className={provider === 'claude' ? 'text-primary-text' : 'text-text-muted'}
                />
                <span
                  className={`text-sm font-medium ${provider === 'claude' ? 'text-primary-text' : 'text-text-secondary'}`}
                >
                  Claude
                </span>
              </button>
              <button
                onClick={() => setProvider('local-llm')}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                  provider === 'local-llm'
                    ? 'border-primary bg-primary-muted/40'
                    : 'border-border-subtle hover:border-primary/30 hover:bg-surface-overlay'
                }`}
              >
                <Monitor
                  size={24}
                  className={
                    provider === 'local-llm' ? 'text-primary-text' : 'text-text-muted'
                  }
                />
                <span
                  className={`text-sm font-medium ${provider === 'local-llm' ? 'text-primary-text' : 'text-text-secondary'}`}
                >
                  Local LLM
                </span>
              </button>
            </div>
          </div>

          {/* Summary info */}
          <div className="rounded-xl bg-surface-overlay p-4 space-y-2">
            <p className="text-sm text-text-primary">
              Running{' '}
              <span className="font-semibold">{selectedTrackCount} auditor{selectedTrackCount !== 1 ? 's' : ''}</span>{' '}
              in{' '}
              <span className="font-semibold capitalize">{mode}</span> mode
            </p>
            <p className="text-xs text-text-muted">Estimated time: {estimateText}</p>
          </div>

          {/* Local LLM note */}
          {provider === 'local-llm' && (
            <div className="rounded-lg bg-info/5 border border-info/20 px-4 py-3">
              <p className="text-xs text-info">
                Using locally configured LLM backend. Make sure your local model server is running.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-subtle bg-surface-base/50">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-overlay transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(provider)}
            className="flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-lg bg-success/10 text-success hover:bg-success/20 transition-colors"
          >
            <Play size={14} />
            Start Audit
          </button>
        </div>
      </div>
    </div>
  )
}
