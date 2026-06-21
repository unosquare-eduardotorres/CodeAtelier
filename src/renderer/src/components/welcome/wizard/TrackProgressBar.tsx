import { CheckCircle2, Minus, Circle } from 'lucide-react'
import type { GrillTrackId, GrillTrackScore } from '../../../../../shared/types'
import { GRILL_TRACKS } from '../../../../../shared/constants'

// ── Types ─────────────────────────────────────────────────────────────────

export type TrackStatus = 'pending' | 'active' | 'completed' | 'skipped'

// ── Status style lookups ──────────────────────────────────────────────────

const TRACK_NAME_STYLES: Record<TrackStatus, string> = {
  active: 'text-primary font-semibold',
  completed: 'text-text-primary',
  skipped: 'text-text-muted line-through',
  pending: 'text-text-muted'
}

const CONNECTOR_STYLES: Record<TrackStatus, string> = {
  completed: 'bg-text-muted/40',
  skipped: 'bg-text-muted/40',
  active: 'bg-border-subtle',
  pending: 'bg-border-subtle'
}

// ── Status icon sub-component ─────────────────────────────────────────────

function StatusIcon({ status }: { status: TrackStatus }): React.JSX.Element {
  if (status === 'completed') {
    return <CheckCircle2 size={14} className="text-success flex-shrink-0" />
  }
  if (status === 'skipped') {
    return <Minus size={14} className="text-text-muted flex-shrink-0" />
  }
  if (status === 'active') {
    return (
      <div className="relative flex-shrink-0">
        <Circle size={14} className="text-primary" />
        <div className="absolute inset-0 rounded-full animate-ping bg-primary/20" />
      </div>
    )
  }
  return <Circle size={14} className="text-text-muted/40 flex-shrink-0" />
}

// ── Component ─────────────────────────────────────────────────────────────

export default function TrackProgressBar({
  selectedTracks,
  getTrackStatus,
  trackScores
}: {
  selectedTracks: GrillTrackId[]
  getTrackStatus: (trackId: GrillTrackId) => TrackStatus
  trackScores: GrillTrackScore[]
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 px-4 py-2.5 border-b border-border-subtle bg-surface-overlay/50">
      {selectedTracks.map((trackId, idx) => {
        const status = getTrackStatus(trackId)
        const track = GRILL_TRACKS[trackId]
        const score = trackScores.find((ts) => ts.trackId === trackId)?.score

        return (
          <div key={trackId} className="flex items-center gap-1">
            {idx > 0 && (
              <div className={`w-6 h-px mx-0.5 ${CONNECTOR_STYLES[status]}`} />
            )}

            <div className="flex items-center gap-1.5">
              <StatusIcon status={status} />

              <span
                className={`text-xs font-medium whitespace-nowrap ${TRACK_NAME_STYLES[status]}`}
              >
                {track.name}
              </span>

              {status === 'completed' && score !== undefined && (
                <span className="text-[10px] font-semibold text-success">{score}</span>
              )}
              {status === 'skipped' && (
                <span className="text-[10px] text-text-muted italic">skipped</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
