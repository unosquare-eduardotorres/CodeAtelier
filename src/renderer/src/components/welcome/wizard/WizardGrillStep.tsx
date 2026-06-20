/**
 * WizardGrillStep — Step 3 of the Create New Project wizard.
 *
 * Runs a greenfield grill session that auto-advances through each
 * selected track, carrying forward decisions as context so questions
 * don't repeat. Reuses existing workspace grill components.
 *
 * Flow per track:
 *   auto-start → evaluating → answering → submit → score
 *   → auto-advance to next track (or finish)
 *
 * Users can skip any track mid-grill. Decisions accumulate across tracks.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  ArrowRight,
  Pause,
  CheckCircle2,
  Loader2,
  SkipForward,
  RefreshCw,
  Circle,
  Minus
} from 'lucide-react'
import {
  useGrillStreamStore,
  getFlatContent,
  getFlatToolActivities
} from '@renderer/store/grill-stream.store'
import { stripGrillEvaluationBlocks } from '@renderer/utils/strip-grill-json'
import type { QuestionState } from '@renderer/components/chat'
import GrillChatView from '../../workspace/GrillChatView'
import type { GrillChatMessage, GrillPhase } from '../../workspace/GrillChatView'
import GrillSidebar from '../../workspace/GrillSidebar'
import type {
  GrillQuestion,
  GrillTrackId,
  GrillTrackScore,
  GrillDecision
} from '../../../../../shared/types'
import { GRILL_TRACKS } from '../../../../../shared/constants'

// ── Types ─────────────────────────────────────────────────────────────────

interface WizardGrillStepProps {
  /** Real workspace id — created early (end of Focus step) so the grill is workspace-backed. */
  workspaceId: string
  projectName: string
  projectDescription: string
  selectedTracks: GrillTrackId[]
  grillDecisions: GrillDecision[]
  trackScores: GrillTrackScore[]
  onDecisionsChange: (decisions: GrillDecision[]) => void
  onTrackScoresChange: (scores: GrillTrackScore[]) => void
  onDone: () => void
  onBack: () => void
}

interface GrillIteration {
  score: number
  scoreLabel: string
  questions: GrillQuestion[]
  feedback: string
  trackId?: GrillTrackId
  suggestedNextTrack?: { trackId: GrillTrackId; reason: string }
}

type TrackStatus = 'pending' | 'active' | 'completed' | 'skipped'

// ── Shared helpers ────────────────────────────────────────────────────────

/** Capture current answers as GrillDecision[] and merge with existing. */
function captureAndMergeDecisions(
  currentIteration: GrillIteration,
  activeTrack: GrillTrackId,
  questionStates: Record<string, QuestionState>,
  existingDecisions: GrillDecision[]
): GrillDecision[] {
  const newDecisions: GrillDecision[] = []
  for (const q of currentIteration.questions) {
    const state = questionStates[q.id]
    if (!state || (state.skipped && state.selectedOptions.length === 0)) continue
    newDecisions.push({
      trackId: activeTrack,
      questionId: q.id,
      questionText: q.header || q.question.slice(0, 60),
      selectedOption: state.selectedOptions.join(', ') || 'Skipped',
      otherText: state.otherText || undefined
    })
  }
  const existingKeys = new Set(newDecisions.map((d) => `${d.trackId}:${d.questionId}`))
  return [
    ...existingDecisions.filter((d) => !existingKeys.has(`${d.trackId}:${d.questionId}`)),
    ...newDecisions
  ]
}

/** Build a user-facing summary string from current answers. */
function buildUserAnswerSummary(
  currentIteration: GrillIteration,
  questionStates: Record<string, QuestionState>
): string {
  return currentIteration.questions
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
}

// ── Evaluation result handler hook ────────────────────────────────────────

