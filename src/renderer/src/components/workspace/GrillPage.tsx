import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { ArrowLeft, Flame, Play, Check, LayoutGrid, Square, MessageSquare, ClipboardList } from 'lucide-react'
import { useChatActions, useWorkspaceStore } from '@renderer/store'
import { useIdeaStore } from '@renderer/store/idea.store'
import { useGrillStreamStore, getFlatContent, getFlatToolActivities } from '@renderer/store/grill-stream.store'
import { stripGrillEvaluationBlocks } from '@renderer/utils/strip-grill-json'
import type { QuestionState } from '@renderer/components/chat'
import type { GrillQuestion, GrillTrackId, GrillTrackScore, DecisionEntry } from '../../../../shared/types'
import { GRILL_TRACKS } from '../../../../shared/constants'
import GrillChatView from './GrillChatView'
import type { GrillChatMessage, GrillPhase } from './GrillChatView'
import GrillDecisionsView from './GrillDecisionsView'
import { GrillTrackSelector } from './GrillTrackSelector'
import GrillSidebar from './GrillSidebar'

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
  feedback: string
  answersFormatted: string
  trackId?: GrillTrackId
}

/** Soft cap for enriched description — suggest completion after this length */
const MAX_DESCRIPTION_CHARS = 15_000

/** Minimum iterations before suggesting completion */
const MIN_ITERATIONS = 5

