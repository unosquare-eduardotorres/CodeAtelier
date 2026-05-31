import { ArrowLeft, Check, Landmark, LayoutGrid, Play, Target } from 'lucide-react'
import type { GrillPhase } from '../GrillChatView'

interface GrillPageFooterProps {
  phase: GrillPhase
  canSubmit: boolean
  isAtCharLimit: boolean
  shouldSuggestCompletion: boolean
  questionsRepeated: boolean
  trackScoresCount: number
  onSaveAndExit: () => void
  onConvertDirectly: () => void
  onBackToTracks: () => void
  onSubmit: () => void
  onStartGoal?: () => void
  onCouncilSweep?: () => void
}

export default function GrillPageFooter({
  phase,
  canSubmit,
  isAtCharLimit,
  shouldSuggestCompletion,
  questionsRepeated,
  trackScoresCount,
  onSaveAndExit,
  onConvertDirectly,
  onBackToTracks,
  onSubmit,
  onStartGoal,
  onCouncilSweep
}: GrillPageFooterProps): React.JSX.Element {
  return (
    <div className="flex-shrink-0 border-t border-border-subtle bg-surface-raised px-6 py-3">
      <div className="max-w-3xl mx-auto flex items-center justify-between">
        {/* Left: Pause & Exit */}
        <div className="flex items-center gap-2">
          {phase !== 'evaluating' && (
            <button
              onClick={onSaveAndExit}
              aria-label="Pause and exit grill"
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-subtle transition-colors text-sm"
            >
              <ArrowLeft size={14} />
              Pause &amp; Exit
            </button>
          )}
        </div>

        {/* Right: Convert Directly, Back to Tracks, Submit & Re-evaluate */}
        <div className="flex items-center gap-2">
          {phase === 'selecting' && onCouncilSweep && (
            <button
              onClick={onCouncilSweep}
              aria-label="Run council sweep on the requirement"
              className="flex items-center gap-1.5 px-3 py-2.5 border border-purple-500 text-purple-400 hover:bg-purple-500/10 font-medium rounded-lg text-sm transition-colors press-scale"
            >
              <Landmark size={14} />
              Council Sweep
            </button>
          )}
          {phase === 'selecting' && trackScoresCount > 0 && (
            <button
              onClick={onConvertDirectly}
              aria-label="Convert idea directly to conversation"
              className="flex items-center gap-1.5 px-3 py-2.5 border border-success text-success hover:bg-success/10 font-medium rounded-lg text-sm transition-colors press-scale"
            >
              Convert Directly
            </button>
          )}
          {phase === 'answering' && (
            <button
              onClick={onBackToTracks}
              aria-label="Switch to a different grill track"
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-subtle transition-colors text-sm"
            >
              <LayoutGrid size={14} />
              Switch Track
            </button>
          )}
          {phase !== 'evaluating' && phase !== 'selecting' && (
            <button
              onClick={onConvertDirectly}
              aria-label="Convert idea directly to conversation"
              className={`flex items-center gap-1.5 rounded-lg text-sm transition-colors press-scale ${
                shouldSuggestCompletion
                  ? 'px-5 py-2.5 bg-success hover:bg-success-hover text-white font-semibold'
                  : 'px-3 py-2.5 border border-success text-success hover:bg-success/10 font-medium'
              }`}
            >
              {shouldSuggestCompletion && <Check size={14} />}
              Convert Directly
            </button>
          )}
          {phase === 'answering' && !questionsRepeated && (
            <button
              onClick={onSubmit}
              disabled={!canSubmit || isAtCharLimit}
              aria-label="Submit answers and re-evaluate"
              className="flex items-center gap-1.5 px-5 py-2.5 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold transition-colors press-scale"
            >
              <Play size={14} />
              Submit &amp; Re-evaluate
            </button>
          )}
          {onStartGoal && phase !== 'evaluating' && phase !== 'selecting' && trackScoresCount > 0 && (
            <button
              onClick={onStartGoal}
              aria-label="Start goal-based quality completion"
              className="flex items-center gap-1.5 px-5 py-2.5 bg-cyan-500 hover:bg-cyan-600 text-white rounded-lg text-sm font-semibold transition-colors press-scale"
            >
              <Target size={14} />
              Start Goal
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
