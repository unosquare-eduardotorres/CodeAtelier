/**
 * GrillTrackSelector — extracted from GrillPage.tsx.
 * Renders the track selection grid with radar chart and scores.
 */
import {
  ClipboardCheck,
  Building2,
  Palette,
  Shield,
  TestTube,
  Cloud,
  Database,
  Code,
  Sparkles
} from 'lucide-react'
import type { GrillTrackId, GrillTrackScore } from '../../../../shared/types'
import { GRILL_TRACKS } from '../../../../shared/constants'
import GrillRadarChart from './GrillRadarChart'

/** Map lucide icon names to components */
const TRACK_ICONS: Record<string, React.ElementType> = {
  ClipboardCheck,
  Building2,
  Palette,
  Shield,
  TestTube,
  Cloud,
  Database,
  Code
}

function getScoreColor(score: number): string {
  if (score <= 20) return '#dc2626'
  if (score <= 40) return '#ea580c'
  if (score <= 60) return '#d97706'
  if (score <= 80) return '#65a30d'
  return '#16a34a'
}

interface GrillTrackSelectorProps {
  trackScores: GrillTrackScore[]
  suggestedNextTrack: { trackId: GrillTrackId; reason: string } | null
  onSelectTrack: (trackId: GrillTrackId) => void
}

export function GrillTrackSelector({
  trackScores,
  suggestedNextTrack,
  onSelectTrack
}: GrillTrackSelectorProps): React.JSX.Element {
  return (
    <>
      {/* Radar chart — show when 2+ tracks completed */}
      {trackScores.length > 1 && (
        <div className="flex justify-center">
          <GrillRadarChart
            trackScores={trackScores}
            size={260}
            onTrackClick={(trackId) => onSelectTrack(trackId as GrillTrackId)}
          />
        </div>
      )}

      {/* Track description */}
      <div className="text-center">
        <h2 className="text-lg font-semibold text-text-primary mb-1">Choose a Grill Track</h2>
        <p className="text-sm text-text-muted">
          Each track evaluates your requirement from a specialist perspective.
          {trackScores.length === 0 && ' Start with any track — we recommend Requirements first.'}
        </p>
      </div>

      {/* Track selector grid */}
      <div className="grid grid-cols-2 gap-3">
        {Object.values(GRILL_TRACKS).map((track) => {
          const existingScore = trackScores.find((ts) => ts.trackId === track.id)
          const isSuggested = suggestedNextTrack?.trackId === track.id
          const IconComponent = TRACK_ICONS[track.icon] ?? Code
          return (
            <button
              key={track.id}
              onClick={() => onSelectTrack(track.id)}
              className={`p-4 rounded-xl border bg-surface-overlay hover:bg-surface-base transition-all text-left group ${
                isSuggested ? 'border-accent/50 ring-1 ring-accent/20' : 'border-border-subtle'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <IconComponent
                  size={16}
                  className={
                    isSuggested
                      ? 'text-accent'
                      : 'text-text-muted group-hover:text-text-secondary transition-colors'
                  }
                />
                <span className="text-sm font-semibold text-text-primary">{track.name}</span>
                {existingScore && (
                  <span
                    className="ml-auto text-xs font-bold"
                    style={{ color: getScoreColor(existingScore.score) }}
                  >
                    {existingScore.score}
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted leading-relaxed">{track.description}</p>
              {isSuggested && suggestedNextTrack && (
                <div className="mt-2 flex items-center gap-1 text-xs text-accent">
                  <Sparkles size={10} />
                  <span>AI suggested: {suggestedNextTrack.reason}</span>
                </div>
              )}
              {existingScore && (
                <div className="mt-2 text-xs text-text-muted">
                  {existingScore.iterationCount} iteration
                  {existingScore.iterationCount !== 1 ? 's' : ''} completed
                </div>
              )}
            </button>
          )
        })}
      </div>
    </>
  )
}
