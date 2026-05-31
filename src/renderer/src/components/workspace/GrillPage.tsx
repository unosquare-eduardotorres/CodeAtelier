import { MessageSquare, ClipboardList, FileText, CheckCircle } from 'lucide-react'
import { useState, useCallback } from 'react'
import type { LLMProvider, GrillStructuredPlan } from '../../../../shared/types'
import GrillChatView from './GrillChatView'
import GrillDecisionsView from './GrillDecisionsView'
import { GrillTrackSelector } from './GrillTrackSelector'
import GrillSidebar from './GrillSidebar'
import { useGrillSession, GrillPageHeader, GrillPageFooter } from './grill'
import { useMpaStore } from '@renderer/store/mpa.store'
import { useWorkspaceStore } from '@renderer/store/workspace.store'
import type { GrillDecision } from '../../../../shared/mpa-types'

interface GrillPageProps {
  ideaId: string
  conversationId: string
  ideaTitle: string
  ideaDescription?: string
  isNewSession?: boolean
  onBack: () => void
  onComplete: () => void
  onNavigateToGoals?: () => void
  onNavigateToCouncil?: () => void
}

export default function GrillPage({
  ideaId,
  conversationId,
  ideaTitle,
  ideaDescription,
  isNewSession,
  onBack,
  onComplete,
  onNavigateToGoals,
  onNavigateToCouncil
}: GrillPageProps): React.JSX.Element {
  const session = useGrillSession({
    ideaId,
    conversationId,
    ideaTitle,
    ideaDescription,
    isNewSession,
    onBack,
    onComplete
  })

  const [structuredPlan, setStructuredPlan] = useState<GrillStructuredPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  // Generate structured plan from grill session
  const handleGeneratePlan = useCallback(async () => {
    if (!activeWorkspace) return
    session.setPhase('completing')
    setPlanError(null)

    try {
      const plan = await window.api.grillGeneratePlan({
        sessionId: conversationId,
        workspaceId: activeWorkspace.id
      })
      setStructuredPlan(plan)
      session.setPhase('completed')
    } catch (err) {
      console.error('Plan generation failed:', err)
      setPlanError(err instanceof Error ? err.message : 'Plan generation failed')
      session.setPhase('selecting') // Revert on error
    }
  }, [activeWorkspace, conversationId, session])

  // Back to grill from completed phase
  const handleBackToGrill = useCallback(() => {
    setStructuredPlan(null)
    session.setPhase('selecting')
  }, [session])

  return (
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0 overflow-hidden">
      <GrillPageHeader
        ideaTitle={ideaTitle}
        selectedTrack={session.selectedTrack}
        phase={session.phase}
        onBack={onBack}
        onStopGrill={session.handleStopGrill}
        onBackToTracks={session.handleBackToTracks}
      />

      {/* Tab toggle — Chat / Decisions (only visible when not in track-selection phase) */}
      {session.phase !== 'selecting' && (
        <div className="flex-shrink-0 border-b border-border-subtle bg-surface-raised px-6">
          <div className="flex items-center gap-1">
            <button
              onClick={() => session.setActiveTab('chat')}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                session.activeTab === 'chat'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-muted hover:text-text-secondary'
              }`}
            >
              <MessageSquare size={14} />
              Chat
            </button>
            <button
              onClick={() => session.setActiveTab('decisions')}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                session.activeTab === 'decisions'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-muted hover:text-text-secondary'
              }`}
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
            <p className="text-text-secondary text-sm">Generating structured implementation plan…</p>
            <p className="text-text-muted text-xs">This may take a minute</p>
          </div>
        </div>
      ) : session.phase === 'completed' && structuredPlan ? (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {/* Plan header */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-success/15 rounded-lg flex items-center justify-center">
                <CheckCircle size={20} className="text-success" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text-primary">{structuredPlan.title}</h2>
                <p className="text-sm text-text-secondary">{structuredPlan.summary}</p>
              </div>
            </div>

            {/* Implementation items */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <FileText size={14} />
                Implementation Items ({structuredPlan.items.length})
              </h3>
              {structuredPlan.items.map((item, i) => (
                <div key={item.id || i} className="p-3 rounded-lg border border-border-subtle bg-surface-overlay">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-accent/15 text-accent">{item.scope}</span>
                    <span className="text-sm font-medium text-text-primary">{item.title}</span>
                  </div>
                  <p className="text-xs text-text-secondary">{item.description}</p>
                  {item.files.length > 0 && (
                    <p className="text-xs text-text-muted mt-1">Files: {item.files.join(', ')}</p>
                  )}
                </div>
              ))}
            </div>

            {/* Risks */}
            {structuredPlan.risks.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-text-primary">⚠️ Risks</h3>
                <ul className="list-disc list-inside space-y-1">
                  {structuredPlan.risks.map((risk, i) => (
                    <li key={i} className="text-xs text-text-secondary">{risk}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Constraints */}
            {structuredPlan.constraints.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-text-primary">🔒 Constraints</h3>
                <ul className="list-disc list-inside space-y-1">
                  {structuredPlan.constraints.map((c, i) => (
                    <li key={i} className="text-xs text-text-secondary">{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
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
        <div className="flex flex-1 min-h-0">
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
        onBackToGrill={handleBackToGrill}
        onStartGoal={() => {
          // Extract decisions for goal context
          const grillDecisions: GrillDecision[] = session.decisions.map((d) => ({
            header: d.question,
            selectedOption: d.answer,
            reason: d.questionFull ?? ''
          }))
          // Pre-load goal with grill context
          useMpaStore.getState().setPreloadedGoal({
            text: `${ideaTitle}${ideaDescription ? ': ' + ideaDescription : ''}`,
            grillSessionId: conversationId,
            grillDecisions
          })
          // Navigate to goals
          if (onNavigateToGoals) {
            onNavigateToGoals()
          }
        }}
        onCouncilSweep={structuredPlan ? async () => {
          if (!activeWorkspace) return
          // Send the structured plan to the council
          await window.api.councilStart({
            workspaceId: activeWorkspace.id,
            inputType: 'plan',
            planContent: structuredPlan.requirementDocument,
            structuredPlan,
            originalUserRequest: ideaTitle,
            grillSessionId: conversationId
          })
          onNavigateToCouncil?.()
        } : undefined}
      />
    </div>
  )
}
