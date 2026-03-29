import { useState, useCallback, useEffect, useRef } from 'react'
import {
  ArrowLeft,
  Flame,
  Play,
  Loader2,
  Edit3,
  Check,
  ClipboardCheck,
  Building2,
  Palette,
  Shield,
  TestTube,
  Cloud,
  Database,
  Code,
  Sparkles,
  LayoutGrid
} from 'lucide-react'
import { useChatActions, useWorkspaceStore } from '@renderer/store'
import { useIdeaStore } from '@renderer/store/idea.store'
import { QuestionItem } from '@renderer/components/chat'
import type { QuestionState } from '@renderer/components/chat'
import type { GrillQuestion, GrillTrackId, GrillTrackScore } from '../../../../shared/types'
import { GRILL_TRACKS } from '../../../../shared/constants'
import ScoreGauge from './ScoreGauge'
import GrillRadarChart from './GrillRadarChart'

interface GrillPageProps {
  ideaId: string
  conversationId: string
  ideaTitle: string
  ideaDescription?: string
  isNewSession?: boolean
  onBack: () => void
  onComplete: () => void
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
  answersFormatted: string
  trackId?: GrillTrackId
}

/** Soft cap for enriched description — suggest completion after this length */
const MAX_DESCRIPTION_CHARS = 15_000

/** Minimum iterations before suggesting completion */
const MIN_ITERATIONS = 5

type GrillPhase = 'selecting' | 'evaluating' | 'answering' | 'paused'

/** Map lucide icon names to components */
const TRACK_ICONS: Record<string, React.ElementType> = {
  ClipboardCheck,
  Building2,
  Palette,
  Shield,
  TestTube,
  Cloud,
  Database,
  Code
}

function getScoreColor(score: number): string {
  if (score <= 20) return '#dc2626'
  if (score <= 40) return '#ea580c'
  if (score <= 60) return '#d97706'
  if (score <= 80) return '#65a30d'
  return '#16a34a'
}

