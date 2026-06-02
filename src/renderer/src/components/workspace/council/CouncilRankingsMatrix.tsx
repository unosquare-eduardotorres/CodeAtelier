/**
 * CouncilRankingsMatrix — shows peer review results in a compact view.
 *
 * Displays:
 *   - Who each reviewer thought was strongest
 *   - What blind spots were identified
 *   - What everyone missed
 */

import { COUNCIL_ADVISORS } from '../../../../../shared/constants'
import type { CouncilPeerReview, CouncilAdvisorRole } from '../../../../../shared/types'
import AdvisorIcon from './AdvisorIcon'

interface CouncilRankingsMatrixProps {
  peerReviews: CouncilPeerReview[]
}

export default function CouncilRankingsMatrix({
  peerReviews
}: CouncilRankingsMatrixProps): React.JSX.Element {
  if (peerReviews.length === 0) {
    return (
      <div className="text-center text-text-secondary text-sm py-6">No peer reviews available</div>
    )
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-text-primary px-1">Peer Review Results</h3>

      <div className="space-y-2">
        {peerReviews.map((pr) => {
          const reviewer = COUNCIL_ADVISORS[pr.reviewerRole as CouncilAdvisorRole]
          return (
            <div
              key={pr.reviewerRole}
              className="rounded-lg border border-border-subtle bg-surface-overlay p-3"
            >
              <div className="flex items-center gap-2 mb-2">
                <AdvisorIcon advisor={reviewer} size={14} className="text-text-secondary" />
                <span className="text-xs font-semibold text-text-primary">
                  {reviewer?.name ?? pr.reviewerRole}
                </span>
              </div>

              <div className="space-y-1.5 text-xs">
                <div className="flex items-start gap-2">
                  <span className="text-success font-medium w-20 flex-shrink-0">Strongest:</span>
                  <span className="text-text-body">
                    Response {pr.strongestResponse} — {pr.strongestReason}
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-warning font-medium w-20 flex-shrink-0">Blind spot:</span>
                  <span className="text-text-body">
                    Response {pr.biggestBlindSpot} — {pr.blindSpotDescription}
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-error font-medium w-20 flex-shrink-0">All missed:</span>
                  <span className="text-text-body">{pr.missedByAll}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
