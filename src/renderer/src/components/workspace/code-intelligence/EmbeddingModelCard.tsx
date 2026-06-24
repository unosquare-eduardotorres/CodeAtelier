import { useState } from 'react'
import { RefreshCw, Loader2, Plug, ExternalLink, AlertTriangle } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import { OMLX_EMBEDDING } from '../../../../../shared/constants'
import type { EmbeddingModelStatus } from '../../../../../shared/types'

interface EmbeddingModelCardProps {
  embeddingStatus: EmbeddingModelStatus | null
  isAppleSilicon: boolean | null // null = loading
  onNavigateToModels: () => void
}

export default function EmbeddingModelCard({
  embeddingStatus,
  isAppleSilicon,
  onNavigateToModels
}: EmbeddingModelCardProps): React.JSX.Element {
  const [isChecking, setIsChecking] = useState(false)

  const handleCheckConnection = async (): Promise<void> => {
    setIsChecking(true)
    try {
      await window.api.embeddingInitialize()
    } catch {
      // Error will surface via embedding events
    }
    setIsChecking(false)
  }

  const handleOpenDashboard = async (): Promise<void> => {
    const url = await window.api.omlxAdminUrl()
    window.open(url, '_blank')
  }

  // Determine status label and color
  let statusLabel = 'Not connected'
  let statusColor = 'text-text-muted'
  let statusDot = 'bg-surface-base'

  if (embeddingStatus?.ready) {
    statusLabel = 'Ready'
    statusColor = 'text-success'
    statusDot = 'bg-success'
  } else if (embeddingStatus?.omlxRunning && !embeddingStatus?.omlxEmbeddingModelLoaded) {
    statusLabel = 'No embedding model loaded'
    statusColor = 'text-warning'
    statusDot = 'bg-warning'
  } else if (embeddingStatus?.omlxRunning) {
    statusLabel = 'Connected'
    statusColor = 'text-success'
    statusDot = 'bg-success'
  }

  return (
    <SettingsCard>
      <div className="flex items-center gap-2 mb-3">
        <Plug size={14} className="text-text-secondary" />
        <h3 className="text-sm font-medium text-text-body">Embedding Model</h3>
      </div>

      <div className="space-y-2 text-xs">
        {/* Backend */}
        <div className="flex items-baseline justify-between">
          <span className="text-text-secondary">Backend</span>
          <span className="text-text-body">oMLX (Apple Silicon native)</span>
        </div>

        {/* Status */}
        <div className="flex items-center justify-between">
          <span className="text-text-secondary">Status</span>
          <span className={`flex items-center gap-1.5 ${statusColor}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
            {statusLabel}
          </span>
        </div>

        {/* Loaded model */}
        <div className="flex items-baseline justify-between">
          <span className="text-text-secondary">Model</span>
          <span className="text-text-body font-mono">
            {embeddingStatus?.omlxEmbeddingModelId ?? 'None loaded'}
          </span>
        </div>

        {/* Recommended */}
        <div className="flex items-baseline justify-between">
          <span className="text-text-secondary">Recommended</span>
          <span className="text-text-muted font-mono text-[10px] truncate max-w-[240px]">
            {OMLX_EMBEDDING.recommendedModel.id}
          </span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-4 flex items-center gap-2">
        {embeddingStatus?.ready ? (
          <>
            <button
              onClick={handleOpenDashboard}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-md transition-colors"
            >
              <ExternalLink size={12} />
              Open oMLX Dashboard
            </button>
            <button
              onClick={handleCheckConnection}
              disabled={isChecking}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isChecking ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Check Connection
            </button>
          </>
        ) : (
          <button
            onClick={onNavigateToModels}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-primary hover:bg-primary-hover rounded-md transition-colors"
          >
            Configure oMLX Connection →
          </button>
        )}
      </div>

      {/* Apple Silicon warning */}
      {isAppleSilicon === false && (
        <div className="mt-3 flex items-start gap-2">
          <AlertTriangle size={14} className="text-warning mt-0.5 shrink-0" />
          <p className="text-xs text-text-muted leading-relaxed">
            <span className="font-medium text-text-secondary">Apple Silicon required.</span>{' '}
            oMLX only runs on Apple Silicon (M1/M2/M3/M4) Macs. Semantic search is not available on
            Intel-based Macs.
          </p>
        </div>
      )}

      {/* Help text */}
      {!embeddingStatus?.ready && isAppleSilicon !== false && (
        <p className="mt-3 text-xs text-text-muted leading-relaxed">
          Install an embedding model in oMLX to enable semantic search. Open the oMLX admin
          dashboard and download{' '}
          <span className="font-mono text-text-secondary">
            {OMLX_EMBEDDING.recommendedModel.id}
          </span>{' '}
          (~{OMLX_EMBEDDING.recommendedModel.estimatedSizeMB} MB).
        </p>
      )}
    </SettingsCard>
  )
}
