/**
 * GrillPersistenceController — sits between GrillAgentService events and the renderer.
 *
 * Responsibilities:
 *   1. Persist messages to DB as chunks arrive (buffered — flush every 2 seconds or on boundaries)
 *   2. Forward events to renderer (same as current wireGrillEvents)
 *   3. Update session status on state transitions
 *   4. Handle reconnect — when renderer mounts, serve full state from DB + attach to live events
 */

import log from 'electron-log'
import type { GrillTrackId, GrillEvaluation, ToolActivity } from '../../shared/types'
import type { GrillSession, GrillSessionStatus } from '../db/repositories/grill-session.repository'
import { grillSessionRepository } from '../db/repositories'
import { getDatabase } from '../db/index'
import { IPC_CHANNELS } from '../../shared/constants'
import { getSessionEventRouter, type SessionEventRouter } from './session-event-router'
import { TextDeltaBatcher } from '../ipc/text-delta-batcher'

const ctrlLog = log.scope('grill-persistence')

/** Lightweight chat message shape for DB persistence */
interface PersistableMessage {
  type: string
  content?: string
  toolActivities?: unknown[]
  score?: number
  scoreLabel?: string
  feedback?: string
  trackName?: string
  questions?: unknown[]
  questionStates?: Record<string, unknown>
}

/** Status payload sent to the renderer */
export interface GrillStatusPayload {
  status: GrillSessionStatus
  ideaId: string
  trackId: GrillTrackId | null
  score: number | null
}

// GRILL-01 + GRILL-06: Per-workspace tracking state to prevent concurrent
// evaluations from overwriting each other's session/idea/track IDs.
interface WorkspaceTrackingState {
  sessionId: string
  ideaId: string
  trackId: GrillTrackId
  workspaceId: string
  evaluationHandled: boolean
  messageBuffer: PersistableMessage[]
  flushTimer: NodeJS.Timeout | null
}

export class GrillPersistenceController {
  /** Per-workspace tracking state — keyed by workspaceId. */
  private activeSessions = new Map<string, WorkspaceTrackingState>()
  /** Batches renderer-bound text at ~30fps so grill streams as smoothly as chat. */
  private textBatcher = new TextDeltaBatcher()

  /** Buffer flush interval in ms */
  private static readonly FLUSH_INTERVAL_MS = 2000

  /** Get tracking state for a workspace (returns null if not tracking). */
  private getTracking(workspaceId: string): WorkspaceTrackingState | null {
    return this.activeSessions.get(workspaceId) ?? null
  }

  // ── Public API ────────────────────────────────────────────────────────

  /** Start tracking a grill evaluation — creates/updates DB session */
  async startTracking(ideaId: string, workspaceId: string, trackId: GrillTrackId): Promise<string> {
    // Check for existing session for this idea
    let session = grillSessionRepository.findByIdeaId(ideaId)

    if (session) {
      // Re-use existing session — update track + status
      grillSessionRepository.updateTrackId(session.id, trackId)
      grillSessionRepository.updateStatus(session.id, 'evaluating')
    } else {
      // Create new session
      session = grillSessionRepository.create(ideaId, workspaceId, trackId)
      grillSessionRepository.updateStatus(session.id, 'evaluating')
    }

    // GRILL-TIMER-RACE-01 + GRILL-BUFFER-ORPHAN-01: Clear old flush timer and
    // flush buffered messages before overwriting tracking state to prevent
    // dangling timers and orphaned message data.
    const oldTracking = this.activeSessions.get(workspaceId)
    if (oldTracking) {
      if (oldTracking.flushTimer) {
        clearTimeout(oldTracking.flushTimer)
      }
      this.flushToDb(workspaceId)
    }

    // GRILL-01: Store per-workspace tracking state
    this.activeSessions.set(workspaceId, {
      sessionId: session.id,
      ideaId,
      trackId,
      workspaceId,
      evaluationHandled: false,
      messageBuffer: [],
      flushTimer: null
    })

    // Emit status change so the bottom status bar shows the active "Grilling…"
    // pill immediately. Mirrors the markEvaluating / clearTracking pattern.
    try {
      const router = getSessionEventRouter()
      this.emitStatusChange(workspaceId, router, 'evaluating')
    } catch {
      /* router may not be initialized yet */
    }

    ctrlLog.info(
      `[grill-persistence] Tracking session=${session.id} idea=${ideaId} track=${trackId}`
    )
    return session.id
  }

