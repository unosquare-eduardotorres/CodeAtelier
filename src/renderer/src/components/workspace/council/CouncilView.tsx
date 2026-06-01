/**
 * CouncilView — full-page council view.
 *
 * Three visual phases:
 *   Phase 1 (deliberating): 5 streaming columns for advisor opinions
 *   Phase 2 (peer-review):  Rankings matrix + consensus analysis
 *   Phase 3 (synthesizing → complete): Chairman verdict card with score gauge
 *
 * Footer: Accept & Build / Revise Plan / Dismiss
 */

import { useEffect, useMemo } from 'react'
import { Hammer, Play, RefreshCw, X, Landmark, Loader2 } from 'lucide-react'
import { useCouncilStore } from '@renderer/store/council.store'
import { COUNCIL_ADVISOR_ROLES, COUNCIL_ADVISORS } from '../../../../../shared/constants'
import CouncilMemberColumn from './CouncilMemberColumn'
import CouncilVerdictCard from './CouncilVerdictCard'
import CouncilRankingsMatrix from './CouncilRankingsMatrix'
import AdvisorIcon from './AdvisorIcon'

interface CouncilViewProps {
  /** Called when user clicks "Accept & Build" */
  onAcceptAndBuild?: () => void
  /** Called when user clicks "Revise Plan" */
  onRevisePlan?: (feedback: string) => void
  /** Called when user clicks "Dismiss" */
  onDismiss?: () => void
}

