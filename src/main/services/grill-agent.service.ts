/**
 * GrillAgentService — multi-workspace standalone evaluator for the Grill feature.
 *
 * Maintains a Map<workspaceId, GrillSession> so evaluations can run concurrently
 * across different workspaces. Single-shot per workspace: one evaluation per
 * invocation, streams directly to the renderer via events.
 *
 * Events are tagged with workspaceId so the IPC layer can route them correctly.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { GrillTrackId, GrillEvaluation, AgentStatus } from '../../shared/types'
import type { StreamChunk } from './agent-base.service'
import { AgentSessionService } from './agent-session.service'
import { GrillRoleAdapter } from './role-adapters/grill.adapter'
import { GreenfieldGrillRoleAdapter } from './role-adapters/greenfield-grill.adapter'

const grillLog = log.scope('grill-agent')

interface GrillSession {
  session: AgentSessionService
  running: boolean
  /** GRILL-GREENFIELD-CANCEL-ALWAYS-01: Track workspaceId for targeted cancel of greenfield sessions. */
  workspaceId?: string
}

// ── Service ────────────────────────────────────────────────────────────────

export class GrillAgentService extends EventEmitter {
  private sessions = new Map<string, GrillSession>()
  /** Greenfield evaluations don't have a workspace — use a synthetic key. */
  private greenfieldSession: GrillSession | null = null

  /** Check if ANY evaluation is running (backward compat). */
  get isRunning(): boolean {
    if (this.greenfieldSession?.running) return true
    for (const entry of this.sessions.values()) {
      if (entry.running) return true
    }
    return false
  }

  /** Check if a specific workspace has a running evaluation. */
  isRunningForWorkspace(workspaceId: string): boolean {
    return this.sessions.get(workspaceId)?.running ?? false
  }

  /**
   * Run a single grill evaluation for a workspace.
   * Emits: 'stream' (chunk), 'evaluation' (parsed result), 'complete' — all tagged with workspaceId.
   */
  async evaluate(params: {
    workspaceId: string
    workspacePath: string
    trackId: GrillTrackId
    ideaTitle: string
    ideaDescription: string
    iterationHistory?: string
    previousScore?: number
    llmProvider?: import('../../shared/types').LLMProvider
  }): Promise<void> {
    grillLog.info(
      `[grill] evaluate called — track=${params.trackId} workspace=${params.workspaceId}`
    )

    if (this.sessions.get(params.workspaceId)?.running) {
      grillLog.warn(`[grill] Already running for workspace ${params.workspaceId} — ignoring`)
      return
    }

    const adapter = new GrillRoleAdapter({
      workspaceId: params.workspaceId,
      trackId: params.trackId,
      ideaTitle: params.ideaTitle,
      ideaDescription: params.ideaDescription,
      iterationHistory: params.iterationHistory,
      previousScore: params.previousScore,
      llmProvider: params.llmProvider
    })

    const session = new AgentSessionService(adapter)
    const entry: GrillSession = { session, running: true }
    this.sessions.set(params.workspaceId, entry)

    // Wire streaming events for live output — tagged with workspaceId
    session.on('chunk', (chunk: StreamChunk) => {
      this.emit('stream', { workspaceId: params.workspaceId, chunk })
    })

    // Re-emit inner-session status (token/context counters) so the live token
    // usage modal reflects grill activity, not just chat.
    session.on('statusUpdate', (status: AgentStatus) => {
      this.emit('status', { workspaceId: params.workspaceId, status })
    })

    try {
      // Start session in plan mode (read-only)
      await session.start(params.workspacePath, 'plan')

      // Single-shot: send the evaluation trigger
      const syntheticConvId = `grill-${params.trackId}-${Date.now()}`
      const effectiveMessage = params.iterationHistory
        ? `Re-evaluate based on updated decisions:\n\n${params.iterationHistory}`
        : 'Begin your evaluation.'
      await session.send(effectiveMessage, syntheticConvId, [])

      // Collect the full response and parse evaluation
      const responseText = session.getStreamedContent()
      const evaluation = this.parseGrillEvaluation(responseText)

      // GRILL-CANCEL-RACE-01: Only emit evaluation if not cancelled during send()
      if (evaluation && entry.running) {
        grillLog.info(`[grill:${params.trackId}] completed — score=${evaluation.score}`)
        this.emit('evaluation', { workspaceId: params.workspaceId, ...evaluation })
      } else if (!entry.running) {
        grillLog.info(`[grill:${params.trackId}] cancelled — skipping evaluation emit`)
      } else {
        grillLog.warn(`[grill:${params.trackId}] completed but no grill-evaluation block found`)
      }
    } catch (err) {
      grillLog.error(`[grill:${params.trackId}] failed:`, err)
    } finally {
      try {
        await session.stop()
      } catch (e) {
        grillLog.debug('[grill] session.stop() cleanup failed (non-fatal):', e)
      }
      // GRILL-EVAL-NOCOMPL-01: Always emit 'complete' so the persistence controller
      // can clean up tracking state (flush timers, active session map). Pass cancelled
      // flag so listeners can distinguish normal completion from cancellation.
      const wasCancelled = !entry.running
      entry.running = false
      this.sessions.delete(params.workspaceId)
      this.emit('complete', { workspaceId: params.workspaceId, cancelled: wasCancelled })
    }
  }

