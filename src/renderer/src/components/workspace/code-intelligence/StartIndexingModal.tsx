/**
 * StartIndexingModal — confirmation dialog before starting the indexing pipeline.
 *
 * Shows estimated time breakdown based on symbol count, warns about duration,
 * and reassures that progress is checkpointed for resume-after-crash.
 */
import { X, Clock, HardDrive, Cpu, Sparkles } from 'lucide-react'

interface StartIndexingModalProps {
  /** Estimated total symbols (from last scan or a quick count) */
  symbolCount: number
  /** Whether AI descriptions are enabled */
  aiDescriptionsEnabled: boolean
  /** Callback when user confirms */
  onConfirm: () => void
  /** Callback when user cancels */
  onCancel: () => void
}

/**
 * Estimate time for each indexing phase based on observed throughput.
 *
 * Throughput constants (from production logs):
 *   - Preprocessing: ~500 chunks/second (heuristic descriptions)
 *   - Embedding (WASM, single-threaded): ~5 chunks/second → 300 chunks/minute
 *   - AI Descriptions (Claude Haiku): ~100 chunks/minute (batched)
 */
function estimateTime(symbolCount: number, aiDescriptions: boolean) {
  const preprocessMinutes = Math.max(1, Math.ceil(symbolCount / 500 / 60))
  const embeddingMinutes = Math.max(1, Math.ceil(symbolCount / 300))
  const aiDescMinutes = aiDescriptions ? Math.max(1, Math.ceil(symbolCount / 100)) : 0
  const totalMinutes = preprocessMinutes + embeddingMinutes + aiDescMinutes

  return {
    preprocessMinutes,
    embeddingMinutes,
    aiDescMinutes,
    totalMinutes,
    formatted: {
      preprocessing: formatDuration(preprocessMinutes),
      embedding: formatDuration(embeddingMinutes),
      aiDescriptions: aiDescriptions ? formatDuration(aiDescMinutes) : null,
      total: formatDuration(totalMinutes)
    }
  }
}

function formatDuration(minutes: number): string {
  if (minutes < 2) return '~1 minute'
  if (minutes < 60) return `~${minutes} minutes`
  const hours = (minutes / 60).toFixed(1)
  return `~${hours} hours`
}

export default function StartIndexingModal({
  symbolCount,
  aiDescriptionsEnabled,
  onConfirm,
  onCancel
}: StartIndexingModalProps): React.JSX.Element {
  const est = estimateTime(symbolCount, aiDescriptionsEnabled)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="relative bg-surface-panel border border-border-subtle rounded-xl shadow-2xl w-[480px] max-w-[90vw] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">Start Indexing</h2>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-text-secondary">
            Indexing will run in the background based on{' '}
            <strong className="text-text-primary">{symbolCount.toLocaleString()} symbols</strong>:
          </p>

          {/* Phase estimates */}
          <div className="space-y-2 bg-surface-base rounded-lg p-3 border border-border-subtle">
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Cpu size={12} className="text-cyan-400 shrink-0" />
              <span className="flex-1">Preprocessing + heuristic descriptions</span>
              <span className="text-text-muted font-mono">{est.formatted.preprocessing}</span>
            </div>

            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <HardDrive size={12} className="text-blue-400 shrink-0" />
              <span className="flex-1">Embedding (WASM, off main thread)</span>
              <span className="text-text-muted font-mono">{est.formatted.embedding}</span>
            </div>

            {aiDescriptionsEnabled && est.formatted.aiDescriptions && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <Sparkles size={12} className="text-purple-400 shrink-0" />
                <span className="flex-1">AI Descriptions (Claude Haiku)</span>
                <span className="text-text-muted font-mono">{est.formatted.aiDescriptions}</span>
              </div>
            )}

            <div className="flex items-center gap-2 text-xs font-medium text-text-primary pt-1 border-t border-border-subtle">
              <Clock size={12} className="text-text-muted shrink-0" />
              <span className="flex-1">Estimated total</span>
              <span className="font-mono">{est.formatted.total}</span>
            </div>
          </div>

          {/* Reassurance */}
          <div className="text-xs text-text-muted space-y-1.5">
            <p>✓ You can keep using the app normally — embedding runs in a separate process.</p>
            <p>
              ✓ Progress is saved every ~5 minutes — if you close the app, indexing will resume
              where it left off.
            </p>
            <p>
              ✓ Search becomes available immediately with heuristic descriptions while embedding
              continues.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle bg-surface-base/50">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-overlay transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 text-xs font-medium text-white bg-primary hover:bg-primary-hover rounded-md transition-colors"
          >
            Start Indexing
          </button>
        </div>
      </div>
    </div>
  )
}
