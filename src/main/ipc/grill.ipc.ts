/**
 * IPC handlers for Grill evaluations.
 *
 * Bridges the renderer ↔ GrillAgentService and forwards streaming events
 * to the renderer via webContents.send().
 */

import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS, MCP_TOOLS } from '../../shared/constants'
import type { GrillTrackId, GrillEvaluation } from '../../shared/types'
import type { StreamChunk } from '../services/agent-base.service'
import { summarizeToolInput } from '../services/agent-base.service'
import { extractResultSummary } from './chat-shared'
import { workspaceRepository } from '../db/repositories'
import { grillAgentService } from '../services/grill-agent.service'
import { validateSender } from './validate-sender'
import log from 'electron-log'

const grillLog = log.scope('grill-ipc')

export function registerGrillIpc(mainWindow: BrowserWindow): void {
  // ── grill:evaluate — start a grill evaluation ──────────────────────

  ipcMain.handle(
    IPC_CHANNELS.GRILL_EVALUATE,
    async (
      event,
      args: {
        workspaceId: string
        trackId: GrillTrackId
        ideaTitle: string
        ideaDescription: string
        iterationHistory?: string
      }
    ): Promise<void> => {
      validateSender(event)

      grillLog.info('[grill:evaluate] Handler invoked', {
        workspaceId: args?.workspaceId,
        trackId: args?.trackId
      })

      const { workspaceId, trackId, ideaTitle, ideaDescription, iterationHistory } = args

      if (grillAgentService.isRunning) {
        throw new Error('A grill evaluation is already running.')
      }

      // Resolve workspace path
      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
      if (!workspace.repoPath) throw new Error(`Workspace ${workspaceId} has no repo path`)

      grillLog.info(
        `[grill:evaluate] workspaceId=${workspaceId} track=${trackId} title="${ideaTitle.slice(0, 40)}"`
      )

      // Wire event forwarding
      wireGrillEvents(mainWindow, workspace.repoPath)

      // Start the evaluation (non-blocking — runs in background)
      grillAgentService
        .evaluate({
          workspaceId,
          workspacePath: workspace.repoPath,
          trackId,
          ideaTitle,
          ideaDescription,
          iterationHistory
        })
        .catch((err) => {
          grillLog.error('[grill:evaluate] evaluate failed:', err)
        })
    }
  )

  // ── grill:cancel — abort running evaluation ────────────────────────

  ipcMain.handle(IPC_CHANNELS.GRILL_CANCEL, (event): void => {
    validateSender(event)
    grillAgentService.cancel()
  })
}

// ── Event forwarding ─────────────────────────────────────────────────────

/**
 * Wire one-time event listeners for the current grill evaluation.
 * Forwards stream/evaluation/complete to the renderer.
 */
function wireGrillEvents(mainWindow: BrowserWindow, workspacePath: string): void {
  // Remove any stale listeners from a previous run
  grillAgentService.removeAllListeners('stream')
  grillAgentService.removeAllListeners('evaluation')
  grillAgentService.removeAllListeners('complete')

  // ── stream — rich chunk forwarding ──
  grillAgentService.on('stream', (data: { chunk: StreamChunk }) => {
    const { chunk } = data

    if (chunk.type === 'text' && chunk.content) {
      mainWindow.webContents.send(IPC_CHANNELS.GRILL_STREAM_CHUNK, {
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

      mainWindow.webContents.send(IPC_CHANNELS.GRILL_STREAM_CHUNK, {
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
      // Skip control tools
      if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return

      const isToolError =
        typeof chunk.content === 'string' && chunk.content.includes('<tool_use_error>')
      const resultSummary = extractResultSummary(chunk.toolName ?? '', chunk.content)

      let inputSummary: string | undefined
      if (chunk.content) {
        try {
          const parsed = JSON.parse(chunk.content) as Record<string, unknown>
          inputSummary = summarizeToolInput(chunk.toolName ?? '', parsed, workspacePath)
        } catch {
          // Non-JSON content — skip input summary
        }
      }

      const toolActivity: Record<string, unknown> = {
        id: chunk.toolId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        toolName: chunk.toolName ?? 'Unknown',
        status: isToolError ? 'error' : 'completed',
        completedAt: Date.now()
      }
      if (inputSummary) toolActivity.input = inputSummary
      if (resultSummary) toolActivity.result = resultSummary

      mainWindow.webContents.send(IPC_CHANNELS.GRILL_STREAM_CHUNK, {
        type: 'tool_activity',
        toolActivity
      })
    } else if (chunk.type === 'tool_progress') {
      mainWindow.webContents.send(IPC_CHANNELS.GRILL_STREAM_CHUNK, {
        type: 'tool_activity',
        toolActivity: {
          id: chunk.toolId ?? `tool-${Date.now()}`,
          toolName: chunk.toolName ?? 'Unknown',
          status: 'running' as const,
          elapsedSeconds: chunk.elapsedSeconds
        }
      })
    }
  })

  // ── evaluation — parsed result ──
  grillAgentService.on('evaluation', (data: GrillEvaluation) => {
    mainWindow.webContents.send(IPC_CHANNELS.GRILL_EVALUATION_RESULT, data)
  })

  // ── complete ──
  grillAgentService.on('complete', () => {
    mainWindow.webContents.send(IPC_CHANNELS.GRILL_STREAM_COMPLETE, {})
  })
}
