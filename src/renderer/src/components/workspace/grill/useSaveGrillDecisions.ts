import { useCallback } from 'react'
import type { QuestionState } from '@renderer/components/chat'
import type { GrillTrackId, GrillTrackScore } from '../../../../../shared/types'
import type { GrillChatMessage } from '../GrillChatView'
import type { GrillIteration } from './useGrillQuestionState'

/**
 * Hook that encapsulates async decision serialization + IPC persistence.
 *
 * Extracted from useGrillSession to isolate the save/persistence concern.
 */
export function useSaveGrillDecisions(opts: {
  ideaId: string
  iterationCount: number
  selectedTrack: GrillTrackId | null
  chatMessages: GrillChatMessage[]
  currentIteration: GrillIteration | null
  questionStates: Record<string, QuestionState>
  buildFullDescription: (historyEntries: HistoryEntry[]) => string
}): {
  saveDecisions: (
    score: number,
    historyEntries: HistoryEntry[],
    currentTrackScores: GrillTrackScore[],
    messages?: GrillChatMessage[],
    iteration?: GrillIteration | null,
    qStates?: Record<string, QuestionState>
  ) => Promise<void>
} {
  const {
    ideaId,
    iterationCount,
    selectedTrack,
    chatMessages,
    currentIteration,
    questionStates,
    buildFullDescription
  } = opts

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

      const decisionsJson = JSON.stringify({
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
        await window.api.saveIdeaGrillDecisions({ ideaId, decisions: decisionsJson })
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

  return { saveDecisions }
}

export interface HistoryEntry {
  iteration: number
  score: number
  feedback: string
  answersFormatted: string
  trackId?: GrillTrackId
}
