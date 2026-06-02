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
import type { GrillTrackId, GrillEvaluation } from '../../shared/types'
import type { GrillSession, GrillSessionStatus } from '../db/repositories/grill-session.repository'
import { grillSessionRepository } from '../db/repositories'
import { IPC_CHANNELS } from '../../shared/constants'
import { getSessionEventRouter, type SessionEventRouter } from './session-event-router'

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

export class GrillPersistenceController {
  private activeSessionId: string | null = null
  private activeIdeaId: string | null = null
  private activeTrackId: GrillTrackId | null = null
  private messageBuffer: PersistableMessage[] = []
  private flushTimer: NodeJS.Timeout | null = null

  /** Buffer flush interval in ms */
  private static readonly FLUSH_INTERVAL_MS = 2000

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

    this.activeSessionId = session.id
    this.activeIdeaId = ideaId
    this.activeTrackId = trackId

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
    chunkData: { type: string; content?: string; toolActivity?: Record<string, unknown> },
    workspaceId: string,
    router: SessionEventRouter
  ): void {
    // Forward to renderer immediately via router
    router.sendWorkspaceEvent(IPC_CHANNELS.GRILL_STREAM_CHUNK, workspaceId, chunkData)

    // Buffer agent content for DB persistence
    if (chunkData.type === 'text' && chunkData.content) {
      // Accumulate text into buffer — will be flushed as agent message
      const lastMsg = this.messageBuffer[this.messageBuffer.length - 1]
      if (lastMsg && lastMsg.type === 'agent') {
        lastMsg.content = (lastMsg.content ?? '') + chunkData.content
      } else {
        this.messageBuffer.push({ type: 'agent', content: chunkData.content, toolActivities: [] })
      }
    } else if (chunkData.type === 'tool_activity' && chunkData.toolActivity) {
      // Append tool activity to the current agent message
      const lastMsg = this.messageBuffer[this.messageBuffer.length - 1]
      if (lastMsg && lastMsg.type === 'agent') {
        if (!lastMsg.toolActivities) lastMsg.toolActivities = []
        // Merge tool_use → tool_result by ID
        const existingIdx = lastMsg.toolActivities.findIndex(
          (ta: unknown) =>
            (ta as Record<string, unknown>).id ===
            (chunkData.toolActivity as Record<string, unknown>).id
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
        this.messageBuffer.push({
          type: 'agent',
          content: '',
          toolActivities: [chunkData.toolActivity]
        })
      }
    }

    // Schedule flush if not already pending
    this.scheduleFlush()
  }

  /** Handle evaluation result — persist score + questions, update status */
  handleEvaluationResult(
    evaluation: GrillEvaluation,
    workspaceId: string,
    router: SessionEventRouter
  ): void {
    // Forward to renderer via router
    router.sendWorkspaceEvent(
      IPC_CHANNELS.GRILL_EVALUATION_RESULT,
      workspaceId,
      evaluation as unknown as Record<string, unknown>
    )

    if (!this.activeSessionId) return

    // Flush any pending text/tool messages first
    this.flushToDb()

    // Persist evaluation data
    grillSessionRepository.updateScore(
      this.activeSessionId,
      evaluation.score,
      evaluation.scoreLabel,
      evaluation.feedback
    )

    // Save current iteration (questions + metadata)
    grillSessionRepository.updateQuestionStates(
      this.activeSessionId,
      null, // question states will be set by user answers
      evaluation
    )

    // Transition status
    grillSessionRepository.updateStatus(this.activeSessionId, 'awaiting_answers')

    // Emit status change
    this.emitStatusChange(workspaceId, router, 'awaiting_answers')

    ctrlLog.info(
      `[grill-persistence] Evaluation complete — session=${this.activeSessionId} score=${evaluation.score}`
    )
  }

  /** Handle stream complete — flush buffer, finalize */
  handleComplete(workspaceId: string, router: SessionEventRouter): void {
    // Forward to renderer via router
    router.sendWorkspaceEvent(IPC_CHANNELS.GRILL_STREAM_COMPLETE, workspaceId, {})

    // Flush any remaining buffered messages
    this.flushToDb()

    ctrlLog.info(`[grill-persistence] Stream complete — session=${this.activeSessionId}`)
  }

  /** Save user's question answers to DB */
  saveAnswers(sessionId: string, questionStates: Record<string, unknown>): void {
    const session = grillSessionRepository.findById(sessionId)
    if (!session) return

    grillSessionRepository.updateQuestionStates(sessionId, questionStates, session.currentIteration)
  }

  /** Mark session as evaluating (re-evaluation after answers) */
  markEvaluating(sessionId: string, workspaceId: string): void {
    grillSessionRepository.updateStatus(sessionId, 'evaluating')
    this.activeSessionId = sessionId

    const session = grillSessionRepository.findById(sessionId)
    if (session) {
      this.activeIdeaId = session.ideaId
      this.activeTrackId = session.trackId
    }

    const router = getSessionEventRouter()
    this.emitStatusChange(workspaceId, router, 'evaluating')
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

  /** Get the currently active session ID */
  get currentSessionId(): string | null {
    return this.activeSessionId
  }

  /** Clear active tracking (on cancel) */
  clearTracking(): void {
    if (this.activeSessionId) {
      grillSessionRepository.updateStatus(this.activeSessionId, 'cancelled')
      try {
        const router = getSessionEventRouter()
        this.emitStatusChange('', router, 'cancelled')
      } catch {
        /* router may not be initialized during early cancellation */
      }
    }
    this.flushToDb()
    this.activeSessionId = null
    this.activeIdeaId = null
    this.activeTrackId = null
  }

  // ── Private ───────────────────────────────────────────────────────────

  /** Schedule a deferred flush to DB */
  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushToDb()
    }, GrillPersistenceController.FLUSH_INTERVAL_MS)
  }

  /** Flush buffered messages to DB */
  private flushToDb(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (!this.activeSessionId || this.messageBuffer.length === 0) return

    try {
      grillSessionRepository.appendMessages(this.activeSessionId, this.messageBuffer)
    } catch (err) {
      ctrlLog.error('[grill-persistence] Failed to flush messages:', err)
    }

    this.messageBuffer = []
  }

  /** Emit status change event to renderer */
  private emitStatusChange(
    workspaceId: string,
    router: SessionEventRouter,
    status: GrillSessionStatus
  ): void {
    const payload: GrillStatusPayload = {
      status,
      ideaId: this.activeIdeaId ?? '',
      trackId: this.activeTrackId,
      score: null
    }

    // Fetch current score from DB for accuracy
    if (this.activeSessionId) {
      const session = grillSessionRepository.findById(this.activeSessionId)
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