function PhaseIndicator({ phase }: { phase: string }): React.JSX.Element {
  const phases = [
    { id: 'framing', label: 'Framing' },
    { id: 'deliberating', label: 'Council' },
    { id: 'peer-review', label: 'Peer Review' },
    { id: 'synthesizing', label: 'Synthesis' },
    { id: 'complete', label: 'Complete' }
  ]

  const currentIdx = phases.findIndex((p) => p.id === phase)

  return (
    <div className="flex items-center gap-1">
      {phases.map((p, i) => {
        const isActive = p.id === phase
        const isDone = i < currentIdx
        return (
          <div key={p.id} className="flex items-center gap-1">
            {i > 0 && <div className={`w-6 h-px ${isDone ? 'bg-success' : 'bg-border-subtle'}`} />}
            <div
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-primary/20 text-primary border border-primary/30'
                  : isDone
                    ? 'bg-success/10 text-success'
                    : 'text-text-secondary'
              }`}
            >
              {isActive && phase !== 'complete' && (
                <Loader2 size={10} className="animate-spin" />
              )}
              {p.label}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function CouncilView({
  onAcceptAndBuild,
  onRevisePlan,
  onDismiss
}: CouncilViewProps): React.JSX.Element {
  const {
    phase,
    advisors,
    peerReviews,
    verdict,
    currentSessionId,
    currentWorkspaceId,
    handlePhaseChanged,
    handleMemberStream,
    handleMemberComplete,
    handlePeerReviewComplete,
    handleVerdict,
    reset,
    startCouncil,
    setSessionIdentity
  } = useCouncilStore()

  // Wire IPC listeners
  // TODO: Reconcile IPC event types with store handler types to remove `as never` casts
  useEffect(() => {
    const api = window.api
    const cleanups: (() => void)[] = []

    cleanups.push(api.onCouncilPhaseChanged((data) => handlePhaseChanged(data.phase as never)))
    cleanups.push(api.onCouncilMemberStream((data) => handleMemberStream(data)))
    cleanups.push(
      api.onCouncilMemberComplete((data) =>
        handleMemberComplete(data.advisorRole, data.review as never)
      )
    )
    cleanups.push(
      api.onCouncilPeerReviewComplete((data) =>
        handlePeerReviewComplete(data.peerReviews as never)
      )
    )
    cleanups.push(api.onCouncilVerdict((data) => handleVerdict(data.verdict as never)))

    return () => {
      cleanups.forEach((fn) => fn())
    }
  }, [handlePhaseChanged, handleMemberStream, handleMemberComplete, handlePeerReviewComplete, handleVerdict])

  const isRunning = phase !== 'complete' && phase !== 'cancelled' && phase !== 'failed'
  const isFailed = phase === 'failed'

  const completedCount = useMemo(
    () => COUNCIL_ADVISOR_ROLES.filter((r) => advisors[r].status === 'completed').length,
    [advisors]
  )

  return (
    <div className="flex flex-col h-full bg-surface-base">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle bg-surface-overlay">
        <div className="flex items-center gap-3">
          <Landmark size={20} className="text-purple-400" />
          <div>
            <h2 className="text-base font-bold text-text-primary">LLM Council</h2>
            <p className="text-xs text-text-secondary">
              {isRunning
                ? `${completedCount}/5 advisors completed`
                : phase === 'complete'
                  ? 'Council review complete'
                  : `Status: ${phase}`}
            </p>
          </div>
        </div>
        <PhaseIndicator phase={phase} />
      </div>

      {/* Main content area */}
      <div className="flex-1 overflow-hidden">
        {/* Phase 1: Deliberating — 5 advisor columns */}
        {(phase === 'framing' || phase === 'deliberating') && (
          <div className="h-full grid grid-cols-5 gap-2 p-3 overflow-hidden">
            {COUNCIL_ADVISOR_ROLES.map((role) => {
              const advisor = advisors[role]
              return (
                <CouncilMemberColumn
                  key={role}
                  role={role}
                  status={advisor.status}
                  segments={advisor.segments}
                  currentContent={advisor.currentContent}
                  currentToolActivities={advisor.currentToolActivities}
                  review={advisor.review}
                />
              )
            })}
          </div>
        )}

        {/* Phase 2: Peer Review */}
        {phase === 'peer-review' && (
          <div className="h-full overflow-y-auto p-5">
            <div className="max-w-3xl mx-auto space-y-6">
              <div className="text-center py-4">
                <Loader2 size={24} className="animate-spin text-primary mx-auto mb-2" />
                <p className="text-sm text-text-secondary">
                  Advisors are anonymously reviewing each other's responses…
                </p>
              </div>

              {/* Show completed advisor reviews as cards */}
              <div className="grid grid-cols-5 gap-2">
                {COUNCIL_ADVISOR_ROLES.map((role) => {
                  const advisor = advisors[role]
                  if (!advisor.review) return null
                  const a = COUNCIL_ADVISORS[role]
                  return (
                    <div
                      key={role}
                      className="flex flex-col items-center gap-1 p-3 rounded-lg bg-surface-overlay border border-border-subtle"
                    >
                      <AdvisorIcon advisor={a} size={28} className="text-text-secondary" />
                      <span className="text-xs font-medium text-text-primary">{a.name}</span>
                      <span className="text-lg font-bold text-text-primary">
                        {advisor.review.score}
                      </span>
                    </div>
                  )
                })}
              </div>

              {peerReviews.length > 0 && (
                <CouncilRankingsMatrix peerReviews={peerReviews} />
              )}
            </div>
          </div>
        )}

        {/* Phase 3: Synthesis + Complete */}
        {(phase === 'synthesizing' || phase === 'complete') && (
          <div className="h-full overflow-y-auto p-5">
            <div className="max-w-4xl mx-auto space-y-6">
              {phase === 'synthesizing' && !verdict && (
                <div className="text-center py-8">
                  <Loader2 size={24} className="animate-spin text-primary mx-auto mb-2" />
                  <p className="text-sm text-text-secondary">
                    The Chairman is synthesizing all reviews…
                  </p>
                </div>
              )}

              {verdict && <CouncilVerdictCard verdict={verdict} />}

              {/* Peer reviews section (always visible in complete) */}
              {peerReviews.length > 0 && (
                <div className="mt-6">
                  <CouncilRankingsMatrix peerReviews={peerReviews} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Cancelled / Failed — show collected work + status message */}
        {(phase === 'cancelled' || phase === 'failed') && (
          <div className="h-full overflow-y-auto p-5">
            <div className="max-w-3xl mx-auto space-y-6">
              <div className="text-center py-4">
                <p className="text-sm text-text-secondary">
                  {phase === 'cancelled'
                    ? 'This council session was cancelled.'
                    : 'This council session encountered an error.'}
                </p>
              </div>

              {/* Show completed advisor scores */}
              {completedCount > 0 && (
                <div className="grid grid-cols-5 gap-2">
                  {COUNCIL_ADVISOR_ROLES.map((role) => {
                    const advisor = advisors[role]
                    if (!advisor.review) return null
                    const a = COUNCIL_ADVISORS[role]
                    return (
                      <div
                        key={role}
                        className="flex flex-col items-center gap-1 p-3 rounded-lg bg-surface-overlay border border-border-subtle"
                      >
                        <AdvisorIcon advisor={a} size={28} className="text-text-secondary" />
                        <span className="text-xs font-medium text-text-primary">{a.name}</span>
                        <span className="text-lg font-bold text-text-primary">
                          {advisor.review.score}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}

              {peerReviews.length > 0 && <CouncilRankingsMatrix peerReviews={peerReviews} />}
              {verdict && <CouncilVerdictCard verdict={verdict} />}
            </div>
          </div>
        )}
      </div>

      {/* Footer action bar */}
      {phase === 'complete' && (
        <div className="flex items-center gap-2 px-5 py-3 border-t border-border-subtle bg-surface-overlay/95 backdrop-blur-sm">
          {onAcceptAndBuild && (
            <button
              onClick={() => {
                reset()
                onAcceptAndBuild()
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-mode-build hover:brightness-110 text-white rounded text-sm font-medium transition-colors press-scale"
            >
              <Hammer size={14} />
              Accept & Build
            </button>
          )}
          {onRevisePlan && verdict && (
            <button
              onClick={() => {
                const feedback = [
                  'Council Review Feedback:',
                  `Overall Score: ${verdict.overallScore}/100`,
                  '',
                  `Recommendation: ${verdict.sections.recommendation}`,
                  '',
                  'Revisions needed:',
                  ...verdict.revisions.map(
                    (r) => `- [${r.priority.toUpperCase()}] ${r.description} (${r.consensus})`
                  )
                ].join('\n')
                reset()
                onRevisePlan(feedback)
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
            >
              <RefreshCw size={14} />
              Revise Plan
            </button>
          )}
          {onDismiss && (
            <button
              onClick={() => {
                reset()
                onDismiss()
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
            >
              <X size={14} />
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Failed state — show completed advisors + resume */}
      {isFailed && (
        <div className="flex items-center gap-2 px-5 py-3 border-t border-border-subtle bg-surface-overlay/95 backdrop-blur-sm">
          <div className="flex-1">
            <p className="text-xs text-amber-400">
              Council failed. {completedCount}/5 advisors had completed.
            </p>
          </div>
          <button
            onClick={() => {
              if (currentSessionId && currentWorkspaceId) {
                const sid = currentSessionId
                const wid = currentWorkspaceId
                startCouncil()          // reset UI to clean state
                setSessionIdentity(sid, wid) // re-set identity (startCouncil clears it)
                window.api.councilResume({ sessionId: sid, workspaceId: wid }).catch(console.error)
              }
            }}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded text-sm font-medium transition-colors press-scale"
          >
            <Play size={14} />
            Resume
          </button>
          {onDismiss && (
            <button
              onClick={() => {
                reset()
                onDismiss()
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
            >
              <X size={14} />
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Cancelled state — dismiss button */}
      {phase === 'cancelled' && (
        <div className="flex items-center gap-2 px-5 py-3 border-t border-border-subtle bg-surface-overlay/95 backdrop-blur-sm">
          <div className="flex-1">
            <p className="text-xs text-text-secondary">
              Council was cancelled. {completedCount}/5 advisors had completed.
            </p>
          </div>
          {onDismiss && (
            <button
              onClick={() => {
                reset()
                onDismiss()
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
            >
              <X size={14} />
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Cancel button while running */}
      {isRunning && (
        <div className="flex items-center gap-2 px-5 py-3 border-t border-border-subtle bg-surface-overlay/95 backdrop-blur-sm">
          <button
            onClick={() => {
              window.api.councilCancel()
              reset()
              onDismiss?.()
            }}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-error/20 hover:bg-error/30 text-error rounded text-sm font-medium transition-colors press-scale"
          >
            <X size={14} />
            Cancel Council
          </button>
        </div>
      )}
    </div>
  )
}
