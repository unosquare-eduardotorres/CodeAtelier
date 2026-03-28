import { useState, useCallback, useEffect, useRef } from 'react'
import { ArrowLeft, Flame, Play, Loader2, Edit3, Check } from 'lucide-react'
import { useChatActions, useWorkspaceStore } from '@renderer/store'
import { useIdeaStore } from '@renderer/store/idea.store'
import { QuestionItem } from '@renderer/components/chat'
import type { QuestionState } from '@renderer/components/chat'
import type { GrillQuestion } from '../../../../shared/types'
import ScoreGauge from './ScoreGauge'

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
}

interface HistoryEntry {
  iteration: number
  score: number
  answersFormatted: string
}

/** Soft cap for enriched description — suggest completion after this length */
const MAX_DESCRIPTION_CHARS = 15_000

/** Minimum iterations before suggesting completion */
const MIN_ITERATIONS = 5

type GrillPhase = 'evaluating' | 'answering' | 'paused'

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

  const [phase, setPhase] = useState<GrillPhase>('evaluating')
  const [description, setDescription] = useState(ideaDescription || '')
  const [currentIteration, setCurrentIteration] = useState<GrillIteration | null>(null)
  const [iterationCount, setIterationCount] = useState(0)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>({})
  const [isEditingDescription, setIsEditingDescription] = useState(false)
  const [editedDescription, setEditedDescription] = useState('')
  const [questionsRepeated, setQuestionsRepeated] = useState(false)

  const mountedRef = useRef(false)
  const previousConversationIdRef = useRef<string | null>(null)
  const previousQuestionsRef = useRef<string[]>([])

  const areQuestionsRepeated = (newQuestions: GrillQuestion[]): boolean => {
    const newTexts = newQuestions.map((q) => q.question).sort()
    const prevTexts = [...previousQuestionsRef.current].sort()
    if (newTexts.length !== prevTexts.length) return false
    return newTexts.every((text, i) => text === prevTexts[i])
  }

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
          if (saved.currentScore && !isNewSession) {
            setPhase('paused')
            return
          }
        }
      } catch {
        // Ignore parse errors, treat as new session
      }

      // Load conversation and send initial prompt
      if (activeWorkspace) {
        await loadConversations(activeWorkspace.id)
      }
      await selectConversation(conversationId)

      if (isNewSession) {
        const grillPrompt = `[GRILL MODE]\n\n## Evaluate This Requirement\n**${ideaTitle}**\n\n${description || 'No description provided.'}\n\nAnalyze this requirement and respond with a single grill-evaluation JSON block containing a completeness score (1-100), brief feedback, and exactly 5 questions targeting the weakest areas.`
        await sendMessage(grillPrompt)
        setPhase('evaluating')
      } else {
        setPhase('evaluating')
        // For resume, send a re-evaluation prompt
        const historyText = history
          .map((h) => `Iteration ${h.iteration} (score: ${h.score}): ${h.answersFormatted}`)
          .join('\n')
        const grillPrompt = `[GRILL ITERATION ${iterationCount + 1}]\n\n## Re-evaluate This Requirement\n**${ideaTitle}**\n\n${description}\n\n### Previous Decisions\n${historyText || 'None yet.'}\n\nRe-evaluate the updated requirement. Respond with a grill-evaluation JSON block with updated score and 5 new questions targeting remaining gaps.`
        await sendMessage(grillPrompt)
      }
    }
    init()
  }, [conversationId, activeWorkspace, loadConversations, selectConversation, sendMessage, isNewSession, ideaTitle, description, history, iterationCount, ideaId])

  // Listen for grill evaluation events
  useEffect(() => {
    const cleanup = window.api.onGrillEvaluation((data) => {
      if (data.conversationId !== conversationId) return

      const iteration: GrillIteration = {
        score: data.score,
        scoreLabel: data.scoreLabel,
        feedback: data.feedback,
        questions: data.questions
      }

      setCurrentIteration(iteration)
      setIterationCount((prev) => prev + 1)
      setPhase('answering')

      // Initialize question states with recommended options pre-selected
      const states: Record<string, QuestionState> = {}
      for (const q of data.questions) {
        const recommended = q.options.filter((o) => o.recommended).map((o) => o.label)
        states[q.id] = { selectedOptions: recommended, otherText: '', otherSelected: false, skipped: false }
      }
      setQuestionStates(states)
    })

    return cleanup
  }, [conversationId])

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
        ...historyEntries.map(
          (h) => `### Decisions from Iteration ${h.iteration}\n${h.answersFormatted}`
        )
      ].join('\n\n')
    },
    [description]
  )

  const handleSubmit = useCallback(async () => {
    if (!currentIteration) return
    if (description.length >= MAX_DESCRIPTION_CHARS) return

    const answersText = formatAnswers()

    const newHistory: HistoryEntry = {
      iteration: iterationCount,
      score: currentIteration.score,
      answersFormatted: answersText
    }
    const updatedHistory = [...history, newHistory]
    setHistory(updatedHistory)
    setPhase('evaluating')

    // Build the full enriched description for saving (base + all decisions)
    const fullDescription = buildFullDescription(updatedHistory)

    // Auto-save decisions to DB on every iteration
    const decisions = JSON.stringify({
      iterationCount,
      currentScore: currentIteration.score,
      enrichedDescription: fullDescription,
      history: updatedHistory
    })
    try {
      await window.api.saveIdeaGrillDecisions({ ideaId, decisions })
    } catch (error) {
      console.error('Failed to auto-save grill decisions:', error)
    }

    // Send re-evaluation prompt — use base description + history as separate sections
    const historyText = updatedHistory
      .map((h) => `Iteration ${h.iteration} (score: ${h.score}): ${h.answersFormatted}`)
      .join('\n')

    const grillPrompt = `[GRILL ITERATION ${iterationCount + 1}]\n\n## Re-evaluate This Requirement\n**${ideaTitle}**\n\n${description}\n\n### Decisions from Previous Iterations\n${historyText}\n\nRe-evaluate the updated requirement. Respond with a grill-evaluation JSON block with updated score and 5 new questions targeting remaining gaps.`
    await sendMessage(grillPrompt)
  }, [currentIteration, formatAnswers, description, iterationCount, history, ideaTitle, sendMessage, ideaId, buildFullDescription])

  const handleSaveAndExit = useCallback(async () => {
    // Save state to DB
    const fullDescription = buildFullDescription(history)
    const decisions = JSON.stringify({
      iterationCount,
      currentScore: currentIteration?.score ?? 0,
      enrichedDescription: fullDescription,
      history
    })
    try {
      await window.api.saveIdeaGrillDecisions({ ideaId, decisions })
    } catch (error) {
      console.error('Failed to save grill decisions:', error)
    }
    setPhase('paused')
    onBack()
  }, [iterationCount, currentIteration, history, ideaId, onBack, buildFullDescription])

  const handleConvertDirectly = useCallback(async () => {
    // Build the full enriched description from base + all decisions
    const fullDescription = buildFullDescription(history)

    // Save current state first
    const decisions = JSON.stringify({
      iterationCount,
      currentScore: currentIteration?.score ?? 0,
      enrichedDescription: fullDescription,
      history
    })
    try {
      await window.api.saveIdeaGrillDecisions({ ideaId, decisions })
    } catch {
      // continue anyway
    }

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
  }, [iterationCount, currentIteration, history, ideaId, completeFromGrill, conversationId, onComplete, activeWorkspace, ideaTitle, buildFullDescription, convertDirect, loadConversations, selectConversation, sendMessage])

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
            <Flame size={14} className="text-orange-400 flex-shrink-0" />
            <span className="text-sm font-medium text-orange-300 truncate">
              Grill: {ideaTitle}
            </span>
          </div>
        </div>
      </div>

      {/* Content — scrollable */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Score + Iteration header */}
          <div className="flex items-start gap-6">
            {/* Iteration info + feedback */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-semibold text-text-primary">
                  Iteration {iterationCount} of ∞
                </span>
                {phase === 'evaluating' && (
                  <span className="text-xs text-orange-400 animate-pulse">
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
                    <Loader2 size={32} className="text-orange-400 animate-spin" />
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
            <div className="rounded-xl border border-green-500/30 bg-green-500/5 overflow-hidden">
              <div className="px-4 py-4 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                  <Check size={16} className="text-green-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-green-300">
                    {isAtCharLimit
                      ? 'Character limit reached — your requirement is detailed enough for implementation.'
                      : `Score: ${currentIteration.score}/100 — your requirement looks ${currentIteration.score >= 85 ? 'ready' : 'solid'}. You can keep refining or convert now.`}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    {iterationCount} iteration{iterationCount !== 1 ? 's' : ''} completed · {description.length.toLocaleString()} / {MAX_DESCRIPTION_CHARS.toLocaleString()} chars
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Evaluating skeleton */}
          {phase === 'evaluating' && (
            <div className="rounded-xl border border-border-subtle bg-surface-overlay overflow-hidden">
              <div className="px-4 py-8 flex flex-col items-center gap-3">
                <Loader2 size={24} className="text-orange-400 animate-spin" />
                <span className="text-sm text-text-muted">
                  Evaluating your requirement...
                </span>
                <span className="text-xs text-text-muted">
                  This may take a moment as Da Vinci explores your codebase.
                </span>
              </div>
            </div>
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

          {/* Right: Convert Directly, Submit & Re-evaluate */}
          <div className="flex items-center gap-2">
            {phase !== 'evaluating' && (
              <button
                onClick={handleConvertDirectly}
                aria-label="Convert idea directly to conversation"
                className={`flex items-center gap-1.5 rounded-lg text-sm transition-colors press-scale ${
                  shouldSuggestCompletion
                    ? 'px-5 py-2.5 bg-green-600 hover:bg-green-500 text-white font-semibold'
                    : 'px-3 py-2.5 border border-green-600 text-green-400 hover:bg-green-600/10 font-medium'
                }`}
              >
                {shouldSuggestCompletion && <Check size={14} />}
                Convert Directly
              </button>
            )}
            {phase === 'answering' && (
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