  /** Handle stream chunk — buffer and forward to renderer */
  handleStreamChunk(
    chunkData: { type: string; content?: string; toolActivity?: ToolActivity },
    workspaceId: string,
    router: SessionEventRouter
  ): void {
    // Forward to renderer — text is batched at ~30fps (matching chat), tool
    // activities flush pending text first then forward immediately so ordering
    // is preserved. DB buffering below still accumulates per-chunk.
    if (chunkData.type === 'text' && chunkData.content) {
      this.textBatcher.push(workspaceId, chunkData.content, (text) => {
        router.sendWorkspaceEvent(IPC_CHANNELS.GRILL_STREAM_CHUNK, workspaceId, {
          type: 'text',
          content: text
        })
      })
    } else if (chunkData.type === 'tool_activity' && chunkData.toolActivity) {
      this.textBatcher.flush(workspaceId)
      router.sendWorkspaceEvent(IPC_CHANNELS.GRILL_STREAM_CHUNK, workspaceId, chunkData)
    } else {
      router.sendWorkspaceEvent(IPC_CHANNELS.GRILL_STREAM_CHUNK, workspaceId, chunkData)
    }

    // Buffer agent content for DB persistence (per-workspace buffer)
    const tracking = this.getTracking(workspaceId)
    if (tracking) {
      const buffer = tracking.messageBuffer
      if (chunkData.type === 'text' && chunkData.content) {
        // Accumulate text into buffer — will be flushed as agent message
        const lastMsg = buffer[buffer.length - 1]
        if (lastMsg && lastMsg.type === 'agent') {
          lastMsg.content = (lastMsg.content ?? '') + chunkData.content
        } else {
          buffer.push({ type: 'agent', content: chunkData.content, toolActivities: [] })
        }
      } else if (chunkData.type === 'tool_activity' && chunkData.toolActivity) {
        // Append tool activity to the current agent message
        const lastMsg = buffer[buffer.length - 1]
        if (lastMsg && lastMsg.type === 'agent') {
          if (!lastMsg.toolActivities) lastMsg.toolActivities = []
          // Merge tool_use → tool_result by ID
          const existingIdx = lastMsg.toolActivities.findIndex(
            (ta: unknown) => (ta as Record<string, unknown>).id === chunkData.toolActivity!.id
          )
          if (existingIdx >= 0) {
            lastMsg.toolActivities[existingIdx] = {
              ...(lastMsg.toolActivities[existingIdx] as Record<string, unknown>),
              ...chunkData.toolActivity
            }
          } else {
            lastMsg.toolActivities.push(chunkData.toolActivity)
          }
        } else {
          buffer.push({
            type: 'agent',
            content: '',
            toolActivities: [chunkData.toolActivity]
          })
        }
      }

      // Schedule flush if not already pending
      this.scheduleFlush(workspaceId)
    }
  }

