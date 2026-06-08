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

      if (evaluation) {
        grillLog.info(`[grill:${params.trackId}] completed — score=${evaluation.score}`)
        this.emit('evaluation', { workspaceId: params.workspaceId, ...evaluation })
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
      entry.running = false
      this.sessions.delete(params.workspaceId)
      this.emit('complete', { workspaceId: params.workspaceId })
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
    this.greenfieldSession = { session, running: true }

    // Wire streaming events for live output
    session.on('chunk', (chunk: StreamChunk) => {
      this.emit('stream', { chunk })
    })

    // Wire status updates so the modal's live counters move during a greenfield grill.
    // No workspaceId exists yet; the IPC status listener's guard passes when undefined.
    session.on('statusUpdate', (status: AgentStatus) => {
      this.emit('status', { status })
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

      if (evaluation) {
        grillLog.info(`[grill:greenfield:${params.trackId}] completed — score=${evaluation.score}`)
        this.emit('evaluation', evaluation)
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
      this.greenfieldSession = null
      this.emit('complete')
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
      // Validate required fields
      if (
        typeof parsed.score !== 'number' ||
        !Array.isArray(parsed.questions) ||
        parsed.questions.length === 0
      ) {
        grillLog.warn('[grill] Parsed grill-evaluation has invalid structure')
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
