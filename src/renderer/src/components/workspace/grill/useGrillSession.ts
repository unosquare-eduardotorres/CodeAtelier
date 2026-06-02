import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useChatActions, useWorkspaceStore } from '@renderer/store'
import { useIdeaStore } from '@renderer/store/idea.store'
import { useGrillStreamStore } from '@renderer/store/grill-stream.store'
import type { QuestionState } from '@renderer/components/chat'
import type {
  GrillTrackId,
  GrillTrackScore,
  DecisionEntry,
  LLMProvider,
  GrillStructuredPlan
} from '../../../../../shared/types'
import { GRILL_TRACKS } from '../../../../../shared/constants'
import type { GrillChatMessage, GrillPhase } from '../GrillChatView'
import { useGrillQuestionState } from './useGrillQuestionState'
import type { GrillIteration } from './useGrillQuestionState'
import { useSaveGrillDecisions } from './useSaveGrillDecisions'
import type { HistoryEntry } from './useSaveGrillDecisions'
import { useGrillStreamListeners } from './useGrillStreamListeners'
import { useGrillActions } from './useGrillActions'

/** Soft cap for enriched description — suggest completion after this length */
const MAX_DESCRIPTION_CHARS = 15_000

/** Minimum iterations before suggesting completion */
const MIN_ITERATIONS = 5

export interface GrillSessionResult {
  // State
  phase: GrillPhase
  description: string
  currentIteration: GrillIteration | null
  iterationCount: number
  history: HistoryEntry[]
  questionStates: Record<string, QuestionState>
  questionsRepeated: boolean
  chatMessages: GrillChatMessage[]
  selectedTrack: GrillTrackId | null
  trackScores: GrillTrackScore[]
  suggestedNextTrack: { trackId: GrillTrackId; reason: string } | null
  grillProvider: LLMProvider
  activeTab: 'chat' | 'decisions'
  condensedDocument: string | undefined
  isCondensing: boolean
  decisions: DecisionEntry[]
  requirementDocument: string
  totalQuestions: number
  answeredCount: number
  canSubmit: boolean
  shouldSuggestCompletion: boolean
  isAtCharLimit: boolean

  // Actions
  setPhase: (phase: GrillPhase) => void
  setQuestionStates: React.Dispatch<React.SetStateAction<Record<string, QuestionState>>>
  setActiveTab: (tab: 'chat' | 'decisions') => void
  setGrillProvider: (provider: LLMProvider) => void
  startTrackGrill: (trackId: GrillTrackId) => Promise<void>
  handleSubmit: () => Promise<void>
  handleBackToTracks: () => Promise<void>
  handleStopGrill: () => Promise<void>
  handleSaveAndExit: () => Promise<void>
  handleConvertDirectly: () => Promise<void>
  handleCondense: () => Promise<void>
}

