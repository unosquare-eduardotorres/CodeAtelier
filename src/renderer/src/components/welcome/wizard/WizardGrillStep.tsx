/**
 * WizardGrillStep — Step 2 of the Create New Project wizard.
 *
 * Runs a greenfield grill session to help the user make concrete
 * decisions about their project before creating it. Reuses the
 * existing grill IPC channels with the `greenfield: true` flag.
 *
 * Same 6 tracks, same scoring, same question UX — but no codebase
 * analysis (GreenfieldGrillRoleAdapter has no MCP tools).
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { ArrowRight, Pause, CheckCircle2, Loader2 } from 'lucide-react'
import {
  useGrillStreamStore,
  getFlatContent,
  getFlatToolActivities
} from '@renderer/store/grill-stream.store'
import { stripGrillEvaluationBlocks } from '@renderer/utils/strip-grill-json'
import type { QuestionState } from '@renderer/components/chat'
import GrillChatView from '../../workspace/GrillChatView'
import type { GrillChatMessage, GrillPhase } from '../../workspace/GrillChatView'
import { GrillTrackSelector } from '../../workspace/GrillTrackSelector'
import type {
  GrillQuestion,
  GrillTrackId,
  GrillTrackScore,
  GrillDecision
} from '../../../../../shared/types'
import { GRILL_TRACKS } from '../../../../../shared/constants'

interface WizardGrillStepProps {
  projectName: string
  projectDescription: string
  grillDecisions: GrillDecision[]
  trackScores: GrillTrackScore[]
  onDecisionsChange: (decisions: GrillDecision[]) => void
  onTrackScoresChange: (scores: GrillTrackScore[]) => void
  onPauseAndCreate: () => void
  onReady: () => void
}

interface GrillIteration {
  score: number
  scoreLabel: string
  questions: GrillQuestion[]
  feedback: string
  trackId?: GrillTrackId
  suggestedNextTrack?: { trackId: GrillTrackId; reason: string }
}

interface HistoryEntry {
  iteration: number
  score: number
  feedback: string
  answersFormatted: string
  trackId?: GrillTrackId
}

/** Well Done threshold — ready banner appears at this score */
const READY_THRESHOLD = 61

