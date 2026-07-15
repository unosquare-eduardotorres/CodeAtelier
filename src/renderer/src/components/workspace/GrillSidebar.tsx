/**
 * GrillSidebar — context sidebar (right panel, ~25% width) for grill sessions.
 *
 * Shows the current score gauge, iteration counter, scoring criteria for the
 * active track, completed track scores, and suggested next track.
 */

import { Flame, ChevronRight, ListChecks, BarChart3, Lightbulb } from 'lucide-react'
import { GRILL_TRACKS } from '../../../../shared/constants'
import type { GrillTrackId, GrillTrackScore } from '../../../../shared/types'
import Avatar from '../common/Avatar'
import ScoreGauge from './ScoreGauge'

interface GrillSidebarProps {
  selectedTrack: GrillTrackId | null
  currentScore: number | null
  currentScoreLabel: string | null
  iterationCount: number
  trackScores: GrillTrackScore[]
  answeredCount: number
  totalQuestions: number
  suggestedNextTrack: { trackId: GrillTrackId; reason: string } | null
}

export default function GrillSidebar({
  selectedTrack,
  currentScore,
  currentScoreLabel,
  iterationCount,
  trackScores,
  answeredCount,
  totalQuestions,
  suggestedNextTrack
}: GrillSidebarProps): React.JSX.Element {
  const track = selectedTrack ? GRILL_TRACKS[selectedTrack] : null

  return (
    <div
      data-testid="grill-sidebar"
      className="w-72 flex-shrink-0 border-l border-border-subtle bg-surface-base overflow-y-auto"
    >
      <div className="p-4 space-y-5">
        {/* Grill Analyst portrait */}
        <div className="flex justify-center">
          <Avatar avatarKey="grillme" size="xxl" />
        </div>

        {/* Score gauge */}
        <div data-testid="grill-score-summary" className="flex flex-col items-center gap-2">
          {currentScore !== null ? (
            <ScoreGauge score={currentScore} size={100} label={currentScoreLabel ?? undefined} />
          ) : (
            <div className="flex flex-col items-center gap-2 py-4">
              <Flame size={24} className="text-text-muted animate-pulse" />
              <span className="text-xs text-text-muted">Awaiting evaluation…</span>
            </div>
          )}
        </div>

        {/* Iteration counter */}
        <div className="rounded-lg bg-surface-overlay px-3 py-2.5 border border-border-subtle">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted">Iteration</span>
            <span className="text-sm font-semibold text-text-primary">{iterationCount || '—'}</span>
          </div>
          {totalQuestions > 0 && (
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-xs text-text-muted">Answered</span>
              <span className="text-xs text-text-secondary">
                {answeredCount} / {totalQuestions}
              </span>
            </div>
          )}
        </div>

        {/* Scoring criteria */}
        {track && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <ListChecks size={12} className="text-text-muted" />
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Scoring Criteria
              </span>
            </div>
            <ul className="space-y-1.5">
              {track.scoringFocus.map((criterion, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-xs text-text-secondary leading-relaxed"
                >
                  <span className="text-accent mt-0.5 flex-shrink-0">•</span>
                  {criterion}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Grilled tracks — show when 2+ tracks done */}
        {trackScores.length >= 2 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <BarChart3 size={12} className="text-text-muted" />
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Grilled Tracks
              </span>
            </div>
            <div className="space-y-1">
              {trackScores.map((ts) => {
                const t = GRILL_TRACKS[ts.trackId]
                const isActive = ts.trackId === selectedTrack
                return (
                  <div
                    key={ts.trackId}
                    className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs ${
                      isActive
                        ? 'bg-accent/10 border border-accent/20'
                        : 'bg-surface-overlay border border-border-subtle'
                    }`}
                  >
                    <span
                      className={`truncate ${isActive ? 'text-accent font-medium' : 'text-text-secondary'}`}
                    >
                      {t?.name ?? ts.trackId}
                    </span>
                    <span
                      className={`font-semibold ${isActive ? 'text-accent' : 'text-text-primary'}`}
                    >
                      {ts.score}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* AI suggested next track */}
        {suggestedNextTrack && (
          <div className="rounded-lg bg-accent/5 border border-accent/15 px-3 py-2.5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Lightbulb size={12} className="text-accent" />
              <span className="text-xs font-semibold text-accent">Suggested Next</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-text-primary">
                {GRILL_TRACKS[suggestedNextTrack.trackId]?.name ?? suggestedNextTrack.trackId}
              </span>
              <ChevronRight size={12} className="text-text-muted" />
            </div>
            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
              {suggestedNextTrack.reason}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
