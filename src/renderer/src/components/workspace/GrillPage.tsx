import {
  MessageSquare,
  ClipboardList,
  FileText,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  CheckSquare
} from 'lucide-react'
import { useState, useCallback } from 'react'
import type { LLMProvider, GrillStructuredPlan } from '../../../../shared/types'
import GrillChatView from './GrillChatView'
import GrillDecisionsView from './GrillDecisionsView'
import { GrillTrackSelector } from './GrillTrackSelector'
import GrillSidebar from './GrillSidebar'
import {
  useGrillSession,
  GrillPageHeader,
  GrillPageFooter,
  RequirementDocumentPanel
} from './grill'
import { useWorkspaceStore } from '@renderer/store/workspace.store'
import { useCouncilStore } from '@renderer/store/council.store'

// ── Goal-type badge labels ────────────────────────────────────────────────

const GOAL_TYPE_LABELS: Record<GrillStructuredPlan['goalType'], string> = {
  feature: '✨ Feature',
  refactor: '♻️ Refactor',
  bugfix: '🐛 Bug Fix',
  tests: '🧪 Tests'
}

// ── Plan decisions, grouped by track (collapsible) ────────────────────────

function PlanDecisionGroups({
  decisions
}: {
  decisions: GrillStructuredPlan['decisions']
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
        <ClipboardList size={14} className="text-accent" />
        Decisions ({decisions.reduce((n, t) => n + t.items.length, 0)})
      </h3>
      {decisions.map((track) => {
        const isCollapsed = collapsed.has(track.trackId)
        return (
          <div
            key={track.trackId}
            className="rounded-lg border border-border-subtle bg-surface-overlay overflow-hidden"
          >
            <button
              onClick={() => toggle(track.trackId)}
              className="w-full px-4 py-2.5 flex items-center gap-2 bg-surface-base/40 hover:bg-surface-base/60 transition-colors text-left"
            >
              {isCollapsed ? (
                <ChevronRight size={14} className="text-text-muted flex-shrink-0" />
              ) : (
                <ChevronDown size={14} className="text-text-muted flex-shrink-0" />
              )}
              <span className="text-xs font-semibold text-accent">{track.trackName}</span>
              {track.score != null && (
                <>
                  <span className="text-text-muted">·</span>
                  <span className="text-xs font-medium text-text-secondary">{track.score}/100</span>
                </>
              )}
              <span className="text-xs text-text-muted ml-auto">
                {track.items.length} decision{track.items.length !== 1 ? 's' : ''}
              </span>
            </button>
            {!isCollapsed && (
              <div className="divide-y divide-border-subtle">
                {track.items.map((item, idx) => (
                  <div key={idx} className="px-4 py-3">
                    <div className="text-xs font-medium text-text-secondary mb-1">
                      Q: {item.question}
                    </div>
                    <div className="text-sm text-text-body mb-1">A: {item.answer}</div>
                    {item.rationale && (
                      <p className="text-xs text-text-muted leading-relaxed italic">
                        {item.rationale}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const getTabClass = (isActive: boolean): string =>
  isActive
    ? 'border-accent text-accent'
    : 'border-transparent text-text-muted hover:text-text-secondary'

function isValidPlan(plan: unknown): plan is GrillStructuredPlan {
  return (
    plan != null &&
    typeof plan === 'object' &&
    'items' in plan &&
    Array.isArray((plan as Record<string, unknown>).items)
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function GrillCompletedPlanView({ plan }: { plan: GrillStructuredPlan }): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Plan header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-success/15 rounded-lg flex items-center justify-center">
            <CheckCircle size={20} className="text-success" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-text-primary">{plan.title}</h2>
              {plan.goalType && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-accent/15 text-accent">
                  {GOAL_TYPE_LABELS[plan.goalType] ?? plan.goalType}
                </span>
              )}
            </div>
            <p className="text-sm text-text-secondary">{plan.summary}</p>
          </div>
        </div>

        {/* Implementation items */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <FileText size={14} />
            Implementation Items ({plan.items.length})
          </h3>
          {plan.items.map((item, i) => (
            <div
              key={item.id || i}
              className="p-3 rounded-lg border border-border-subtle bg-surface-overlay"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-accent/15 text-accent">
                  {item.scope}
                </span>
                <span className="text-sm font-medium text-text-primary">{item.title}</span>
              </div>
              <p className="text-xs text-text-secondary">{item.description}</p>
              {item.files.length > 0 && (
                <p className="text-xs text-text-muted mt-1">Files: {item.files.join(', ')}</p>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                {item.includesTests && (
                  <span className="inline-flex items-center gap-1 text-xs text-success">
                    <CheckSquare size={11} />
                    Includes tests
                  </span>
                )}
                {item.dependsOn.length > 0 && (
                  <span className="text-xs text-text-muted">
                    Depends on: {item.dependsOn.join(', ')}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Decisions by track */}
        {plan.decisions.length > 0 && <PlanDecisionGroups decisions={plan.decisions} />}

        {/* Requirement Document */}
        {plan.requirementDocument && <RequirementDocumentPanel text={plan.requirementDocument} />}

        {/* Risks */}
        {plan.risks.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-text-primary">⚠️ Risks</h3>
            <ul className="list-disc list-inside space-y-1">
              {plan.risks.map((risk, i) => (
                <li key={i} className="text-xs text-text-secondary">
                  {risk}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Constraints */}
        {plan.constraints.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-text-primary">🔒 Constraints</h3>
            <ul className="list-disc list-inside space-y-1">
              {plan.constraints.map((c, i) => (
                <li key={i} className="text-xs text-text-secondary">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Page component ──────────────────────────────────────────────────────────

interface GrillPageProps {
  ideaId: string
  conversationId: string
  ideaTitle: string
  ideaDescription?: string
  isNewSession?: boolean
  reviewMode?: boolean
  onBack: () => void
  onComplete: () => void
  onNavigateToCouncil?: () => void
}

export default function GrillPage({
  ideaId,
  conversationId,
  ideaTitle,
  ideaDescription,
  isNewSession,
  reviewMode,
  onBack,
  onComplete,
  onNavigateToCouncil
}: GrillPageProps): React.JSX.Element {
  const [structuredPlan, setStructuredPlan] = useState<GrillStructuredPlan | null>(null)

  const session = useGrillSession({
    ideaId,
    conversationId,
    ideaTitle,
    ideaDescription,
    isNewSession,
    onBack,
    onComplete,
    onRestorePlan: setStructuredPlan
  })

  const [planError, setPlanError] = useState<string | null>(null)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  // Generate structured plan from grill session
  const handleGeneratePlan = useCallback(async (): Promise<GrillStructuredPlan | null> => {
    if (!activeWorkspace) return null
    session.setPhase('completing')
    setPlanError(null)

    try {
      const plan = await window.api.grillGeneratePlan({
        sessionId: conversationId,
        ideaId,
        workspaceId: activeWorkspace.id
      })
      if (isValidPlan(plan)) {
        setStructuredPlan(plan)
        session.setPhase('completed')
        return plan
      }
      throw new Error('Invalid plan structure returned from API')
    } catch (err) {
      console.error('Plan generation failed:', err)
      setPlanError(err instanceof Error ? err.message : 'Plan generation failed')
      session.setPhase('selecting') // Revert on error
      return null
    }
  }, [activeWorkspace, conversationId, ideaId, session])

  // Discard the entire grill — delete the session row + snapshot, then leave.
  const handleDiscard = useCallback(async () => {
    try {
      await window.api.grillDiscard({ ideaId })
    } catch (err) {
      console.error('grillDiscard failed:', err)
    }
    onBack()
  }, [ideaId, onBack])

  // Back to grill from completed phase
  const handleBackToGrill = useCallback(() => {
    setStructuredPlan(null)
    session.setPhase('selecting')
  }, [session])

  const handleCouncilSweep = useCallback(async () => {
    if (!activeWorkspace || !structuredPlan) return

    // Mark grill as complete BEFORE navigating away
    try {
      await window.api.grillComplete({ ideaId })
    } catch (err) {
      console.error('grillComplete failed:', err)
    }

    const councilStore = useCouncilStore.getState()
    councilStore.startCouncil()
    const { sessionId } = await window.api.councilStart({
      workspaceId: activeWorkspace.id,
      inputType: 'plan',
      planContent: structuredPlan.requirementDocument,
      structuredPlan,
      originalUserRequest: ideaTitle,
      grillSessionId: conversationId
    })
    councilStore.setSessionIdentity(sessionId, activeWorkspace.id)
    onNavigateToCouncil?.()
  }, [activeWorkspace, structuredPlan, ideaTitle, conversationId, ideaId, onNavigateToCouncil])

  return (
    <div
      data-testid="grill-page"
      className="flex-1 flex flex-col bg-surface-raised min-w-0 overflow-hidden"
    >
      <GrillPageHeader
        ideaTitle={ideaTitle}
        selectedTrack={session.selectedTrack}
        phase={session.phase}
        onBack={onBack}
        onStopGrill={session.handleStopGrill}
        onBackToTracks={session.handleBackToTracks}
        onDiscard={handleDiscard}
      />

      {/* Tab toggle — Chat / Decisions (only visible when not in track-selection phase) */}
      {session.phase !== 'selecting' && (
        <div className="flex-shrink-0 border-b border-border-subtle bg-surface-raised px-6">
          <div className="flex items-center gap-1">
            <button
              onClick={() => session.setActiveTab('chat')}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${getTabClass(session.activeTab === 'chat')}`}
            >
              <MessageSquare size={14} />
              Chat
            </button>
            <button
              onClick={() => session.setActiveTab('decisions')}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${getTabClass(session.activeTab === 'decisions')}`}
            >
              <ClipboardList size={14} />
              Decisions
              {session.decisions.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-accent/15 text-accent font-semibold">
                  {session.decisions.length}
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Content — track selector, chat + sidebar, decisions, or plan view */}
      {session.phase === 'completing' ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="animate-spin h-8 w-8 border-2 border-accent border-t-transparent rounded-full mx-auto" />
            <p className="text-text-secondary text-sm">
              Generating structured implementation plan…
            </p>
            <p className="text-text-muted text-xs">This may take a minute</p>
          </div>
        </div>
      ) : session.phase === 'completed' && structuredPlan ? (
        <GrillCompletedPlanView plan={structuredPlan} />
      ) : session.phase === 'selecting' ? (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {/* LLM Provider toggle */}
            <div className="flex items-center gap-3 px-1">
              <span className="text-xs font-medium text-text-secondary">Provider:</span>
              <div className="flex rounded-lg border border-border-subtle overflow-hidden">
                {(['claude', 'local-llm'] as LLMProvider[]).map((prov) => (
                  <button
                    key={prov}
                    className={`px-3 py-1 text-xs font-medium transition-colors ${
                      session.grillProvider === prov
                        ? 'bg-accent text-white'
                        : 'bg-surface-overlay text-text-secondary hover:text-text-primary'
                    }`}
                    onClick={() => session.setGrillProvider(prov)}
                  >
                    {prov === 'claude' ? '☁️ Cloud' : '🖥️ Local'}
                  </button>
                ))}
              </div>
            </div>
            <GrillTrackSelector
              trackScores={session.trackScores}
              suggestedNextTrack={session.suggestedNextTrack}
              onSelectTrack={session.startTrackGrill}
            />
          </div>
        </div>
      ) : session.activeTab === 'decisions' ? (
        <GrillDecisionsView
          ideaDescription={session.description}
          ideaTitle={ideaTitle}
          decisions={session.decisions}
          requirementDocument={session.requirementDocument}
          onCondense={session.handleCondense}
          condensedDocument={session.condensedDocument}
          isCondensing={session.isCondensing}
        />
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <GrillChatView
            messages={session.chatMessages}
            phase={session.phase}
            description={session.description}
            ideaTitle={ideaTitle}
            currentQuestions={session.currentIteration?.questions ?? null}
            questionStates={session.questionStates}
            onQuestionChange={(id, state) =>
              session.setQuestionStates((prev) => ({ ...prev, [id]: state }))
            }
            round={session.iterationCount + 1}
          />
          <GrillSidebar
            selectedTrack={session.selectedTrack}
            currentScore={session.currentIteration?.score ?? null}
            currentScoreLabel={session.currentIteration?.scoreLabel ?? null}
            iterationCount={session.iterationCount}
            trackScores={session.trackScores}
            answeredCount={session.answeredCount}
            totalQuestions={session.totalQuestions}
            suggestedNextTrack={session.suggestedNextTrack}
          />
        </div>
      )}

      {planError && (
        <div className="flex-shrink-0 px-6 py-2 bg-red-500/10 border-t border-red-500/20">
          <p className="text-xs text-red-400 text-center">❌ {planError}</p>
        </div>
      )}

      <GrillPageFooter
        phase={session.phase}
        canSubmit={session.canSubmit}
        isAtCharLimit={session.isAtCharLimit}
        shouldSuggestCompletion={session.shouldSuggestCompletion}
        questionsRepeated={session.questionsRepeated}
        trackScoresCount={session.trackScores.length}
        onSaveAndExit={session.handleSaveAndExit}
        onConvertDirectly={session.handleConvertDirectly}
        onBackToTracks={session.handleBackToTracks}
        onSubmit={session.handleSubmit}
        onGeneratePlan={handleGeneratePlan}
        onBackToGrill={reviewMode ? undefined : handleBackToGrill}
        onCouncilSweep={structuredPlan ? handleCouncilSweep : undefined}
      />
    </div>
  )
}