export default function WizardGrillStep({
  projectName,
  projectDescription,
  grillDecisions,
  trackScores,
  onDecisionsChange,
  onTrackScoresChange,
  onPauseAndCreate,
  onReady
}: WizardGrillStepProps): React.JSX.Element {
  const [phase, setPhase] = useState<GrillPhase>('selecting')
  const [currentIteration, setCurrentIteration] = useState<GrillIteration | null>(null)
  const [iterationCount, setIterationCount] = useState(0)
  const [_history, setHistory] = useState<HistoryEntry[]>([])
  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>({})
  const [chatMessages, setChatMessages] = useState<GrillChatMessage[]>([])
  const [selectedTrack, setSelectedTrack] = useState<GrillTrackId | null>(null)
  const [suggestedNextTrack, setSuggestedNextTrack] = useState<{
    trackId: GrillTrackId
    reason: string
  } | null>(null)

  const previousQuestionsRef = useRef<string[]>([])
  const [_questionsRepeated, setQuestionsRepeated] = useState(false)

  // Computed readiness
  const overallScore = useMemo(() => {
    if (trackScores.length === 0) return 0
    const sum = trackScores.reduce((a, b) => a + b.score, 0)
    return Math.round(sum / trackScores.length)
  }, [trackScores])

  const isReady = overallScore >= READY_THRESHOLD

  const areQuestionsRepeated = (newQuestions: GrillQuestion[]): boolean => {
    const newTexts = newQuestions.map((q) => q.question).sort()
    const prevTexts = [...previousQuestionsRef.current].sort()
    if (newTexts.length !== prevTexts.length) return false
    return newTexts.every((text, i) => text === prevTexts[i])
  }

  /** Start a grill evaluation for a specific track */
  const startTrackGrill = useCallback(
    async (trackId: GrillTrackId) => {
      setSelectedTrack(trackId)
      setPhase('evaluating')
      setSuggestedNextTrack(null)

      // Reset grill stream store for fresh evaluation
      useGrillStreamStore.getState().reset()

      setChatMessages((prev) => [
        ...prev,
        { type: 'system', content: `Starting ${GRILL_TRACKS[trackId].name} track…` }
      ])

      // Build iteration history from previous decisions
      const existingTrackScore = trackScores.find((ts) => ts.trackId === trackId)
      const iterationHistory =
        grillDecisions.length > 0
          ? grillDecisions
              .map(
                (d) =>
                  `- **${d.questionText}**: ${d.selectedOption}${d.otherText ? ` (${d.otherText})` : ''}`
              )
              .join('\n')
          : undefined

      try {
        await window.api.grillEvaluate({
          workspaceId: 'greenfield', // placeholder — greenfield flag skips workspace lookup
          trackId,
          ideaTitle: projectName,
          ideaDescription: projectDescription,
          previousScore: existingTrackScore?.score,
          greenfield: true,
          projectName,
          iterationHistory
        })
      } catch (error) {
        console.error('Failed to start greenfield grill evaluation:', error)
        setChatMessages((prev) => [
          ...prev,
          {
            type: 'system',
            content: `❌ Failed to start evaluation: ${error instanceof Error ? error.message : String(error)}`
          }
        ])
        setPhase('paused')
      }
    },
    [projectName, projectDescription, trackScores, grillDecisions]
  )

  // ── Grill stream event listeners ──
  useEffect(() => {
    const grillStore = useGrillStreamStore.getState()

    const unsubChunk = window.api.onGrillStreamChunk((data) => {
      grillStore.handleStreamChunk(data)
    })

    const unsubEval = window.api.onGrillEvaluationResult((data) => {
      grillStore.flush()
      const storeState = useGrillStreamStore.getState()
      const content = getFlatContent(storeState)
      const toolActivities = getFlatToolActivities(storeState)
      const cleanContent = stripGrillEvaluationBlocks(content)

      const newMessages: GrillChatMessage[] = []
      if (cleanContent || toolActivities.length > 0) {
        newMessages.push({ type: 'agent', content: cleanContent, toolActivities })
      }

      const trackName =
        (data.trackId ?? selectedTrack)
          ? GRILL_TRACKS[(data.trackId ?? selectedTrack) as GrillTrackId]?.name
          : undefined

      newMessages.push({
        type: 'evaluation',
        score: data.score,
        scoreLabel: data.scoreLabel,
        feedback: data.feedback,
        trackName
      })
      setChatMessages((prev) => [...prev, ...newMessages])
      grillStore.reset()

      const iteration: GrillIteration = {
        score: data.score,
        scoreLabel: data.scoreLabel,
        feedback: data.feedback,
        questions: data.questions,
        trackId: (data.trackId ?? selectedTrack) as GrillTrackId | undefined,
        suggestedNextTrack: data.suggestedNextTrack as
          | { trackId: GrillTrackId; reason: string }
          | undefined
      }

      setCurrentIteration(iteration)
      setPhase('answering')

      // Update track scores
      const trackId = (data.trackId ?? selectedTrack) as GrillTrackId | null
      if (trackId) {
        const newScores = trackScores.filter((ts) => ts.trackId !== trackId)
        const updatedScores = [
          ...newScores,
          {
            trackId,
            score: data.score,
            scoreLabel: data.scoreLabel,
            iterationCount:
              (trackScores.find((ts) => ts.trackId === trackId)?.iterationCount ?? 0) + 1,
            lastFeedback: data.feedback
          }
        ]
        onTrackScoresChange(updatedScores)
      }

      if (data.suggestedNextTrack) {
        setSuggestedNextTrack(data.suggestedNextTrack as { trackId: GrillTrackId; reason: string })
      }

      const repeated =
        previousQuestionsRef.current.length > 0 && areQuestionsRepeated(data.questions)
      setQuestionsRepeated(repeated)
      previousQuestionsRef.current = data.questions.map((q) => q.question)

      // Initialize question states with recommended options pre-selected
      const states: Record<string, QuestionState> = {}
      for (const q of data.questions) {
        const recommended = (q.options ?? []).filter((o) => o.recommended).map((o) => o.label)
        states[q.id] = {
          selectedOptions: recommended,
          otherText: '',
          otherSelected: false,
          skipped: false
        }
      }
      setQuestionStates(states)
    })

    const unsubComplete = window.api.onGrillStreamComplete(() => {
      grillStore.flush()
      const completeState = useGrillStreamStore.getState()
      const content = getFlatContent(completeState)
      const toolActivities = getFlatToolActivities(completeState)
      const cleanContent = stripGrillEvaluationBlocks(content)
      if (cleanContent || toolActivities.length > 0) {
        setChatMessages((prev) => [
          ...prev,
          { type: 'agent', content: cleanContent, toolActivities }
        ])
      }
      grillStore.reset()
    })

    return () => {
      unsubChunk()
      unsubEval()
      unsubComplete()
    }
  }, [selectedTrack, trackScores, onTrackScoresChange])

  /** Submit answers and re-evaluate */
  const handleSubmitAnswers = useCallback(() => {
    if (!currentIteration || !selectedTrack) return

    // Capture decisions from current answers
    const newDecisions: GrillDecision[] = []
    for (const q of currentIteration.questions) {
      const state = questionStates[q.id]
      if (!state || (state.skipped && state.selectedOptions.length === 0)) continue

      const selectedOption = state.selectedOptions.join(', ') || 'Skipped'
      newDecisions.push({
        trackId: selectedTrack,
        questionId: q.id,
        questionText: q.header || q.question.slice(0, 60),
        selectedOption,
        otherText: state.otherText || undefined
      })
    }

    // Merge with existing decisions (replace same track+question combos)
    const existingKeys = new Set(newDecisions.map((d) => `${d.trackId}:${d.questionId}`))
    const merged = [
      ...grillDecisions.filter((d) => !existingKeys.has(`${d.trackId}:${d.questionId}`)),
      ...newDecisions
    ]
    onDecisionsChange(merged)

    // Build user answer summary for chat
    const userSummary = currentIteration.questions
      .map((q) => {
        const state = questionStates[q.id]
        if (!state) return null
        const answer = state.skipped
          ? 'Skipped'
          : state.selectedOptions.join(', ') + (state.otherText ? ` — ${state.otherText}` : '')
        return `**${q.header || 'Q'}**: ${answer}`
      })
      .filter(Boolean)
      .join('\n')

    setChatMessages((prev) => [...prev, { type: 'user', content: userSummary }])

    // Record history
    setHistory((prev) => [
      ...prev,
      {
        iteration: iterationCount + 1,
        score: currentIteration.score,
        feedback: currentIteration.feedback,
        answersFormatted: userSummary,
        trackId: selectedTrack
      }
    ])
    setIterationCount((c) => c + 1)

    // Re-evaluate with updated decisions
    startTrackGrill(selectedTrack)
  }, [
    currentIteration,
    selectedTrack,
    questionStates,
    grillDecisions,
    onDecisionsChange,
    iterationCount,
    startTrackGrill
  ])

  return (
    <div className="flex flex-1 min-h-0">
      {/* Sidebar — track selector + scores */}
      <div className="w-64 border-r border-border-subtle flex flex-col overflow-y-auto bg-surface-base/50">
        <div className="p-4 border-b border-border-subtle">
          <h3 className="text-sm font-semibold text-text-primary">Tracks</h3>
          <p className="text-xs text-text-muted mt-0.5">Evaluate each area of your project</p>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          <GrillTrackSelector
            trackScores={trackScores}
            suggestedNextTrack={suggestedNextTrack}
            onSelectTrack={(trackId) => {
              if (phase === 'evaluating') return
              startTrackGrill(trackId)
            }}
          />
        </div>

        {/* Overall score */}
        {trackScores.length > 0 && (
          <div className="p-4 border-t border-border-subtle">
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">Overall Score</span>
              <span className={`font-semibold ${isReady ? 'text-success' : 'text-text-primary'}`}>
                {overallScore}/100
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Ready banner */}
        {isReady && (
          <div className="flex items-center gap-2 px-4 py-2.5 bg-success-muted border-b border-success/30">
            <CheckCircle2 size={16} className="text-success flex-shrink-0" />
            <span className="text-sm font-medium text-success">Your project is well-defined!</span>
            <span className="text-xs text-text-secondary">
              You can continue grilling or proceed to create.
            </span>
          </div>
        )}

        {/* Chat view */}
        <div className="flex-1 min-h-0">
          <GrillChatView
            messages={chatMessages}
            phase={phase}
            description={projectDescription}
            ideaTitle={projectName}
            currentQuestions={phase === 'answering' ? (currentIteration?.questions ?? null) : null}
            questionStates={questionStates}
            onQuestionChange={(id, state) =>
              setQuestionStates((prev) => ({ ...prev, [id]: state }))
            }
          />
        </div>

        {/* Footer buttons */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle bg-surface-base">
          <button
            type="button"
            onClick={onPauseAndCreate}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                       text-text-secondary hover:text-text-primary hover:bg-surface-overlay
                       transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <Pause size={14} />
            Pause & Create
          </button>

          <div className="flex items-center gap-2">
            {phase === 'answering' && (
              <button
                type="button"
                onClick={handleSubmitAnswers}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium
                           bg-primary hover:bg-primary-hover text-white
                           transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 press-scale"
              >
                Continue Grilling
                <ArrowRight size={14} />
              </button>
            )}

            {phase === 'evaluating' && (
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <Loader2 size={14} className="animate-spin" />
                Evaluating…
              </div>
            )}

            {isReady && (
              <button
                type="button"
                onClick={onReady}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium
                           bg-success hover:bg-success/90 text-white
                           transition-colors focus:outline-none focus:ring-2 focus:ring-success/50 press-scale"
              >
                <CheckCircle2 size={14} />
                It&apos;s Ready
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
