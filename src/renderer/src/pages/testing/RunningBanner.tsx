/**
 * RunningBanner — Prominent animated banner shown while an E2E test run is in progress.
 *
 * Replaces the old 12px Loader2 spinner with a visually-prominent card featuring:
 * - Animated gradient sweep border (e2e-sweep keyframe)
 * - Pulsing flask icon with expanding ring
 * - Current scenario title
 * - Live pass/fail/done counts with embedded ProgressBar
 * - Elapsed timer (mm:ss)
 * - Cancel button
 */

import { useEffect, useState, useRef } from 'react'
import { FlaskConical, Square } from 'lucide-react'
import ProgressBar from './ProgressBar'
import type { E2EProgressEvent } from '../../../../shared/types'

interface RunningBannerProps {
  scenarioTitle: string | null
  counts: E2EProgressEvent['counts'] | null
  startedAt: number
  onCancel: () => void
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export default function RunningBanner({
  scenarioTitle,
  counts,
  startedAt,
  onCancel
}: RunningBannerProps): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    setElapsed(Date.now() - startedAt)
    intervalRef.current = setInterval(() => {
      setElapsed(Date.now() - startedAt)
    }, 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [startedAt])

  const completed = counts ? counts.passed + counts.failed + counts.error + counts.skipped : 0

  return (
    <div className="relative rounded-xl border border-info/30 overflow-hidden">
      {/* Animated gradient sweep along top edge */}
      <div
        className="absolute inset-x-0 top-0 h-1 animate-e2e-sweep"
        style={{
          backgroundImage:
            'linear-gradient(90deg, transparent 0%, #3b82f6 25%, #8b5cf6 50%, #3b82f6 75%, transparent 100%)'
        }}
      />

      <div className="px-5 py-4 bg-surface-raised/50">
        <div className="flex items-center gap-4">
          {/* Pulsing flask icon with ring */}
          <div className="relative shrink-0">
            <FlaskConical size={24} className="text-info animate-pulse" />
            <div className="absolute inset-0 rounded-full border-2 border-info/40 animate-e2e-ring" />
          </div>

          {/* Title + counts */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-semibold text-info">
                {scenarioTitle ? `Running: ${scenarioTitle}` : 'Running tests...'}
              </span>
              <span className="text-xs tabular-nums text-text-muted">{formatElapsed(elapsed)}</span>
            </div>

            {/* Inline counts */}
            <div className="flex items-center gap-3 text-xs">
              {counts && (
                <>
                  <span className="tabular-nums text-success">✓ {counts.passed}</span>
                  <span className="tabular-nums text-danger">✗ {counts.failed + counts.error}</span>
                  <span className="tabular-nums text-text-muted">
                    {completed}/{counts.total} done
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Cancel button */}
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-danger/40 text-danger hover:bg-danger/10 transition-colors"
          >
            <Square size={10} /> Cancel
          </button>
        </div>

        {/* Embedded progress bar */}
        {counts && (
          <div className="mt-3">
            <ProgressBar counts={counts} />
          </div>
        )}
      </div>
    </div>
  )
}
