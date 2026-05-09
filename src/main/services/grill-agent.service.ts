/**
 * GrillAgentService — standalone evaluator for the Grill feature.
 *
 * A sibling to AuditAgentService that owns its own AgentSessionService.
 * Single-shot: one evaluation per invocation, streams directly to the
 * renderer via events. No interaction with the chat pipeline.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { GrillTrackId, GrillEvaluation } from '../../shared/types'
import type { StreamChunk } from './agent-base.service'
import { AgentSessionService } from './agent-session.service'
import { GrillRoleAdapter } from './role-adapters/grill.adapter'

const grillLog = log.scope('grill-agent')

// ── Service ────────────────────────────────────────────────────────────────

export class GrillAgentService extends EventEmitter {
  private session: AgentSessionService | null = null
  private running = false

  get isRunning(): boolean {
    return this.running
  }

  /**
   * Run a single grill evaluation.
   * Emits: 'stream' (chunk), 'evaluation' (parsed result), 'complete'
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

    if (this.running) {
      grillLog.warn('[grill] Already running — ignoring duplicate start')
      return
    }

    this.running = true

    const adapter = new GrillRoleAdapter({
      workspaceId: params.workspaceId,
      trackId: params.trackId,
      ideaTitle: params.ideaTitle,
      ideaDescription: params.ideaDescription,
      iterationHistory: params.iterationHistory,
      previousScore: params.previousScore,
      llmProvider: params.llmProvider
    })

    this.session = new AgentSessionService(adapter)

    // Wire streaming events for live output
    this.session.on('chunk', (chunk: StreamChunk) => {
      this.emit('stream', { chunk })
    })

    try {
      // Start session in plan mode (read-only)
      await this.session.start(params.workspacePath, 'plan')

      // Single-shot: send the evaluation trigger
      const syntheticConvId = `grill-${params.trackId}-${Date.now()}`
      const effectiveMessage = params.iterationHistory
        ? `Re-evaluate based on updated decisions:\n\n${params.iterationHistory}`
        : 'Begin your evaluation.'
      await this.session.send(effectiveMessage, syntheticConvId, [])

      // Collect the full response and parse evaluation
      const responseText = this.session.getStreamedContent()
      const evaluation = this.parseGrillEvaluation(responseText)

      if (evaluation) {
        grillLog.info(`[grill:${params.trackId}] completed — score=${evaluation.score}`)
        this.emit('evaluation', evaluation)
      } else {
        grillLog.warn(`[grill:${params.trackId}] completed but no grill-evaluation block found`)
      }
    } catch (err) {
      grillLog.error(`[grill:${params.trackId}] failed:`, err)
    } finally {
      try {
        await this.session.stop()
      } catch {
        /* best-effort cleanup */
      }
      this.session = null
      this.running = false
      this.emit('complete')
    }
  }

  /** Cancel the running evaluation. */
  cancel(): void {
    grillLog.info('[grill] Cancel requested')
    if (this.session) {
      try {
        this.session.cancelCurrentQuery()
      } catch {
        /* non-fatal */
      }
    }
    this.running = false
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
}

export const grillAgentService = new GrillAgentService()
