import { Hammer, Landmark, Lightbulb, RefreshCw, ClipboardCheck } from 'lucide-react'

interface BuildActionBarProps {
  onBuildNow?: () => void
  onSaveAsIdea?: () => void
  onRefine?: () => void
  onCouncilReview?: () => void
  onUserClicked: () => void
  /** When true, shows a "Saved to Plans" indicator */
  savedToPlans?: boolean
}

export default function BuildActionBar({
  onBuildNow,
  onSaveAsIdea,
  onRefine,
  onCouncilReview,
  onUserClicked,
  savedToPlans
}: BuildActionBarProps): React.JSX.Element {
  return (
    <div className="sticky bottom-0 flex items-center gap-2 px-5 py-3 border-t border-border-subtle bg-surface-overlay/95 backdrop-blur-sm">
      {onBuildNow && (
        <button
          onClick={() => {
            onUserClicked()
            onBuildNow()
          }}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-mode-build hover:brightness-110 text-white rounded text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-mode-build/50 press-scale"
        >
          <Hammer size={14} />
          Build Now
        </button>
      )}
      {onCouncilReview && (
        <button
          onClick={() => {
            onUserClicked()
            onCouncilReview()
          }}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-purple-600/80 hover:bg-purple-600 text-white rounded text-sm font-medium transition-colors press-scale"
        >
          <Landmark size={14} />
          Council
        </button>
      )}
      {onSaveAsIdea && (
        <button
          onClick={() => {
            onUserClicked()
            onSaveAsIdea()
          }}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
        >
          <Lightbulb size={14} />
          Save as Idea
        </button>
      )}
      {onRefine && (
        <button
          onClick={() => {
            onUserClicked()
            onRefine()
          }}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
        >
          <RefreshCw size={14} />
          Refine Plan
        </button>
      )}
      {savedToPlans && (
        <span className="ml-auto flex items-center gap-1.5 text-xs text-success/80 select-none">
          <ClipboardCheck size={13} />
          Saved to Plans
        </span>
      )}
    </div>
  )
}
