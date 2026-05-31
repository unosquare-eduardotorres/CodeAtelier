import { ArrowLeft, Flame, Square, LayoutGrid } from 'lucide-react'
import { GRILL_TRACKS } from '../../../../../shared/constants'
import type { GrillTrackId } from '../../../../../shared/types'
import type { GrillPhase } from '../GrillChatView'

interface GrillPageHeaderProps {
  ideaTitle: string
  selectedTrack: GrillTrackId | null
  phase: GrillPhase
  onBack: () => void
  onStopGrill: () => void
  onBackToTracks: () => void
}

export default function GrillPageHeader({
  ideaTitle,
  selectedTrack,
  phase,
  onBack,
  onStopGrill,
  onBackToTracks
}: GrillPageHeaderProps): React.JSX.Element {
  return (
    <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface-raised sticky top-0 z-20">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors text-sm"
        >
          <ArrowLeft size={14} />
          Back to Ideas
        </button>
        <div className="w-px h-5 bg-border-subtle" />
        <div className="flex items-center gap-2 min-w-0">
          <Flame size={14} className="text-accent flex-shrink-0" />
          <span className="text-sm font-medium text-accent truncate">Grill: {ideaTitle}</span>
          {selectedTrack && phase !== 'selecting' && (
            <>
              <span className="text-text-muted">/</span>
              <span className="text-xs text-text-secondary">
                {GRILL_TRACKS[selectedTrack].name}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {phase === 'evaluating' && (
          <button
            onClick={onStopGrill}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-danger border border-danger/30 hover:bg-danger-muted transition-colors"
          >
            <Square size={12} />
            Stop Grilling
          </button>
        )}
        {phase !== 'selecting' && phase !== 'evaluating' && (
          <button
            onClick={onBackToTracks}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors text-xs"
          >
            <LayoutGrid size={12} />
            All Tracks
          </button>
        )}
      </div>
    </div>
  )
}
