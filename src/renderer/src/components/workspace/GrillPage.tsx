import { useState, useCallback, useEffect, useRef } from 'react'
import { ArrowLeft, Flame, Pause, Play, MessageSquare, Loader2, Edit3, Check } from 'lucide-react'
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
  onExitToChat: () => void
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

type GrillPhase = 'evaluating' | 'answering' | 'paused'

export default function GrillPage({
  ideaId,
  conversationId,
  ideaTitle,
  ideaDescription,
  isNewSession,
  onBack,
  onComplete,
  onExitToChat
}: GrillPageProps): React.JSX.Element {
  const { selectConversation, loadConversations, sendMessage } = useChatActions()
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const { completeFromGrill } = useIdeaStore()

  const [phase, setPhase] = useState<GrillPhase>('evaluating')
  const [description, setDescription] = useState(ideaDescription || '')
  const [currentIteration, setCurrentIteration] = useState<GrillIteration | null>(null)
  const [iterationCount, setIterationCount] = useState(0)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>({})
  const [isEditingDescription, setIsEditingDescription] = useState(false)
  const [editedDescription, setEditedDescription] = useState('')

  const mountedRef = useRef(false)
  const previousConversationIdRef = useRef<string | null>(null)

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
          if (saved.enrichedDescription) setDescription(saved.enrichedDescription)
          if (saved.history) setHistory(saved.history)
          if (saved.currentScore && !isNewSession) {
            // We have saved state but no active evaluation — show as paused
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
        states[q.id] = { selectedOptions: recommended, otherText: '', skipped: false }
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
        states[q.id] = { selectedOptions: recommended, otherText: '', skipped: false }
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

  const handleSubmit = useCallback(async () => {
    if (!currentIteration) return

    const answersText = formatAnswers()
    const enrichedDescription = `${description}\n\n### Decisions from Iteration ${iterationCount}\n${answersText}`

    // Save history entry
    const newHistory: HistoryEntry = {
      iteration: iterationCount,
      score: currentIteration.score,
      answersFormatted: answersText
    }
    setHistory((prev) => [...prev, newHistory])
    setDescription(enrichedDescription)
    setPhase('evaluating')

    // Send re-evaluation prompt
    const historyText = [...history, newHistory]
      .map((h) => `Iteration ${h.iteration} (score: ${h.score}): ${h.answersFormatted}`)
      .join('\n')

    const grillPrompt = `[GRILL ITERATION ${iterationCount + 1}]\n\n## Re-evaluate This Requirement\n**${ideaTitle}**\n\n${enrichedDescription}\n\n### Previous Decisions\n${historyText}\n\nRe-evaluate the updated requirement. Respond with a grill-evaluation JSON block with updated score and 5 new questions targeting remaining gaps.`
    await sendMessage(grillPrompt)
  }, [currentIteration, formatAnswers, description, iterationCount, history, ideaTitle, sendMessage])

  const handlePause = useCallback(async () => {
    // Save state to DB
    const decisions = JSON.stringify({
      iterationCount,
      currentScore: currentIteration?.score ?? 0,
      enrichedDescription: description,
      history
    })
    try {
      await window.api.saveIdeaGrillDecisions({ ideaId, decisions })
    } catch (error) {
      console.error('Failed to save grill decisions:', error)
    }
    setPhase('paused')
    onBack()
  }, [iterationCount, currentIteration, description, history, ideaId, onBack])

  const handleResume = useCallback(async () => {
    setPhase('evaluating')
    const historyText = history
      .map((h) => `Iteration ${h.iteration} (score: ${h.score}): ${h.answersFormatted}`)
      .join('\n')
    const grillPrompt = `[GRILL ITERATION ${iterationCount + 1}]\n\n## Re-evaluate This Requirement\n**${ideaTitle}**\n\n${description}\n\n### Previous Decisions\n${historyText || 'None yet.'}\n\nRe-evaluate the updated requirement. Respond with a grill-evaluation JSON block with updated score and 5 new questions targeting remaining gaps.`
    await sendMessage(grillPrompt)
  }, [history, iterationCount, ideaTitle, description, sendMessage])

  const handleConvertDirectly = useCallback(async () => {
    // Save current state first
    const decisions = JSON.stringify({
      iterationCount,
      currentScore: currentIteration?.score ?? 0,
      enrichedDescription: description,
      history
    })
    try {
      await window.api.saveIdeaGrillDecisions({ ideaId, decisions })
    } catch {
      // continue anyway
    }

    await completeFromGrill(conversationId, description)
    onComplete()
  }, [iterationCount, currentIteration, description, history, ideaId, completeFromGrill, conversationId, onComplete])

  const handleExitToChat = useCallback(() => {
    onExitToChat()
  }, [onExitToChat])

  const answeredCount = currentIteration?.questions.filter((q) => {
    const state = questionStates[q.id]
    if (!state) return false
    return state.skipped || state.selectedOptions.length > 0 || state.otherText.trim().length > 0
  }).length ?? 0

  const totalQuestions = currentIteration?.questions.length ?? 0

  const canSubmit = currentIteration?.questions.every((q) => {
    const state = questionStates[q.id]
    if (!state) return false
    if (state.skipped) return true
    return state.selectedOptions.length > 0 || state.otherText.trim().length > 0
  }) ?? false

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
          <div className="flex items-center gap-2">
            {phase === 'answering' && (
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="flex items-center gap-1.5 px-5 py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold transition-colors press-scale"
              >
                <Play size={14} />
                Submit &amp; Re-evaluate
              </button>
            )}
            {phase === 'paused' && (
              <button
                onClick={handleResume}
                className="flex items-center gap-1.5 px-5 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-semibold transition-colors press-scale"
              >
                <Play size={14} />
                Resume
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {phase !== 'evaluating' && (
              <>
                <button
                  onClick={handlePause}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-subtle transition-colors text-sm"
                >
                  <Pause size={14} />
                  Pause
                </button>
                <button
                  onClick={handleConvertDirectly}
                  className="flex items-center gap-1.5 px-3 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm font-medium transition-colors press-scale"
                >
                  Convert Directly
                </button>
              </>
            )}
            <button
              onClick={handleExitToChat}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-subtle transition-colors text-sm"
            >
              <MessageSquare size={14} />
              Exit to Chat
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
