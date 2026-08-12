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
import { Hammer, Play, RefreshCw, X, Landmark, Loader2, GitFork, FileText } from 'lucide-react'
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
  /** Called when user clicks "Update Plan" (from-chat flow) */
  onUpdatePlan?: (sessionId: string, verdict: CouncilVerdict, originConversationId: string, workspaceId: string) => void
  /** Called when user clicks "Accept & Build" (standalone flow) */
  onAcceptAndBuild?: (sessionId: string, workspaceId: string) => void
  /** Called when user clicks "Back to Sessions" / dismiss */
  onDismiss?: () => void
  /** Whether an outcome action is in progress */
  isProcessing?: boolean
  /** Navigate to the Plans Hub tab */
  onNavigateToPlans?: () => void
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
  /** Null = standalone council (no originating chat) */
  originConversationId: string | null
  currentSessionId: string
  currentWorkspaceId: string
  onUpdatePlan: (sessionId: string, verdict: CouncilVerdict, originConversationId: string, workspaceId: string) => void
  onAcceptAndBuild: (sessionId: string, workspaceId: string) => void
  onDismiss?: () => void
  onReset: () => void
  isProcessing?: boolean
}

function CouncilActionBar({
  verdict,
  originConversationId,
  currentSessionId,
  currentWorkspaceId,
  onUpdatePlan,
  onAcceptAndBuild,
  onDismiss,
  onReset,
  isProcessing
}: CouncilActionBarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border-subtle bg-surface-overlay/95 backdrop-blur-sm">
      {originConversationId ? (
        /* ── From-chat: "Update Plan" is primary, "Fork" is secondary ── */
        <>
          <button
            disabled={isProcessing}
            onClick={() => {
              const sid = currentSessionId
              const v = verdict
              const cid = originConversationId
              const wid = currentWorkspaceId
              // onReset() moved into handler — called AFTER async navigation completes
              onUpdatePlan(sid, v, cid, wid)
            }}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-mode-build hover:brightness-110 text-white rounded text-sm font-medium transition-colors press-scale disabled:opacity-50"
          >
            <RefreshCw size={14} className={isProcessing ? 'animate-spin' : ''} />
            {isProcessing ? 'Updating…' : 'Update Plan'}
          </button>
          <button
            disabled={isProcessing}
            data-testid="council-fork-button"
            onClick={() => {
              const sid = currentSessionId
              const wid = currentWorkspaceId
              // onReset() moved into handler — called AFTER async navigation completes
              onAcceptAndBuild(sid, wid)
            }}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale disabled:opacity-50"
          >
            {isProcessing ? <Loader2 size={14} className="animate-spin" /> : <GitFork size={14} />}
            {isProcessing ? 'Forking…' : 'Fork as New Chat'}
          </button>
        </>
      ) : (
        /* ── Standalone: "Accept & Build" is primary ── */
        <button
          disabled={isProcessing}
          onClick={() => {
            const sid = currentSessionId
            const wid = currentWorkspaceId
            // onReset() moved into handler — called AFTER async navigation completes
            onAcceptAndBuild(sid, wid)
          }}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-mode-build hover:brightness-110 text-white rounded text-sm font-medium transition-colors press-scale disabled:opacity-50"
        >
          <Hammer size={14} />
          {isProcessing ? 'Preparing…' : 'Accept & Build'}
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

// ── Extracted helpers ─────────────────────────────────────────────────────

function getHeaderStatusText(isRunning: boolean, phase: string, completedCount: number): string {
  if (isRunning) return `${completedCount}/5 advisors completed`
  if (phase === 'complete') return 'Council review complete'
  return `Status: ${phase}`
}

// ── Phase content sub-components ─────────────────────────────────────────

function FramingPhaseContent({
  advisors,
  selectedAdvisor,
  setSelectedAdvisor
}: {
  advisors: CouncilAdvisors
  selectedAdvisor: CouncilAdvisorRole
  setSelectedAdvisor: (role: CouncilAdvisorRole) => void
}): React.JSX.Element {
  return (
    <div className="h-full flex gap-2 p-3 overflow-hidden">
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
              <AdvisorIcon advisor={def} size={16} className="text-text-secondary flex-shrink-0" />
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
  )
}

function PeerReviewPhaseContent({
  advisors,
  peerReviews,
  completedCount
}: {
  advisors: CouncilAdvisors
  peerReviews: CouncilPeerReview[]
  completedCount: number
}): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center py-4">
          <Loader2 size={24} className="animate-spin text-indigo-400 mx-auto mb-2" />
          <p className="text-sm text-text-primary font-medium">Peer review in progress</p>
          <p className="text-xs text-text-muted mt-1">
            Advisors are anonymously cross-examining each other&apos;s findings. This
            typically takes ~90 seconds.
          </p>
        </div>
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
        {peerReviews.length > 0 && <CouncilRankingsMatrix peerReviews={peerReviews} />}
      </div>
    </div>
  )
}

function SynthesizingPhaseContent({
  verdict
}: {
  verdict: CouncilVerdict | null
}): React.JSX.Element {
  return (
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
  )
}

function CompletePhaseContent({
  verdict,
  advisors,
  peerReviews,
  activeTab,
  setActiveTab
}: {
  verdict: CouncilVerdict | null
  advisors: CouncilAdvisors
  peerReviews: CouncilPeerReview[]
  activeTab: 'overview' | 'advisors' | 'peer-reviews'
  setActiveTab: (tab: 'overview' | 'advisors' | 'peer-reviews') => void
}): React.JSX.Element {
  return (
    <div className="flex-1 h-full overflow-hidden flex flex-col">
      <div className="flex items-center gap-1 px-5 py-2 border-b border-border-subtle flex-shrink-0">
        {(['overview', 'advisors', 'peer-reviews'] as const).map((tab) => (
          <button
            key={tab}
            data-testid={`council-advisor-tab-${tab}`}
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
  )
}

function CancelledFailedContent({
  phase,
  advisors,
  peerReviews,
  verdict,
  completedCount
}: {
  phase: string
  advisors: CouncilAdvisors
  peerReviews: CouncilPeerReview[]
  verdict: CouncilVerdict | null
  completedCount: number
}): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center py-4">
          <p className="text-sm text-text-secondary">
            {phase === 'cancelled'
              ? 'This council session was cancelled.'
              : 'This council session encountered an error.'}
          </p>
        </div>
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
  )
}

// ── Footer bar ───────────────────────────────────────────────────────────

function CouncilFooterBar({
  phase,
  isFailed,
  isRunning,
  completedCount,
  currentSessionId,
  currentWorkspaceId,
  startCouncil,
  setSessionIdentity,
  reset,
  onDismiss
}: {
  phase: string
  isFailed: boolean
  isRunning: boolean
  completedCount: number
  currentSessionId: string | null
  currentWorkspaceId: string | null
  startCouncil: () => void
  setSessionIdentity: (sid: string, wid: string) => void
  reset: () => void
  onDismiss?: () => void
}): React.JSX.Element | null {
  if (isFailed) {
    return (
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
              startCouncil()
              setSessionIdentity(sid, wid)
              window.api.councilResume({ sessionId: sid, workspaceId: wid })
                .catch((err) => {
                  console.error('[council] Resume failed:', err)
                  reset()
                })
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
    )
  }

  if (phase === 'cancelled') {
    return (
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
    )
  }

  if (isRunning) {
    return (
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
    )
  }

  return null
}

// ── Main component ────────────────────────────────────────────────────────

export default function CouncilView({
  inputTitle,
  onUpdatePlan,
  onAcceptAndBuild,
  onDismiss,
  isProcessing,
  onNavigateToPlans
}: CouncilViewProps): React.JSX.Element {
  const {
    phase,
    advisors,
    peerReviews,
    verdict,
    currentSessionId,
    currentWorkspaceId,
    inputTitle: storeInputTitle,
    originConversationId,
    isHydrated,
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

  // Look up plan created from this council session (for hydrated/historical views)
  const [linkedPlanTitle, setLinkedPlanTitle] = useState<string | null>(null)
  useEffect(() => {
    if (!isHydrated || !currentSessionId || phase !== 'complete') return
    let cancelled = false
    window.api
      .planFindBySource({ source: 'council', sourceId: currentSessionId })
      .then((plan) => {
        if (!cancelled && plan?.title) setLinkedPlanTitle(plan.title)
      })
      .catch(() => { /* best-effort */ })
    return () => { cancelled = true }
  }, [isHydrated, currentSessionId, phase])

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
              {getHeaderStatusText(isRunning, phase, completedCount)}
            </p>
          </div>
        </div>
        <PhaseIndicator phase={phase} />
      </div>

      {/* ── Sticky action bar (complete phase, live sessions only) ──────── */}
      {phase === 'complete' && verdict && !isHydrated && (
        <CouncilActionBar
          verdict={verdict}
          originConversationId={originConversationId}
          currentSessionId={currentSessionId!}
          currentWorkspaceId={currentWorkspaceId!}
          onUpdatePlan={onUpdatePlan!}
          onAcceptAndBuild={onAcceptAndBuild!}
          onDismiss={onDismiss}
          onReset={reset}
          isProcessing={isProcessing}
        />
      )}

      {/* ── Linked plan banner (hydrated historical sessions) ──────────── */}
      {isHydrated && linkedPlanTitle && (
        <div className="flex items-center gap-2 px-5 py-2 border-b border-border-subtle bg-indigo-500/5">
          <FileText size={14} className="text-indigo-400 flex-shrink-0" />
          <span className="text-xs text-text-secondary">
            This council produced a plan:
          </span>
          <span className="text-xs font-medium text-text-primary truncate">
            &ldquo;{linkedPlanTitle}&rdquo;
          </span>
          {onNavigateToPlans && (
            <button
              type="button"
              onClick={onNavigateToPlans}
              className="text-xs text-indigo-400 hover:text-indigo-300 font-medium ml-auto flex-shrink-0 transition-colors"
            >
              View in Plans Hub →
            </button>
          )}
        </div>
      )}

      {/* ── Main content area ───────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        {(phase === 'framing' || phase === 'deliberating') && (
          <FramingPhaseContent
            advisors={advisors}
            selectedAdvisor={selectedAdvisor}
            setSelectedAdvisor={setSelectedAdvisor}
          />
        )}

        {phase === 'peer-review' && (
          <PeerReviewPhaseContent
            advisors={advisors}
            peerReviews={peerReviews}
            completedCount={completedCount}
          />
        )}

        {phase === 'synthesizing' && <SynthesizingPhaseContent verdict={verdict} />}

        {phase === 'complete' && (
          <CompletePhaseContent
            verdict={verdict}
            advisors={advisors}
            peerReviews={peerReviews}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
          />
        )}

        {(phase === 'cancelled' || phase === 'failed') && (
          <CancelledFailedContent
            phase={phase}
            advisors={advisors}
            peerReviews={peerReviews}
            verdict={verdict}
            completedCount={completedCount}
          />
        )}
      </div>

      {/* ── Footer bars (non-complete phases) ───────────────────────────── */}

      <CouncilFooterBar
        phase={phase}
        isFailed={isFailed}
        isRunning={isRunning}
        completedCount={completedCount}
        currentSessionId={currentSessionId}
        currentWorkspaceId={currentWorkspaceId}
        startCouncil={startCouncil}
        setSessionIdentity={setSessionIdentity}
        reset={reset}
        onDismiss={onDismiss}
      />
    </div>
  )
}