export function useGrillSession(opts: {
  ideaId: string
  conversationId: string
  ideaTitle: string
  ideaDescription?: string
  isNewSession?: boolean
  onBack: () => void
  onComplete: () => void
  onRestorePlan?: (plan: GrillStructuredPlan) => void
}): GrillSessionResult {
  const {
    ideaId,
    conversationId,
    ideaTitle,
    ideaDescription,
    isNewSession,
    onBack,
    onComplete,
    onRestorePlan
  } = opts
  const { loadConversations, selectConversation, sendMessage } = useChatActions()
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const { completeFromGrill, convertDirect } = useIdeaStore()

  // ── Question state (extracted hook) ──
  const {
    currentIteration,
    setCurrentIteration,
    questionStates,
    setQuestionStates,
    questionsRepeated,
    setQuestionsRepeated,
    totalQuestions,
    answeredCount,
    canSubmit,
    formatAnswers,
    checkAndSetRepeated,
    initQuestionStates
  } = useGrillQuestionState()

  const [phase, setPhase] = useState<GrillPhase>(isNewSession ? 'selecting' : 'paused')
  const [description] = useState(ideaDescription || '')
  const [iterationCount, setIterationCount] = useState(0)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [chatMessages, setChatMessages] = useState<GrillChatMessage[]>([])
  const [selectedTrack, setSelectedTrack] = useState<GrillTrackId | null>(null)
  const [trackScores, setTrackScores] = useState<GrillTrackScore[]>([])
  const [suggestedNextTrack, setSuggestedNextTrack] = useState<{
    trackId: GrillTrackId
    reason: string
  } | null>(null)
  const [grillProvider, setGrillProvider] = useState<LLMProvider>('claude')
  const [activeTab, setActiveTab] = useState<'chat' | 'decisions'>('chat')
  const [condensedDocument, setCondensedDocument] = useState<string | undefined>()
  const [isCondensing, setIsCondensing] = useState(false)

  const mountedRef = useRef(false)

  // Load workspace provider setting
  useEffect(() => {
    if (!activeWorkspace?.id) return
    window.api
      .getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      .then((settings) => {
        setGrillProvider((settings.llmProvider as LLMProvider) ?? 'claude')
      })
      .catch((err) =>
        console.warn('[useGrillSession] Non-fatal: workspace settings load failed:', err)
      )
  }, [activeWorkspace?.id])

  // ── Start track evaluation ──
  const startTrackGrill = useCallback(
    async (trackId: GrillTrackId) => {
      if (!activeWorkspace) return
      setSelectedTrack(trackId)
      setPhase('evaluating')
      setSuggestedNextTrack(null)
      useGrillStreamStore.getState().reset()
      setChatMessages((prev) => [
        ...prev,
        { type: 'system', content: `Starting ${GRILL_TRACKS[trackId].name} track…` }
      ])
      const existingTrackScore = trackScores.find((ts) => ts.trackId === trackId)
      try {
        await window.api.grillEvaluate({
          workspaceId: activeWorkspace.id,
          trackId,
          ideaTitle,
          ideaDescription: description,
          previousScore: existingTrackScore?.score,
          ideaId,
          llmProvider: grillProvider
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
    [activeWorkspace, ideaTitle, description, trackScores, grillProvider, ideaId]
  )

  // ── Stream event listeners (extracted hook) ──
  useGrillStreamListeners({
    selectedTrack,
    setChatMessages,
    setCurrentIteration,
    setPhase,
    setTrackScores,
    setSuggestedNextTrack,
    checkAndSetRepeated,
    initQuestionStates
  })

  // ── On mount: restore saved state (snapshot-authoritative) or start fresh ──
  //
  // The grill writes to two stores: the `grill_sessions` row (live status +
  // currentIteration, but agent-narration-only messages) and the
  // `ideas.grill_decisions` JSON snapshot (the ONLY place holding the full chat,
  // history, trackScores and per-iteration decisions). We read both and treat
  // the snapshot as authoritative for the data only it carries.
  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true

    const init = async (): Promise<void> => {
      // A brand-new session never restores — go straight to track selection.
      if (isNewSession) {
        setPhase('selecting')
        return
      }

      // Live DB session — freshest status + currentIteration + (if completed) plan.
      let dbSession: {
        status?: string
        currentIteration?: GrillIteration | null
        plan?: GrillStructuredPlan | null
      } | null = null
      try {
        const s = await window.api.grillGetSession({ ideaId })
        if (s && typeof s === 'object') {
          dbSession = s as {
            status?: string
            currentIteration?: GrillIteration | null
            plan?: GrillStructuredPlan | null
          }
        }
      } catch {
        /* non-fatal — fall back to the snapshot */
      }

      // Completed handoff — transient state was stripped; surface the plan-only view.
      if (dbSession?.status === 'completed') {
        if (dbSession.plan) {
          onRestorePlan?.(dbSession.plan)
          setPhase('completed')
        } else {
          // Convert-Directly handoffs keep no grill plan — nothing to restore.
          setPhase('selecting')
        }
        return
      }

      // JSON snapshot — full chat + history + trackScores + per-iteration decisions.
      let snapshot: {
        iterationCount?: number
        history?: HistoryEntry[]
        trackScores?: GrillTrackScore[]
        chatMessages?: GrillChatMessage[]
        currentIteration?: GrillIteration | null
        activeTrack?: GrillTrackId
      } | null = null
      try {
        const idea = useIdeaStore.getState().ideas.find((i) => i.id === ideaId)
        if (idea?.grillDecisions) snapshot = JSON.parse(idea.grillDecisions)
      } catch {
        /* ignore parse errors */
      }

      // Nothing persisted anywhere → fresh selection screen.
      if (!dbSession && !snapshot) {
        setPhase('selecting')
        return
      }

      // Snapshot is authoritative for the data only it carries.
      if (snapshot) {
        if (snapshot.iterationCount) setIterationCount(snapshot.iterationCount)
        if (snapshot.history) setHistory(snapshot.history)
        if (snapshot.trackScores) setTrackScores(snapshot.trackScores)
        if (snapshot.chatMessages) setChatMessages(snapshot.chatMessages)
        if (snapshot.activeTrack) setSelectedTrack(snapshot.activeTrack)
      }

      // Prefer the live row's currentIteration (freshest), fall back to snapshot.
      const currentIteration = dbSession?.currentIteration ?? snapshot?.currentIteration ?? null
      if (currentIteration) {
        setCurrentIteration(currentIteration)
        // Reset unsubmitted toggles — restored card starts from recommended defaults.
        initQuestionStates(currentIteration.questions ?? [])
      }

      // Derive phase.
      const status = dbSession?.status
      const hasCurrentQuestions = (currentIteration?.questions?.length ?? 0) > 0
      const hasTrackScores = (snapshot?.trackScores?.length ?? 0) > 0
      if (status === 'evaluating') {
        setPhase('evaluating')
      } else if (status === 'awaiting_answers' || hasCurrentQuestions) {
        setPhase('answering')
      } else if (hasTrackScores) {
        setPhase('selecting')
      } else {
        setPhase('paused')
      }
    }
    init()
  }, [isNewSession, ideaId, setCurrentIteration, initQuestionStates, onRestorePlan])

  // ── Helpers ──

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

  const decisions = useMemo((): DecisionEntry[] => {
    const entries: DecisionEntry[] = []
    let iteration = 0
    for (const msg of chatMessages) {
      if (msg.type === 'questions') {
        iteration++
        for (const q of msg.questions) {
          const state = msg.questionStates[q.id]
          if (!state) continue
          const answerParts: string[] = []
          if (state.skipped) {
            answerParts.push('_Skipped_')
          } else {
            if (state.selectedOptions.length > 0) answerParts.push(state.selectedOptions.join(', '))
            if (state.otherText?.trim()) answerParts.push(`(Custom: ${state.otherText.trim()})`)
          }
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

  const requirementDocument = useMemo(
    () => buildFullDescription(history),
    [buildFullDescription, history]
  )

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

  const { saveDecisions } = useSaveGrillDecisions({
    ideaId,
    iterationCount,
    selectedTrack,
    chatMessages,
    currentIteration,
    questionStates,
    buildFullDescription
  })

  // ── Action handlers (extracted hook) ──
  const {
    handleSubmit,
    handleBackToTracks,
    handleStopGrill,
    handleSaveAndExit,
    handleConvertDirectly
  } = useGrillActions({
    ideaId,
    ideaTitle,
    conversationId,
    description,
    activeWorkspace,
    currentIteration,
    selectedTrack,
    iterationCount,
    history,
    trackScores,
    questionStates,
    chatMessages,
    condensedDocument,
    saveDecisions,
    formatAnswers,
    buildFullDescription,
    setPhase,
    setIterationCount,
    setChatMessages,
    setHistory,
    setQuestionsRepeated,
    completeFromGrill,
    convertDirect,
    loadConversations,
    selectConversation,
    sendMessage,
    onBack,
    onComplete
  })

  const shouldSuggestCompletion =
    iterationCount >= MIN_ITERATIONS || description.length >= MAX_DESCRIPTION_CHARS
  const isAtCharLimit = description.length >= MAX_DESCRIPTION_CHARS

  return {
    phase,
    description,
    currentIteration,
    iterationCount,
    history,
    questionStates,
    questionsRepeated,
    chatMessages,
    selectedTrack,
    trackScores,
    suggestedNextTrack,
    grillProvider,
    activeTab,
    condensedDocument,
    isCondensing,
    decisions,
    requirementDocument,
    totalQuestions,
    answeredCount,
    canSubmit,
    shouldSuggestCompletion,
    isAtCharLimit,
    setPhase,
    setQuestionStates,
    setActiveTab,
    setGrillProvider,
    startTrackGrill,
    handleSubmit,
    handleBackToTracks,
    handleStopGrill,
    handleSaveAndExit,
    handleConvertDirectly,
    handleCondense
  }
}
