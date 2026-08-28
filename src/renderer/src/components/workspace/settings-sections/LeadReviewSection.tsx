/**
 * LeadReviewSection — workspace settings surface for `settings.leadReviewPass`
 * (M6.1).
 *
 * Toggle for the post-verify lead-review pass: after VERIFY passes, one
 * strong-model session reviews the whole feature diff for the cross-task
 * failure modes the per-task gates cannot see (spec drift, test gaming).
 * Default OFF — the pass costs an extra session per run.
 *
 * The `blueprint:lead-review` role binding stays mandatory either way (it is
 * the escalation ladder's fixer of last resort), so this toggle only gates the
 * extra pass, never the ladder.
 */

import type { JSX } from 'react'
import { UserCheck } from 'lucide-react'
import ToggleRow from './ToggleRow'

export default function LeadReviewSection({
  enabled,
  onToggle
}: {
  /** Current value of settings.leadReviewPass (default OFF). */
  enabled: boolean
  onToggle: (value: boolean) => void
}): JSX.Element {
  return (
    <section
      data-testid="lead-review-section"
      className="rounded-xl border border-border-subtle bg-surface-raised p-4 space-y-3"
    >
      <div className="flex items-start gap-2">
        <UserCheck size={14} className="text-text-muted mt-0.5" />
        <div className="flex-1">
          <h3 className="text-sm font-medium text-text-primary">Lead Review Pass</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            After verification passes, one strong-model review of the whole feature diff for spec
            drift and test gaming. Off by default — it adds a session to every run.
          </p>
        </div>
      </div>

      <div data-testid="lead-review-pass-toggle">
        <ToggleRow
          label="Run lead review after verify"
          description="Whole-diff review for cross-task issues before the blueprint completes"
          checked={enabled}
          onChange={onToggle}
        />
      </div>
    </section>
  )
}
