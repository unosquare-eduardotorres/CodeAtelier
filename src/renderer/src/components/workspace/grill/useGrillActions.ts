import { useCallback } from 'react'
import { useGrillStreamStore } from '@renderer/store/grill-stream.store'
import type { QuestionState } from '@renderer/components/chat'
import type { GrillTrackId, GrillTrackScore, LLMProvider } from '../../../../../shared/types'
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
  completeFromGrill: (conversationId: string, description: string) => Promise<void>
  convertDirect: (ideaId: string, workspaceId: string) => Promise<{ conversation: { id: string } }>
  loadConversations: (workspaceId: string) => Promise<void>
  selectConversation: (conversationId: string) => Promise<void>
  sendMessage: (message: string) => Promise<void>
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
    await saveDecisions(currentIteration.score, updatedHistory, trackScores)
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
    try {
      await window.api.grillCancel()
    } catch (error) {
      console.error('Failed to cancel grill:', error)
    }
    setPhase('paused')
  }, [setPhase])

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

    if (activeWorkspace) {
      try {
        const { conversation: newConv } = await convertDirect(ideaId, activeWorkspace.id)
        await loadConversations(activeWorkspace.id)
        await selectConversation(newConv.id)
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
