/**
 * IPC handlers for Grill evaluations.
 *
 * Bridges the renderer ↔ GrillAgentService and forwards streaming events
 * to the renderer via webContents.send().
 */

import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  GrillTrackId,
  GrillEvaluation,
  LLMProvider,
  GrillStructuredPlan,
  GrillDecision,
  GrillTrackScore,
  AgentStatus
} from '../../shared/types'
import type { StreamChunk } from '../services/agent-base.service'
import { processToolChunk } from './tool-chunk-processor'
import { createTimedCleanupMap } from './listener-cleanup'
import {
  workspaceRepository,
  grillSessionRepository,
  ideaRepository,
  messageRepository
} from '../db/repositories'
import { grillAgentService } from '../services/grill-agent.service'
import { grillPersistenceController } from '../services/grill-persistence.controller'
import { grillPlanGeneratorService } from '../services/grill-plan-generator.service'
import { runOneShotClaude } from '../services/one-shot-claude'
import { grillPlanToStructuredPlan } from '../services/grill-plan-mapper'
import { getSessionEventRouter } from '../services/session-event-router'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'
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
      await handleGrillEvaluate(args)
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
    const status = grillPersistenceController.getStatusForWorkspace(args.workspaceId)
    grillLog.info(
      `[grill:getStatus] workspace=${args.workspaceId} status=${status?.status ?? 'null'}`
    )
    return status
  })

  // ── grill:getSession — full session state from DB ─────────────────

  ipcMain.handle(IPC_CHANNELS.GRILL_GET_SESSION, (event, args: { ideaId: string }) => {
    validateSender(event)
    const session = grillPersistenceController.getSessionState(args.ideaId)
    grillLog.info(
      `[grill:getSession] idea=${args.ideaId} reconnect status=${session?.status ?? 'null'}`
    )
    return session
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
    async (
      event,
      args: { sessionId: string; ideaId?: string; workspaceId: string }
    ): Promise<GrillStructuredPlan> => {
      validateSender(event)

      const { sessionId, ideaId, workspaceId } = args
      if (!sessionId || !workspaceId) {
        throw new Error('sessionId and workspaceId are required')
      }

      grillLog.info(
        `[grill:generatePlan] Generating plan for idea=${ideaId ?? 'n/a'} session=${sessionId}`
      )

      const workspace = workspaceRepository.findById(workspaceId)
      const workspacePath = workspace?.repoPath

      const plan = await grillPlanGeneratorService.generate({
        sessionId,
        ideaId,
        workspaceId,
        workspacePath
      })

      grillLog.info(`[grill:generatePlan] ✓ Plan generated: ${plan.items.length} items`)
      return plan
    }
  )

  // ── grill:generatePlanFromDecisions — session-less plan from decisions ──

  ipcMain.handle(
    IPC_CHANNELS.GRILL_GENERATE_PLAN_FROM_DECISIONS,
    async (
      event,
      args: {
        projectName: string
        description: string
        grillDecisions: GrillDecision[]
        trackScores?: GrillTrackScore[]
        workspaceId: string
      }
    ): Promise<GrillStructuredPlan> => {
      validateSender(event)

      const { projectName, description, grillDecisions, trackScores, workspaceId } = args
      if (!workspaceId) {
        throw new Error('workspaceId is required')
      }

      grillLog.info(
        `[grill:generatePlanFromDecisions] Generating plan for project="${projectName}" (${grillDecisions?.length ?? 0} decisions)`
      )

      const plan = await grillPlanGeneratorService.generateFromDecisions({
        projectName: projectName ?? '',
        description: description ?? '',
        grillDecisions: grillDecisions ?? [],
        trackScores,
        workspaceId
      })

      grillLog.info(
        `[grill:generatePlanFromDecisions] ✓ Plan generated: ${plan.items.length} items`
      )
      return plan
    }
  )

  // ── grill:seedPlanCard — seed an already-generated plan as a chat card ──
  // Maps the GrillStructuredPlan to the chat StructuredPlan shape and writes it
  // as a `da-vinci` message containing a ```plan block. Deterministic — no LLM
  // round-trip — so the grill→chat handoff renders the existing plan instantly.

  ipcMain.handle(IPC_CHANNELS.GRILL_SEED_PLAN_CARD, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.GRILL_SEED_PLAN_CARD)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.GRILL_SEED_PLAN_CARD)
    const plan = (args as { plan?: GrillStructuredPlan }).plan
    if (!plan || typeof plan !== 'object') {
      throw new Error(`${IPC_CHANNELS.GRILL_SEED_PLAN_CARD}: field 'plan' must be an object`)
    }

    const structured = grillPlanToStructuredPlan(plan)
    const leadIn = 'Here’s the implementation plan synthesized from your grill session.'
    const contentMd = `${leadIn}\n\n\`\`\`plan\n${JSON.stringify(structured)}\n\`\`\``

    grillLog.info(
      `[grill:seedPlanCard] Seeding plan card into conversation=${conversationId} (${structured.phases?.length ?? 0} phases)`
    )
    return messageRepository.create(conversationId, 'da-vinci', contentMd)
  })

  // ── grill:complete — strip transient state at final handoff, keep plan ──

  ipcMain.handle(IPC_CHANNELS.GRILL_COMPLETE, (event, args: { ideaId: string }): void => {
    validateSender(event)
    const { ideaId } = args
    if (!ideaId) throw new Error('ideaId is required')

    grillLog.info(`[grill:complete] Completing + stripping transient state for idea=${ideaId}`)
    grillSessionRepository.completeAndStrip(ideaId)
    ideaRepository.clearGrillDecisions(ideaId)

    // Emit terminal status so the renderer badge clears immediately
    const workspace = ideaRepository.findById(ideaId)?.workspaceId
    if (workspace) grillPersistenceController.notifyTerminal(workspace, ideaId, 'completed')
  })

  // ── grill:discard — delete the session row + snapshot entirely ──────

  ipcMain.handle(IPC_CHANNELS.GRILL_DISCARD, (event, args: { ideaId: string }): void => {
    validateSender(event)
    const { ideaId } = args
    if (!ideaId) throw new Error('ideaId is required')

    grillLog.info(`[grill:discard] Discarding grill session + snapshot for idea=${ideaId}`)
    // Capture workspaceId BEFORE deleting the session/idea data
    const workspace = ideaRepository.findById(ideaId)?.workspaceId
    grillSessionRepository.deleteByIdeaId(ideaId)
    ideaRepository.clearGrillDecisions(ideaId)

    // Emit terminal status so the renderer badge clears immediately
    if (workspace) grillPersistenceController.notifyTerminal(workspace, ideaId, 'cancelled')
  })

  // ── grill:listPlannedIdeas — idea IDs in a workspace that have a saved plan ──

  ipcMain.handle(
    IPC_CHANNELS.GRILL_LIST_PLANNED_IDEAS,
    (event, args: { workspaceId: string }): string[] => {
      validateSender(event)
      if (!args?.workspaceId) return []
      return grillSessionRepository.findIdeaIdsWithPlan(args.workspaceId)
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

        const { text: condensed } = await runOneShotClaude({
          feature: 'condense',
          model: 'claude-haiku-4-5-20251001',
          args: [
            '-p',
            text,
            '--model',
            'claude-haiku-4-5-20251001',
            '--system-prompt',
            systemPrompt,
            '--permission-mode',
            'plan',
            '--max-turns',
            '1'
          ],
          cli: {
            timeout: 60_000
          }
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

// ── Evaluate handler (extracted for CC reduction) ────────────────────────

async function handleGrillEvaluate(args: {
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
}): Promise<void> {
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

    // Emit transient 'evaluating' status so the bottom bar shows "Grilling…"
    // immediately. The standard path gets this from startTracking, but
    // greenfield skips the persistence controller.
    try {
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.GRILL_STATUS_CHANGED,
        workspaceId,
        { status: 'evaluating', ideaId: '', trackId, score: null }
      )
    } catch {
      /* router not initialized */
    }

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

// ── Event forwarding ─────────────────────────────────────────────────────

const grillCleanup = createTimedCleanupMap('grill')

/**
 * Wire per-workspace event listeners for the current grill evaluation.
 * Transforms stream chunks, then routes through the persistence controller
 * which both persists to DB and forwards to the renderer via SessionEventRouter.
 */
function wireGrillEvents(workspaceId: string, workspacePath: string): void {
  const cleanups = grillCleanup.prepareCleanups(workspaceId)
  // GRILL-12: resolve router lazily inside callbacks, not at wire time

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
          getSessionEventRouter()
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
          grillPersistenceController.handleStreamChunk(result, workspaceId, getSessionEventRouter())
        }
      }
    }
  )

  // ── status — forward live token/context counters to the renderer ──
  grillCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    grillAgentService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, { ...data.status })
    }
  )

  // ── evaluation — through persistence controller ──
  grillCleanup.addListener<GrillEvaluation & { workspaceId?: string }>(
    cleanups,
    grillAgentService,
    'evaluation',
    (data) => {
      grillPersistenceController.handleEvaluationResult(data, workspaceId, getSessionEventRouter())
    }
  )

  // ── complete — through persistence controller ──
  grillCleanup.addListener<{ workspaceId?: string } | undefined>(
    cleanups,
    grillAgentService,
    'complete',
    () => {
      grillPersistenceController.handleComplete(workspaceId, getSessionEventRouter())
      grillCleanup.runCleanup(workspaceId)
    }
  )

  // Safety net: auto-clean listeners after 60 min (max adapter timeout is 45 min)
  grillCleanup.scheduleAutoCleanup(workspaceId, cleanups, 60 * 60_000)
}
