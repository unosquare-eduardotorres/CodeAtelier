import { useEffect, useRef } from 'react'
import { useIdeaStore } from '@renderer/store/idea.store'
import type { GrillTrackId, GrillTrackScore, GrillStructuredPlan } from '../../../../../shared/types'
import type { GrillChatMessage, GrillPhase } from '../GrillChatView'
import type { GrillIteration } from './useGrillQuestionState'
import type { HistoryEntry } from './useSaveGrillDecisions'

interface RestoreSetters {
  setPhase: (phase: GrillPhase) => void
  setIterationCount: (n: number) => void
  setHistory: (h: HistoryEntry[]) => void
  setTrackScores: (ts: GrillTrackScore[]) => void
  setChatMessages: (msgs: GrillChatMessage[]) => void
  setSelectedTrack: (t: GrillTrackId | null) => void
  setCurrentIteration: (iter: GrillIteration | null) => void
  initQuestionStates: (questions: GrillIteration['questions']) => void
  onRestorePlan?: (plan: GrillStructuredPlan) => void
}

/** Restores a grill session from DB + snapshot on mount. */
export function useGrillSessionRestore(
  ideaId: string,
  isNewSession: boolean | undefined,
  setters: RestoreSetters
): void {
  const mountedRef = useRef(false)

  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true

    const init = async (): Promise<void> => {
      if (isNewSession) {
        setters.setPhase('selecting')
        return
      }

      // Fetch live DB session
      const dbSession = await fetchDbSession(ideaId)

      // Handle completed session
      if (dbSession?.status === 'completed') {
        if (dbSession.plan) {
          setters.onRestorePlan?.(dbSession.plan)
          setters.setPhase('completed')
        } else {
          setters.setPhase('selecting')
        }
        return
      }

      // Fetch JSON snapshot
      const snapshot = loadSnapshot(ideaId)

      // Nothing persisted → fresh selection
      if (!dbSession && !snapshot) {
        setters.setPhase('selecting')
        return
      }

      // Restore snapshot data
      if (snapshot) {
        if (snapshot.iterationCount) setters.setIterationCount(snapshot.iterationCount)
        if (snapshot.history) setters.setHistory(snapshot.history)
        if (snapshot.trackScores) setters.setTrackScores(snapshot.trackScores)
        if (snapshot.chatMessages) setters.setChatMessages(snapshot.chatMessages)
        if (snapshot.activeTrack) setters.setSelectedTrack(snapshot.activeTrack)
      }

      // Prefer live row's currentIteration, fall back to snapshot
      const currentIteration = dbSession?.currentIteration ?? snapshot?.currentIteration ?? null
      if (currentIteration) {
        setters.setCurrentIteration(currentIteration)
        setters.initQuestionStates(currentIteration.questions ?? [])
      }

      // Derive phase from status
      setters.setPhase(
        derivePhase(dbSession?.status, currentIteration, snapshot?.trackScores)
      )
    }
    init()
  }, [isNewSession, ideaId, setters])
}

// ── Helpers ──

async function fetchDbSession(ideaId: string): Promise<{
  status?: string
  currentIteration?: GrillIteration | null
  plan?: GrillStructuredPlan | null
} | null> {
  try {
    const s = await window.api.grillGetSession({ ideaId })
    if (s && typeof s === 'object') {
      return s as {
        status?: string
        currentIteration?: GrillIteration | null
        plan?: GrillStructuredPlan | null
      }
    }
  } catch {
    /* non-fatal */
  }
  return null
}

interface SnapshotData {
  iterationCount?: number
  history?: HistoryEntry[]
  trackScores?: GrillTrackScore[]
  chatMessages?: GrillChatMessage[]
  currentIteration?: GrillIteration | null
  activeTrack?: GrillTrackId
}

function loadSnapshot(ideaId: string): SnapshotData | null {
  try {
    const idea = useIdeaStore.getState().ideas.find((i) => i.id === ideaId)
    if (idea?.grillDecisions) return JSON.parse(idea.grillDecisions)
  } catch {
    /* ignore parse errors */
  }
  return null
}

function derivePhase(
  status: string | undefined,
  currentIteration: GrillIteration | null,
  trackScores: GrillTrackScore[] | undefined
): GrillPhase {
  const hasCurrentQuestions = (currentIteration?.questions?.length ?? 0) > 0
  const hasTrackScores = (trackScores?.length ?? 0) > 0
  if (status === 'evaluating') return 'evaluating'
  if (status === 'awaiting_answers' || hasCurrentQuestions) return 'answering'
  if (hasTrackScores) return 'selecting'
  return 'paused'
}