function useWizardGrillEvalHandler(opts: {
  activeTrack: GrillTrackId | null
  trackScores: GrillTrackScore[]
  onTrackScoresChange: (scores: GrillTrackScore[]) => void
  setChatMessages: React.Dispatch<React.SetStateAction<GrillChatMessage[]>>
  setCurrentIteration: React.Dispatch<React.SetStateAction<GrillIteration | null>>
  setPhase: React.Dispatch<React.SetStateAction<GrillPhase>>
  setSuggestedNextTrack: React.Dispatch<
    React.SetStateAction<{ trackId: GrillTrackId; reason: string } | null>
  >
  setIterationCount: React.Dispatch<React.SetStateAction<number>>
  setQuestionStates: React.Dispatch<React.SetStateAction<Record<string, QuestionState>>>
  previousQuestionsRef: React.MutableRefObject<string[]>
}): void {
  const {
    activeTrack,
    trackScores,
    onTrackScoresChange,
    setChatMessages,
    setCurrentIteration,
    setPhase,
    setSuggestedNextTrack,
    setIterationCount,
    setQuestionStates,
    previousQuestionsRef
  } = opts

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
        (data.trackId ?? activeTrack)
          ? GRILL_TRACKS[(data.trackId ?? activeTrack) as GrillTrackId]?.name
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
        trackId: (data.trackId ?? activeTrack) as GrillTrackId | undefined,
        suggestedNextTrack: data.suggestedNextTrack as
          | { trackId: GrillTrackId; reason: string }
          | undefined
      }

      setCurrentIteration(iteration)
      setPhase('answering')
      setIterationCount((c) => c + 1)

      // Update track scores
      const resolvedTrackId = (data.trackId ?? activeTrack) as GrillTrackId | null
      if (resolvedTrackId) {
        const newScores = trackScores.filter((ts) => ts.trackId !== resolvedTrackId)
        const updatedScores = [
          ...newScores,
          {
            trackId: resolvedTrackId,
            score: data.score,
            scoreLabel: data.scoreLabel,
            iterationCount:
              (trackScores.find((ts) => ts.trackId === resolvedTrackId)?.iterationCount ?? 0) + 1,
            lastFeedback: data.feedback
          }
        ]
        onTrackScoresChange(updatedScores)
      }

      if (data.suggestedNextTrack) {
        setSuggestedNextTrack(data.suggestedNextTrack as { trackId: GrillTrackId; reason: string })
      }

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
  }, [activeTrack, trackScores, onTrackScoresChange])
}

// ── Component ─────────────────────────────────────────────────────────────

