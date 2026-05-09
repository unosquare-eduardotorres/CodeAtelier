import { useState } from 'react'
import { RefreshCw, Loader2, HardDrive } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import type { EmbeddingModelStatus } from '../../../../../shared/types'

interface EmbeddingModelCardProps {
  embeddingStatus: EmbeddingModelStatus | null
  onShowSetup: () => void
}

export default function EmbeddingModelCard({
  embeddingStatus,
  onShowSetup
}: EmbeddingModelCardProps): React.JSX.Element {
  const [isRedownloading, setIsRedownloading] = useState(false)

  const handleRedownload = async (): Promise<void> => {
    setIsRedownloading(true)
    try {
      await window.api.embeddingInitialize()
    } catch {
      // Error will surface via embedding events
    }
    setIsRedownloading(false)
  }

  // Determine status label and color
  let statusLabel = 'Not downloaded'
  let statusColor = 'text-text-muted'
  let statusDot = 'bg-surface-base'

  if (embeddingStatus?.ready) {
    statusLabel = 'Ready'
    statusColor = 'text-success'
    statusDot = 'bg-success'
  } else if (embeddingStatus?.cached) {
    statusLabel = 'Ready (cached)'
    statusColor = 'text-success'
    statusDot = 'bg-success'
  }

  return (
    <SettingsCard>
      <div className="flex items-center gap-2 mb-3">
        <HardDrive size={14} className="text-text-secondary" />
        <h3 className="text-sm font-medium text-text-body">Embedding Model</h3>
      </div>

      <div className="space-y-2 text-xs">
        {/* Model name */}
        <div className="flex items-baseline justify-between">
          <span className="text-text-secondary">Model</span>
          <span className="text-text-body font-mono">nomic-ai/nomic-embed-text-v1.5</span>
        </div>

        {/* Status */}
        <div className="flex items-center justify-between">
          <span className="text-text-secondary">Status</span>
          <span className={`flex items-center gap-1.5 ${statusColor}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
            {statusLabel}
          </span>
        </div>

        {/* Size */}
        <div className="flex items-baseline justify-between">
          <span className="text-text-secondary">Size</span>
          <span className="text-text-body">~270 MB (ONNX quantized)</span>
        </div>

        {/* Cache location */}
        <div className="flex items-baseline justify-between">
          <span className="text-text-secondary">Cache</span>
          <span className="text-text-muted font-mono text-[10px] truncate max-w-[240px]">
            ~/Library/Application Support/code-atelier/models
          </span>
        </div>

        {/* Runtime */}
        <div className="flex items-baseline justify-between">
          <span className="text-text-secondary">Runtime</span>
          <span className="text-text-body">WASM (in-process, no external tools)</span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-4 flex items-center gap-2">
        {embeddingStatus?.ready || embeddingStatus?.cached ? (
          <button
            onClick={handleRedownload}
            disabled={isRedownloading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRedownloading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Re-download Model
          </button>
        ) : (
          <button
            onClick={onShowSetup}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-primary hover:bg-primary-hover rounded-md transition-colors"
          >
            Download Model
          </button>
        )}
      </div>
    </SettingsCard>
  )
}