  /**
   * Run a greenfield grill evaluation (for new project ideas — no workspace/code).
   * Emits: 'stream' (chunk), 'evaluation' (parsed result), 'complete'
   */
  async evaluateGreenfield(params: {
    trackId: GrillTrackId
    projectName: string
    projectDescription: string
    iterationHistory?: string
    previousScore?: number
    llmProvider?: import('../../shared/types').LLMProvider
    /** GRILL-04: Synthetic workspaceId for event routing in multi-window mode. */
    workspaceId?: string
  }): Promise<void> {
    grillLog.info(
      `[grill] evaluateGreenfield called — track=${params.trackId} project="${params.projectName}"`
    )

    if (this.greenfieldSession?.running) {
      grillLog.warn('[grill] Greenfield already running — ignoring duplicate start')
      return
    }

    const adapter = new GreenfieldGrillRoleAdapter({
      trackId: params.trackId,
      projectName: params.projectName,
      projectDescription: params.projectDescription,
      iterationHistory: params.iterationHistory,
      previousScore: params.previousScore,
      llmProvider: params.llmProvider
    })

    const session = new AgentSessionService(adapter)
    // GRILL-GREENFIELD-CANCEL-ALWAYS-01: Store workspaceId so cancel(wsId) can
    // verify it matches before cancelling an unrelated greenfield evaluation.
    const greenfieldEntry: GrillSession = { session, running: true, workspaceId: wsId }
    this.greenfieldSession = greenfieldEntry

    // GRILL-04: Include workspaceId in all greenfield events for correct routing
    const wsId = params.workspaceId

    // Wire streaming events for live output
    session.on('chunk', (chunk: StreamChunk) => {
      this.emit('stream', { workspaceId: wsId, chunk })
    })

    // Wire status updates so the modal's live counters move during a greenfield grill.
    session.on('statusUpdate', (status: AgentStatus) => {
      this.emit('status', { workspaceId: wsId, status })
    })

    try {
      // Use OS temp dir as working directory (no workspace exists yet)
      const os = await import('node:os')
      const workDir = os.tmpdir()

      await session.start(workDir, 'plan')

      const syntheticConvId = `greenfield-grill-${params.trackId}-${Date.now()}`
      const effectiveMessage = params.iterationHistory
        ? `Re-evaluate based on updated decisions:\n\n${params.iterationHistory}`
        : 'Begin your evaluation.'
      await session.send(effectiveMessage, syntheticConvId, [])

      const responseText = session.getStreamedContent()
      const evaluation = this.parseGrillEvaluation(responseText)

      // GRILL-CANCEL-RACE-01: Only emit evaluation if not cancelled during send()
      if (evaluation && greenfieldEntry.running) {
        grillLog.info(`[grill:greenfield:${params.trackId}] completed — score=${evaluation.score}`)
        this.emit('evaluation', { workspaceId: wsId, ...evaluation })
      } else if (!greenfieldEntry.running) {
        grillLog.info(`[grill:greenfield:${params.trackId}] cancelled — skipping evaluation emit`)
      } else {
        grillLog.warn(
          `[grill:greenfield:${params.trackId}] completed but no grill-evaluation block found`
        )
      }
    } catch (err) {
      grillLog.error(`[grill:greenfield:${params.trackId}] failed:`, err)
    } finally {
      try {
        await this.greenfieldSession.session.stop()
      } catch (e) {
        grillLog.debug('[grill:greenfield] session.stop() cleanup failed (non-fatal):', e)
      }
      // GRILL-EVAL-NOCOMPL-01: Always emit 'complete' so persistence controller cleans up.
      const wasCancelled = !greenfieldEntry.running
      this.greenfieldSession = null
      this.emit('complete', { workspaceId: wsId, cancelled: wasCancelled })
    }
  }

