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
  CouncilPhase
} from '../../shared/types'
import type { StreamChunk } from './agent-base.service'
import { processToolChunk } from '../ipc/tool-chunk-processor'
import { IPC_CHANNELS } from '../../shared/constants'
import { councilSessionRepository } from '../db/repositories/council-session.repository'
import type { SessionEventRouter } from './session-event-router'

const ctrlLog = log.scope('council-persistence')

export class CouncilPersistenceController {
  private activeSessionId: string | null = null
  private activeWorkspaceId: string | null = null
  private activeWorkspacePath: string | null = null
  private transcriptParts: string[] = []

  // ── Public API ────────────────────────────────────────────────────────

  /** Start tracking a council session */
  startTracking(sessionId: string, workspaceId: string, workspacePath: string): void {
    this.activeSessionId = sessionId
    this.activeWorkspaceId = workspaceId
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

    if (chunk.type === 'text' && chunk.content) {
      router.sendWorkspaceEvent(IPC_CHANNELS.COUNCIL_MEMBER_STREAM, workspaceId, {
        advisorRole,
        type: 'text',
        content: chunk.content
      })
    } else if (chunk.type === 'tool_use' || chunk.type === 'tool_result' || chunk.type === 'tool_progress') {
      const result = processToolChunk(chunk, { workspacePath, agentType: 'council' })
      if (result) {
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

  /** Handle verdict — forward to renderer */
  handleVerdict(
    data: { workspaceId: string; verdict: CouncilVerdict },
    router: SessionEventRouter
  ): void {
    router.sendWorkspaceEvent(IPC_CHANNELS.COUNCIL_VERDICT, data.workspaceId, {
      verdict: data.verdict
    })
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
    this.activeSessionId = null
    this.activeWorkspaceId = null
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