export default function GrillPage({
  ideaId,
  conversationId,
  ideaTitle,
  ideaDescription,
  isNewSession,
  onBack,
  onComplete
}: GrillPageProps): React.JSX.Element {
  const { selectConversation, loadConversations, sendMessage } = useChatActions()
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const { completeFromGrill, convertDirect } = useIdeaStore()

  const [phase, setPhase] = useState<GrillPhase>(isNewSession ? 'selecting' : 'evaluating')
  const [description, setDescription] = useState(ideaDescription || '')
  const [currentIteration, setCurrentIteration] = useState<GrillIteration | null>(null)
  const [iterationCount, setIterationCount] = useState(0)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>({})
  const [isEditingDescription, setIsEditingDescription] = useState(false)
  const [editedDescription, setEditedDescription] = useState('')
  const [questionsRepeated, setQuestionsRepeated] = useState(false)

  // Track-specific state
  const [selectedTrack, setSelectedTrack] = useState<GrillTrackId | null>(null)
  const [trackScores, setTrackScores] = useState<GrillTrackScore[]>([])
  const [suggestedNextTrack, setSuggestedNextTrack] = useState<{
    trackId: GrillTrackId
    reason: string
  } | null>(null)

  const mountedRef = useRef(false)
  const previousConversationIdRef = useRef<string | null>(null)
  const previousQuestionsRef = useRef<string[]>([])

  const areQuestionsRepeated = (newQuestions: GrillQuestion[]): boolean => {
    const newTexts = newQuestions.map((q) => q.question).sort()
    const prevTexts = [...previousQuestionsRef.current].sort()
    if (newTexts.length !== prevTexts.length) return false
    return newTexts.every((text, i) => text === prevTexts[i])
  }

  /** Build track-aware grill prompt */
  const buildGrillPrompt = useCallback(
    (trackId: GrillTrackId | null, isIteration: boolean, historyText?: string): string => {
      const trackLabel = trackId ? ` TRACK: ${trackId.toUpperCase()}` : ''
      const trackContext = trackId
        ? `\n\nFocus ONLY on ${GRILL_TRACKS[trackId].name} aspects.\nScoring criteria: ${GRILL_TRACKS[trackId].scoringFocus.join(', ')}.`
        : ''

      if (isIteration && historyText) {
        return `[GRILL ITERATION ${iterationCount + 1}${trackLabel}]\n\n## Re-evaluate This Requirement\n**${ideaTitle}**\n\n${description}\n\n### Decisions from Previous Iterations\n${historyText}${trackContext}\n\nRe-evaluate the updated requirement. Respond with a grill-evaluation JSON block with updated score and 5 new questions targeting remaining gaps.`
      }

      return `[GRILL MODE${trackLabel}]\n\n## Evaluate This Requirement\n**${ideaTitle}**\n\n${description || 'No description provided.'}${trackContext}\n\nAnalyze this requirement and respond with a single grill-evaluation JSON block containing a completeness score (1-100), brief feedback, and exactly 5 questions targeting the weakest areas.`
    },
    [ideaTitle, description, iterationCount]
  )

  /** Start a grill session for a specific track */
  const startTrackGrill = useCallback(
    async (trackId: GrillTrackId) => {
      setSelectedTrack(trackId)
      setPhase('evaluating')
      setSuggestedNextTrack(null)

      // Load conversation if needed
      if (activeWorkspace) {
        await loadConversations(activeWorkspace.id)
      }
      await selectConversation(conversationId)

      const prompt = buildGrillPrompt(trackId, false)
      await sendMessage(prompt)
    },
    [activeWorkspace, conversationId, loadConversations, selectConversation, sendMessage, buildGrillPrompt]
  )

  // Restore previous conversation on unmount
  useEffect(() => {
    previousConversationIdRef.current = null
    return () => {
      const prevId = previousConversationIdRef.current
      if (prevId) {
        selectConversation(prevId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On mount: load saved state or start fresh
  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true

    const init = async (): Promise<void> => {
      // Try to load saved grill decisions from the idea
      try {
        const ideas = useIdeaStore.getState().ideas
        const idea = ideas.find((i) => i.id === ideaId)
        if (idea?.grillDecisions) {
          const saved = JSON.parse(idea.grillDecisions)
          if (saved.iterationCount) setIterationCount(saved.iterationCount)
          // Note: Do NOT restore enrichedDescription into description state.
          // The description state holds only the base description; buildFullDescription
          // appends history entries on top. Restoring the enriched version would cause
          // duplication of "Decisions from Iteration N" headings.
          if (saved.history) setHistory(saved.history)
          if (saved.trackScores) setTrackScores(saved.trackScores)
          if (saved.activeTrack) setSelectedTrack(saved.activeTrack)
          if (saved.currentScore && !isNewSession) {
            // If there are track scores, go to selecting to let user pick next track
            if (saved.trackScores?.length > 0) {
              setPhase('selecting')
            } else {
              setPhase('paused')
            }
            return
          }
        }
      } catch {
        // Ignore parse errors, treat as new session
      }

      // For new sessions, show track selection
      if (isNewSession) {
        setPhase('selecting')
        return
      }

      // Load conversation and send initial prompt (legacy non-track flow)
      if (activeWorkspace) {
        await loadConversations(activeWorkspace.id)
      }
      await selectConversation(conversationId)

      setPhase('evaluating')
      // For resume, send a re-evaluation prompt
      const historyText = history
        .map((h) => `Iteration ${h.iteration} (score: ${h.score}): ${h.answersFormatted}`)
        .join('\n')
      const grillPrompt = buildGrillPrompt(selectedTrack, true, historyText)
      await sendMessage(grillPrompt)
    }
    init()
  }, [conversationId, activeWorkspace, loadConversations, selectConversation, sendMessage, isNewSession, ideaTitle, description, history, iterationCount, ideaId, buildGrillPrompt, selectedTrack])

  // Listen for grill evaluation events
  useEffect(() => {
    const cleanup = window.api.onGrillEvaluation((data) => {
      if (data.conversationId !== conversationId) return

      const iteration: GrillIteration = {
        score: data.score,
        scoreLabel: data.scoreLabel,
        feedback: data.feedback,
        questions: data.questions,
        trackId: data.trackId ?? selectedTrack ?? undefined,
        suggestedNextTrack: data.suggestedNextTrack ?? undefined
      }

      setCurrentIteration(iteration)
      setIterationCount((prev) => prev + 1)
      setPhase('answering')

      // Update track scores if this is a track-specific evaluation
      const trackId = data.trackId ?? selectedTrack
      if (trackId) {
        setTrackScores((prev) => {
          const existing = prev.filter((ts) => ts.trackId !== trackId)
          return [
            ...existing,
            {
              trackId,
              score: data.score,
              scoreLabel: data.scoreLabel,
              iterationCount: (prev.find((ts) => ts.trackId === trackId)?.iterationCount ?? 0) + 1,
              lastFeedback: data.feedback
            }
          ]
        })
      }

      // Store AI suggestion for next track
      if (data.suggestedNextTrack) {
        setSuggestedNextTrack(data.suggestedNextTrack)
      }

      // Detect if questions are the same as previous iteration
      const repeated =
        previousQuestionsRef.current.length > 0 && areQuestionsRepeated(data.questions)
      setQuestionsRepeated(repeated)
      previousQuestionsRef.current = data.questions.map((q) => q.question)

      // Initialize question states with recommended options pre-selected
      const states: Record<string, QuestionState> = {}
      for (const q of data.questions) {
        const recommended = q.options.filter((o) => o.recommended).map((o) => o.label)
        states[q.id] = { selectedOptions: recommended, otherText: '', otherSelected: false, skipped: false }
      }
      setQuestionStates(states)
    })

    return cleanup
  }, [conversationId, selectedTrack])

  // Also listen for legacy grill-question events as fallback
  useEffect(() => {
    const cleanup = window.api.onGrillQuestion((data) => {
      if (data.conversationId !== conversationId) return
      // Only process if we haven't received a grill-evaluation already
      if (currentIteration && phase === 'answering') return

      const iteration: GrillIteration = {
        score: 0,
        scoreLabel: '',
        feedback: 'Evaluation in progress...',
        questions: data.questions
      }

      setCurrentIteration(iteration)
      setIterationCount((prev) => prev + 1)
      setPhase('answering')

      // Detect if questions are the same as previous iteration
      const repeated =
        previousQuestionsRef.current.length > 0 && areQuestionsRepeated(data.questions)
      setQuestionsRepeated(repeated)
      previousQuestionsRef.current = data.questions.map((q) => q.question)

      const states: Record<string, QuestionState> = {}
      for (const q of data.questions) {
        const recommended = q.options.filter((o) => o.recommended).map((o) => o.label)
        states[q.id] = { selectedOptions: recommended, otherText: '', otherSelected: false, skipped: false }
      }
      setQuestionStates(states)
    })

    return cleanup
  }, [conversationId, currentIteration, phase])

  const formatAnswers = useCallback((): string => {
    if (!currentIteration) return ''
    const parts: string[] = []
    for (const q of currentIteration.questions) {
      const state = questionStates[q.id]
      if (!state || state.skipped) {
        parts.push(`- **${q.header || q.question}**: _Skipped_`)
        continue
      }
      const selected = state.selectedOptions.join(', ')
      const other = state.otherText ? ` (Custom: ${state.otherText})` : ''
      parts.push(`- **${q.header || q.question}**: ${selected}${other}`)
    }
    return parts.join('\n')
  }, [currentIteration, questionStates])

  /** Build the full enriched description from the base description + all history entries */
  const buildFullDescription = useCallback(
    (historyEntries: HistoryEntry[]): string => {
      if (historyEntries.length === 0) return description
      return [
        description,
        ...historyEntries.map((h) => {
          const trackLabel = h.trackId ? ` [${GRILL_TRACKS[h.trackId]?.name ?? h.trackId}]` : ''
          return `### Decisions from Iteration ${h.iteration}${trackLabel}\n${h.answersFormatted}`
        })
      ].join('\n\n')
    },
    [description]
  )

  /** Save decisions to DB (includes track scores) */
  const saveDecisions = useCallback(
    async (
      score: number,
      historyEntries: HistoryEntry[],
      currentTrackScores: GrillTrackScore[]
    ) => {
      const fullDescription = buildFullDescription(historyEntries)
      const decisions = JSON.stringify({
        iterationCount,
        currentScore: score,
        enrichedDescription: fullDescription,
        history: historyEntries,
        trackScores: currentTrackScores,
        activeTrack: selectedTrack
      })
      try {
        await window.api.saveIdeaGrillDecisions({ ideaId, decisions })
      } catch (error) {
        console.error('Failed to save grill decisions:', error)
      }
    },
    [iterationCount, buildFullDescription, selectedTrack, ideaId]
  )

  const handleSubmit = useCallback(async () => {
    if (!currentIteration) return
    if (description.length >= MAX_DESCRIPTION_CHARS) return

    const answersText = formatAnswers()

    const newHistory: HistoryEntry = {
      iteration: iterationCount,
      score: currentIteration.score,
      answersFormatted: answersText,
      trackId: selectedTrack ?? undefined
    }
    const updatedHistory = [...history, newHistory]
    setHistory(updatedHistory)
    setPhase('evaluating')
    setQuestionsRepeated(false)

    // Auto-save decisions to DB on every iteration
    await saveDecisions(currentIteration.score, updatedHistory, trackScores)

    // Send re-evaluation prompt — use base description + history as separate sections
    const historyText = updatedHistory
      .map((h) => {
        const trackLabel = h.trackId ? ` [${GRILL_TRACKS[h.trackId]?.name ?? h.trackId}]` : ''
        return `Iteration ${h.iteration}${trackLabel} (score: ${h.score}): ${h.answersFormatted}`
      })
      .join('\n')

    const grillPrompt = buildGrillPrompt(selectedTrack, true, historyText)
    await sendMessage(grillPrompt)
  }, [currentIteration, formatAnswers, description, iterationCount, history, sendMessage, buildGrillPrompt, selectedTrack, saveDecisions, trackScores])

  /** Return to track selection after completing a track iteration */
  const handleBackToTracks = useCallback(async () => {
    // Save current state
    await saveDecisions(currentIteration?.score ?? 0, history, trackScores)
    setPhase('selecting')
  }, [currentIteration, history, trackScores, saveDecisions])

  const handleSaveAndExit = useCallback(async () => {
    await saveDecisions(currentIteration?.score ?? 0, history, trackScores)
    setPhase('paused')
    onBack()
  }, [currentIteration, history, trackScores, saveDecisions, onBack])

  const handleConvertDirectly = useCallback(async () => {
    // Build the full enriched description from base + all decisions
    const fullDescription = buildFullDescription(history)

    // Save current state first
    await saveDecisions(currentIteration?.score ?? 0, history, trackScores)

    // Complete the grill (marks idea as completed, saves summary)
    try {
      await completeFromGrill(conversationId, fullDescription)
    } catch (error) {
      console.error('Failed to complete from grill:', error)
    }

    // Create a NEW conversation for planning via convertDirect
    if (activeWorkspace) {
      try {
        const { conversation: newConv } = await convertDirect(ideaId, activeWorkspace.id)
        await loadConversations(activeWorkspace.id)
        await selectConversation(newConv.id)

        // Send "Generate a plan" prompt with the full enriched context
        const planPrompt = `## ${ideaTitle}\n\n${fullDescription}\n\nGenerate a comprehensive implementation plan for this requirement. Use the structured \`\`\`plan block format with sections (one per phase), steps, affected files, complexity estimates, and risks. Do NOT write the plan to a file — emit it inline.`
        await sendMessage(planPrompt)
      } catch (error) {
        console.error('Failed to create planning conversation:', error)
      }
    }

    onComplete()
  }, [currentIteration, history, ideaId, completeFromGrill, conversationId, onComplete, activeWorkspace, ideaTitle, buildFullDescription, convertDirect, loadConversations, selectConversation, sendMessage, saveDecisions, trackScores])

  const answeredCount = currentIteration?.questions.filter((q) => {
    const state = questionStates[q.id]
    if (!state) return false
    return state.skipped || state.selectedOptions.length > 0 || state.otherSelected || state.otherText.trim().length > 0
  }).length ?? 0

  const totalQuestions = currentIteration?.questions.length ?? 0

  const canSubmit = currentIteration?.questions.every((q) => {
    const state = questionStates[q.id]
    if (!state) return false
    if (state.skipped) return true
    return state.selectedOptions.length > 0 || state.otherSelected || state.otherText.trim().length > 0
  }) ?? false

  const shouldSuggestCompletion =
    iterationCount >= MIN_ITERATIONS || description.length >= MAX_DESCRIPTION_CHARS

  const isAtCharLimit = description.length >= MAX_DESCRIPTION_CHARS

  const handleStartEdit = (): void => {
    setEditedDescription(description)
    setIsEditingDescription(true)
  }

  const handleSaveEdit = (): void => {
    setDescription(editedDescription)
    setIsEditingDescription(false)
  }

  return (
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface-raised sticky top-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors text-sm"
          >
            <ArrowLeft size={14} />
            Back to Ideas
          </button>
          <div className="w-px h-5 bg-border-subtle" />
          <div className="flex items-center gap-2 min-w-0">
            <Flame size={14} className="text-accent flex-shrink-0" />
            <span className="text-sm font-medium text-accent truncate">
              Grill: {ideaTitle}
            </span>
            {selectedTrack && phase !== 'selecting' && (
              <>
                <span className="text-text-muted">/</span>
                <span className="text-xs text-text-secondary">
                  {GRILL_TRACKS[selectedTrack].name}
                </span>
              </>
            )}
          </div>
        </div>
        {/* Back to track selection button */}
        {phase !== 'selecting' && phase !== 'evaluating' && (
          <button
            onClick={handleBackToTracks}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors text-xs"
          >
            <LayoutGrid size={12} />
            All Tracks
          </button>
        )}
      </div>

      {/* Content — scrollable */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* ════════════════════════════════════════════════════════════
              TRACK SELECTION PHASE
              ════════════════════════════════════════════════════════════ */}
          {phase === 'selecting' && (
            <>
              {/* Radar chart — show when 2+ tracks completed */}
              {trackScores.length > 1 && (
                <div className="flex justify-center">
                  <GrillRadarChart
                    trackScores={trackScores}
                    size={260}
                    onTrackClick={(trackId) => startTrackGrill(trackId as GrillTrackId)}
                  />
                </div>
              )}

              {/* Track description */}
              <div className="text-center">
                <h2 className="text-lg font-semibold text-text-primary mb-1">
                  Choose a Grill Track
                </h2>
                <p className="text-sm text-text-muted">
                  Each track evaluates your requirement from a specialist perspective.
                  {trackScores.length === 0 && ' Start with any track — we recommend Requirements first.'}
                </p>
              </div>

              {/* Track selector grid */}
              <div className="grid grid-cols-2 gap-3">
                {Object.values(GRILL_TRACKS).map((track) => {
                  const existingScore = trackScores.find((ts) => ts.trackId === track.id)
                  const isSuggested = suggestedNextTrack?.trackId === track.id
                  const IconComponent = TRACK_ICONS[track.icon] ?? Code
                  return (
                    <button
                      key={track.id}
                      onClick={() => startTrackGrill(track.id)}
                      className={`p-4 rounded-xl border bg-surface-overlay hover:bg-surface-base transition-all text-left group ${
                        isSuggested
                          ? 'border-accent/50 ring-1 ring-accent/20'
                          : 'border-border-subtle'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <IconComponent
                          size={16}
                          className={
                            isSuggested
                              ? 'text-accent'
                              : 'text-text-muted group-hover:text-text-secondary transition-colors'
                          }
                        />
                        <span className="text-sm font-semibold text-text-primary">
                          {track.name}
                        </span>
                        {existingScore && (
                          <span
                            className="ml-auto text-xs font-bold"
                            style={{ color: getScoreColor(existingScore.score) }}
                          >
                            {existingScore.score}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted leading-relaxed">{track.description}</p>
                      {isSuggested && suggestedNextTrack && (
                        <div className="mt-2 flex items-center gap-1 text-xs text-accent">
                          <Sparkles size={10} />
                          <span>AI suggested: {suggestedNextTrack.reason}</span>
                        </div>
                      )}
                      {existingScore && (
                        <div className="mt-2 text-xs text-text-muted">
                          {existingScore.iterationCount} iteration{existingScore.iterationCount !== 1 ? 's' : ''} completed
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {/* ════════════════════════════════════════════════════════════
              ACTIVE GRILL SESSION (evaluating / answering / paused)
              ════════════════════════════════════════════════════════════ */}
          {phase !== 'selecting' && (
            <>
              {/* Score + Iteration header */}
              <div className="flex items-start gap-6">
                {/* Iteration info + feedback */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-semibold text-text-primary">
                      Iteration {iterationCount} of &infin;
                    </span>
                    {selectedTrack && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-surface-overlay text-text-secondary border border-border-subtle">
                        {GRILL_TRACKS[selectedTrack].name}
                      </span>
                    )}
                    {phase === 'evaluating' && (
                      <span className="text-xs text-accent animate-pulse">
                        Da Vinci is analyzing your requirement...
                      </span>
                    )}
                  </div>
                  {currentIteration?.feedback && (
                    <p className="text-sm text-text-secondary leading-relaxed">
                      {currentIteration.feedback}
                    </p>
                  )}
                </div>

                {/* Score Gauge */}
                <div className="flex-shrink-0">
                  {phase === 'evaluating' ? (
                    <div className="flex flex-col items-center gap-2" style={{ width: 120 }}>
                      <div className="w-[120px] h-[120px] flex items-center justify-center">
                        <Loader2 size={32} className="text-accent animate-spin" />
                      </div>
                      <span className="text-xs font-semibold text-text-muted">Analyzing...</span>
                    </div>
                  ) : (
                    <ScoreGauge
                      score={currentIteration?.score ?? 0}
                      label={currentIteration?.scoreLabel}
                    />
                  )}
                </div>
              </div>

              {/* Description section */}
              <div className="rounded-xl border border-border-subtle bg-surface-overlay overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 bg-surface-base/60 border-b border-border-subtle">
                  <span className="text-sm font-semibold text-text-primary">
                    Requirement Description
                  </span>
                  {!isEditingDescription ? (
                    <button
                      onClick={handleStartEdit}
                      className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                    >
                      <Edit3 size={12} />
                      Edit
                    </button>
                  ) : (
                    <button
                      onClick={handleSaveEdit}
                      className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
                    >
                      <Check size={12} />
                      Save
                    </button>
                  )}
                </div>
                <div className="px-4 py-3">
                  {isEditingDescription ? (
                    <textarea
                      value={editedDescription}
                      onChange={(e) => setEditedDescription(e.target.value)}
                      className="w-full min-h-[120px] bg-transparent text-sm text-text-body placeholder-text-muted outline-none resize-y"
                      placeholder="Describe your idea..."
                      autoFocus
                    />
                  ) : (
                    <div className="text-sm text-text-body whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                      {description || 'No description provided.'}
                    </div>
                  )}
                </div>
              </div>

              {/* Questions section */}
              {phase === 'answering' && currentIteration && (
                <div className="rounded-xl border border-border-subtle bg-surface-overlay overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-surface-base/60 border-b border-border-subtle">
                    <span className="text-sm font-semibold text-text-primary">
                      Questions ({totalQuestions})
                    </span>
                    <span className="text-xs text-text-muted">
                      {answeredCount}/{totalQuestions} answered
                    </span>
                  </div>
                  <div className="px-4 py-4 space-y-3">
                    {currentIteration.questions.map((question, idx) => (
                      <QuestionItem
                        key={question.id}
                        question={question}
                        questionIndex={idx}
                        totalQuestions={totalQuestions}
                        state={
                          questionStates[question.id] ?? {
                            selectedOptions: [],
                            otherText: '',
                            otherSelected: false,
                            skipped: false
                          }
                        }
                        onChange={(state) =>
                          setQuestionStates((prev) => ({ ...prev, [question.id]: state }))
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Completion suggestion — non-blocking, user decides */}
              {shouldSuggestCompletion && phase === 'answering' && currentIteration && (
                <div className="rounded-xl border border-success/30 bg-success/5 overflow-hidden">
                  <div className="px-4 py-4 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-success/20 flex items-center justify-center flex-shrink-0">
                      <Check size={16} className="text-success" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-success">
                        {isAtCharLimit
                          ? 'Character limit reached — your requirement is detailed enough for implementation.'
                          : `Score: ${currentIteration.score}/100 — your requirement looks ${currentIteration.score >= 85 ? 'ready' : 'solid'}. You can keep refining or convert now.`}
                      </p>
                      <p className="text-xs text-text-muted mt-0.5">
                        {iterationCount} iteration{iterationCount !== 1 ? 's' : ''} completed · {description.length.toLocaleString()} / {MAX_DESCRIPTION_CHARS.toLocaleString()} chars
                        {trackScores.length > 0 && ` · ${trackScores.length} track${trackScores.length !== 1 ? 's' : ''} grilled`}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Evaluating skeleton */}
              {phase === 'evaluating' && (
                <div className="rounded-xl border border-border-subtle bg-surface-overlay overflow-hidden">
                  <div className="px-4 py-8 flex flex-col items-center gap-3">
                    <Loader2 size={24} className="text-accent animate-spin" />
                    <span className="text-sm text-text-muted">
                      Evaluating your requirement{selectedTrack ? ` (${GRILL_TRACKS[selectedTrack].name})` : ''}...
                    </span>
                    <span className="text-xs text-text-muted">
                      This may take a moment as Da Vinci explores your codebase.
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Footer actions — always visible */}
      <div className="flex-shrink-0 border-t border-border-subtle bg-surface-raised px-6 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          {/* Left: Pause & Exit */}
          <div className="flex items-center gap-2">
            {phase !== 'evaluating' && (
              <button
                onClick={handleSaveAndExit}
                aria-label="Pause and exit grill"
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-subtle transition-colors text-sm"
              >
                <ArrowLeft size={14} />
                Pause &amp; Exit
              </button>
            )}
          </div>

          {/* Right: Convert Directly, Back to Tracks, Submit & Re-evaluate */}
          <div className="flex items-center gap-2">
            {phase === 'selecting' && trackScores.length > 0 && (
              <button
                onClick={handleConvertDirectly}
                aria-label="Convert idea directly to conversation"
                className="flex items-center gap-1.5 px-3 py-2.5 border border-success text-success hover:bg-success/10 font-medium rounded-lg text-sm transition-colors press-scale"
              >
                Convert Directly
              </button>
            )}
            {phase === 'answering' && (
              <button
                onClick={handleBackToTracks}
                aria-label="Switch to a different grill track"
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-subtle transition-colors text-sm"
              >
                <LayoutGrid size={14} />
                Switch Track
              </button>
            )}
            {phase !== 'evaluating' && phase !== 'selecting' && (
              <button
                onClick={handleConvertDirectly}
                aria-label="Convert idea directly to conversation"
                className={`flex items-center gap-1.5 rounded-lg text-sm transition-colors press-scale ${
                  shouldSuggestCompletion
                    ? 'px-5 py-2.5 bg-success hover:bg-success-hover text-white font-semibold'
                    : 'px-3 py-2.5 border border-success text-success hover:bg-success/10 font-medium'
                }`}
              >
                {shouldSuggestCompletion && <Check size={14} />}
                Convert Directly
              </button>
            )}
            {phase === 'answering' && !questionsRepeated && (
              <button
                onClick={handleSubmit}
                disabled={!canSubmit || isAtCharLimit}
                aria-label="Submit answers and re-evaluate"
                className="flex items-center gap-1.5 px-5 py-2.5 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold transition-colors press-scale"
              >
                <Play size={14} />
                Submit &amp; Re-evaluate
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
