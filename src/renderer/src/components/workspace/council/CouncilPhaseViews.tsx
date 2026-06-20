/**
 * Phase-specific sub-components for CouncilView.
 * Extracted to reduce cyclomatic complexity of the main component.
 */

import { Loader2 } from 'lucide-react'
import { COUNCIL_ADVISOR_ROLES, COUNCIL_ADVISORS } from '../../../../../shared/constants'
import CouncilMemberColumn, { StatusBadge } from './CouncilMemberColumn'
import CouncilVerdictCard from './CouncilVerdictCard'
import CouncilRankingsMatrix from './CouncilRankingsMatrix'
import CouncilAdvisorDetailsTab from './CouncilAdvisorDetailsTab'
import AdvisorIcon from './AdvisorIcon'
import type { useCouncilViewState } from './useCouncilViewState'

type CouncilState = ReturnType<typeof useCouncilViewState>

// ── Phase 1: Deliberating ──

export function CouncilDeliberatingView({
  advisors,
  selectedAdvisor,
  setSelectedAdvisor
}: Pick<CouncilState, 'advisors' | 'selectedAdvisor' | 'setSelectedAdvisor'>): React.JSX.Element {
  return (
    <div data-testid="council-deliberating-view" className="h-full flex gap-2 p-3 overflow-hidden">
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

// ── Phase 2: Peer Review ──

export function CouncilPeerReviewView({
  advisors,
  peerReviews,
  completedCount
}: Pick<CouncilState, 'advisors' | 'peerReviews' | 'completedCount'>): React.JSX.Element {
  return (
    <div data-testid="council-peer-review-view" className="h-full overflow-y-auto p-5">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center py-4">
          <Loader2 size={24} className="animate-spin text-indigo-400 mx-auto mb-2" />
          <p className="text-sm text-text-primary font-medium">Peer review in progress</p>
          <p className="text-xs text-text-muted mt-1">
            Advisors are anonymously cross-examining each other&apos;s findings. This typically
            takes ~90 seconds.
          </p>
        </div>

        <AdvisorScoreGrid advisors={advisors} animate />

        {completedCount > 0 && <AdvisorKeyFindings advisors={advisors} />}
        {peerReviews.length > 0 && <CouncilRankingsMatrix peerReviews={peerReviews} />}
      </div>
    </div>
  )
}

// ── Phase 3: Synthesizing ──

export function CouncilSynthesizingView({
  verdict
}: Pick<CouncilState, 'verdict'>): React.JSX.Element {
  return (
    <div data-testid="council-synthesizing-view" className="h-full overflow-y-auto p-5">
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

// ── Phase 4: Complete ──

export function CouncilCompleteView({
  advisors,
  peerReviews,
  verdict,
  activeTab,
  setActiveTab
}: Pick<CouncilState, 'advisors' | 'peerReviews' | 'verdict' | 'activeTab' | 'setActiveTab'>): React.JSX.Element {
  const TAB_LABELS = { overview: 'Overview', advisors: 'Advisor Details', 'peer-reviews': 'Peer Reviews' } as const
  return (
    <div data-testid="council-complete-view" className="flex-1 h-full overflow-hidden flex flex-col">
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
            {TAB_LABELS[tab]}
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

// ── Terminal State (cancelled/failed) ──

export function CouncilTerminalView({
  phase,
  advisors,
  peerReviews,
  verdict,
  completedCount
}: Pick<CouncilState, 'advisors' | 'peerReviews' | 'verdict' | 'completedCount'> & { phase: string }): React.JSX.Element {
  return (
    <div data-testid="council-terminal-view" className="h-full overflow-y-auto p-5">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center py-4">
          <p className="text-sm text-text-secondary">
            {phase === 'cancelled'
              ? 'This council session was cancelled.'
              : 'This council session encountered an error.'}
          </p>
        </div>
        {completedCount > 0 && <AdvisorScoreGrid advisors={advisors} />}
        {peerReviews.length > 0 && <CouncilRankingsMatrix peerReviews={peerReviews} />}
        {verdict && <CouncilVerdictCard verdict={verdict} />}
      </div>
    </div>
  )
}

// ── Shared sub-components ──

function AdvisorScoreGrid({
  advisors,
  animate
}: {
  advisors: CouncilState['advisors']
  animate?: boolean
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-5 gap-2">
      {COUNCIL_ADVISOR_ROLES.map((role) => {
        const advisor = advisors[role]
        const a = COUNCIL_ADVISORS[role]
        return (
          <div
            key={role}
            className={`flex flex-col items-center gap-1 p-3 rounded-lg bg-surface-overlay border border-border-subtle${
              animate ? ' animate-pulse-subtle' : ''
            }`}
          >
            <AdvisorIcon advisor={a} size={28} className="text-text-secondary" />
            <span className="text-xs font-medium text-text-primary">{a.name}</span>
            {advisor.review ? (
              <span className="text-lg font-bold text-text-primary">{advisor.review.score}</span>
            ) : (
              <span className="text-lg font-bold text-text-muted">&mdash;</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function AdvisorKeyFindings({
  advisors
}: {
  advisors: CouncilState['advisors']
}): React.JSX.Element {
  return (
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
                <span className="text-xs font-semibold text-text-primary">{def.name}</span>
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
  )
}
