import {
  ArrowLeft,
  Check,
  FileText,
  Landmark,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Undo2
} from 'lucide-react'
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
  onCouncilSweep?: () => void
  onGeneratePlan?: () => void
  onBackToGrill?: () => void
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
  onCouncilSweep,
  onGeneratePlan,
  onBackToGrill
}: GrillPageFooterProps): React.JSX.Element {
  // Completing phase — spinner only
  if (phase === 'completing') {
    return (
      <div className="flex-shrink-0 border-t border-border-subtle bg-surface-raised px-6 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-center gap-2 text-text-secondary text-sm">
          <Loader2 size={14} className="animate-spin" />
          Generating structured implementation plan…
        </div>
      </div>
    )
  }

  // Completed phase — handoff buttons
  if (phase === 'completed') {
    return (
      <div className="flex-shrink-0 border-t border-border-subtle bg-surface-raised px-6 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            {onBackToGrill && (
              <button
                onClick={onBackToGrill}
                aria-label="Back to grill for further iteration"
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-subtle transition-colors text-sm"
              >
                <Undo2 size={14} />
                Back to Grill
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onCouncilSweep && (
              <button
                onClick={onCouncilSweep}
                aria-label="Send plan to council for review"
                className="flex items-center gap-1.5 px-3 py-2.5 border border-purple-500 text-purple-400 hover:bg-purple-500/10 font-medium rounded-lg text-sm transition-colors press-scale"
              >
                <Landmark size={14} />
                Council Sweep
              </button>
            )}
            <button
              onClick={onConvertDirectly}
              aria-label="Continue in chat"
              className="flex items-center gap-1.5 px-5 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-semibold transition-colors press-scale"
            >
              <MessageSquare size={14} />
              Continue in Chat
            </button>
          </div>
        </div>
      </div>
    )
  }

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
          {phase === 'selecting' && trackScoresCount > 0 && onGeneratePlan && (
            <button
              onClick={onGeneratePlan}
              aria-label="Generate structured plan from grill decisions"
              className="flex items-center gap-1.5 px-5 py-2.5 bg-success hover:bg-success-hover text-white rounded-lg text-sm font-semibold transition-colors press-scale"
            >
              <FileText size={14} />
              Complete &amp; Generate Plan
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
              aria-label="Accept answers and re-evaluate"
              className="flex items-center gap-1.5 px-5 py-2.5 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold transition-colors press-scale"
            >
              <Check size={14} />
              Accept &amp; Re-evaluate
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
