import { useEffect, useRef } from 'react'
import { useIdeaStore } from '@renderer/store/idea.store'
import type {
  GrillTrackId,
  GrillTrackScore,
  GrillStructuredPlan
} from '../../../../../shared/types'
import type { GrillChatMessage, GrillPhase } from '../GrillChatView'
import type { GrillIteration } from './useGrillQuestionState'
import type { GrillQuestion } from '../../../../../shared/types'
import type { HistoryEntry } from './useSaveGrillDecisions'

interface UseGrillSessionRestoreOpts {
  ideaId: string
  isNewSession?: boolean
  setPhase: (phase: GrillPhase) => void
  setCurrentIteration: (iteration: GrillIteration | null) => void
  setIterationCount: (count: number) => void
  setHistory: (history: HistoryEntry[]) => void
  setTrackScores: (scores: GrillTrackScore[]) => void
  setChatMessages: (msgs: GrillChatMessage[]) => void
  setSelectedTrack: (track: GrillTrackId | null) => void
  initQuestionStates: (questions: GrillQuestion[]) => void
  onRestorePlan?: (plan: GrillStructuredPlan) => void
}

/**
 * On mount, restores a grill session from the DB row + snapshot, or starts fresh.
 *
 * The grill writes to two stores: the `grill_sessions` row (live status +
 * currentIteration, but agent-narration-only messages) and the
 * `ideas.grill_decisions` JSON snapshot (the ONLY place holding the full chat,
 * history, trackScores and per-iteration decisions). We read both and treat
 * the snapshot as authoritative for the data only it carries.
 */
export function useGrillSessionRestore(opts: UseGrillSessionRestoreOpts): void {
  const {
    ideaId,
    isNewSession,
    setPhase,
    setCurrentIteration,
    setIterationCount,
    setHistory,
    setTrackScores,
    setChatMessages,
    setSelectedTrack,
    initQuestionStates,
    onRestorePlan
  } = opts

  const mountedRef = useRef(false)

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
      const currentIter = dbSession?.currentIteration ?? snapshot?.currentIteration ?? null
      if (currentIter) {
        setCurrentIteration(currentIter)
        // Reset unsubmitted toggles — restored card starts from recommended defaults.
        initQuestionStates(currentIter.questions ?? [])
      }

      // Derive phase.
      const status = dbSession?.status
      const hasCurrentQuestions = (currentIter?.questions?.length ?? 0) > 0
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
}
