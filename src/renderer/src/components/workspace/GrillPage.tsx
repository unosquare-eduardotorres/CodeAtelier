import { MessageSquare, ClipboardList } from 'lucide-react'
import type { LLMProvider } from '../../../../shared/types'
import GrillChatView from './GrillChatView'
import GrillDecisionsView from './GrillDecisionsView'
import { GrillTrackSelector } from './GrillTrackSelector'
import GrillSidebar from './GrillSidebar'
import { useGrillSession, GrillPageHeader, GrillPageFooter } from './grill'
import { useMpaStore } from '@renderer/store/mpa.store'
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
}

export default function GrillPage({
  ideaId,
  conversationId,
  ideaTitle,
  ideaDescription,
  isNewSession,
  onBack,
  onComplete,
  onNavigateToGoals
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

      {/* Content — track selector, chat + sidebar, or decisions view */}
      {session.phase === 'selecting' ? (
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
      />
    </div>
  )
}
