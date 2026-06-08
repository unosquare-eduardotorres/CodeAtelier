/**
 * useGrillQuestionState — Question tracking, answer collection, and submission validation.
 *
 * Extracted from useGrillSession to reduce complexity (~100 LOC).
 * Manages the current iteration's questions, user answers, repetition detection,
 * and formatting for submission.
 */

import { useState, useCallback, useRef, useMemo } from 'react'
import type { QuestionState } from '@renderer/components/chat'
import type { GrillQuestion, GrillTrackId } from '../../../../../shared/types'

export interface GrillIteration {
  score: number
  scoreLabel: string
  questions: GrillQuestion[]
  feedback: string
  trackId?: GrillTrackId
  suggestedNextTrack?: { trackId: GrillTrackId; reason: string }
}

interface UseGrillQuestionStateResult {
  // State
  currentIteration: GrillIteration | null
  setCurrentIteration: React.Dispatch<React.SetStateAction<GrillIteration | null>>
  questionStates: Record<string, QuestionState>
  setQuestionStates: React.Dispatch<React.SetStateAction<Record<string, QuestionState>>>
  questionsRepeated: boolean
  setQuestionsRepeated: (v: boolean) => void

  // Computed
  totalQuestions: number
  answeredCount: number
  canSubmit: boolean

  // Helpers
  formatAnswers: () => string
  /** Check if new questions match the previous set (indicates the LLM is stuck). */
  checkAndSetRepeated: (newQuestions: GrillQuestion[]) => boolean
  /** Initialize question states from evaluation result (pre-selects recommended options). */
  initQuestionStates: (questions: GrillQuestion[]) => void
}

export function useGrillQuestionState(): UseGrillQuestionStateResult {
  const [currentIteration, setCurrentIteration] = useState<GrillIteration | null>(null)
  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>({})
  const [questionsRepeated, setQuestionsRepeated] = useState(false)
  const previousQuestionsRef = useRef<string[]>([])

  // ── Computed ──

  const totalQuestions = currentIteration?.questions.length ?? 0

  const answeredCount = useMemo(() => {
    if (!currentIteration) return 0
    return currentIteration.questions.filter((q) => {
      const state = questionStates[q.id]
      if (!state) return false
      return state.skipped || state.selectedOptions.length > 0 || state.otherText.trim().length > 0
    }).length
  }, [currentIteration, questionStates])

  const canSubmit = useMemo(
    () =>
      currentIteration?.questions.every((q) => {
        const state = questionStates[q.id]
        if (!state) return false
        if (state.skipped) return true
        return (
          state.selectedOptions.length > 0 ||
          state.otherSelected ||
          state.otherText.trim().length > 0
        )
      }) ?? false,
    [currentIteration, questionStates]
  )

  // ── Helpers ──

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
      const fullQ = q.question !== q.header && q.header ? `\n  > ${q.question}` : ''
      parts.push(`- **${q.header || q.question}**: ${selected}${other}${fullQ}`)
    }
    return parts.join('\n')
  }, [currentIteration, questionStates])

  const checkAndSetRepeated = useCallback((newQuestions: GrillQuestion[]): boolean => {
    const newTexts = newQuestions.map((q) => q.question).sort()
    const prevTexts = [...previousQuestionsRef.current].sort()
    const isRepeated =
      prevTexts.length > 0 &&
      newTexts.length === prevTexts.length &&
      newTexts.every((text, i) => text === prevTexts[i])

    setQuestionsRepeated(isRepeated)
    previousQuestionsRef.current = newQuestions.map((q) => q.question)
    return isRepeated
  }, [])

  const initQuestionStates = useCallback((questions: GrillQuestion[]) => {
    const states: Record<string, QuestionState> = {}
    for (const q of questions) {
      const recommended = (q.options ?? []).filter((o) => o.recommended).map((o) => o.label)
      states[q.id] = {
        selectedOptions: recommended,
        otherText: '',
        otherSelected: false,
        skipped: false
      }
    }
    setQuestionStates(states)
  }, [])

  return {
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
  }
}