export default function GrillPage({
  ideaId,
  conversationId,
  ideaTitle,
  ideaDescription,
  isNewSession,
  onBack,
  onComplete
}: GrillPageProps): React.JSX.Element {
  const { loadConversations, selectConversation, sendMessage } = useChatActions()
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const { completeFromGrill, convertDirect } = useIdeaStore()

  const [phase, setPhase] = useState<GrillPhase>(isNewSession ? 'selecting' : 'paused')
  const [description] = useState(ideaDescription || '')
  const [currentIteration, setCurrentIteration] = useState<GrillIteration | null>(null)
  const [iterationCount, setIterationCount] = useState(0)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>({})
  const [questionsRepeated, setQuestionsRepeated] = useState(false)

  // ── Chat-like message history ──
  const [chatMessages, setChatMessages] = useState<GrillChatMessage[]>([])

  // Track-specific state
  const [selectedTrack, setSelectedTrack] = useState<GrillTrackId | null>(null)
  const [trackScores, setTrackScores] = useState<GrillTrackScore[]>([])
  const [suggestedNextTrack, setSuggestedNextTrack] = useState<{
    trackId: GrillTrackId
    reason: string
  } | null>(null)

  // ── Tab state (Chat vs Decisions) ──
  type GrillTab = 'chat' | 'decisions'
  const [activeTab, setActiveTab] = useState<GrillTab>('chat')
  const [condensedDocument, setCondensedDocument] = useState<string | undefined>()
  const [isCondensing, setIsCondensing] = useState(false)

  const mountedRef = useRef(false)
  const previousQuestionsRef = useRef<string[]>([])

  // ── Computed: answered / total for sidebar ──
  const totalQuestions = currentIteration?.questions.length ?? 0
  const answeredCount = currentIteration
    ? currentIteration.questions.filter((q) => {
        const state = questionStates[q.id]
        if (!state) return false
        return (
          state.skipped || state.selectedOptions.length > 0 || state.otherText.trim().length > 0
        )
      }).length
    : 0

  const areQuestionsRepeated = (newQuestions: GrillQuestion[]): boolean => {
    const newTexts = newQuestions.map((q) => q.question).sort()
    const prevTexts = [...previousQuestionsRef.current].sort()
    if (newTexts.length !== prevTexts.length) return false
    return newTexts.every((text, i) => text === prevTexts[i])
  }

  /** Start a grill session for a specific track */
  const startTrackGrill = useCallback(
    async (trackId: GrillTrackId) => {
      if (!activeWorkspace) return

      setSelectedTrack(trackId)
      setPhase('evaluating')
      setSuggestedNextTrack(null)

      // Reset grill stream store for fresh evaluation
      useGrillStreamStore.getState().reset()

      // Add system message to chat history
      setChatMessages((prev) => [
        ...prev,
        { type: 'system', content: `Starting ${GRILL_TRACKS[trackId].name} track…` }
      ])

      // Start dedicated grill evaluation
      const existingTrackScore = trackScores.find((ts) => ts.trackId === trackId)
      try {
        await window.api.grillEvaluate({
          workspaceId: activeWorkspace.id,
          trackId,
          ideaTitle,
          ideaDescription: description,
          previousScore: existingTrackScore?.score,
          ideaId
        })
      } catch (error) {
        console.error('Failed to start grill evaluation:', error)
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
    [activeWorkspace, ideaTitle, description, trackScores]
  )

  // ── Grill stream event listeners ──
  useEffect(() => {
    const grillStore = useGrillStreamStore.getState()

    const unsubChunk = window.api.onGrillStreamChunk((data) => {
      grillStore.handleStreamChunk(data)
    })

    const unsubEval = window.api.onGrillEvaluationResult((data) => {
      // Flush remaining buffered content
      grillStore.flush()

      // Capture content from grill stream store (NOT chat store — never cleared)
      const storeState = useGrillStreamStore.getState()
      const content = getFlatContent(storeState)
      const toolActivities = getFlatToolActivities(storeState)

      // Strip the raw grill-evaluation JSON block so it doesn't render as markdown
      // (the parsed evaluation renders separately as a GrillEvaluationBubble)
      const cleanContent = stripGrillEvaluationBlocks(content)

      const newMessages: GrillChatMessage[] = []
      if (cleanContent || toolActivities.length > 0) {
        newMessages.push({
          type: 'agent',
          content: cleanContent,
          toolActivities
        })
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

      // Reset grill store for next iteration
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
        setSuggestedNextTrack(data.suggestedNextTrack as { trackId: GrillTrackId; reason: string })
      }

      // Detect if questions are the same as previous iteration
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

      // If no evaluation was received, still capture the agent content
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
      // Don't auto-transition — user can still see what was analyzed
    })

    return () => {
      unsubChunk()
      unsubEval()
      unsubComplete()
    }
    // selectedTrack is used inside the callback to resolve trackName;
    // we intentionally capture it via closure. Re-subscribing on change
    // ensures the latest value is used.
  }, [selectedTrack])

  // On mount: load saved state or start fresh
  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true

    const init = async (): Promise<void> => {
      // 1. Try loading from DB session (Phase 2: background persistence)
      try {
        const dbSession = await window.api.grillGetSession({ ideaId })
        if (dbSession && typeof dbSession === 'object') {
          const s = dbSession as {
            status?: string
            iterationCount?: number
            history?: unknown[]
            trackScores?: unknown[]
            messages?: unknown[]
            currentIteration?: GrillIteration | null
            questionStates?: Record<string, QuestionState> | null
            trackId?: GrillTrackId | null
            currentScore?: number | null
          }
          if (s.iterationCount) setIterationCount(s.iterationCount)
          if (s.history) setHistory(s.history as HistoryEntry[])
          if (s.trackScores) setTrackScores(s.trackScores as GrillTrackScore[])
          if (s.messages) setChatMessages(s.messages as GrillChatMessage[])
          if (s.currentIteration) setCurrentIteration(s.currentIteration)
          if (s.questionStates) setQuestionStates(s.questionStates as Record<string, QuestionState>)
          if (s.trackId) setSelectedTrack(s.trackId)

          // Restore phase based on DB session status
          if (s.status === 'evaluating') {
            setPhase('evaluating')
            return
          }
          if (s.status === 'awaiting_answers') {
            setPhase('answering')
            return
          }
          if (s.currentScore != null) {
            if (s.currentIteration?.questions?.length && s.questionStates) {
              setPhase('answering')
            } else if (s.trackScores && (s.trackScores as unknown[]).length > 0) {
              setPhase('selecting')
            } else {
              setPhase('paused')
            }
            return
          }
        }
      } catch {
        /* non-fatal — fall through to legacy load */
      }

      // 2. Fallback: load from grillDecisions JSON in the idea (legacy)
      try {
        const ideas = useIdeaStore.getState().ideas
        const idea = ideas.find((i) => i.id === ideaId)
        if (idea?.grillDecisions) {
          const saved = JSON.parse(idea.grillDecisions)
          if (saved.iterationCount) setIterationCount(saved.iterationCount)
          if (saved.history) setHistory(saved.history)
          if (saved.trackScores) setTrackScores(saved.trackScores)
          if (saved.chatMessages) setChatMessages(saved.chatMessages)
          if (saved.currentIteration) setCurrentIteration(saved.currentIteration)
          if (saved.questionStates) setQuestionStates(saved.questionStates)
          if (saved.activeTrack) {
            setSelectedTrack(saved.activeTrack as GrillTrackId)
          }
          // Fix falsy-zero: use != null instead of truthiness check
          if (saved.currentScore != null && !isNewSession) {
            // If saved state has questions ready, go to answering
            if (saved.currentIteration?.questions?.length > 0 && saved.questionStates) {
              setPhase('answering')
            } else if (saved.trackScores?.length > 0) {
              // If there are track scores, go to selecting to let user pick next track
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

      // For resume without saved state — don't auto-fire grillEvaluate.
      // Show track selection so user can choose what to do.
      setPhase('selecting')
    }
    init()
  }, [activeWorkspace, isNewSession, ideaTitle, description, history, ideaId, selectedTrack])

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
      // Include full question text when header is a short label
      const fullQ = q.question !== q.header && q.header ? `\n  > ${q.question}` : ''
      parts.push(`- **${q.header || q.question}**: ${selected}${other}${fullQ}`)
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
          return `### Iteration ${h.iteration}${trackLabel}\nScore: ${h.score}/100\nFeedback: ${h.feedback}\nDecisions:\n${h.answersFormatted}`
        })
      ].join('\n\n')
    },
    [description]
  )

  // ── Decisions derivation for the Decisions tab ──

  /** Derive structured DecisionEntry[] from chat message history */
  const decisions = useMemo((): DecisionEntry[] => {
    const entries: DecisionEntry[] = []
    let iteration = 0

    for (const msg of chatMessages) {
      if (msg.type === 'questions') {
        // Track which iteration this belongs to
        iteration++
        for (const q of msg.questions) {
          const state = msg.questionStates[q.id]
          if (!state) continue
          const answerParts: string[] = []
          if (state.skipped) {
            answerParts.push('_Skipped_')
          } else {
            if (state.selectedOptions.length > 0) {
              answerParts.push(state.selectedOptions.join(', '))
            }
            if (state.otherText?.trim()) {
              answerParts.push(`(Custom: ${state.otherText.trim()})`)
            }
          }
          // Find the matching track from the history entry
          const historyEntry = history.find((h) => h.iteration === iteration)
          entries.push({
            iteration,
            trackId: historyEntry?.trackId,
            question: q.header || q.question,
            questionFull: q.header && q.question !== q.header ? q.question : undefined,
            answer: answerParts.join(' ') || '_No answer_',
            score: historyEntry?.score
          })
        }
      }
    }
    return entries
  }, [chatMessages, history])

  /** Requirement document for the Decisions tab */
  const requirementDocument = useMemo(
    () => buildFullDescription(history),
    [buildFullDescription, history]
  )

  /** Condense handler — calls Haiku-tier summarization via IPC */
  const handleCondense = useCallback(async () => {
    if (isCondensing || !requirementDocument) return
    setIsCondensing(true)
    try {
      const { condensed } = await window.api.grillCondenseRequirement({
        text: requirementDocument
      })
      setCondensedDocument(condensed)
    } catch (error) {
      console.error('Failed to condense requirement:', error)
    } finally {
      setIsCondensing(false)
    }
  }, [requirementDocument, isCondensing])

  /** Save decisions to DB (includes track scores, chat history, and question state) */
  const saveDecisions = useCallback(
    async (
      score: number,
      historyEntries: HistoryEntry[],
      currentTrackScores: GrillTrackScore[],
      messages?: GrillChatMessage[],
      iteration?: GrillIteration | null,
      qStates?: Record<string, QuestionState>
    ) => {
      const fullDescription = buildFullDescription(historyEntries)

      // Keep lightweight tool summaries — drop full result content to keep JSON reasonable
      const messagesToSave = (messages ?? chatMessages).map((msg) =>
        msg.type === 'agent'
          ? {
              ...msg,
              toolActivities: msg.toolActivities.map((ta) => ({
                id: ta.id,
                toolName: ta.toolName,
                status: ta.status,
                input: ta.input,
                result: undefined,
                startedAt: ta.startedAt,
                completedAt: ta.completedAt
              }))
            }
          : msg
      )

      const decisions = JSON.stringify({
        iterationCount,
        currentScore: score,
        enrichedDescription: fullDescription,
        history: historyEntries,
        trackScores: currentTrackScores,
        activeTrack: selectedTrack,
        chatMessages: messagesToSave,
        currentIteration: iteration !== undefined ? iteration : currentIteration,
        questionStates: qStates ?? questionStates
      })
      try {
        await window.api.saveIdeaGrillDecisions({ ideaId, decisions })
      } catch (error) {
        console.error('Failed to save grill decisions:', error)
      }
    },
    [
      iterationCount,
      buildFullDescription,
      selectedTrack,
      ideaId,
      chatMessages,
      currentIteration,
      questionStates
    ]
  )

  const handleSubmit = useCallback(async () => {
    if (!currentIteration || !activeWorkspace || !selectedTrack) return
    if (description.length >= MAX_DESCRIPTION_CHARS) return

    const answersText = formatAnswers()

    // Increment iteration count ONLY on actual user submission
    const newIterationCount = iterationCount + 1
    setIterationCount(newIterationCount)

    // Capture questions + selections as a read-only snapshot, then user answers
    setChatMessages((prev) => [
      ...prev,
      {
        type: 'questions',
        questions: currentIteration.questions,
        questionStates: { ...questionStates }
      },
      { type: 'user', content: answersText }
    ])

    const newHistory: HistoryEntry = {
      iteration: newIterationCount,
      score: currentIteration.score,
      feedback: currentIteration.feedback,
      answersFormatted: answersText,
      trackId: selectedTrack ?? undefined
    }
    const updatedHistory = [...history, newHistory]
    setHistory(updatedHistory)
    setPhase('evaluating')
    setQuestionsRepeated(false)

    // Auto-save decisions to DB on every iteration
    await saveDecisions(currentIteration.score, updatedHistory, trackScores)

    // Reset grill stream store for fresh evaluation
    useGrillStreamStore.getState().reset()

    // Build iteration history text
    const historyText = updatedHistory
      .map((h) => {
        const trackLabel = h.trackId ? ` [${GRILL_TRACKS[h.trackId]?.name ?? h.trackId}]` : ''
        return `### Iteration ${h.iteration}${trackLabel}\nScore: ${h.score}/100\nFeedback: ${h.feedback}\nDecisions:\n${h.answersFormatted}`
      })
      .join('\n\n')

    // Start dedicated grill evaluation with history
    try {
      await window.api.grillEvaluate({
        workspaceId: activeWorkspace.id,
        trackId: selectedTrack,
        ideaTitle,
        ideaDescription: description,
        iterationHistory: historyText,
        previousScore: currentIteration.score,
        ideaId
      })
    } catch (error) {
      console.error('Failed to re-evaluate:', error)
      setChatMessages((prev) => [
        ...prev,
        {
          type: 'system',
          content: `❌ Re-evaluation failed: ${error instanceof Error ? error.message : String(error)}`
        }
      ])
      setPhase('paused')
    }
  }, [
    currentIteration,
    activeWorkspace,
    formatAnswers,
    description,
    iterationCount,
    history,
    ideaTitle,
    selectedTrack,
    saveDecisions,
    trackScores
  ])

  /** Return to track selection after completing a track iteration */
  const handleBackToTracks = useCallback(async () => {
    // Cancel any running evaluation before switching
    try {
      await window.api.grillCancel()
    } catch {
      /* non-fatal */
    }
    // Save current state
    await saveDecisions(currentIteration?.score ?? 0, history, trackScores)
    setPhase('selecting')
  }, [currentIteration, history, trackScores, saveDecisions])

  const handleStopGrill = useCallback(async () => {
    try {
      await window.api.grillCancel()
    } catch (error) {
      console.error('Failed to cancel grill:', error)
    }
    setPhase('paused')
  }, [])

  const handleSaveAndExit = useCallback(async () => {
    // Cancel any running evaluation before exiting
    try {
      await window.api.grillCancel()
    } catch {
      /* non-fatal */
    }
    await saveDecisions(currentIteration?.score ?? 0, history, trackScores)
    setPhase('paused')
    onBack()
  }, [currentIteration, history, trackScores, saveDecisions, onBack])

  const handleConvertDirectly = useCallback(async () => {
    // Build the full enriched description from base + all decisions
    const fullDescription = buildFullDescription(history)
    // Use condensed text when available (user already reviewed it)
    const effectiveDescription = condensedDocument || fullDescription

    // Save current state first
    await saveDecisions(currentIteration?.score ?? 0, history, trackScores)

    // Complete the grill (marks idea as completed, saves summary)
    try {
      await completeFromGrill(conversationId, effectiveDescription)
    } catch (error) {
      console.error('Failed to complete from grill:', error)
    }

    // Create a NEW conversation for planning via convertDirect
    if (activeWorkspace) {
      try {
        const { conversation: newConv } = await convertDirect(ideaId, activeWorkspace.id)
        await loadConversations(activeWorkspace.id)
        await selectConversation(newConv.id)

        // Send "Generate a plan" prompt with the enriched context
        const planPrompt = `## ${ideaTitle}\n\n${effectiveDescription}\n\nGenerate a comprehensive implementation plan for this requirement. Use the structured \`\`\`plan block format with sections (one per phase), steps, affected files, complexity estimates, and risks. Do NOT write the plan to a file — emit it inline.`
        await sendMessage(planPrompt)
      } catch (error) {
        console.error('Failed to create planning conversation:', error)
      }
    }

    onComplete()
  }, [
    currentIteration,
    history,
    ideaId,
    completeFromGrill,
    conversationId,
    onComplete,
    activeWorkspace,
    ideaTitle,
    buildFullDescription,
    condensedDocument,
    convertDirect,
    loadConversations,
    selectConversation,
    sendMessage,
    saveDecisions,
    trackScores
  ])

  const canSubmit =
    currentIteration?.questions.every((q) => {
      const state = questionStates[q.id]
      if (!state) return false
      if (state.skipped) return true
      return (
        state.selectedOptions.length > 0 || state.otherSelected || state.otherText.trim().length > 0
      )
    }) ?? false

  const shouldSuggestCompletion =
    iterationCount >= MIN_ITERATIONS || description.length >= MAX_DESCRIPTION_CHARS

  const isAtCharLimit = description.length >= MAX_DESCRIPTION_CHARS

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
            <span className="text-sm font-medium text-accent truncate">Grill: {ideaTitle}</span>
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
        <div className="flex items-center gap-2">
          {/* Stop button — visible during evaluation */}
          {phase === 'evaluating' && (
            <button
              onClick={handleStopGrill}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-danger border border-danger/30 hover:bg-danger-muted transition-colors"
            >
              <Square size={12} />
              Stop Grilling
            </button>
          )}
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
      </div>

      {/* Tab toggle — Chat / Decisions (only visible when not in track-selection phase) */}
      {phase !== 'selecting' && (
        <div className="flex-shrink-0 border-b border-border-subtle bg-surface-raised px-6">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveTab('chat')}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'chat'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-muted hover:text-text-secondary'
              }`}
            >
              <MessageSquare size={14} />
              Chat
            </button>
            <button
              onClick={() => setActiveTab('decisions')}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'decisions'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-muted hover:text-text-secondary'
              }`}
            >
              <ClipboardList size={14} />
              Decisions
              {decisions.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-accent/15 text-accent font-semibold">
                  {decisions.length}
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Content — track selector, chat + sidebar, or decisions view */}
      {phase === 'selecting' ? (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            <GrillTrackSelector
              trackScores={trackScores}
              suggestedNextTrack={suggestedNextTrack}
              onSelectTrack={startTrackGrill}
            />
          </div>
        </div>
      ) : activeTab === 'decisions' ? (
        <GrillDecisionsView
          ideaDescription={description}
          ideaTitle={ideaTitle}
          decisions={decisions}
          requirementDocument={requirementDocument}
          onCondense={handleCondense}
          condensedDocument={condensedDocument}
          isCondensing={isCondensing}
        />
      ) : (
        <div className="flex flex-1 min-h-0">
          <GrillChatView
            messages={chatMessages}
            phase={phase}
            description={description}
            ideaTitle={ideaTitle}
            currentQuestions={currentIteration?.questions ?? null}
            questionStates={questionStates}
            onQuestionChange={(id, state) =>
              setQuestionStates((prev) => ({ ...prev, [id]: state }))
            }
          />
          <GrillSidebar
            selectedTrack={selectedTrack}
            currentScore={currentIteration?.score ?? null}
            currentScoreLabel={currentIteration?.scoreLabel ?? null}
            iterationCount={iterationCount}
            trackScores={trackScores}
            answeredCount={answeredCount}
            totalQuestions={totalQuestions}
            suggestedNextTrack={suggestedNextTrack}
          />
        </div>
      )}

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
