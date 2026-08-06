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
import { modelConfigService } from '../services/model-config.service'
import { DEFAULT_MODEL_CONFIG } from '../../shared/constants'
import { grillPlanToStructuredPlan } from '../services/grill-plan-mapper'
import { getSessionEventRouter } from '../services/session-event-router'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'
import { notificationService } from '../services/notification.service'
import { resolveWorkspaceName } from './resolve-workspace-name'
import log from 'electron-log'

const grillLog = log.scope('grill-ipc')

// GRILL-DUALSTART-01: Per-workspace start lock prevents the TOCTOU race between
// the isRunning check and evaluate() registering the session in the Map. The lock
// is set synchronously before setup and released in evaluate()'s .finally().
const grillStartLocks = new Set<string>()

export function registerGrillIpc(_mainWindow: BrowserWindow): void {
  // ── grill:evaluate — start a grill evaluation ──────────────────────

  ipcMain.handle(IPC_CHANNELS.GRILL_EVALUATE, async (event, rawArgs: unknown): Promise<void> => {
    validateSender(event)
    // MCP-05 / IPC-08: Runtime validation for all fields
    const ch = IPC_CHANNELS.GRILL_EVALUATE
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const trackId = requireString(args, 'trackId', ch) as GrillTrackId
    const ideaTitle = requireString(args, 'ideaTitle', ch)
    const ideaDescription = requireString(args, 'ideaDescription', ch)
    const iterationHistory = args.iterationHistory as string | undefined
    const previousScore = args.previousScore as number | undefined
    const ideaId = args.ideaId as string | undefined
    const explicitProvider = args.llmProvider as LLMProvider | undefined
    const greenfield = args.greenfield as boolean | undefined
    const projectName = args.projectName as string | undefined

    grillLog.info('[grill:evaluate] Handler invoked', {
      workspaceId,
      trackId,
      greenfield
    })

    // GRILL-DUALSTART-01 + GRILL-ISRUNNING-GLOBAL-01: Per-workspace start lock
    // prevents the TOCTOU race between isRunning check and evaluate() setting
    // session.running. Uses isRunningForWorkspace instead of global isRunning
    // to allow cross-workspace concurrent evaluations.
    if (grillStartLocks.has(workspaceId) || grillAgentService.isRunningForWorkspace(workspaceId)) {
      throw new Error('A grill evaluation is already running for this workspace.')
    }
    grillStartLocks.add(workspaceId)

    try {
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
            {
              status: 'evaluating',
              ideaId: '',
              trackId,
              score: null
            }
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
            llmProvider,
            workspaceId // GRILL-04: pass for event routing
          })
          .catch((err) => {
            grillLog.error('[grill:evaluate:greenfield] evaluate failed:', err)
          })
          .finally(() => {
            grillStartLocks.delete(workspaceId)
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
        .finally(() => {
          grillStartLocks.delete(workspaceId)
        })
    } catch (e) {
      // GRILL-DUALSTART-01: Release lock if synchronous setup fails
      // (e.g. workspace not found, startTracking throws)
      grillStartLocks.delete(workspaceId)
      throw e
    }
  })

  // ── grill:cancel — abort running evaluation ────────────────────────

  // GRILL-02: Accept workspaceId so cancel targets the correct workspace
  ipcMain.handle(IPC_CHANNELS.GRILL_CANCEL, (event, rawArgs?: unknown): void => {
    validateSender(event)
    const workspaceId =
      rawArgs && typeof rawArgs === 'object'
        ? optionalString(
            rawArgs as Record<string, unknown>,
            'workspaceId',
            IPC_CHANNELS.GRILL_CANCEL
          )
        : undefined
    grillAgentService.cancel(workspaceId ?? undefined)
    grillPersistenceController.clearTracking(workspaceId ?? undefined)
  })

  // ── grill:getStatus — current grill status for a workspace ────────

  ipcMain.handle(IPC_CHANNELS.GRILL_GET_STATUS, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.GRILL_GET_STATUS)
    const wId = requireString(args, 'workspaceId', IPC_CHANNELS.GRILL_GET_STATUS)
    const status = grillPersistenceController.getStatusForWorkspace(wId)
    grillLog.info(`[grill:getStatus] workspace=${wId} status=${status?.status ?? 'null'}`)
    return status
  })

  // ── grill:getSession — full session state from DB ─────────────────

  ipcMain.handle(IPC_CHANNELS.GRILL_GET_SESSION, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.GRILL_GET_SESSION)
    const ideaId = requireString(args, 'ideaId', IPC_CHANNELS.GRILL_GET_SESSION)
    const session = grillPersistenceController.getSessionState(ideaId)
    grillLog.info(`[grill:getSession] idea=${ideaId} reconnect status=${session?.status ?? 'null'}`)
    return session
  })

  // ── grill:saveAnswers — persist question states to DB session ─────

  ipcMain.handle(IPC_CHANNELS.GRILL_SAVE_ANSWERS, (event, rawArgs: unknown): void => {
    validateSender(event)
    const ch = IPC_CHANNELS.GRILL_SAVE_ANSWERS
    const args = requireObject(rawArgs, ch)
    const sessionId = requireString(args, 'sessionId', ch)
    if (!args.questionStates || typeof args.questionStates !== 'object') {
      throw new Error(`${ch}: field 'questionStates' must be an object`)
    }
    grillPersistenceController.saveAnswers(
      sessionId,
      args.questionStates as Record<string, unknown>
    )
  })

  // ── grill:generatePlan — Generate structured plan from grill session ──

  ipcMain.handle(
    IPC_CHANNELS.GRILL_GENERATE_PLAN,
    async (event, rawArgs: unknown): Promise<GrillStructuredPlan> => {
      validateSender(event)
      const ch = IPC_CHANNELS.GRILL_GENERATE_PLAN
      const args = requireObject(rawArgs, ch)
      const sessionId = requireString(args, 'sessionId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const ideaId = args.ideaId as string | undefined

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
    async (event, rawArgs: unknown): Promise<GrillStructuredPlan> => {
      validateSender(event)
      const ch = IPC_CHANNELS.GRILL_GENERATE_PLAN_FROM_DECISIONS
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const projectName = ((args.projectName as string) ?? '').slice(0, 10_000)
      const description = ((args.description as string) ?? '').slice(0, 50_000)

      // PLAN-GEN-02 + GRILL-IPC-01: Validate grillDecisions is actually an array with bounded size
      if (args.grillDecisions != null && !Array.isArray(args.grillDecisions)) {
        throw new Error(`${ch}: grillDecisions must be an array`)
      }
      const grillDecisions = (Array.isArray(args.grillDecisions) ? args.grillDecisions : []).slice(
        0,
        200
      ) as GrillDecision[]

      // Validate trackScores if present
      const rawTrackScores = args.trackScores
      const trackScores = Array.isArray(rawTrackScores)
        ? (rawTrackScores.slice(0, 100) as GrillTrackScore[])
        : undefined

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
  // as a `specialist` message containing a ```plan block. Deterministic — no LLM
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
    return messageRepository.create(conversationId, 'specialist', contentMd)
  })

  // ── grill:complete — strip transient state at final handoff, keep plan ──

  ipcMain.handle(IPC_CHANNELS.GRILL_COMPLETE, (event, rawArgs: unknown): void => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.GRILL_COMPLETE)
    const ideaId = requireString(args, 'ideaId', IPC_CHANNELS.GRILL_COMPLETE)

    grillLog.info(`[grill:complete] Completing + stripping transient state for idea=${ideaId}`)
    // GRILL-COMPLETE-DISCARD-NOTRYCATCH-01: Wrap DB ops in try-catch so a failure
    // doesn't prevent the terminal status emission below.
    try {
      grillSessionRepository.completeAndStrip(ideaId)
      ideaRepository.clearGrillDecisions(ideaId)
    } catch (err) {
      grillLog.error('[grill:complete] DB operation failed:', err)
    }
    // Always emit terminal status — even if DB ops failed
    const workspace = ideaRepository.findById(ideaId)?.workspaceId
    if (workspace) grillPersistenceController.notifyTerminal(workspace, ideaId, 'completed')
  })

  // ── grill:discard — delete the session row + snapshot entirely ──────

  ipcMain.handle(IPC_CHANNELS.GRILL_DISCARD, (event, rawArgs: unknown): void => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.GRILL_DISCARD)
    const ideaId = requireString(args, 'ideaId', IPC_CHANNELS.GRILL_DISCARD)

    grillLog.info(`[grill:discard] Discarding grill session + snapshot for idea=${ideaId}`)
    // Capture workspaceId BEFORE deleting the session/idea data
    const workspace = ideaRepository.findById(ideaId)?.workspaceId
    // GRILL-COMPLETE-DISCARD-NOTRYCATCH-01: Wrap DB ops in try-catch so a failure
    // doesn't prevent the terminal status emission below.
    try {
      grillSessionRepository.deleteByIdeaId(ideaId)
      ideaRepository.clearGrillDecisions(ideaId)
    } catch (err) {
      grillLog.error('[grill:discard] DB operation failed:', err)
    }
    // Always emit terminal status — even if DB ops failed
    if (workspace) grillPersistenceController.notifyTerminal(workspace, ideaId, 'cancelled')
  })

  // ── grill:listPlannedIdeas — idea IDs in a workspace that have a saved plan ──

  ipcMain.handle(IPC_CHANNELS.GRILL_LIST_PLANNED_IDEAS, (event, rawArgs: unknown): string[] => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.GRILL_LIST_PLANNED_IDEAS)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.GRILL_LIST_PLANNED_IDEAS)
    return grillSessionRepository.findIdeaIdsWithPlan(workspaceId)
  })

  // ── grill:condenseRequirement — Haiku summarization of long docs ───

  ipcMain.handle(
    IPC_CHANNELS.GRILL_CONDENSE_REQUIREMENT,
    async (event, rawArgs: unknown): Promise<{ condensed: string }> => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.GRILL_CONDENSE_REQUIREMENT)
      const text = requireString(args, 'text', IPC_CHANNELS.GRILL_CONDENSE_REQUIREMENT)
      const workspaceId = optionalString(
        args,
        'workspaceId',
        IPC_CHANNELS.GRILL_CONDENSE_REQUIREMENT
      )
      if (text.length < 1000) {
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

        const resolvedCondenseModel = workspaceId
          ? modelConfigService.getModelById(workspaceId, 'condense')
          : DEFAULT_MODEL_CONFIG['condense']

        const { text: condensed } = await runOneShotClaude({
          feature: 'condense',
          model: resolvedCondenseModel,
          args: [
            '-p',
            text,
            '--model',
            resolvedCondenseModel,
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

  // ── status — forward live token/context counters to the renderer ──
  grillCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    grillAgentService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      router.sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, { ...data.status })
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
      // GRILL-DEDUP-NOTIF-01: Read evaluationHandled BEFORE handleComplete()
      // clears tracking state. The normal path dispatches 'needs_input' from
      // handleEvaluationResult — only fire the 'completed' notification when
      // no evaluation was parsed (recovery/empty-evaluation path).
      const tracking = grillPersistenceController.getTrackingForWorkspace(workspaceId)
      const evaluationWasHandled = tracking?.evaluationHandled ?? false

      grillPersistenceController.handleComplete(workspaceId, router)

      if (!evaluationWasHandled) {
        notificationService.dispatch({
          workspaceId,
          workspaceName: resolveWorkspaceName(workspaceId),
          service: 'grill',
          status: 'completed',
          summary: 'Grill evaluation complete — review your score and questions',
          targetPage: 'grill'
        })
      }

      grillCleanup.runCleanup(workspaceId)
    }
  )

  // Safety net: auto-clean listeners after 60 min (max adapter timeout is 45 min)
  grillCleanup.scheduleAutoCleanup(workspaceId, cleanups, 60 * 60_000)
}