  /** Handle evaluation result — persist score + questions, update status */
  handleEvaluationResult(
    evaluation: GrillEvaluation,
    workspaceId: string,
    router: SessionEventRouter
  ): void {
    // Flush any buffered narration before the evaluation result so text ordering
    // is preserved on the renderer.
    this.textBatcher.flush(workspaceId)

    // Forward to renderer via router
    router.sendWorkspaceEvent(
      IPC_CHANNELS.GRILL_EVALUATION_RESULT,
      workspaceId,
      evaluation as unknown as Record<string, unknown>
    )

    const tracking = this.getTracking(workspaceId)
    if (!tracking) return

    // Flush any pending text/tool messages first
    this.flushToDb(workspaceId)

    // GRILL-TX-NOERRHANDLING-01: Wrap transaction in try-catch so a DB failure
    // doesn't crash the event listener. If it fails, evaluationHandled stays false
    // and handleComplete() recovery logic will kick in.
    try {
      const db = getDatabase()
      db.transaction(() => {
        grillSessionRepository.updateScore(
          tracking.sessionId,
          evaluation.score,
          evaluation.scoreLabel,
          evaluation.feedback
        )
        grillSessionRepository.updateQuestionStates(
          tracking.sessionId,
          null, // question states will be set by user answers
          evaluation
        )
        grillSessionRepository.updateStatus(tracking.sessionId, 'awaiting_answers')
      })()

      // GRILL-EVAL-01: Set flag AFTER transaction succeeds so recovery logic in
      // handleComplete() can detect and handle DB failures.
      tracking.evaluationHandled = true
    } catch (err) {
      ctrlLog.error('[grill-persistence] Evaluation transaction failed:', err)
      // evaluationHandled stays false — handleComplete() will recover gracefully
    }

    // GRILL-HANDLEEVAL-EMIT-UNGUARDED-01: Wrap in try-catch matching
    // startTracking/clearTracking pattern. If router throws here,
    // evaluationHandled is already set — recovery in handleComplete() is safe.
    try {
      this.emitStatusChange(workspaceId, router, 'awaiting_answers')
    } catch {
      /* router may not be initialized or window destroyed */
    }

    ctrlLog.info(
      `[grill-persistence] Evaluation complete — session=${tracking.sessionId} score=${evaluation.score}`
    )
  }

  /** Handle stream complete — flush buffer, finalize */
  handleComplete(workspaceId: string, router: SessionEventRouter): void {
    // Flush trailing narration before the complete event, then forget the flusher.
    this.textBatcher.reset(workspaceId)

    // Forward to renderer via router
    router.sendWorkspaceEvent(IPC_CHANNELS.GRILL_STREAM_COMPLETE, workspaceId, {})

    const tracking = this.getTracking(workspaceId)

    // GRILL-FLUSH-UNWAITED-01: Flush remaining buffer using a local reference
    // instead of going through flushToDb() → getTracking(). If flushToDb()
    // fails and schedules a retry via scheduleFlush(), the retry fires after
    // tracking is deleted — permanently orphaning the buffer. By flushing
    // directly here, we fail-fast on the final flush and avoid dangling retries.
    if (tracking && tracking.messageBuffer.length > 0) {
      if (tracking.flushTimer) {
        clearTimeout(tracking.flushTimer)
        tracking.flushTimer = null
      }
      try {
        grillSessionRepository.appendMessages(tracking.sessionId, tracking.messageBuffer)
        tracking.messageBuffer = []
      } catch (err) {
        ctrlLog.error('[grill-persistence] Final flush failed — messages lost:', err)
      }
    }

    // GRILL-06: Guard uses per-workspace evaluationHandled flag
    // Guard against the empty-evaluation dead-end: if the stream ended without
    // a parseable evaluation block (handleEvaluationResult never fired), the
    // session is still pinned at 'evaluating' and nothing will ever move it.
    // Revert it to a recoverable state so the UI doesn't get stuck "Grilling…".
    if (tracking && !tracking.evaluationHandled) {
      const session = grillSessionRepository.findById(tracking.sessionId)
      if (session && session.status === 'evaluating') {
        const recovered: GrillSessionStatus =
          session.currentScore !== null ? 'awaiting_answers' : 'failed'
        grillSessionRepository.updateStatus(tracking.sessionId, recovered)
        this.emitStatusChange(workspaceId, router, recovered)
        ctrlLog.warn(
          `[grill-persistence] Stream ended with no evaluation — reverting session=${tracking.sessionId} evaluating→${recovered}`
        )
      }
    }

    // GRILL-TRACK-01: Clean up tracking state to prevent memory leaks and
    // potential message corruption if a new evaluation starts in the same workspace.
    if (tracking) {
      if (tracking.flushTimer) {
        clearTimeout(tracking.flushTimer)
        tracking.flushTimer = null
      }
      this.activeSessions.delete(workspaceId)
    }

    ctrlLog.info(`[grill-persistence] Stream complete — session=${tracking?.sessionId ?? 'none'}`)
  }

