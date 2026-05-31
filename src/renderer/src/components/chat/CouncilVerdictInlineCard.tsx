/**
 * CouncilVerdictInlineCard — compact inline card for the chat stream.
 *
 * Shows:
 *   - Overall score + recommendation summary
 *   - Advisor chips (clickable to expand)
 *   - Collapsible sections for full reviews
 *   - Accept & Build / Revise buttons
 */

import { useState } from 'react'
import { ChevronDown, ChevronUp, Landmark } from 'lucide-react'
import ScoreGauge from '../workspace/ScoreGauge'
import type { CouncilVerdict, CouncilAdvisorRole } from '../../../../shared/types'
import { COUNCIL_ADVISORS } from '../../../../shared/constants'

interface CouncilVerdictInlineCardProps {
  verdict: CouncilVerdict
}

export default function CouncilVerdictInlineCard({
  verdict
}: CouncilVerdictInlineCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-lg border border-purple-500/30 bg-surface-overlay overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-3 bg-purple-500/5 border-b border-purple-500/20">
        <Landmark size={16} className="text-purple-400" />
        <span className="text-sm font-semibold text-text-primary">Council Verdict</span>
        <div className="ml-auto flex items-center gap-2">
          <ScoreGauge score={verdict.overallScore} size={36} />
          <span className="text-lg font-bold text-text-primary">{verdict.overallScore}</span>
        </div>
      </div>

      {/* Compact summary */}
      <div className="px-4 py-3">
        <p className="text-sm text-text-body leading-relaxed">
          {verdict.sections.recommendation}
        </p>

        {verdict.sections.oneThingFirst && (
          <div className="mt-2 px-2 py-1.5 rounded bg-primary/10 border border-primary/20">
            <span className="text-xs font-semibold text-primary">Do This First: </span>
            <span className="text-xs text-text-body">{verdict.sections.oneThingFirst}</span>
          </div>
        )}

        {/* Advisor score chips */}
        {verdict.individualScores && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {(Object.entries(verdict.individualScores) as [CouncilAdvisorRole, number][]).map(
              ([role, score]) => {
                const advisor = COUNCIL_ADVISORS[role]
                if (!advisor) return null
                return (
                  <span
                    key={role}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-float border border-border-subtle text-xs"
                    title={advisor.name}
                  >
                    <span>{advisor.emoji}</span>
                    <span className="font-bold text-text-primary">{score}</span>
                  </span>
                )
              }
            )}
          </div>
        )}
      </div>

      {/* Expandable details */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-center w-full gap-1 px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-float/50 transition-colors border-t border-border-subtle"
      >
        {expanded ? (
          <>
            <ChevronUp size={12} /> Hide details
          </>
        ) : (
          <>
            <ChevronDown size={12} /> Show details ({verdict.revisions.length} revisions)
          </>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3 border-t border-border-subtle">
          {/* Agreements */}
          <div>
            <span className="text-xs font-semibold text-success">Agreement:</span>
            <p className="text-xs text-text-body mt-0.5">{verdict.sections.agrees}</p>
          </div>

          {/* Disagreements */}
          <div>
            <span className="text-xs font-semibold text-warning">Disagreements:</span>
            <p className="text-xs text-text-body mt-0.5">{verdict.sections.clashes}</p>
          </div>

          {/* Blind spots */}
          <div>
            <span className="text-xs font-semibold text-error">Blind Spots:</span>
            <p className="text-xs text-text-body mt-0.5">{verdict.sections.blindSpots}</p>
          </div>

          {/* Revisions */}
          {verdict.revisions.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-text-primary">Revisions:</span>
              {verdict.revisions.map((rev, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span
                    className={`px-1 py-0.5 rounded text-[9px] font-bold uppercase ${
                      rev.priority === 'high'
                        ? 'bg-error/10 text-error'
                        : rev.priority === 'medium'
                          ? 'bg-warning/10 text-warning'
                          : 'bg-info/10 text-info'
                    }`}
                  >
                    {rev.priority}
                  </span>
                  <span className="text-text-body">{rev.description}</span>
                  <span className="text-text-secondary ml-auto flex-shrink-0">{rev.consensus}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
