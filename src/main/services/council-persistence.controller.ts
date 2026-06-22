/**
 * CouncilPersistenceController — sits between CouncilService events and the renderer.
 *
 * Responsibilities:
 *   1. Forward events to renderer via webContents.send()
 *   2. Save transcript to workspace .agent-studio/ directory
 *   3. Persist council sessions to DB
 *
 * Follows the same pattern as GrillPersistenceController.
 */

import log from 'electron-log'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  CouncilAdvisorRole,
  CouncilReview,
  CouncilPeerReview,
  CouncilVerdict,
  CouncilPhase,
  StructuredPlan
} from '../../shared/types'
import type { StreamChunk } from './agent-base.service'
import { processToolChunk } from '../ipc/tool-chunk-processor'
import { TextDeltaBatcher } from '../ipc/text-delta-batcher'
import { IPC_CHANNELS } from '../../shared/constants'
import { councilSessionRepository } from '../db/repositories/council-session.repository'
import { planRegistryService } from './plan-registry.service'
import { safeParseJSON } from '../db/json-utils'
import type { SessionEventRouter } from './session-event-router'

const ctrlLog = log.scope('council-persistence')

export class CouncilPersistenceController {
  private activeSessionId: string | null = null
  private activeWorkspacePath: string | null = null
  private transcriptParts: string[] = []
  /** Batches renderer-bound text at ~30fps (per advisor) so council streams smoothly. */
  private textBatcher = new TextDeltaBatcher()

  /** Batch key — keeps each advisor's stream separate within a workspace. */
  private batchKey(workspaceId: string, advisorRole: string): string {
    return `${workspaceId}:${advisorRole}`
  }

  // ── Public API ────────────────────────────────────────────────────────

  /** Start tracking a council session */
  startTracking(sessionId: string, _workspaceId: string, workspacePath: string): void {
    this.activeSessionId = sessionId
    this.activeWorkspacePath = workspacePath
    this.transcriptParts = []
    ctrlLog.info(`[council-persistence] Tracking session=${sessionId}`)
  }

  /** Handle phase change — forward to renderer */
  handlePhaseChanged(
    data: { workspaceId: string; phase: CouncilPhase },
    router: SessionEventRouter
  ): void {
    router.sendWorkspaceEvent(IPC_CHANNELS.COUNCIL_PHASE_CHANGED, data.workspaceId, {
      phase: data.phase
    })
  }

  /** Handle stream chunk from an advisor — transform and forward to renderer */
  handleMemberStream(
    data: { workspaceId: string; advisorRole: string; chunk: StreamChunk },
    workspacePath: string,
    router: SessionEventRouter
  ): void {
    const { chunk, advisorRole, workspaceId } = data
    const key = this.batchKey(workspaceId, advisorRole)

    if (chunk.type === 'text' && chunk.content) {
      // Batch text at ~30fps (matching chat) per advisor.
      this.textBatcher.push(key, chunk.content, (text) => {
        router.sendWorkspaceEvent(IPC_CHANNELS.COUNCIL_MEMBER_STREAM, workspaceId, {
          advisorRole,
          type: 'text',
          content: text
        })
      })
    } else if (
      chunk.type === 'tool_use' ||
      chunk.type === 'tool_result' ||
      chunk.type === 'tool_progress'
    ) {
      const result = processToolChunk(chunk, { workspacePath, agentType: 'council' })
      if (result) {
        // Flush pending text before the tool block so ordering is preserved.
        this.textBatcher.flush(key)
        router.sendWorkspaceEvent(IPC_CHANNELS.COUNCIL_MEMBER_STREAM, workspaceId, {
          advisorRole,
          ...result
        })
      }
    }
  }

  /** Handle advisor completion — forward to renderer */
  handleMemberComplete(
    data: { workspaceId: string; advisorRole: CouncilAdvisorRole; review: CouncilReview | null },
    router: SessionEventRouter
  ): void {
    // Flush trailing narration before completion, then forget the advisor flusher.
    this.textBatcher.reset(this.batchKey(data.workspaceId, data.advisorRole))

    router.sendWorkspaceEvent(IPC_CHANNELS.COUNCIL_MEMBER_COMPLETE, data.workspaceId, {
      advisorRole: data.advisorRole,
      review: data.review
    })

    // Buffer transcript
    if (data.review) {
      this.transcriptParts.push(
        `## ${data.advisorRole.toUpperCase()} (Score: ${data.review.score}/100)\n\n${data.review.summary}\n\n` +
          `Key Findings: ${data.review.keyFindings.join('; ')}\n` +
          `Blind Spots: ${data.review.blindSpots.join('; ')}\n`
      )
    }
  }

