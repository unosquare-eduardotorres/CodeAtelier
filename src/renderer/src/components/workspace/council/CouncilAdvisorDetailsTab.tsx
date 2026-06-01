/**
 * CouncilAdvisorDetailsTab — read-only advisor review cards.
 *
 * Rendered inside the "Advisor Details" tab of the completed council view.
 * Shows each advisor's key findings, score, and verdict in a card layout.
 */

import AdvisorIcon from './AdvisorIcon'
import { VerdictBadge } from './CouncilMemberColumn'
import { COUNCIL_ADVISOR_ROLES, COUNCIL_ADVISORS } from '../../../../../shared/constants'
import type { CouncilAdvisorRole, CouncilMemberStatus, CouncilReview } from '../../../../../shared/types'
import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'
import type { ToolActivity } from '../../../../../shared/types'

interface AdvisorStreamState {
  segments: StreamSegment[]
  currentContent: string
  currentToolActivities: ToolActivity[]
  status: CouncilMemberStatus
  review: CouncilReview | null
}

interface CouncilAdvisorDetailsTabProps {
  advisors: Record<CouncilAdvisorRole, AdvisorStreamState>
}

export default function CouncilAdvisorDetailsTab({
  advisors
}: CouncilAdvisorDetailsTabProps): React.JSX.Element {
  return (
    <div className="space-y-4">
      {COUNCIL_ADVISOR_ROLES.map((role) => {
        const advisor = advisors[role]
        const def = COUNCIL_ADVISORS[role]
        if (!advisor.review) return null
        return (
          <div
            key={role}
            className="rounded-lg border border-border-subtle bg-surface-overlay overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-surface-float/50 border-b border-border-subtle">
              <div className="flex items-center gap-2">
                <AdvisorIcon advisor={def} size={18} className="text-text-secondary" />
                <span className="text-sm font-semibold text-text-primary">{def.name}</span>
                <VerdictBadge verdict={advisor.review.verdict} />
              </div>
              <span className="text-lg font-bold text-text-primary">{advisor.review.score}</span>
            </div>
            {/* Key findings */}
            <div className="px-4 py-3">
              <ul className="text-sm text-text-body space-y-1">
                {advisor.review.keyFindings.map((f, i) => (
                  <li key={i}>• {f}</li>
                ))}
              </ul>
            </div>
          </div>
        )
      })}
    </div>
  )
}
