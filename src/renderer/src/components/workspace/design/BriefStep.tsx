/**
 * BriefStep — step 1 of the design wizard: what are you trying to accomplish?
 *
 * The brief is optional. It does two things: it preselects the cards on step 2
 * via `design:route`, and it is persisted on the run row so a later report or
 * blueprint handoff can reproduce the user's intent.
 *
 * The example chips are the catalogue's own `DESIGN_BRIEF_EXAMPLES`, so they
 * stay in step with the routing keywords rather than drifting into copy that
 * routes to nothing.
 */

import { Sparkles } from 'lucide-react'
import { DESIGN_BRIEF_EXAMPLES } from '../../../../../shared/design-commands'

interface BriefStepProps {
  brief: string
  onBriefChange: (brief: string) => void
  /** Submits the step — Enter with Cmd/Ctrl, or the footer button. */
  onNext: () => void
}

export default function BriefStep({
  brief,
  onBriefChange,
  onNext
}: BriefStepProps): React.JSX.Element {
  return (
    <div data-testid="design-brief-step" className="max-w-2xl mx-auto px-6 py-8 space-y-6">
      <div className="text-center space-y-2">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-accent-muted mb-1">
          <Sparkles size={22} className="text-accent" />
        </div>
        <h3 className="text-base font-semibold text-text-primary">What do you want to improve?</h3>
        <p className="text-xs text-text-secondary max-w-md mx-auto">
          Describe it in your own words and the right design passes get picked for you. You can
          change them on the next step — or skip this and choose yourself.
        </p>
      </div>

      <textarea
        data-testid="design-brief-input"
        value={brief}
        onChange={(e) => onBriefChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onNext()
        }}
        rows={4}
        autoFocus
        aria-label="Design brief — describe what you want to improve"
        placeholder="e.g. this settings page feels generic and hard to scan"
        className="w-full bg-surface-base border border-border-subtle rounded-xl px-4 py-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
      />

      <div className="space-y-2">
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
          Or start from one of these
        </span>
        <div className="flex flex-wrap gap-2">
          {DESIGN_BRIEF_EXAMPLES.map((example) => (
            <button
              key={example}
              data-testid="design-brief-chip"
              onClick={() => onBriefChange(example)}
              className="px-3 py-1.5 text-[11px] rounded-full border border-border-subtle text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent-muted transition-colors text-left"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
