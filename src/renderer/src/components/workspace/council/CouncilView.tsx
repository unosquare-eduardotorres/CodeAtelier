/**
 * CouncilView — full-page council view.
 *
 * Visual phases:
 *   Phase 1 (framing/deliberating): Two-panel detail view — expanded advisor + mini sidebar
 *   Phase 2 (peer-review):          Enriched waiting experience with scores + key findings
 *   Phase 3 (synthesizing):         Spinner while chairman synthesizes
 *   Phase 4 (complete):             Sticky action bar + tabbed content (Overview / Advisor Details / Peer Reviews)
 *
 * Action bar: Accept & Build / Send to Goal / Revise Plan / Back to Sessions
 */

import { useEffect, useMemo, useState } from 'react'
import { Hammer, Play, RefreshCw, X, Landmark, Loader2, Target } from 'lucide-react'
import { useCouncilStore } from '@renderer/store/council.store'
import { COUNCIL_ADVISOR_ROLES, COUNCIL_ADVISORS } from '../../../../../shared/constants'
import type { CouncilAdvisorRole, CouncilPeerReview, CouncilVerdict } from '../../../../../shared/types'
import CouncilMemberColumn, { StatusBadge } from './CouncilMemberColumn'
import CouncilVerdictCard from './CouncilVerdictCard'
import CouncilRankingsMatrix from './CouncilRankingsMatrix'
import CouncilAdvisorDetailsTab from './CouncilAdvisorDetailsTab'
import AdvisorIcon from './AdvisorIcon'

type CouncilAdvisors = ReturnType<typeof useCouncilStore.getState>['advisors']

// ── Props ─────────────────────────────────────────────────────────────────

interface CouncilViewProps {
  /** Title of the content being reviewed */
  inputTitle?: string
  /** Called when user clicks "Accept & Build" */
  onAcceptAndBuild?: () => void
  /** Called when user clicks "Revise Plan" */
  onRevisePlan?: (feedback: string) => void
  /** Called when user clicks "Back to Sessions" / dismiss */
  onDismiss?: () => void
  /** Called when user clicks "Send to Goal" */
  onSendToGoal?: (goal: string, title: string) => void
}

// ── Phase indicator ───────────────────────────────────────────────────────

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
              {isActive && phase !== 'complete' && <Loader2 size={10} className="animate-spin" />}
              {p.label}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Action bar (complete phase) ──────────────────────────────────────────

interface CouncilActionBarProps {
  verdict: CouncilVerdict
  resolvedTitle: string | undefined
  onAcceptAndBuild?: () => void
  onSendToGoal?: (text: string, title: string) => void
  onRevisePlan?: (feedback: string) => void
  onDismiss?: () => void
  onReset: () => void
}

function CouncilActionBar({
  verdict,
  resolvedTitle,
  onAcceptAndBuild,
  onSendToGoal,
  onRevisePlan,
  onDismiss,
  onReset
}: CouncilActionBarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border-subtle bg-surface-overlay/95 backdrop-blur-sm">
      {onAcceptAndBuild && (
        <button
          onClick={() => {
            onReset()
            onAcceptAndBuild()
          }}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-mode-build hover:brightness-110 text-white rounded text-sm font-medium transition-colors press-scale"
        >
          <Hammer size={14} />
          Accept & Build
        </button>
      )}
      {onSendToGoal && (
        <button
          onClick={() => {
            const goalText = [
              verdict.sections.recommendation,
              '',
              'Key revisions:',
              ...verdict.revisions
                .filter((r) => r.priority === 'high' || r.priority === 'medium')
                .map((r) => `- ${r.description}`)
            ].join('\n')

            onReset()
            onSendToGoal(goalText, resolvedTitle ?? 'Council-reviewed plan')
          }}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 rounded text-sm font-medium transition-colors press-scale"
        >
          <Target size={14} />
          Send to Goal
        </button>
      )}
      {onRevisePlan && (
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
            onReset()
            onRevisePlan(feedback)
          }}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
        >
          <RefreshCw size={14} />
          Revise Plan
        </button>
      )}
      <button
        onClick={() => {
          onReset()
          onDismiss?.()
        }}
        className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
      >
        <X size={14} />
        Back to Sessions
      </button>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────