  /** Save user's question answers to DB */
  saveAnswers(sessionId: string, questionStates: Record<string, unknown>): void {
    const session = grillSessionRepository.findById(sessionId)
    if (!session) return

    // GRILL-SAVEANSWERS-NOGUARD-01: Wrap in try-catch to prevent a DB error
    // from propagating to the IPC handler as an unhandled exception.
    try {
      grillSessionRepository.updateQuestionStates(sessionId, questionStates, session.currentIteration)
    } catch (err) {
      ctrlLog.error(`[grill-persistence] saveAnswers failed for session=${sessionId}:`, err)
    }
  }

  /** Mark session as evaluating (re-evaluation after answers) */
  markEvaluating(sessionId: string, workspaceId: string): void {
    grillSessionRepository.updateStatus(sessionId, 'evaluating')

    const session = grillSessionRepository.findById(sessionId)
    if (session && session.trackId) {
      // GRILL-TIMER-RACE-01 + GRILL-BUFFER-ORPHAN-01: Clear old timer and flush
      // buffer before overwriting to prevent dangling timers and data loss.
      const oldTracking = this.activeSessions.get(workspaceId)
      if (oldTracking) {
        if (oldTracking.flushTimer) {
          clearTimeout(oldTracking.flushTimer)
        }
        this.flushToDb(workspaceId)
      }

      // GRILL-01: Update per-workspace tracking state
      this.activeSessions.set(workspaceId, {
        sessionId,
        ideaId: session.ideaId,
        trackId: session.trackId,
        workspaceId,
        evaluationHandled: false,
        messageBuffer: [],
        flushTimer: null
      })
    }

    // GRILL-MARKEVALUATING-EMIT-UNGUARDED-01: Wrap router calls in try-catch
    // matching the pattern in startTracking/clearTracking.
    try {
      const router = getSessionEventRouter()
      this.emitStatusChange(workspaceId, router, 'evaluating')
    } catch {
      /* router may not be initialized during re-evaluation */
    }
  }

  /** Get the current grill status for a workspace (for status bar + icons) */
  getStatusForWorkspace(workspaceId: string): GrillStatusPayload | null {
    const sessions = grillSessionRepository.getActiveForWorkspace(workspaceId)
    if (sessions.length === 0) return null

    const active = sessions[0]
    return {
      status: active.status,
      ideaId: active.ideaId,
      trackId: active.trackId,
      score: active.currentScore
    }
  }

  /** Get full session state for reconnect */
  getSessionState(ideaId: string): GrillSession | null {
    return grillSessionRepository.findByIdeaId(ideaId)
  }

  /** Get the currently active session ID (first active session, for backward compat) */
  get currentSessionId(): string | null {
    for (const state of this.activeSessions.values()) {
      return state.sessionId
    }
    return null
  }

