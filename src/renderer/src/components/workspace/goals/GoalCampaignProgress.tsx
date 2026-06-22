/**
 * GoalCampaignProgress — live monitoring rail for an active campaign.
 *
 * Renders the ordered goal list with per-goal status (pending/running/done/
 * failed/skipped), the running goal's success criteria, and the Retry/Skip/Stop
 * prompt when the campaign is paused on a failed goal.
 *
 * The active goal's phase timeline + stream are rendered separately by GoalPage
 * (driven by the existing per-goal MPA events).
 */

import { type JSX } from 'react'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
  SkipForward,
  RotateCcw,
  StopCircle,
  AlertTriangle
} from 'lucide-react'
import { useMpaStore } from '@renderer/store/mpa.store'
import type { MpaCampaignGoalStatus } from '../../../../../shared/mpa-types'

function StatusIcon({ status }: { status: MpaCampaignGoalStatus }): JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={14} className="text-success flex-shrink-0" />
    case 'failed':
      return <XCircle size={14} className="text-danger flex-shrink-0" />
    case 'running':
      return <Loader2 size={14} className="text-cyan-400 animate-spin flex-shrink-0" />
    case 'skipped':
      return <SkipForward size={14} className="text-text-muted flex-shrink-0" />
    default:
      return <Circle size={14} className="text-text-muted flex-shrink-0" />
  }
}

interface GoalCampaignProgressProps {
  workspaceId: string
}

export default function GoalCampaignProgress({
  workspaceId
}: GoalCampaignProgressProps): JSX.Element | null {
  const activeCampaign = useMpaStore((s) => s.activeCampaign)
  const respondToCampaign = useMpaStore((s) => s.respondToCampaign)

  if (!activeCampaign) return null

  const { title, currentIndex, totalGoals, goals, paused } = activeCampaign

  return (
    <div data-testid="goal-campaign-progress" className="space-y-3">
      <div className="rounded-xl border border-border-subtle bg-surface-overlay p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-text-primary truncate">{title}</span>
          <span className="text-[11px] text-text-muted">
            Goal {Math.min(currentIndex + 1, totalGoals)} of {totalGoals}
          </span>
        </div>

        <ul className="space-y-1.5">
          {goals.map((g) => {
            const isCurrent = g.orderIndex === currentIndex
            return (
              <li key={g.goalId} className="space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <StatusIcon status={g.status} />
                  <span
                    className={
                      g.status === 'running'
                        ? 'text-text-primary font-medium'
                        : g.status === 'skipped'
                          ? 'text-text-muted line-through'
                          : 'text-text-secondary'
                    }
                  >
                    {g.title || '(untitled)'}
                  </span>
                </div>
                {/* Show success criteria for the running goal. */}
                {isCurrent && g.successCriteria.length > 0 && (
                  <ul className="ml-6 space-y-0.5">
                    {g.successCriteria.map((c, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-[11px] text-text-muted">
                        <span className="mt-0.5">○</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      {paused && (
        <div className="rounded-xl border border-purple-400/30 bg-purple-500/5 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-purple-400 mt-0.5 shrink-0" />
            <p className="text-xs text-text-secondary">{paused.reason}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="goal-campaign-action-btn"
              onClick={() => respondToCampaign(workspaceId, 'retry')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-cyan-400 bg-cyan-500/20 hover:bg-cyan-500/30 rounded-lg"
            >
              <RotateCcw size={13} /> Retry
            </button>
            <button
              type="button"
              onClick={() => respondToCampaign(workspaceId, 'skip')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-base hover:bg-surface-overlay rounded-lg"
            >
              <SkipForward size={13} /> Skip
            </button>
            <button
              type="button"
              onClick={() => respondToCampaign(workspaceId, 'stop')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 rounded-lg"
            >
              <StopCircle size={13} /> Stop
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