export default function WizardGrillStep({
  workspaceId,
  projectName,
  projectDescription,
  selectedTracks,
  grillDecisions,
  trackScores,
  onDecisionsChange,
  onTrackScoresChange,
  onDone,
  onBack
}: WizardGrillStepProps): React.JSX.Element {
  const [phase, setPhase] = useState<GrillPhase>('selecting')
  const [currentIteration, setCurrentIteration] = useState<GrillIteration | null>(null)
  const [iterationCount, setIterationCount] = useState(0)
  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>({})
  const [chatMessages, setChatMessages] = useState<GrillChatMessage[]>([])
  const [activeTrack, setActiveTrack] = useState<GrillTrackId | null>(null)
  const [suggestedNextTrack, setSuggestedNextTrack] = useState<{
    trackId: GrillTrackId
    reason: string
  } | null>(null)
  const [completedTracks, setCompletedTracks] = useState<Set<GrillTrackId>>(new Set())
  const [skippedTracks, setSkippedTracks] = useState<Set<GrillTrackId>>(new Set())

  const previousQuestionsRef = useRef<string[]>([])
  const hasAutoStarted = useRef(false)

  // ── Track status helpers ──

  const getTrackStatus = useCallback(
    (trackId: GrillTrackId): TrackStatus => {
      if (skippedTracks.has(trackId)) return 'skipped'
      if (completedTracks.has(trackId)) return 'completed'
      if (trackId === activeTrack) return 'active'
      return 'pending'
    },
    [activeTrack, completedTracks, skippedTracks]
  )

  const getNextTrack = useCallback((): GrillTrackId | null => {
    for (const trackId of selectedTracks) {
      if (!completedTracks.has(trackId) && !skippedTracks.has(trackId) && trackId !== activeTrack) {
        return trackId
      }
    }
    return null
  }, [selectedTracks, completedTracks, skippedTracks, activeTrack])

  const allTracksDone = useMemo(() => {
    return selectedTracks.every((t) => completedTracks.has(t) || skippedTracks.has(t))
  }, [selectedTracks, completedTracks, skippedTracks])

  // Answered count for sidebar
  const answeredCount = useMemo(() => {
    return Object.values(questionStates).filter((s) => s.selectedOptions.length > 0 || s.skipped)
      .length
  }, [questionStates])

  const totalQuestions = currentIteration?.questions?.length ?? 0

  // ── Start track evaluation ──

  const startTrackGrill = useCallback(
    async (trackId: GrillTrackId) => {
      setActiveTrack(trackId)
      setPhase('evaluating')
      setSuggestedNextTrack(null)
      setCurrentIteration(null)

      useGrillStreamStore.getState().reset()

      setChatMessages((prev) => [
        ...prev,
        { type: 'system', content: `Starting ${GRILL_TRACKS[trackId].name} track…` }
      ])

      // Build iteration history from ALL previous decisions (context carry-over)
      const existingTrackScore = trackScores.find((ts) => ts.trackId === trackId)
      const iterationHistory =
        grillDecisions.length > 0
          ? grillDecisions
              .map(
                (d) =>
                  `- [${GRILL_TRACKS[d.trackId]?.name ?? d.trackId}] **${d.questionText}**: ${d.selectedOption}${d.otherText ? ` (${d.otherText})` : ''}`
              )
              .join('\n')
          : undefined

      try {
        await window.api.grillEvaluate({
          workspaceId,
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
    [workspaceId, projectName, projectDescription, trackScores, grillDecisions]
  )

  // ── Auto-start first track on mount ──
  useEffect(() => {
    if (!hasAutoStarted.current && selectedTracks.length > 0) {
      hasAutoStarted.current = true
      startTrackGrill(selectedTracks[0])
    }
  }, [selectedTracks, startTrackGrill])

  // ── Auto-advance to next track after completing one ──
  const advanceToNextTrack = useCallback(
    (justCompletedTrack: GrillTrackId) => {
      setCompletedTracks((prev) => new Set([...prev, justCompletedTrack]))

      // Find next pending track
      const remaining = selectedTracks.filter(
        (t) => t !== justCompletedTrack && !completedTracks.has(t) && !skippedTracks.has(t)
      )

      if (remaining.length > 0) {
        startTrackGrill(remaining[0])
      } else {
        // All tracks done → auto-transition to Create step
        onDone()
      }
    },
    [selectedTracks, completedTracks, skippedTracks, startTrackGrill, onDone]
  )

  // ── Skip current track ──
  const handleSkipTrack = useCallback(() => {
    if (!activeTrack) return
    setSkippedTracks((prev) => new Set([...prev, activeTrack]))

    setChatMessages((prev) => [
      ...prev,
      { type: 'system', content: `Skipped ${GRILL_TRACKS[activeTrack].name} track` }
    ])

    // Find next non-completed, non-skipped track
    const remaining = selectedTracks.filter(
      (t) => t !== activeTrack && !completedTracks.has(t) && !skippedTracks.has(t)
    )

    if (remaining.length > 0) {
      startTrackGrill(remaining[0])
    } else {
      onDone()
    }
  }, [activeTrack, selectedTracks, completedTracks, skippedTracks, startTrackGrill, onDone])

  // ── Grill stream event listeners (extracted hook) ──
  useWizardGrillEvalHandler({
    activeTrack,
    trackScores,
    onTrackScoresChange,
    setChatMessages,
    setCurrentIteration,
    setPhase,
    setSuggestedNextTrack,
    setIterationCount,
    setQuestionStates,
    previousQuestionsRef
  })

  // ── Submit answers → capture decisions, advance to next track ──
  const handleSubmitAnswers = useCallback(() => {
    if (!currentIteration || !activeTrack) return

    const merged = captureAndMergeDecisions(
      currentIteration,
      activeTrack,
      questionStates,
      grillDecisions
    )
    onDecisionsChange(merged)

    const userSummary = buildUserAnswerSummary(currentIteration, questionStates)
    setChatMessages((prev) => [...prev, { type: 'user', content: userSummary }])

    advanceToNextTrack(activeTrack)
  }, [
    currentIteration,
    activeTrack,
    questionStates,
    grillDecisions,
    onDecisionsChange,
    advanceToNextTrack
  ])

  // ── Re-evaluate same track (new round, no advance) ──
  const handleReEvaluate = useCallback(() => {
    if (!currentIteration || !activeTrack) return

    const merged = captureAndMergeDecisions(
      currentIteration,
      activeTrack,
      questionStates,
      grillDecisions
    )
    onDecisionsChange(merged)

    const userSummary = buildUserAnswerSummary(currentIteration, questionStates)
    setChatMessages((prev) => [...prev, { type: 'user', content: userSummary }])

    // Build iteration history from ALL decisions so far
    const iterationHistory = merged
      .map(
        (d) =>
          `- [${GRILL_TRACKS[d.trackId]?.name ?? d.trackId}] **${d.questionText}**: ${d.selectedOption}${d.otherText ? ` (${d.otherText})` : ''}`
      )
      .join('\n')

    // Re-evaluate same track (non-advancing)
    setPhase('evaluating')
    useGrillStreamStore.getState().reset()

    const existingTrackScore = trackScores.find((ts) => ts.trackId === activeTrack)

    window.api
      .grillEvaluate({
        workspaceId,
        trackId: activeTrack,
        ideaTitle: projectName,
        ideaDescription: projectDescription,
        previousScore: existingTrackScore?.score,
        greenfield: true,
        projectName,
        iterationHistory
      })
      .catch((error) => {
        console.error('Re-evaluation failed:', error)
        setPhase('answering')
      })
  }, [
    workspaceId,
    currentIteration,
    activeTrack,
    questionStates,
    grillDecisions,
    onDecisionsChange,
    trackScores,
    projectName,
    projectDescription
  ])

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Track Progress Bar */}
      <TrackProgressBar
        selectedTracks={selectedTracks}
        getTrackStatus={getTrackStatus}
        trackScores={trackScores}
      />

      <div className="flex flex-1 min-h-0">
        {/* Main content — Chat view */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat view */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <GrillChatView
              messages={chatMessages}
              phase={phase}
              description={projectDescription}
              ideaTitle={projectName}
              currentQuestions={
                phase === 'answering' ? (currentIteration?.questions ?? null) : null
              }
              questionStates={questionStates}
              onQuestionChange={(id, state) =>
                setQuestionStates((prev) => ({ ...prev, [id]: state }))
              }
              round={iterationCount + 1}
            />
          </div>

          {/* Footer buttons */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle bg-surface-base flex-shrink-0">
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                         text-text-secondary hover:text-text-primary hover:bg-surface-overlay
                         transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <Pause size={14} />
              Pause & Create
            </button>

            <div className="flex items-center gap-2">
              {/* Skip Track */}
              {phase !== 'evaluating' && !allTracksDone && (
                <button
                  type="button"
                  onClick={handleSkipTrack}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                             text-text-secondary hover:text-text-primary hover:bg-surface-overlay
                             border border-border-subtle transition-colors
                             focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <SkipForward size={14} />
                  Skip Track
                </button>
              )}

              {/* Submit & Re-evaluate (same track, new round) */}
              {phase === 'answering' && (
                <button
                  type="button"
                  onClick={handleReEvaluate}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium
                             border border-primary text-primary hover:bg-primary/10
                             transition-colors press-scale"
                >
                  <RefreshCw size={14} />
                  Accept & Re-evaluate
                </button>
              )}

              {/* Submit & Next (advance to next track) */}
              {phase === 'answering' && (
                <button
                  type="button"
                  onClick={handleSubmitAnswers}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium
                             bg-primary hover:bg-primary-hover text-white
                             transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 press-scale"
                >
                  {getNextTrack()
                    ? `Accept & Next: ${GRILL_TRACKS[getNextTrack()!].name}`
                    : 'Accept & Finish'}
                  <ArrowRight size={14} />
                </button>
              )}

              {phase === 'evaluating' && (
                <div className="flex items-center gap-2 text-sm text-text-muted">
                  <Loader2 size={14} className="animate-spin" />
                  Evaluating…
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <GrillSidebar
          selectedTrack={activeTrack}
          currentScore={currentIteration?.score ?? null}
          currentScoreLabel={currentIteration?.scoreLabel ?? null}
          iterationCount={iterationCount}
          trackScores={trackScores}
          answeredCount={answeredCount}
          totalQuestions={totalQuestions}
          suggestedNextTrack={suggestedNextTrack}
        />
      </div>
    </div>
  )
}

// ── Track Progress Bar ────────────────────────────────────────────────────

function TrackProgressBar({
  selectedTracks,
  getTrackStatus,
  trackScores
}: {
  selectedTracks: GrillTrackId[]
  getTrackStatus: (trackId: GrillTrackId) => TrackStatus
  trackScores: GrillTrackScore[]
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 px-4 py-2.5 border-b border-border-subtle bg-surface-overlay/50">
      {selectedTracks.map((trackId, idx) => {
        const status = getTrackStatus(trackId)
        const track = GRILL_TRACKS[trackId]
        const score = trackScores.find((ts) => ts.trackId === trackId)?.score

        return (
          <div key={trackId} className="flex items-center gap-1">
            {idx > 0 && (
              <div
                className={`w-6 h-px mx-0.5 ${
                  status === 'completed' || status === 'skipped'
                    ? 'bg-text-muted/40'
                    : 'bg-border-subtle'
                }`}
              />
            )}

            <div className="flex items-center gap-1.5">
              {/* Status icon */}
              {status === 'completed' && (
                <CheckCircle2 size={14} className="text-success flex-shrink-0" />
              )}
              {status === 'skipped' && (
                <Minus size={14} className="text-text-muted flex-shrink-0" />
              )}
              {status === 'active' && (
                <div className="relative flex-shrink-0">
                  <Circle size={14} className="text-primary" />
                  <div className="absolute inset-0 rounded-full animate-ping bg-primary/20" />
                </div>
              )}
              {status === 'pending' && (
                <Circle size={14} className="text-text-muted/40 flex-shrink-0" />
              )}

              {/* Track name */}
              <span
                className={`text-xs font-medium whitespace-nowrap ${
                  status === 'active'
                    ? 'text-primary font-semibold'
                    : status === 'completed'
                      ? 'text-text-primary'
                      : status === 'skipped'
                        ? 'text-text-muted line-through'
                        : 'text-text-muted'
                }`}
              >
                {track.name}
              </span>

              {/* Score badge */}
              {status === 'completed' && score !== undefined && (
                <span className="text-[10px] font-semibold text-success">{score}</span>
              )}
              {status === 'skipped' && (
                <span className="text-[10px] text-text-muted italic">skipped</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
