import { Play, Square } from 'lucide-react'
import type { AuditMode } from '../../../../shared/types'

interface HealthAuditControlsProps {
  mode: AuditMode
  onModeChange: (mode: AuditMode) => void
  onStart: () => void
  onCancel: () => void
  isRunning: boolean
  hasSelectedTracks: boolean
}

export default function HealthAuditControls({
  mode,
  onModeChange,
  onStart,
  onCancel,
  isRunning,
  hasSelectedTracks
}: HealthAuditControlsProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      {/* Light / Deep toggle */}
      <div className="flex items-center bg-surface-overlay rounded-lg p-0.5">
        <button
          onClick={() => onModeChange('light')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            mode === 'light'
              ? 'bg-primary-muted text-primary-text'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          disabled={isRunning}
        >
          Light
        </button>
        <button
          onClick={() => onModeChange('deep')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            mode === 'deep'
              ? 'bg-primary-muted text-primary-text'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          disabled={isRunning}
        >
          Deep
        </button>
      </div>

      {/* Start / Cancel buttons */}
      {isRunning ? (
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
        >
          <Square size={12} />
          Cancel
        </button>
      ) : (
        <button
          onClick={onStart}
          disabled={!hasSelectedTracks}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-success/10 text-success hover:bg-success/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Play size={12} />
          Run Audit
        </button>
      )}
    </div>
  )
}