  /** Handle peer review completion — forward to renderer */
  handlePeerReviewComplete(
    data: { workspaceId: string; peerReviews: CouncilPeerReview[] },
    router: SessionEventRouter
  ): void {
    router.sendWorkspaceEvent(IPC_CHANNELS.COUNCIL_PEER_REVIEW_COMPLETE, data.workspaceId, {
      peerReviews: data.peerReviews
    })
  }

  /** Handle verdict — forward to renderer + dual-write to Plan Hub */
  handleVerdict(
    data: { workspaceId: string; verdict: CouncilVerdict },
    router: SessionEventRouter
  ): void {
    router.sendWorkspaceEvent(IPC_CHANNELS.COUNCIL_VERDICT, data.workspaceId, {
      verdict: data.verdict
    })

    // Dual-write: register the council-reviewed plan in the Plan Hub
    if (this.activeSessionId) {
      try {
        const session = councilSessionRepository.findById(this.activeSessionId)
        if (session?.structuredPlanJson) {
          const originalPlan = safeParseJSON<StructuredPlan | null>(
            session.structuredPlanJson,
            null
          )
          if (originalPlan) {
            planRegistryService.registerCouncilVerdict({
              workspaceId: data.workspaceId,
              councilSessionId: this.activeSessionId,
              verdict: data.verdict,
              originalPlan
            })
          }
        }
      } catch (err) {
        ctrlLog.warn('[council:verdict] Plan registry write failed (non-critical):', err)
      }
    }
  }

  /** Handle session teardown — save transcript, clean up internal state. No renderer events. */
  async handleSessionEnded(
    _data: { workspaceId: string },
    _router: SessionEventRouter
  ): Promise<void> {
    // Save transcript to workspace filesystem
    await this.saveTranscript()

    // Persist transcript to DB
    if (this.activeSessionId && this.transcriptParts.length > 0) {
      try {
        const transcriptMd = this.transcriptParts.join('\n')
        councilSessionRepository.saveTranscript(this.activeSessionId, transcriptMd)
      } catch (err) {
        ctrlLog.warn('[council-persistence] DB transcript save failed (non-fatal):', err)
      }
    }

    ctrlLog.info(`[council-persistence] Session ended — session=${this.activeSessionId}`)
    this.resetTrackingState()
  }

  /** Clear tracking on explicit cancel — state cleanup only.
   *  The 'cancelled' phase is already emitted by councilService.cancel() → setPhase(). */
  clearTracking(): void {
    this.resetTrackingState()
  }

  /** Internal state cleanup — no renderer events */
  private resetTrackingState(): void {
    this.textBatcher.reset()
    this.activeSessionId = null
    this.activeWorkspacePath = null
    this.transcriptParts = []
  }

  // ── Private ───────────────────────────────────────────────────────────

  /** Save full transcript to .agent-studio/ directory */
  private async saveTranscript(): Promise<void> {
    if (!this.activeWorkspacePath || this.transcriptParts.length === 0) return

    try {
      const agentDir = join(this.activeWorkspacePath, '.agent-studio')
      await fs.mkdir(agentDir, { recursive: true })

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `council-transcript-${timestamp}.md`
      const filePath = join(agentDir, filename)

      const content = [
        `# LLM Council Transcript`,
        ``,
        `**Date:** ${new Date().toISOString()}`,
        `**Session:** ${this.activeSessionId}`,
        ``,
        `---`,
        ``,
        ...this.transcriptParts
      ].join('\n')

      await fs.writeFile(filePath, content, 'utf-8')
      ctrlLog.info(`[council-persistence] Transcript saved: ${filePath}`)
    } catch (err) {
      ctrlLog.error('[council-persistence] Failed to save transcript:', err)
    }
  }
}

export const councilPersistenceController = new CouncilPersistenceController()
