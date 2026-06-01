/**
 * IPC handlers for Grill evaluations.
 *
 * Bridges the renderer ↔ GrillAgentService and forwards streaming events
 * to the renderer via webContents.send().
 */

import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { GrillTrackId, GrillEvaluation, LLMProvider, GrillStructuredPlan } from '../../shared/types'
import type { StreamChunk } from '../services/agent-base.service'
import { processToolChunk } from './tool-chunk-processor'
import { createTimedCleanupMap } from './listener-cleanup'
import { workspaceRepository } from '../db/repositories'
import { grillAgentService } from '../services/grill-agent.service'
import { grillPersistenceController } from '../services/grill-persistence.controller'
import { grillPlanGeneratorService } from '../services/grill-plan-generator.service'
import { getSessionEventRouter } from '../services/session-event-router'
import { validateSender } from './validate-sender'
import log from 'electron-log'

const grillLog = log.scope('grill-ipc')

export function registerGrillIpc(_mainWindow: BrowserWindow): void {
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
        wireGrillEvents(workspaceId, '')

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
      const settings = workspaceRepository.getSettings(workspace.id)
      const llmProvider: LLMProvider = explicitProvider ?? settings.llmProvider ?? 'claude'

      // Wire event forwarding (through persistence controller)
      wireGrillEvents(workspaceId, workspace.repoPath)

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
    grillPersistenceController.clearTracking()
  })

  // ── grill:getStatus — current grill status for a workspace ────────

  ipcMain.handle(IPC_CHANNELS.GRILL_GET_STATUS, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return grillPersistenceController.getStatusForWorkspace(args.workspaceId)
  })

  // ── grill:getSession — full session state from DB ─────────────────

  ipcMain.handle(IPC_CHANNELS.GRILL_GET_SESSION, (event, args: { ideaId: string }) => {
    validateSender(event)
    return grillPersistenceController.getSessionState(args.ideaId)
  })

  // ── grill:saveAnswers — persist question states to DB session ─────

  ipcMain.handle(
    IPC_CHANNELS.GRILL_SAVE_ANSWERS,
    (event, args: { sessionId: string; questionStates: Record<string, unknown> }): void => {
      validateSender(event)
      grillPersistenceController.saveAnswers(args.sessionId, args.questionStates)
    }
  )

  // ── grill:generatePlan — Generate structured plan from grill session ──

  ipcMain.handle(
    IPC_CHANNELS.GRILL_GENERATE_PLAN,
    async (event, args: { sessionId: string; workspaceId: string }): Promise<GrillStructuredPlan> => {
      validateSender(event)

      const { sessionId, workspaceId } = args
      if (!sessionId || !workspaceId) {
        throw new Error('sessionId and workspaceId are required')
      }

      grillLog.info(`[grill:generatePlan] Generating plan for session=${sessionId}`)

      const workspace = workspaceRepository.findById(workspaceId)
      const workspacePath = workspace?.repoPath

      const plan = await grillPlanGeneratorService.generate({
        sessionId,
        workspaceId,
        workspacePath
      })

      grillLog.info(`[grill:generatePlan] ✓ Plan generated: ${plan.items.length} items`)
      return plan
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

      grillLog.info(`[grill:condense] Condensing requirement document (${text.length} chars)`)

      try {
        const { execFileSync } = await import('node:child_process')

        const systemPrompt = [
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
        ].join('\n')

        const condensed = execFileSync('claude', [
          '-p', text,
          '--model', 'claude-haiku-4-5-20251001',
          '--system-prompt', systemPrompt,
          '--permission-mode', 'plan',
          '--max-turns', '1',
          '--output-format', 'text'
        ], {
          encoding: 'utf-8',
          timeout: 60_000
        })

        grillLog.info(
          `[grill:condense] Done — ${text.length} → ${condensed.length} chars (${Math.round((condensed.length / text.length) * 100)}%)`
        )

        return { condensed: condensed.trim() || text }
      } catch (err) {
        grillLog.error('[grill:condense] Failed:', err)
        throw new Error(`Condensation failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )
}

// ── Event forwarding ─────────────────────────────────────────────────────

const grillCleanup = createTimedCleanupMap('grill')

/**
 * Wire per-workspace event listeners for the current grill evaluation.
 * Transforms stream chunks, then routes through the persistence controller
 * which both persists to DB and forwards to the renderer via SessionEventRouter.
 */
function wireGrillEvents(workspaceId: string, workspacePath: string): void {
  const cleanups = grillCleanup.prepareCleanups(workspaceId)
  const router = getSessionEventRouter()

  // ── stream — transform chunk + route through persistence ──
  grillCleanup.addListener<{ workspaceId?: string; chunk: StreamChunk }>(
    cleanups,
    grillAgentService,
    'stream',
    (data) => {
      const { chunk } = data

      if (chunk.type === 'text' && chunk.content) {
        grillPersistenceController.handleStreamChunk(
          { type: 'text', content: chunk.content },
          workspaceId,
          router
        )
      } else if (
        chunk.type === 'tool_use' ||
        chunk.type === 'tool_result' ||
        chunk.type === 'tool_progress'
      ) {
        const result = processToolChunk(chunk, {
          workspacePath,
          agentType: 'grill',
          formatTagsToSkip: ['grill-evaluation']
        })
        if (result) {
          grillPersistenceController.handleStreamChunk(result, workspaceId, router)
        }
      }
    }
  )

  // ── evaluation — through persistence controller ──
  grillCleanup.addListener<GrillEvaluation & { workspaceId?: string }>(
    cleanups,
    grillAgentService,
    'evaluation',
    (data) => {
      grillPersistenceController.handleEvaluationResult(data, workspaceId, router)
    }
  )

  // ── complete — through persistence controller ──
  grillCleanup.addListener<{ workspaceId?: string } | undefined>(
    cleanups,
    grillAgentService,
    'complete',
    () => {
      grillPersistenceController.handleComplete(workspaceId, router)
      grillCleanup.runCleanup(workspaceId)
    }
  )

  // Safety net: auto-clean listeners after 60 min (max adapter timeout is 45 min)
  grillCleanup.scheduleAutoCleanup(workspaceId, cleanups, 60 * 60_000)
}