  /**
   * Emit a terminal status event (completed/cancelled) so the renderer badge
   * clears immediately. Called from GRILL_COMPLETE and GRILL_DISCARD handlers.
   */
  notifyTerminal(workspaceId: string, ideaId: string, status: GrillSessionStatus): void {
    try {
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.GRILL_STATUS_CHANGED, workspaceId, {
        status,
        ideaId,
        trackId: null,
        score: null
      })
    } catch {
      /* router may not be initialized */
    }
    const tracking = this.getTracking(workspaceId)
    if (tracking && tracking.ideaId === ideaId) {
      this.flushToDb(workspaceId)
      this.activeSessions.delete(workspaceId)
    }
  }

  /** Clear active tracking (on cancel). Optionally scoped to a workspace. */
  clearTracking(workspaceId?: string): void {
    // GRILL-02 + GRILL-03: Accept workspaceId so cancel targets the right workspace
    // and status emission uses the correct workspaceId instead of empty string.
    if (workspaceId) {
      const tracking = this.getTracking(workspaceId)
      if (tracking) {
        // GRILL-TIMER-01: Clear flush timer before cleanup to prevent
        // dangling setTimeout callbacks accessing deleted tracking state.
        if (tracking.flushTimer) {
          clearTimeout(tracking.flushTimer)
          tracking.flushTimer = null
        }
        this.textBatcher.reset(workspaceId)
        grillSessionRepository.updateStatus(tracking.sessionId, 'cancelled')
        try {
          const router = getSessionEventRouter()
          this.emitStatusChange(workspaceId, router, 'cancelled')
        } catch {
          /* router may not be initialized during early cancellation */
        }
        this.flushToDb(workspaceId)
        this.activeSessions.delete(workspaceId)
      }
    } else {
      // Cancel ALL active sessions (backward compat)
      for (const [wsId, tracking] of this.activeSessions) {
        // GRILL-TIMER-01: Clear flush timer before cleanup
        if (tracking.flushTimer) {
          clearTimeout(tracking.flushTimer)
          tracking.flushTimer = null
        }
        this.textBatcher.reset(wsId)
        grillSessionRepository.updateStatus(tracking.sessionId, 'cancelled')
        try {
          const router = getSessionEventRouter()
          this.emitStatusChange(wsId, router, 'cancelled')
        } catch {
          /* router may not be initialized during early cancellation */
        }
        this.flushToDb(wsId)
      }
      this.activeSessions.clear()
    }
  }

  // ── Private ───────────────────────────────────────────────────────────

  /** Schedule a deferred flush to DB for a specific workspace */
  private scheduleFlush(workspaceId: string): void {
    const tracking = this.getTracking(workspaceId)
    if (!tracking || tracking.flushTimer) return
    tracking.flushTimer = setTimeout(() => {
      tracking.flushTimer = null
      this.flushToDb(workspaceId)
    }, GrillPersistenceController.FLUSH_INTERVAL_MS)
  }

  /** Flush buffered messages to DB for a specific workspace */
  private flushToDb(workspaceId: string): void {
    const tracking = this.getTracking(workspaceId)
    if (!tracking) return

    if (tracking.flushTimer) {
      clearTimeout(tracking.flushTimer)
      tracking.flushTimer = null
    }

    if (tracking.messageBuffer.length === 0) return

    try {
      grillSessionRepository.appendMessages(tracking.sessionId, tracking.messageBuffer)
      // GRILL-MSG-LOSS-01: Only clear buffer on successful write.
      // Previously, buffer was always cleared — even on DB failure — causing
      // permanent data loss. Now we retain and retry on next flush.
      tracking.messageBuffer = []
    } catch (err) {
      ctrlLog.error('[grill-persistence] Failed to flush messages — will retry:', err)
      this.scheduleFlush(workspaceId)
    }
  }

  /** Emit status change event to renderer */
  private emitStatusChange(
    workspaceId: string,
    router: SessionEventRouter,
    status: GrillSessionStatus
  ): void {
    const tracking = this.getTracking(workspaceId)
    const payload: GrillStatusPayload = {
      status,
      ideaId: tracking?.ideaId ?? '',
      trackId: tracking?.trackId ?? null,
      score: null
    }

    // Fetch current score from DB for accuracy
    if (tracking) {
      const session = grillSessionRepository.findById(tracking.sessionId)
      if (session) {
        payload.score = session.currentScore
      }
    }

    router.sendWorkspaceEvent(
      IPC_CHANNELS.GRILL_STATUS_CHANGED,
      workspaceId,
      payload as unknown as Record<string, unknown>
    )
  }
}

export const grillPersistenceController = new GrillPersistenceController()
