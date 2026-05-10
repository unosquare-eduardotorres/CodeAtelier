/**
 * IPC handlers for Grill evaluations.
 *
 * Bridges the renderer ↔ GrillAgentService and forwards streaming events
 * to the renderer via webContents.send().
 */

import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS, MCP_TOOLS } from '../../shared/constants'
import type { GrillTrackId, GrillEvaluation, LLMProvider } from '../../shared/types'
import type { StreamChunk } from '../services/agent-base.service'
import { summarizeToolInput } from '../services/agent-base.service'
import { extractResultSummary, reportToolError } from './chat-shared'
import { workspaceRepository } from '../db/repositories'
import { grillAgentService } from '../services/grill-agent.service'
import { grillPersistenceController } from '../services/grill-persistence.controller'
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
        previousScore?: number
        ideaId?: string
        llmProvider?: LLMProvider
        greenfield?: boolean
        projectName?: string
      }
    ): Promise<void> => {
      validateSender(event)

      grillLog.info('[grill:evaluate] Handler invoked', {
        workspaceId: args?.workspaceId,
        trackId: args?.trackId,
        greenfield: args?.greenfield
      })

      const {
        workspaceId,
        trackId,
        ideaTitle,
        ideaDescription,
        iterationHistory,
        previousScore,
        ideaId,
        llmProvider: explicitProvider,
        greenfield,
        projectName
      } = args

      if (grillAgentService.isRunning) {
        throw new Error('A grill evaluation is already running.')
      }

      // ── Greenfield path: no workspace lookup needed ──
      if (greenfield) {
        grillLog.info(
          `[grill:evaluate:greenfield] track=${trackId} project="${(projectName ?? ideaTitle).slice(0, 40)}"`
        )

        const llmProvider: LLMProvider = explicitProvider ?? 'claude'

        // Wire event forwarding (no persistence controller for greenfield)
        wireGrillEvents(mainWindow, '')

        grillAgentService
          .evaluateGreenfield({
            trackId,
            projectName: projectName ?? ideaTitle,
            projectDescription: ideaDescription,
            iterationHistory,
            previousScore,
            llmProvider
          })
          .catch((err) => {
            grillLog.error('[grill:evaluate:greenfield] evaluate failed:', err)
          })
        return
      }

      // ── Standard path: existing workspace ──
      // Resolve workspace path
      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
      if (!workspace.repoPath) throw new Error(`Workspace ${workspaceId} has no repo path`)

      grillLog.info(
        `[grill:evaluate] workspaceId=${workspaceId} track=${trackId} title="${ideaTitle.slice(0, 40)}"`
      )

      // Start persistence tracking (if ideaId is provided)
      if (ideaId) {
        await grillPersistenceController.startTracking(ideaId, workspaceId, trackId)
      }

      // Resolve LLM provider: explicit selection → workspace setting → 'claude'
      const settings = JSON.parse(workspace.settingsJson ?? '{}')
      const llmProvider: LLMProvider = explicitProvider ?? settings.llmProvider ?? 'claude'

      // Wire event forwarding (through persistence controller)
      wireGrillEvents(mainWindow, workspace.repoPath)

      // Start the evaluation (non-blocking — runs in background)
      grillAgentService
        .evaluate({
          workspaceId,
          workspacePath: workspace.repoPath,
          trackId,
          ideaTitle,
          ideaDescription,
          iterationHistory,
          previousScore,
          llmProvider
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
    grillPersistenceController.clearTracking(mainWindow)
  })

  // ── grill:getStatus — current grill status for a workspace ────────

  ipcMain.handle(
    IPC_CHANNELS.GRILL_GET_STATUS,
    (event, args: { workspaceId: string }) => {
      validateSender(event)
      return grillPersistenceController.getStatusForWorkspace(args.workspaceId)
    }
  )

  // ── grill:getSession — full session state from DB ─────────────────

  ipcMain.handle(
    IPC_CHANNELS.GRILL_GET_SESSION,
    (event, args: { ideaId: string }) => {
      validateSender(event)
      return grillPersistenceController.getSessionState(args.ideaId)
    }
  )

  // ── grill:saveAnswers — persist question states to DB session ─────

  ipcMain.handle(
    IPC_CHANNELS.GRILL_SAVE_ANSWERS,
    (event, args: { sessionId: string; questionStates: Record<string, unknown> }): void => {
      validateSender(event)
      grillPersistenceController.saveAnswers(args.sessionId, args.questionStates, mainWindow)
    }
  )

  // ── grill:condenseRequirement — Haiku summarization of long docs ───

  ipcMain.handle(
    IPC_CHANNELS.GRILL_CONDENSE_REQUIREMENT,
    async (event, args: { text: string }): Promise<{ condensed: string }> => {
      validateSender(event)

      const { text } = args
      if (!text || text.length < 1000) {
        return { condensed: text }
      }

      grillLog.info(
        `[grill:condense] Condensing requirement document (${text.length} chars)`
      )

      try {
        const { query } = await import('@anthropic-ai/claude-agent-sdk')
        const { authProvider } = await import('../services/auth-provider')

        // Ensure API key is in env (same pattern as SDKExecutor)
        const apiKey = authProvider.getApiKey()
        if (apiKey && !process.env.ANTHROPIC_API_KEY) {
          process.env.ANTHROPIC_API_KEY = apiKey
        }

        const result = query({
          prompt: text,
          options: {
            model: 'claude-haiku-4-5-20251001',
            systemPrompt: [
              'You are a technical requirement condensation assistant.',
              'Condense the following requirement document into a clear, structured summary.',
              'RULES:',
              '- Preserve ALL decisions, constraints, and acceptance criteria',
              '- Remove redundant phrasing, repeated context, and verbose explanations',
              '- Keep the iteration/track structure but merge similar decisions',
              '- Use concise bullet points instead of full paragraphs',
              '- Target roughly 40-60% of the original length',
              '- Do NOT add new information or opinions',
              '- Output plain markdown — no code fences around the result'
            ].join('\n'),
            permissionMode: 'bypassPermissions',
            maxTurns: 1,
            abortController: new AbortController()
          }
        })

        let condensed = ''
        for await (const msg of result) {
          if (msg.type === 'assistant' && typeof msg.message === 'string') {
            condensed += msg.message
          }
        }

        grillLog.info(
          `[grill:condense] Done — ${text.length} → ${condensed.length} chars (${Math.round((condensed.length / text.length) * 100)}%)`
        )

        return { condensed: condensed.trim() || text }
      } catch (err) {
        grillLog.error('[grill:condense] Failed:', err)
        throw new Error(
          `Condensation failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  )
}

// ── Event forwarding ─────────────────────────────────────────────────────

/**
 * Wire one-time event listeners for the current grill evaluation.
 * Transforms stream chunks, then routes through the persistence controller
 * which both persists to DB and forwards to the renderer.
 */
function wireGrillEvents(mainWindow: BrowserWindow, workspacePath: string): void {
  // Remove any stale listeners from a previous run
  grillAgentService.removeAllListeners('stream')
  grillAgentService.removeAllListeners('evaluation')
  grillAgentService.removeAllListeners('complete')

  // ── stream — transform chunk + route through persistence ──
  grillAgentService.on('stream', (data: { chunk: StreamChunk }) => {
    const { chunk } = data

    if (chunk.type === 'text' && chunk.content) {
      grillPersistenceController.handleStreamChunk(
        { type: 'text', content: chunk.content },
        mainWindow
      )
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

      grillPersistenceController.handleStreamChunk(
        {
          type: 'tool_activity',
          toolActivity: {
            id: chunk.toolId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            toolName: chunk.toolName ?? 'Unknown',
            status: 'running' as const,
            input: inputSummary,
            startedAt: Date.now()
          }
        },
        mainWindow
      )
    } else if (chunk.type === 'tool_result') {
      // Skip control tools
      if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return

      const isToolError =
        typeof chunk.content === 'string' && chunk.content.includes('<tool_use_error>')

      // Skip reporting prompt-format artifacts that the model sometimes emits as tool calls.
      // grill-evaluation is a fenced-block language tag, not a real tool.
      const GRILL_FORMAT_TAGS = new Set(['grill-evaluation'])

      // Auto-capture tool errors to the bug tracker (skip known format tags)
      if (isToolError && chunk.content && !GRILL_FORMAT_TAGS.has(chunk.toolName ?? '')) {
        reportToolError(chunk.toolName ?? 'Unknown', chunk.content, { agentType: 'grill' })
      }

      const resultSummaryObj = extractResultSummary(chunk.toolName ?? '', chunk.content)
      const resultSummary = resultSummaryObj?.result
      const resultDetail = resultSummaryObj?.resultDetail

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
      if (resultDetail) toolActivity.resultDetail = resultDetail

      grillPersistenceController.handleStreamChunk(
        { type: 'tool_activity', toolActivity },
        mainWindow
      )
    } else if (chunk.type === 'tool_progress') {
      grillPersistenceController.handleStreamChunk(
        {
          type: 'tool_activity',
          toolActivity: {
            id: chunk.toolId ?? `tool-${Date.now()}`,
            toolName: chunk.toolName ?? 'Unknown',
            status: 'running' as const,
            elapsedSeconds: chunk.elapsedSeconds
          }
        },
        mainWindow
      )
    }
  })

  // ── evaluation — through persistence controller ──
  grillAgentService.on('evaluation', (data: GrillEvaluation) => {
    grillPersistenceController.handleEvaluationResult(data, mainWindow)
  })

  // ── complete — through persistence controller ──
  grillAgentService.on('complete', () => {
    grillPersistenceController.handleComplete(mainWindow)
  })
}
