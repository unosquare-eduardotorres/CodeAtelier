import { useEffect } from 'react'
import {
  useGrillStreamStore,
  getFlatContent,
  getFlatToolActivities
} from '@renderer/store/grill-stream.store'
import { stripGrillEvaluationBlocks } from '@renderer/utils/strip-grill-json'
import type { GrillTrackId, GrillTrackScore } from '../../../../../shared/types'
import { GRILL_TRACKS } from '../../../../../shared/constants'
import type { GrillChatMessage, GrillPhase } from '../GrillChatView'
import type { GrillIteration } from './useGrillQuestionState'

/**
 * Hook that subscribes to grill stream events (chunk, evaluation result, complete)
 * and updates local state accordingly.
 *
 * Extracted from useGrillSession to isolate stream event wiring.
 */
export function useGrillStreamListeners(opts: {
  selectedTrack: GrillTrackId | null
  setChatMessages: React.Dispatch<React.SetStateAction<GrillChatMessage[]>>
  setCurrentIteration: (iteration: GrillIteration) => void
  setPhase: (phase: GrillPhase) => void
  setTrackScores: React.Dispatch<React.SetStateAction<GrillTrackScore[]>>
  setSuggestedNextTrack: (val: { trackId: GrillTrackId; reason: string } | null) => void
  checkAndSetRepeated: (questions: unknown[]) => void
  initQuestionStates: (questions: unknown[]) => void
}): void {
  const {
    selectedTrack,
    setChatMessages,
    setCurrentIteration,
    setPhase,
    setTrackScores,
    setSuggestedNextTrack,
    checkAndSetRepeated,
    initQuestionStates
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

      const resolvedTrackId = (data.trackId ?? selectedTrack) as GrillTrackId | null
      if (resolvedTrackId) {
        setTrackScores((prev) => {
          const existing = prev.filter((ts) => ts.trackId !== resolvedTrackId)
          return [
            ...existing,
            {
              trackId: resolvedTrackId,
              score: data.score,
              scoreLabel: data.scoreLabel,
              iterationCount:
                (prev.find((ts) => ts.trackId === resolvedTrackId)?.iterationCount ?? 0) + 1,
              lastFeedback: data.feedback
            }
          ]
        })
      }

      if (data.suggestedNextTrack) {
        setSuggestedNextTrack(data.suggestedNextTrack as { trackId: GrillTrackId; reason: string })
      }

      checkAndSetRepeated(data.questions)
      initQuestionStates(data.questions)
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
  }, [selectedTrack])
}
