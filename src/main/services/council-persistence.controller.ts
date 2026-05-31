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

import type { BrowserWindow } from 'electron'
import log from 'electron-log'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  CouncilAdvisorRole,
  CouncilReview,
  CouncilPeerReview,
  CouncilVerdict,
  CouncilPhase,
  CouncilMemberStatus
} from '../../shared/types'
import type { StreamChunk } from './agent-base.service'
import { summarizeToolInput } from './agent-base.service'
import { extractResultSummary, reportToolError } from '../ipc/chat-shared'
import { IPC_CHANNELS, MCP_TOOLS } from '../../shared/constants'
import { councilSessionRepository } from '../db/repositories/council-session.repository'

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
    mainWindow: BrowserWindow
  ): void {
    mainWindow.webContents.send(IPC_CHANNELS.COUNCIL_PHASE_CHANGED, data)
  }

  /** Handle stream chunk from an advisor — transform and forward to renderer */
  handleMemberStream(
    data: { workspaceId: string; advisorRole: string; chunk: StreamChunk },
    mainWindow: BrowserWindow,
    workspacePath: string
  ): void {
    const { chunk, advisorRole } = data

    if (chunk.type === 'text' && chunk.content) {
      mainWindow.webContents.send(IPC_CHANNELS.COUNCIL_MEMBER_STREAM, {
        advisorRole,
        type: 'text',
        content: chunk.content
      })
    } else if (chunk.type === 'tool_use') {
      // Skip control tools
      if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return

      let inputSummary: string | undefined
      if (chunk.toolInput) {
        try {
          const parsed = JSON.parse(chunk.toolInput) as Record<string, unknown>
          inputSummary = summarizeToolInput(chunk.toolName ?? '', parsed, workspacePath)
        } catch {
          inputSummary = chunk.toolInput.slice(0, 120)
        }
      }

      mainWindow.webContents.send(IPC_CHANNELS.COUNCIL_MEMBER_STREAM, {
        advisorRole,
        type: 'tool_activity',
        toolActivity: {
          id: chunk.toolId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          toolName: chunk.toolName ?? 'Unknown',
          status: 'running' as const,
          input: inputSummary,
          startedAt: Date.now()
        }
      })
    } else if (chunk.type === 'tool_result') {
      if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return

      const isToolError =
        typeof chunk.content === 'string' && chunk.content.includes('<tool_use_error>')

      if (isToolError && chunk.content) {
        reportToolError(chunk.toolName ?? 'Unknown', chunk.content, { agentType: 'council' })
      }

      const resultSummaryObj = extractResultSummary(chunk.toolName ?? '', chunk.content)
      const resultSummary = resultSummaryObj?.result
      const resultDetail = resultSummaryObj?.resultDetail

      const toolActivity: Record<string, unknown> = {
        id: chunk.toolId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        toolName: chunk.toolName ?? 'Unknown',
        status: isToolError ? 'error' : 'completed',
        completedAt: Date.now()
      }
      if (resultSummary) toolActivity.result = resultSummary
      if (resultDetail) toolActivity.resultDetail = resultDetail

      mainWindow.webContents.send(IPC_CHANNELS.COUNCIL_MEMBER_STREAM, {
        advisorRole,
        type: 'tool_activity',
        toolActivity
      })
    } else if (chunk.type === 'tool_progress') {
      mainWindow.webContents.send(IPC_CHANNELS.COUNCIL_MEMBER_STREAM, {
        advisorRole,
        type: 'tool_activity',
        toolActivity: {
          id: chunk.toolId ?? `tool-${Date.now()}`,
          toolName: chunk.toolName ?? 'Unknown',
          status: 'running' as const,
          elapsedSeconds: chunk.elapsedSeconds
        }
      })
    }
  }

  /** Handle advisor completion — forward to renderer */
  handleMemberComplete(
    data: { workspaceId: string; advisorRole: CouncilAdvisorRole; review: CouncilReview | null },
    mainWindow: BrowserWindow
  ): void {
    mainWindow.webContents.send(IPC_CHANNELS.COUNCIL_MEMBER_COMPLETE, {
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
    mainWindow: BrowserWindow
  ): void {
    mainWindow.webContents.send(IPC_CHANNELS.COUNCIL_PEER_REVIEW_COMPLETE, {
      peerReviews: data.peerReviews
    })
  }

  /** Handle verdict — forward to renderer */
  handleVerdict(
    data: { workspaceId: string; verdict: CouncilVerdict },
    mainWindow: BrowserWindow
  ): void {
    mainWindow.webContents.send(IPC_CHANNELS.COUNCIL_VERDICT, {
      verdict: data.verdict
    })
  }

  /** Handle session complete — save transcript to filesystem + DB */
  async handleComplete(
    _data: { workspaceId: string },
    mainWindow: BrowserWindow
  ): Promise<void> {
    mainWindow.webContents.send(IPC_CHANNELS.COUNCIL_COMPLETE, {})

    // Save transcript to workspace filesystem
    await this.saveTranscript()

    // Also persist transcript to DB for resume/history
    if (this.activeSessionId && this.transcriptParts.length > 0) {
      try {
        const transcriptMd = this.transcriptParts.join('\n')
        councilSessionRepository.saveTranscript(this.activeSessionId, transcriptMd)
      } catch (err) {
        ctrlLog.warn('[council-persistence] DB transcript save failed (non-fatal):', err)
      }
    }

    ctrlLog.info(`[council-persistence] Session complete — session=${this.activeSessionId}`)
    this.clearTracking()
  }

  /** Clear active tracking (on cancel) */
  clearTracking(mainWindow?: BrowserWindow): void {
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.COUNCIL_PHASE_CHANGED, {
        workspaceId: this.activeWorkspaceId,
        phase: 'cancelled'
      })
    }
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