  /** Cancel the running evaluation for a specific workspace. */
  cancel(workspaceId?: string): void {
    grillLog.info(`[grill] Cancel requested${workspaceId ? ` for workspace ${workspaceId}` : ''}`)

    if (workspaceId) {
      const entry = this.sessions.get(workspaceId)
      if (entry?.session) {
        try {
          entry.session.cancelCurrentQuery()
        } catch (e) {
          grillLog.debug('[grill] cancelCurrentQuery() failed (non-fatal):', e)
        }
        entry.running = false
      }
      // GRILL-GREENFIELD-CANCEL-ALWAYS-01: Only cancel greenfield if its workspaceId
      // matches the cancel target. Previously, any workspace cancel would kill an
      // unrelated greenfield evaluation.
      if (this.greenfieldSession?.running && this.greenfieldSession.workspaceId === workspaceId) {
        try {
          this.greenfieldSession.session.cancelCurrentQuery()
        } catch (e) {
          grillLog.debug('[grill:greenfield] cancelCurrentQuery() failed (non-fatal):', e)
        }
        this.greenfieldSession.running = false
      }
    } else {
      // Cancel all (backward compat)
      for (const [, entry] of this.sessions) {
        try {
          entry.session.cancelCurrentQuery()
        } catch (e) {
          grillLog.debug('[grill] cancelCurrentQuery() failed (non-fatal):', e)
        }
        entry.running = false
      }
      if (this.greenfieldSession?.session) {
        try {
          this.greenfieldSession.session.cancelCurrentQuery()
        } catch (e) {
          grillLog.debug('[grill:greenfield] cancelCurrentQuery() failed (non-fatal):', e)
        }
        this.greenfieldSession.running = false
      }
    }
  }

  // ── Private: parse grill-evaluation from response ──────────────────

  private parseGrillEvaluation(text: string): GrillEvaluation | null {
    const regex = /```grill-evaluation\n([\s\S]*?)```/g
    let lastMatch: RegExpExecArray | null = null
    let match: RegExpExecArray | null

    // Use the last match in case the agent emits multiple blocks
    while ((match = regex.exec(text)) !== null) {
      lastMatch = match
    }

    if (!lastMatch) return null

    try {
      const parsed = JSON.parse(lastMatch[1]) as GrillEvaluation
      // GRILL-SCORE-RANGE-01: Validate required fields AND score range (0–10, finite)
      if (
        typeof parsed.score !== 'number' ||
        !Number.isFinite(parsed.score) ||
        parsed.score < 0 ||
        parsed.score > 10 ||
        !Array.isArray(parsed.questions) ||
        parsed.questions.length === 0
      ) {
        grillLog.warn('[grill] Parsed grill-evaluation has invalid structure or out-of-range score')
        return null
      }
      return parsed
    } catch (err) {
      grillLog.error('[grill] Failed to parse grill-evaluation JSON:', err)
      return null
    }
  }
  /** Graceful shutdown — cancel all evaluations and clear sessions. Called on app quit. */
  async shutdown(): Promise<void> {
    grillLog.info(`[grill] Shutdown initiated — ${this.sessions.size} active sessions`)
    this.cancel() // Cancels all sessions
    this.sessions.clear()
    this.greenfieldSession = null
  }
}

export const grillAgentService = new GrillAgentService()
