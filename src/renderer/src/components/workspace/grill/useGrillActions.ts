import { useCallback } from 'react'
import { useGrillStreamStore } from '@renderer/store/grill-stream.store'
import type { QuestionState } from '@renderer/components/chat'
import type { GrillTrackId, GrillTrackScore, Idea } from '../../../../../shared/types'
import { GRILL_TRACKS } from '../../../../../shared/constants'
import type { GrillChatMessage, GrillPhase } from '../GrillChatView'
import type { GrillIteration } from './useGrillQuestionState'
import type { HistoryEntry } from './useSaveGrillDecisions'

/**
 * Hook that encapsulates the 6 grill action handlers + the `finalize()` dedup helper.
 *
 * Extracted from useGrillSession to isolate action dispatching.
 */
export function useGrillActions(opts: {
  ideaId: string
  ideaTitle: string
  conversationId: string
  description: string
  activeWorkspace: { id: string } | null
  currentIteration: GrillIteration | null
  selectedTrack: GrillTrackId | null
  iterationCount: number
  history: HistoryEntry[]
  trackScores: GrillTrackScore[]
  questionStates: Record<string, QuestionState>
  chatMessages: GrillChatMessage[]
  condensedDocument: string | undefined
  saveDecisions: (
    score: number,
    historyEntries: HistoryEntry[],
    currentTrackScores: GrillTrackScore[],
    messages?: GrillChatMessage[],
    iteration?: GrillIteration | null,
    qStates?: Record<string, QuestionState>
  ) => Promise<void>
  formatAnswers: () => string
  buildFullDescription: (historyEntries: HistoryEntry[]) => string
  setPhase: (phase: GrillPhase) => void
  setIterationCount: (count: number) => void
  setChatMessages: React.Dispatch<React.SetStateAction<GrillChatMessage[]>>
  setHistory: React.Dispatch<React.SetStateAction<HistoryEntry[]>>
  setQuestionsRepeated: (val: boolean) => void
  completeFromGrill: (conversationId: string, summary?: string) => Promise<Idea | null>
  convertDirect: (ideaId: string, workspaceId: string) => Promise<{ conversation: { id: string } }>
  loadConversations: (workspaceId: string) => Promise<void>
  selectConversation: (conversationId: string) => Promise<void>
  appendLocalMessage: (content: string, opts?: { role?: 'da-vinci' }) => void
  setStreamingIndicator: (active: boolean) => void
  onBack: () => void
  onComplete: () => void
}): {
  handleSubmit: () => Promise<void>
  handleBackToTracks: () => Promise<void>
  handleStopGrill: () => Promise<void>
  handleSaveAndExit: () => Promise<void>
  handleConvertDirectly: () => Promise<void>
} {
  const {
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
    appendLocalMessage,
    setStreamingIndicator,
    onBack,
    onComplete
  } = opts

  /** Shared pattern: cancel the grill, persist decisions, then transition phase. */
  const finalize = useCallback(
    async (nextPhase: GrillPhase) => {
      try {
        await window.api.grillCancel()
      } catch {
        /* non-fatal */
      }
      await saveDecisions(currentIteration?.score ?? 0, history, trackScores)
      setPhase(nextPhase)
    },
    [currentIteration, history, trackScores, saveDecisions, setPhase]
  )

  const handleSubmit = useCallback(async () => {
    if (!currentIteration || !activeWorkspace || !selectedTrack) return
    if (description.length >= MAX_DESCRIPTION_CHARS) return

    const answersText = formatAnswers()
    const newIterationCount = iterationCount + 1
    setIterationCount(newIterationCount)

    // Build the new messages array explicitly so the persisted snapshot includes
    // the just-submitted iteration (avoids the one-iteration lag from the stale
    // chatMessages closure that setChatMessages' updater would otherwise hide).
    const updatedMessages: GrillChatMessage[] = [
      ...chatMessages,
      {
        type: 'questions',
        questions: currentIteration.questions,
        questionStates: { ...questionStates }
      },
      { type: 'user', content: answersText }
    ]
    setChatMessages(updatedMessages)

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
    await saveDecisions(currentIteration.score, updatedHistory, trackScores, updatedMessages)
    useGrillStreamStore.getState().reset()

    const historyText = updatedHistory
      .map((h) => {
        const trackLabel = h.trackId ? ` [${GRILL_TRACKS[h.trackId]?.name ?? h.trackId}]` : ''
        return `### Iteration ${h.iteration}${trackLabel}\nScore: ${h.score}/100\nFeedback: ${h.feedback}\nDecisions:\n${h.answersFormatted}`
      })
      .join('\n\n')

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
    trackScores,
    questionStates,
    chatMessages,
    ideaId,
    setIterationCount,
    setChatMessages,
    setHistory,
    setPhase,
    setQuestionsRepeated
  ])

  const handleBackToTracks = useCallback(async () => {
    await finalize('selecting')
  }, [finalize])

  const handleStopGrill = useCallback(async () => {
    // Stop = cancel + persist (mirrors Save & Exit without the navigation), so a
    // stopped grill restores with full state instead of an agent-only chat.
    await finalize('paused')
  }, [finalize])

  const handleSaveAndExit = useCallback(async () => {
    await finalize('paused')
    onBack()
  }, [finalize, onBack])

  const handleConvertDirectly = useCallback(async () => {
    const fullDescription = buildFullDescription(history)
    const effectiveDescription = condensedDocument || fullDescription
    await saveDecisions(currentIteration?.score ?? 0, history, trackScores)

    try {
      await completeFromGrill(conversationId, effectiveDescription)
    } catch (error) {
      console.error('Failed to complete from grill:', error)
    }

    // No workspace → nothing to convert; just close the grill view.
    if (!activeWorkspace) {
      onComplete()
      return
    }

    try {
      const { conversation: newConv } = await convertDirect(ideaId, activeWorkspace.id)
      await loadConversations(activeWorkspace.id)
      await selectConversation(newConv.id)

      // Kick off deterministic plan synthesis BEFORE navigating so unmounting the
      // grill view can't race/cancel the in-flight backend call. The grill Q&A
      // already gathered every clarifying decision, so there are no questions on
      // this path — we go straight from handoff to synthesis to the plan card.
      const planPromise = window.api.grillGeneratePlan({
        sessionId: conversationId,
        ideaId,
        workspaceId: activeWorkspace.id
      })

      // Step 1+3 — Handoff: close the grill, land in chat immediately with a
      // spinner + status line while the plan synthesizes in the background.
      onComplete()
      setStreamingIndicator(true)
      appendLocalMessage('Synthesizing the plan from your grilled decisions…', {
        role: 'da-vinci'
      })

      try {
        // Step 4 — seed the deterministic plan card, then re-fetch so the
        // persisted lead-in + card replace the transient status placeholder.
        const plan = await planPromise
        await window.api.grillSeedPlanCard({ conversationId: newConv.id, plan })
        await selectConversation(newConv.id)
      } catch (err) {
        // NEVER paste the raw requirement prompt as a user message. Surface a
        // recoverable status the user can act on instead.
        console.error('Grill plan synthesis failed:', err)
        appendLocalMessage(
          "I couldn't synthesize the plan from your grilled decisions. Send a message to retry, or refine the idea.",
          { role: 'da-vinci' }
        )
      } finally {
        setStreamingIndicator(false)
      }
    } catch (error) {
      console.error('Failed to create planning conversation:', error)
      onComplete()
    }

    // Final handoff — strip transient grill state (Convert Directly keeps no plan).
    try {
      await window.api.grillComplete({ ideaId })
    } catch (error) {
      console.error('grillComplete failed:', error)
    }
  }, [
    currentIteration,
    history,
    ideaId,
    completeFromGrill,
    conversationId,
    onComplete,
    activeWorkspace,
    buildFullDescription,
    condensedDocument,
    convertDirect,
    loadConversations,
    selectConversation,
    appendLocalMessage,
    setStreamingIndicator,
    saveDecisions,
    trackScores
  ])

  return {
    handleSubmit,
    handleBackToTracks,
    handleStopGrill,
    handleSaveAndExit,
    handleConvertDirectly
  }
}

/** Soft cap for enriched description — suggest completion after this length */
const MAX_DESCRIPTION_CHARS = 15_000