export default function CouncilView({
  inputTitle,
  onAcceptAndBuild,
  onRevisePlan,
  onDismiss,
  onSendToGoal
}: CouncilViewProps): React.JSX.Element {
  const {
    phase,
    advisors,
    peerReviews,
    verdict,
    currentSessionId,
    currentWorkspaceId,
    inputTitle: storeInputTitle,
    handlePhaseChanged,
    handleMemberStream,
    handleMemberComplete,
    handlePeerReviewComplete,
    handleVerdict,
    reset,
    startCouncil,
    setSessionIdentity
  } = useCouncilStore()

  // Resolve title: prop > store > fallback
  const resolvedTitle = inputTitle ?? storeInputTitle ?? undefined

  // Local UI state
  const [selectedAdvisor, setSelectedAdvisor] = useState<CouncilAdvisorRole>(
    COUNCIL_ADVISOR_ROLES[0]
  )
  const [activeTab, setActiveTab] = useState<'overview' | 'advisors' | 'peer-reviews'>('overview')

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
      api.onCouncilPeerReviewComplete((data) => handlePeerReviewComplete(data.peerReviews as never))
    )
    cleanups.push(api.onCouncilVerdict((data) => handleVerdict(data.verdict as never)))

    return () => {
      cleanups.forEach((fn) => fn())
    }
  }, [
    handlePhaseChanged,
    handleMemberStream,
    handleMemberComplete,
    handlePeerReviewComplete,
    handleVerdict
  ])

  const isRunning = phase !== 'complete' && phase !== 'cancelled' && phase !== 'failed'
  const isFailed = phase === 'failed'

  const completedCount = useMemo(
    () => COUNCIL_ADVISOR_ROLES.filter((r) => advisors[r].status === 'completed').length,
    [advisors]
  )

  return (
    <div data-testid="council-view" className="flex flex-col h-full bg-surface-base">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle bg-surface-overlay">
        <div className="flex items-center gap-3 min-w-0">
          <Landmark size={20} className="text-indigo-400 flex-shrink-0" />
          <div className="min-w-0">
            <h2 className="text-base font-bold text-text-primary">LLM Council</h2>
            {resolvedTitle && (
              <p className="text-xs text-text-body truncate max-w-lg" title={resolvedTitle}>
                &ldquo;{resolvedTitle}&rdquo;
              </p>
            )}
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

      {/* ── Sticky action bar (complete phase) ──────────────────────────── */}
      {phase === 'complete' && verdict && (
        <CouncilActionBar
          verdict={verdict}
          resolvedTitle={resolvedTitle}
          onAcceptAndBuild={onAcceptAndBuild}
          onSendToGoal={onSendToGoal}
          onRevisePlan={onRevisePlan}
          onDismiss={onDismiss}
          onReset={reset}
        />
      )}

      {/* ── Main content area ───────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        {/* Phase 1: Framing / Deliberating — two-panel detail view */}
        {(phase === 'framing' || phase === 'deliberating') && (
          <div className="h-full flex gap-2 p-3 overflow-hidden">
            {/* Expanded advisor — 70% width */}
            <div className="flex-[7] min-w-0">
              <CouncilMemberColumn
                key={selectedAdvisor}
                role={selectedAdvisor}
                status={advisors[selectedAdvisor].status}
                segments={advisors[selectedAdvisor].segments}
                currentContent={advisors[selectedAdvisor].currentContent}
                currentToolActivities={advisors[selectedAdvisor].currentToolActivities}
                review={advisors[selectedAdvisor].review}
              />
            </div>

            {/* Mini sidebar — 30% width */}
            <div className="flex-[3] flex flex-col gap-1.5 overflow-y-auto">
              {COUNCIL_ADVISOR_ROLES.map((role) => {
                const advisor = advisors[role]
                const def = COUNCIL_ADVISORS[role]
                const isSelected = role === selectedAdvisor
                return (
                  <button
                    key={role}
                    onClick={() => setSelectedAdvisor(role)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                      isSelected
                        ? 'bg-indigo-500/10 border-indigo-500/30'
                        : 'bg-surface-overlay border-border-subtle hover:bg-surface-hover'
                    }`}
                  >
                    <AdvisorIcon
                      advisor={def}
                      size={16}
                      className="text-text-secondary flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-semibold text-text-primary truncate block">
                        {def.name}
                      </span>
                      <StatusBadge status={advisor.status} />
                    </div>
                    {advisor.review && (
                      <span className="text-sm font-bold text-text-primary">
                        {advisor.review.score}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Phase 2: Peer Review — enriched waiting experience */}
        {phase === 'peer-review' && (
          <div className="h-full overflow-y-auto p-5">
            <div className="max-w-3xl mx-auto space-y-6">
              {/* Status indicator */}
              <div className="text-center py-4">
                <Loader2 size={24} className="animate-spin text-indigo-400 mx-auto mb-2" />
                <p className="text-sm text-text-primary font-medium">Peer review in progress</p>
                <p className="text-xs text-text-muted mt-1">
                  Advisors are anonymously cross-examining each other&apos;s findings. This
                  typically takes ~90 seconds.
                </p>
              </div>

              {/* Advisor score cards with pulse animation */}
              <div className="grid grid-cols-5 gap-2">
                {COUNCIL_ADVISOR_ROLES.map((role) => {
                  const advisor = advisors[role]
                  const a = COUNCIL_ADVISORS[role]
                  return (
                    <div
                      key={role}
                      className="flex flex-col items-center gap-1 p-3 rounded-lg bg-surface-overlay border border-border-subtle animate-pulse-subtle"
                    >
                      <AdvisorIcon advisor={a} size={28} className="text-text-secondary" />
                      <span className="text-xs font-medium text-text-primary">{a.name}</span>
                      {advisor.review ? (
                        <span className="text-lg font-bold text-text-primary">
                          {advisor.review.score}
                        </span>
                      ) : (
                        <span className="text-lg font-bold text-text-muted">&mdash;</span>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Key findings summary — pulled from completed advisor reviews */}
              {completedCount > 0 && (
                <div className="rounded-lg border border-border-subtle bg-surface-overlay p-4">
                  <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
                    Key Findings from Advisors
                  </h4>
                  <div className="space-y-3">
                    {COUNCIL_ADVISOR_ROLES.map((role) => {
                      const advisor = advisors[role]
                      if (!advisor.review) return null
                      const def = COUNCIL_ADVISORS[role]
                      return (
                        <div key={role} className="flex items-start gap-2">
                          <AdvisorIcon
                            advisor={def}
                            size={14}
                            className="text-text-secondary mt-0.5 flex-shrink-0"
                          />
                          <div>
                            <span className="text-xs font-semibold text-text-primary">
                              {def.name}
                            </span>
                            <ul className="text-xs text-text-body mt-0.5 space-y-0.5">
                              {advisor.review.keyFindings.slice(0, 2).map((f, i) => (
                                <li key={i}>• {f}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* When peer reviews arrive, show rankings matrix */}
              {peerReviews.length > 0 && <CouncilRankingsMatrix peerReviews={peerReviews} />}
            </div>
          </div>
        )}

        {/* Phase 3: Synthesizing — spinner only */}
        {phase === 'synthesizing' && (
          <div className="h-full overflow-y-auto p-5">
            <div className="max-w-4xl mx-auto space-y-6">
              {!verdict && (
                <div className="text-center py-8">
                  <Loader2 size={24} className="animate-spin text-primary mx-auto mb-2" />
                  <p className="text-sm text-text-secondary">
                    The Chairman is synthesizing all reviews…
                  </p>
                </div>
              )}
              {verdict && <CouncilVerdictCard verdict={verdict} />}
            </div>
          </div>
        )}

        {/* Phase 4: Complete — tabbed content */}
        {phase === 'complete' && (
          <div className="flex-1 h-full overflow-hidden flex flex-col">
            {/* Tab bar */}
            <div className="flex items-center gap-1 px-5 py-2 border-b border-border-subtle flex-shrink-0">
              {(['overview', 'advisors', 'peer-reviews'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    activeTab === tab
                      ? 'bg-indigo-500/20 text-indigo-400'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                  }`}
                >
                  {tab === 'overview'
                    ? 'Overview'
                    : tab === 'advisors'
                      ? 'Advisor Details'
                      : 'Peer Reviews'}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto p-5">
              <div className="max-w-3xl mx-auto space-y-4">
                {activeTab === 'overview' && verdict && <CouncilVerdictCard verdict={verdict} />}
                {activeTab === 'advisors' && <CouncilAdvisorDetailsTab advisors={advisors} />}
                {activeTab === 'peer-reviews' &&
                  (peerReviews.length > 0 ? (
                    <CouncilRankingsMatrix peerReviews={peerReviews} />
                  ) : (
                    <div className="text-center py-8">
                      <p className="text-sm text-text-secondary">
                        No peer review data available for this session.
                      </p>
                    </div>
                  ))}
              </div>
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

      {/* ── Footer bars (non-complete phases) ───────────────────────────── */}

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
                startCouncil() // reset UI to clean state
                setSessionIdentity(sid, wid) // re-set identity (startCouncil clears it)
                window.api.councilResume({ sessionId: sid, workspaceId: wid }).catch(console.error)
              }
            }}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded text-sm font-medium transition-colors press-scale"
          >
            <Play size={14} />
            Resume
          </button>
          <button
            onClick={() => {
              reset()
              onDismiss?.()
            }}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
          >
            <X size={14} />
            Back to Sessions
          </button>
        </div>
      )}

      {/* Cancelled state — back to sessions */}
      {phase === 'cancelled' && (
        <div className="flex items-center gap-2 px-5 py-3 border-t border-border-subtle bg-surface-overlay/95 backdrop-blur-sm">
          <div className="flex-1">
            <p className="text-xs text-text-secondary">
              Council was cancelled. {completedCount}/5 advisors had completed.
            </p>
          </div>
          <button
            onClick={() => {
              reset()
              onDismiss?.()
            }}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
          >
            <X size={14} />
            Back to Sessions
          </button>
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
