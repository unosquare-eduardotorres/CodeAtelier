/**
 * WizardFocusStep — Step 2 of the Create New Project wizard.
 *
 * Multi-select card grid for choosing which grill tracks to evaluate.
 * Shows only greenfield-relevant tracks (5 of 8). Requirements and
 * Architecture are pre-selected. At least 1 track required.
 */

import {
  Check,
  ClipboardCheck,
  Building2,
  Palette,
  Shield,
  Database,
  ArrowRight
} from 'lucide-react'
import type { GrillTrackId } from '../../../../../shared/types'
import { GRILL_TRACKS, GREENFIELD_TRACKS } from '../../../../../shared/constants'

// ── Icon map ────────────────────────────────────────────────────────────────

const TRACK_ICONS: Record<string, React.ElementType> = {
  ClipboardCheck,
  Building2,
  Palette,
  Shield,
  Database
}

// ── Props ───────────────────────────────────────────────────────────────────

interface WizardFocusStepProps {
  selectedTracks: GrillTrackId[]
  onSelectedTracksChange: (tracks: GrillTrackId[]) => void
  onNext: () => void
  onBack: () => void
  onSkip: () => void
}

// ── Component ───────────────────────────────────────────────────────────────

export default function WizardFocusStep({
  selectedTracks,
  onSelectedTracksChange,
  onNext,
  onBack,
  onSkip
}: WizardFocusStepProps): React.JSX.Element {
  const toggleTrack = (trackId: GrillTrackId): void => {
    if (selectedTracks.includes(trackId)) {
      onSelectedTracksChange(selectedTracks.filter((t) => t !== trackId))
    } else {
      onSelectedTracksChange([...selectedTracks, trackId])
    }
  }

  const isValid = selectedTracks.length > 0

  return (
    <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full">
      {/* Header */}
      <div className="text-center mb-2">
        <h2 className="text-xl font-semibold text-text-primary">Focus Areas</h2>
        <p className="text-sm text-text-secondary mt-1">
          Choose the areas you want the AI to evaluate. Requirements and Architecture are
          recommended for all new projects.
        </p>
      </div>

      {/* Track cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {GREENFIELD_TRACKS.map((trackId) => {
          const track = GRILL_TRACKS[trackId]
          const isSelected = selectedTracks.includes(trackId)
          const IconComponent = TRACK_ICONS[track.icon] ?? ClipboardCheck

          return (
            <button
              key={trackId}
              type="button"
              onClick={() => toggleTrack(trackId)}
              className={`relative p-4 rounded-xl border text-left transition-all group ${
                isSelected
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                  : 'border-border-subtle bg-surface-overlay hover:bg-surface-base hover:border-text-muted/30'
              }`}
            >
              {/* Checkmark badge */}
              <div
                className={`absolute top-3 right-3 w-5 h-5 rounded-full flex items-center justify-center transition-all ${
                  isSelected
                    ? 'bg-primary text-white'
                    : 'border border-border-subtle bg-surface-base text-transparent'
                }`}
              >
                <Check size={12} strokeWidth={3} />
              </div>

              {/* Icon + Name */}
              <div className="flex items-center gap-2.5 mb-2 pr-6">
                <IconComponent
                  size={18}
                  className={
                    isSelected
                      ? 'text-primary'
                      : 'text-text-muted group-hover:text-text-secondary transition-colors'
                  }
                />
                <span
                  className={`text-sm font-semibold ${isSelected ? 'text-primary' : 'text-text-primary'}`}
                >
                  {track.name}
                </span>
              </div>

              {/* Description */}
              <p className="text-xs text-text-muted leading-relaxed">{track.description}</p>
            </button>
          )
        })}
      </div>

      {/* Selection count */}
      <p className="text-xs text-text-muted text-center">
        {selectedTracks.length === 0
          ? 'Select at least 1 focus area to continue'
          : `${selectedTracks.length} area${selectedTracks.length !== 1 ? 's' : ''} selected`}
      </p>

      {/* Buttons */}
      <div className="flex items-center justify-between pt-4 border-t border-border-subtle">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                     text-text-secondary hover:text-text-primary hover:bg-surface-overlay
                     transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          Back
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                       text-text-secondary hover:text-text-primary hover:bg-surface-overlay
                       transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            Skip — create blank project
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!isValid}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium
                       bg-primary hover:bg-primary-hover text-white
                       transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                       focus:outline-none focus:ring-2 focus:ring-primary/50 press-scale"
          >
            Start Grilling
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
