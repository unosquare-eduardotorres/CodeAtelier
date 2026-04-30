/**
 * AuditAgentService — orchestrator for workspace health audits.
 *
 * A sibling to ChatAgentService that owns its own AgentSessionService.
 * Runs auditors sequentially (one at a time), each in a fresh session.
 * Emits 'progress', 'result', and 'complete' events for the IPC layer.
 *
 * Chat stays alive and independent — this service has no overlap with it.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type {
  AuditMode,
  AuditTrackId,
  AuditFinding,
  AuditorStatus,
  AuditTrack
} from '../../shared/types'
import type { StreamChunk } from './agent-base.service'
import { AUDIT_TRACKS } from '../../shared/constants'
import { AgentSessionService } from './agent-session.service'
import { AuditRoleAdapter } from './role-adapters/audit.adapter'
import { parseAuditResponse } from './audit-response-parser'

const auditLog = log.scope('audit-agent')

// ── Event payloads ─────────────────────────────────────────────────────────

export interface AuditProgressPayload {
  trackId: AuditTrackId
  status: AuditorStatus
  score?: number
  streamChunk?: string
}

export interface AuditResultPayload {
  trackId: AuditTrackId
  score: number
  status: AuditorStatus
  findings: AuditFinding[]
  summary: string
  skillsUsed: string[]
}

export interface AuditCompletePayload {
  overallScore: number | null
}

// ── Service ────────────────────────────────────────────────────────────────

export class AuditAgentService extends EventEmitter {
  private session: AgentSessionService | null = null
  private abortController: AbortController | null = null
  private running = false

  get isRunning(): boolean {
    return this.running
  }

  /**
   * Run a full audit: iterate selected tracks sequentially.
   * Emits: 'progress', 'result', 'complete'
   */
  async runAudit(params: {
    workspaceId: string
    workspacePath: string
    mode: AuditMode
    selectedTracks: AuditTrackId[]
    auditRunId: string
  }): Promise<void> {
    if (this.running) {
      auditLog.warn('[audit] Already running — ignoring duplicate start')
      return
    }

    this.running = true
    this.abortController = new AbortController()

    const completedResults: AuditResultPayload[] = []

    for (const trackId of params.selectedTracks) {
      if (this.abortController.signal.aborted) {
        this.emit('progress', {
          trackId,
          status: 'cancelled'
        } satisfies AuditProgressPayload)
        continue
      }

      // Signal: running
      this.emit('progress', {
        trackId,
        status: 'running'
      } satisfies AuditProgressPayload)

      try {
        const result = await this.runSingleAuditor({
          workspaceId: params.workspaceId,
          workspacePath: params.workspacePath,
          trackId,
          mode: params.mode
        })

        completedResults.push(result)
        this.emit('result', result)
      } catch (err) {
        const failResult: AuditResultPayload = {
          trackId,
          score: 0,
          status: 'failed',
          findings: [],
          summary: err instanceof Error ? err.message : String(err),
          skillsUsed: []
        }
        this.emit('result', failResult)
      }
    }

    // Calculate overall score
    const overallScore = calculateOverallScore(completedResults, AUDIT_TRACKS)

    this.running = false
    this.abortController = null
    this.emit('complete', { overallScore } satisfies AuditCompletePayload)
  }

  /** Cancel the running audit. Keeps completed results, cancels remaining. */
  cancel(): void {
    auditLog.info('[audit] Cancel requested')
    this.abortController?.abort()

    // If a session is currently running, cancel its query
    if (this.session) {
      try {
        this.session.cancelCurrentQuery()
      } catch {
        /* non-fatal */
      }
    }
  }

  /**
   * Run a single track re-run. Emits 'progress', 'result' (no 'complete').
   * Used for re-running individual auditors from the report view.
   */
  async runSingleTrack(params: {
    workspaceId: string
    workspacePath: string
    trackId: AuditTrackId
    mode: AuditMode
  }): Promise<void> {
    if (this.running) {
      auditLog.warn('[audit:rerun] Already running — ignoring')
      return
    }

    this.running = true
    this.abortController = new AbortController()

    this.emit('progress', {
      trackId: params.trackId,
      status: 'running'
    } satisfies AuditProgressPayload)

    try {
      const result = await this.runSingleAuditor(params)
      this.emit('result', result)
    } catch (err) {
      const failResult: AuditResultPayload = {
        trackId: params.trackId,
        score: 0,
        status: 'failed',
        findings: [],
        summary: err instanceof Error ? err.message : String(err),
        skillsUsed: []
      }
      this.emit('result', failResult)
    } finally {
      this.running = false
      this.abortController = null
    }
  }

  // ── Private: single auditor execution ──────────────────────────────

  private async runSingleAuditor(params: {
    workspaceId: string
    workspacePath: string
    trackId: AuditTrackId
    mode: AuditMode
  }): Promise<AuditResultPayload> {
    const adapter = new AuditRoleAdapter({
      workspaceId: params.workspaceId,
      trackId: params.trackId,
      mode: params.mode
    })

    this.session = new AgentSessionService(adapter)

    // Wire streaming events for live output
    this.session.on('chunk', (chunk: StreamChunk) => {
      // Continue emitting progress for status tracking (backwards compat)
      if (chunk.type === 'text' && chunk.content) {
        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: chunk.content
        } satisfies AuditProgressPayload)
      }
      // Forward the full chunk for chat-like rendering
      this.emit('stream', { trackId: params.trackId, chunk })
    })

    try {
      // Start session in plan mode (read-only)
      await this.session.start(params.workspacePath, 'plan')

      // Single-shot: send the audit trigger message
      // Use a synthetic conversation ID since audits don't persist conversations
      const syntheticConvId = `audit-${params.trackId}-${Date.now()}`
      await this.session.send('Begin your audit.', syntheticConvId, [])

      // ── Check if session was killed by timeout ──
      if (this.session.wasTimedOut()) {
        const timeoutMsg = `Audit timed out after the interaction limit. The local LLM made progress (tool calls executed) but didn't finish analysis. Try running with fewer tracks or a faster model.`
        auditLog.warn(`[audit:${params.trackId}] timed out — returning failed`)
        return {
          trackId: params.trackId,
          score: 0,
          status: 'failed',
          findings: [],
          summary: timeoutMsg,
          skillsUsed: []
        }
      }

      // Collect the full response
      const responseText = this.session.getStreamedContent()

      // Parse structured JSON from the auditor's response
      const parsed = parseAuditResponse(responseText)

      // ── Recovery: if parser fell back (no JSON found), nudge the LLM ──
      if (parsed.score === 0 && parsed.findings.length === 0 && responseText.length > 200) {
        auditLog.warn(
          `[audit:${params.trackId}] No JSON block found in ${responseText.length}-char response — attempting recovery nudge`
        )

        try {
          const nudgeMessage =
            `[System: Your analysis above was thorough but you did not output the required JSON result block. ` +
            `Based on everything you already analyzed, output EXACTLY one JSON code block now with your score (0-100), ` +
            `a 2-3 sentence summary, and your findings array. Do NOT use any tools. Just output the JSON block.]`

          const nudgeConvId = `audit-nudge-${params.trackId}-${Date.now()}`
          await this.session.send(nudgeMessage, nudgeConvId, [])

          const nudgeText = this.session.getStreamedContent()
          const nudgeParsed = parseAuditResponse(nudgeText)

          if (nudgeParsed.score > 0 || nudgeParsed.findings.length > 0) {
            auditLog.info(
              `[audit:${params.trackId}] Recovery succeeded — score=${nudgeParsed.score}, findings=${nudgeParsed.findings.length}`
            )
            return {
              trackId: params.trackId,
              score: nudgeParsed.score,
              status: 'completed',
              findings: nudgeParsed.findings,
              summary: nudgeParsed.summary,
              skillsUsed: []
            }
          }
        } catch (nudgeErr) {
          auditLog.warn(`[audit:${params.trackId}] Recovery nudge failed:`, nudgeErr)
        }

        // If recovery also failed, mark as failed (not silently completed with 0)
        auditLog.error(
          `[audit:${params.trackId}] No structured result extracted — marking as failed`
        )
        return {
          trackId: params.trackId,
          score: 0,
          status: 'failed',
          findings: [],
          summary: `Audit analysis completed but no structured report was produced. The auditor narrated its process but did not output the required JSON result. Try re-running this auditor.`,
          skillsUsed: []
        }
      }

      auditLog.info(
        `[audit:${params.trackId}] completed — score=${parsed.score}, findings=${parsed.findings.length}`
      )

      return {
        trackId: params.trackId,
        score: parsed.score,
        status: 'completed',
        findings: parsed.findings,
        summary: parsed.summary,
        skillsUsed: [] // TODO: Deep mode skill tracking
      }
    } catch (err) {
      auditLog.error(`[audit:${params.trackId}] failed:`, err)
      throw err
    } finally {
      try {
        await this.session.stop()
      } catch {
        /* best-effort cleanup */
      }
      this.session = null
    }
  }
}

// ── Weighted average calculation ───────────────────────────────────────────

function calculateOverallScore(
  results: AuditResultPayload[],
  tracks: Record<AuditTrackId, AuditTrack>
): number | null {
  const completed = results.filter((r) => r.status === 'completed' && r.score > 0)
  if (completed.length === 0) return null

  let weightedSum = 0
  let totalWeight = 0
  for (const r of completed) {
    const weight = tracks[r.trackId]?.weight ?? 1.0
    weightedSum += r.score * weight
    totalWeight += weight
  }
  return Math.round(weightedSum / totalWeight)
}

export const auditAgentService = new AuditAgentService()
