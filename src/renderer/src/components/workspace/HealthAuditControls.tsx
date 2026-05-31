import { useState } from 'react'
import { Play, Square, Pause, RotateCcw } from 'lucide-react'
import type { AuditMode } from '../../../../shared/types'

interface HealthAuditControlsProps {
  mode: AuditMode
  onModeChange: (mode: AuditMode) => void
  onStart: () => void
  onCancel: () => void
  onPause: () => void
  onResume?: () => void
  isRunning: boolean
  isPaused: boolean
  hasSelectedTracks: boolean
  /** Number of incomplete tracks (cancelled/pending/failed) from last run */
  incompleteTrackCount?: number
}

export default function HealthAuditControls({
  mode,
  onModeChange,
  onStart,
  onCancel,
  onPause,
  onResume,
  isRunning,
  isPaused,
  hasSelectedTracks,
  incompleteTrackCount = 0
}: HealthAuditControlsProps): React.JSX.Element {
  const [confirmingCancel, setConfirmingCancel] = useState(false)

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

      {/* Start / Pause / Cancel / Resume buttons */}
      {isRunning ? (
        <div className="flex items-center gap-2">
          {/* Pause button */}
          <button
            onClick={onPause}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors"
            title="Pause audit — you can resume later"
          >
            <Pause size={12} />
            Pause
          </button>

          {/* Cancel with confirmation */}
          {confirmingCancel ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-danger">Cancel audit?</span>
              <button
                onClick={() => {
                  onCancel()
                  setConfirmingCancel(false)
                }}
                className="px-2 py-1 text-[10px] font-medium rounded bg-danger/20 text-danger hover:bg-danger/30 transition-colors"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmingCancel(false)}
                className="px-2 py-1 text-[10px] font-medium rounded bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingCancel(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
            >
              <Square size={12} />
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {/* Resume button — shown when there are incomplete tracks from the last run */}
          {(incompleteTrackCount > 0 || isPaused) && onResume && (
            <button
              onClick={onResume}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-colors"
              title={
                isPaused
                  ? 'Resume paused audit'
                  : 'Resume incomplete tracks from the previous audit'
              }
            >
              <RotateCcw size={12} />
              Resume {!isPaused && incompleteTrackCount > 0 ? `(${incompleteTrackCount})` : ''}
            </button>
          )}

          <button
            onClick={onStart}
            disabled={!hasSelectedTracks}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-success/10 text-success hover:bg-success/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Play size={12} />
            Run Audit
          </button>
        </div>
      )}
    </div>
  )
}
