/**
 * Blueprint IPC handlers.
 *
 * Follows the mpa.ipc.ts pattern:
 * - ipcMain.handle for request/response (CRUD, phase management, artifacts)
 * - webContents.send for event forwarding (phaseStart, phaseProgress, etc.)
 */

import { ipcMain, type BrowserWindow } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString, optionalNumber } from './validate-args'
import { createTimedCleanupMap } from './listener-cleanup'
import { blueprintService } from '../services/blueprint.service'
import { blueprintSpecService } from '../services/blueprint-spec.service'
import { blueprintPlanService } from '../services/blueprint-plan.service'
import { blueprintTasksService } from '../services/blueprint-tasks.service'
import { blueprintReviewService } from '../services/blueprint-review.service'
import { blueprintBuildService } from '../services/blueprint-build.service'
import { blueprintVerifyService } from '../services/blueprint-verify.service'
import { workspaceRepository } from '../db/repositories'
import { getSessionEventRouter } from '../services/session-event-router'
import type { AgentStatus } from '../../shared/types'
import type {
  BlueprintPhaseType,
  BlueprintArtifact,
  BlueprintPriority,
  BlueprintPhaseStartPayload,
  BlueprintPhaseProgressPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload,
  BlueprintApprovalNeededPayload,
  BlueprintWaveStartPayload,
  BlueprintWaveTaskStartPayload,
  BlueprintWaveTaskCompletePayload,
  BlueprintWaveCompletePayload
} from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-ipc')

// ── Event Cleanup ──

const blueprintCleanup = createTimedCleanupMap('blueprint')

// ── Main Registration ──

export function registerBlueprintIpc(_mainWindow: BrowserWindow): void {
  // ── blueprint:create — Create a new blueprint ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_CREATE,
    (event, rawArgs: unknown) => {
      validateSender(event)
      // BP-IPC-NO-VALIDATION-01: Runtime validation matching grill/chat pattern.
      const ch = IPC_CHANNELS.BLUEPRINT_CREATE
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const title = requireString(args, 'title', ch)
      const description = optionalString(args, 'description', ch)
      const priority = optionalString(args, 'priority', ch) as BlueprintPriority | undefined
      const settingsJson = args.settingsJson as Record<string, unknown> | undefined
      return blueprintService.create({ workspaceId, title, description, priority, settingsJson })
    }
  )

  // ── blueprint:createFromIdea — Graduate an Idea to a Blueprint ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_CREATE_FROM_IDEA,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_CREATE_FROM_IDEA
      const args = requireObject(rawArgs, ch)
      const ideaId = requireString(args, 'ideaId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      return blueprintService.createFromIdea(ideaId, workspaceId)
    }
  )

  // ── blueprint:get — Get a blueprint with phases ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_GET, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_GET)
    const id = requireString(args, 'id', IPC_CHANNELS.BLUEPRINT_GET)
    return blueprintService.getBlueprint(id)
  })

  // ── blueprint:getDetails — Get a blueprint with phases + tasks ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_GET_DETAILS, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_GET_DETAILS)
    const id = requireString(args, 'id', IPC_CHANNELS.BLUEPRINT_GET_DETAILS)
    return blueprintService.getBlueprintWithDetails(id)
  })

  // ── blueprint:list — List blueprints for a workspace ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_LIST,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_LIST
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const limit = optionalNumber(args, 'limit', ch)
      return blueprintService.listBlueprints(workspaceId, limit)
    }
  )

  // ── blueprint:delete — Delete a blueprint ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_DELETE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_DELETE)
    const id = requireString(args, 'id', IPC_CHANNELS.BLUEPRINT_DELETE)
    blueprintService.delete(id)
    return { deleted: true }
  })

  // ── blueprint:cancel — Cancel an active blueprint pipeline ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_CANCEL, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_CANCEL)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.BLUEPRINT_CANCEL)

    // BP-CANCEL-LOCK-01: Wrap in try/finally to guarantee blueprintService.cancel()
    // always runs — even if a phase cancel throws. Without this, a single phase
    // cancel failure orphans the startLock and permanently blocks new blueprints.
    try {
      const activeBlueprintId = blueprintService.getActiveBlueprintId(workspaceId)
      if (activeBlueprintId) {
        // Best-effort cancel each phase service — don't let one failure block others
        const phaseServices = [
          blueprintSpecService, blueprintPlanService, blueprintTasksService,
          blueprintReviewService, blueprintBuildService, blueprintVerifyService
        ]
        for (const svc of phaseServices) {
          try { await svc.cancelBlueprint(activeBlueprintId) }
          catch (e) { bpLog.error(`[cancel] Phase cancel failed:`, e) }
        }
      }
    } finally {
      // ALWAYS release the lock, even if phase cancels threw
      blueprintService.cancel(workspaceId)
    }
    return { cancelled: true }
  })

  // ── blueprint:advancePhase — Advance to next phase ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_ADVANCE_PHASE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_ADVANCE_PHASE)
    const blueprintId = requireString(args, 'blueprintId', IPC_CHANNELS.BLUEPRINT_ADVANCE_PHASE)
    return blueprintService.advancePhase(blueprintId)
  })

  // ── blueprint:skipPhase — Skip a phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_SKIP_PHASE,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_SKIP_PHASE
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const phase = requireString(args, 'phase', ch) as BlueprintPhaseType
      blueprintService.skipPhase(blueprintId, phase)
      return { skipped: true }
    }
  )

  // ── blueprint:rewindPhase — Rewind to a previous phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_REWIND_PHASE,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_REWIND_PHASE
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const phase = requireString(args, 'phase', ch) as BlueprintPhaseType
      blueprintService.rewindToPhase(blueprintId, phase)
      return { rewound: true }
    }
  )

  // ── blueprint:buildPrompt — Build system prompt for a phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_BUILD_PROMPT,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_BUILD_PROMPT
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const phase = requireString(args, 'phase', ch) as BlueprintPhaseType
      return { prompt: blueprintService.buildSystemPrompt(blueprintId, phase) }
    }
  )

  // ── blueprint:saveArtifact — Save a phase artifact ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_SAVE_ARTIFACT,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_SAVE_ARTIFACT
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const phase = requireString(args, 'phase', ch) as BlueprintPhaseType
      if (!args.artifact || typeof args.artifact !== 'object') {
        throw new Error(`${ch}: field 'artifact' must be an object`)
      }
      blueprintService.savePhaseArtifact(blueprintId, phase, args.artifact as BlueprintArtifact)
      return { saved: true }
    }
  )

  // ── blueprint:getArtifacts — Get all artifacts for a blueprint ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_GET_ARTIFACTS, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_GET_ARTIFACTS)
    const blueprintId = requireString(args, 'blueprintId', IPC_CHANNELS.BLUEPRINT_GET_ARTIFACTS)
    return blueprintService.getAllArtifacts(blueprintId)
  })

  // ── blueprint:populateTasks — Parse and store tasks from blueprint-tasks JSON ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_POPULATE_TASKS,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_POPULATE_TASKS
      // BP-IPC-NO-VALIDATION-01: Use requireObject/requireString pattern.
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)

      // TASK-02: Validate input bounds before passing to service
      if (!Array.isArray(args.tasks)) {
        throw new Error(`${ch}: tasks must be an array`)
      }
      if (args.tasks.length > 500) {
        throw new Error(`${ch}: tasks array too large (${args.tasks.length}, max 500)`)
      }

      return blueprintService.populateTasks(blueprintId, args.tasks as Array<{
        taskId: string
        wave: number
        description: string
        userStory?: string
        files?: string[]
        isParallel?: boolean
        dependsOn?: string[]
      }>)
    }
  )

  // ── blueprint:getPipelineStatus — Get pipeline status for a workspace ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_GET_PIPELINE_STATUS,
    (event, args: { workspaceId: string }) => {
      validateSender(event)
      return blueprintService.getPipelineStatus(args.workspaceId)
    }
  )

  // ── blueprint:approvalRespond — Respond to an approval gate ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_APPROVAL_RESPOND,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_APPROVAL_RESPOND
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      if (typeof args.approved !== 'boolean') {
        throw new Error(`${ch}: field 'approved' must be a boolean`)
      }
      const approved = args.approved

      if (approved) {
        // Advance to BUILD phase — DB state is set by blueprintBuildService.startBuildPhase()
        bpLog.info(
          `[blueprint:approvalRespond] Blueprint ${blueprintId} — approved, triggering BUILD`
        )

        // Look up workspace for the repo path
        const blueprint = blueprintService.getBlueprint(blueprintId)
        if (blueprint) {
          const workspace = workspaceRepository.findById(blueprint.workspaceId)
          if (workspace) {
            // Wire event forwarding (may already be wired — prepareCleanups is idempotent)
            wireBlueprintEvents(blueprint.workspaceId)

            // Start the BUILD phase (non-blocking)
            blueprintBuildService
              .startBuildPhase({
                blueprintId,
                workspaceId: blueprint.workspaceId,
                workspacePath: workspace.repoPath
              })
              .catch((err) => {
                bpLog.error('[blueprint:approvalRespond] BUILD phase failed:', err)
              })
          } else {
            bpLog.error(
              `[blueprint:approvalRespond] Workspace not found for blueprint ${blueprintId}`
            )
          }
        } else {
          bpLog.error(`[blueprint:approvalRespond] Blueprint not found: ${blueprintId}`)
        }
      } else {
        // Not approved — rewind to plan phase for iteration
        blueprintService.rewindToPhase(blueprintId, 'plan')
        bpLog.info(
          `[blueprint:approvalRespond] Blueprint ${blueprintId} — rejected, rewound to plan`
        )
      }

      return { responded: true }
    }
  )

  // ── blueprint:getConstitution — Get workspace constitution ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_GET_CONSTITUTION,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_GET_CONSTITUTION)
      const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.BLUEPRINT_GET_CONSTITUTION)
      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) return null
      return {
        constitutionMd: workspace.constitutionMd ?? null,
        constitutionVersion: workspace.constitutionVersion ?? '1.0.0'
      }
    }
  )

  // ── blueprint:saveConstitution — Save workspace constitution ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_SAVE_CONSTITUTION,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_SAVE_CONSTITUTION
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const constitutionMd = requireString(args, 'constitutionMd', ch)
      const version = optionalString(args, 'version', ch)
      workspaceRepository.updateConstitution(
        workspaceId,
        constitutionMd,
        version ?? '1.0.0'
      )
      return { saved: true }
    }
  )

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 2: Specify + Clarify Pipeline Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  // ── blueprint:startSpecify — Start the SPECIFY phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_START_SPECIFY,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_START_SPECIFY
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)

      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`)
      }

      const blueprint = blueprintService.getBlueprint(blueprintId)
      if (!blueprint) {
        throw new Error(`Blueprint not found: ${blueprintId}`)
      }

      // Extract grill decisions from settings if available
      const grillDecisions = blueprint.settingsJson?.grillDecisions as
        | Array<{ header: string; selectedOption: string; reason: string }>
        | undefined

      // Wire event forwarding for this workspace
      wireBlueprintEvents(workspaceId)

      // Start the SPECIFY phase (non-blocking)
      blueprintSpecService
        .startSpecifyPhase({
          blueprintId,
          workspaceId,
          workspacePath: workspace.repoPath,
          description: blueprint.description,
          grillDecisions
        })
        .catch((err) => {
          bpLog.error('[blueprint:startSpecify] Phase failed:', err)
        })

      return { started: true }
    }
  )

  // ── blueprint:startClarify — Start the CLARIFY phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_START_CLARIFY,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_START_CLARIFY
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)

      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(workspaceId)

      // Start the CLARIFY phase (non-blocking)
      blueprintSpecService
        .startClarifyPhase({
          blueprintId,
          workspaceId,
          workspacePath: workspace.repoPath
        })
        .catch((err) => {
          bpLog.error('[blueprint:startClarify] Phase failed:', err)
        })

      return { started: true }
    }
  )

  // ── blueprint:clarifyAnswer — Send a user answer during CLARIFY ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_CLARIFY_ANSWER,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_CLARIFY_ANSWER
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const message = requireString(args, 'message', ch)

      await blueprintSpecService.sendClarifyAnswer({
        blueprintId,
        workspaceId,
        message
      })

      return { sent: true }
    }
  )

  // ── blueprint:skipClarify — Skip the CLARIFY phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_SKIP_CLARIFY,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_SKIP_CLARIFY)
      const blueprintId = requireString(args, 'blueprintId', IPC_CHANNELS.BLUEPRINT_SKIP_CLARIFY)
      await blueprintSpecService.skipClarifyPhase(blueprintId)
      return { skipped: true }
    }
  )

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 3: Plan Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════════

  // ── blueprint:startPlan — Start the PLAN phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_START_PLAN,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_START_PLAN
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)

      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(workspaceId)

      // Start the PLAN phase (non-blocking)
      blueprintPlanService
        .startPlanPhase({
          blueprintId,
          workspaceId,
          workspacePath: workspace.repoPath
        })
        .catch((err) => {
          bpLog.error('[blueprint:startPlan] Phase failed:', err)
        })

      return { started: true }
    }
  )

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 4: Tasks Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════════

  // ── blueprint:startTasks — Start the TASKS phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_START_TASKS,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_START_TASKS
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)

      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(workspaceId)

      // Start the TASKS phase (non-blocking)
      blueprintTasksService
        .startTasksPhase({
          blueprintId,
          workspaceId,
          workspacePath: workspace.repoPath
        })
        .catch((err) => {
          bpLog.error('[blueprint:startTasks] Phase failed:', err)
        })

      return { started: true }
    }
  )

  // ═══════════════════════════════════════════════════════════════════════
  //  Phase 5: Review Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════

  // ── blueprint:startReview — Start the REVIEW phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_START_REVIEW,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_START_REVIEW
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)

      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(workspaceId)

      // Start the REVIEW phase (non-blocking)
      blueprintReviewService
        .startReviewPhase({
          blueprintId,
          workspaceId,
          workspacePath: workspace.repoPath
        })
        .catch((err) => {
          bpLog.error('[blueprint:startReview] Phase failed:', err)
        })

      return { started: true }
    }
  )

  // ═══════════════════════════════════════════════════════════════════════
  //  Phase 6: Build Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════

  // ── blueprint:startBuild — Start the BUILD phase (manual trigger) ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_START_BUILD,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_START_BUILD
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)

      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(workspaceId)

      // Start the BUILD phase (non-blocking)
      blueprintBuildService
        .startBuildPhase({
          blueprintId,
          workspaceId,
          workspacePath: workspace.repoPath
        })
        .catch((err) => {
          bpLog.error('[blueprint:startBuild] Phase failed:', err)
        })

      return { started: true }
    }
  )

  // ═══════════════════════════════════════════════════════════════════════
  //  Phase 7: Verify Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════

  // ── blueprint:startVerify — Start the VERIFY phase (manual trigger or auto from BUILD) ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_START_VERIFY,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_START_VERIFY
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)

      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(workspaceId)

      // Start the VERIFY phase (non-blocking)
      blueprintVerifyService
        .startVerifyPhase({
          blueprintId,
          workspaceId,
          workspacePath: workspace.repoPath
        })
        .catch((err) => {
          bpLog.error('[blueprint:startVerify] Phase failed:', err)
        })

      return { started: true }
    }
  )

  // ── Stale blueprint detection on registration ──
  blueprintService.reconcileStaleBlueprints()
}

// ── Event Forwarding (per-workspace) ──

export function wireBlueprintEvents(workspaceId: string): void {
  const cleanups = blueprintCleanup.prepareCleanups(workspaceId)
  // BLUEPRINT-15: resolve router lazily inside callbacks, not at wire time

  blueprintCleanup.addListener<BlueprintPhaseStartPayload>(
    cleanups,
    blueprintService,
    'phaseStart',
    (payload) => {
      bpLog.info(`[event] phaseStart: ${payload.phase}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseProgressPayload>(
    cleanups,
    blueprintService,
    'phaseProgress',
    (payload) => {
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseCompletePayload>(
    cleanups,
    blueprintService,
    'phaseComplete',
    (payload) => {
      bpLog.info(`[event] phaseComplete: ${payload.phase} — ${payload.status}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseArtifactPayload>(
    cleanups,
    blueprintService,
    'phaseArtifact',
    (payload) => {
      bpLog.info(`[event] phaseArtifact: ${payload.phase} — ${payload.artifact.type}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  // ── BlueprintBuildService events (Phase 6: Build) ──

  blueprintCleanup.addListener<BlueprintPhaseStartPayload>(
    cleanups,
    blueprintBuildService,
    'phaseStart',
    (payload) => {
      bpLog.info(`[build-event] phaseStart: ${payload.phase}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseProgressPayload>(
    cleanups,
    blueprintBuildService,
    'phaseProgress',
    (payload) => {
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseCompletePayload>(
    cleanups,
    blueprintBuildService,
    'phaseComplete',
    (payload) => {
      bpLog.info(`[build-event] phaseComplete: ${payload.phase} — ${payload.status}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseArtifactPayload>(
    cleanups,
    blueprintBuildService,
    'phaseArtifact',
    (payload) => {
      bpLog.info(`[build-event] phaseArtifact: ${payload.phase} — ${payload.artifact.type}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  // Forward live token/context counters from build service
  blueprintCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    blueprintBuildService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, { ...data.status })
    }
  )

  // Wave execution events (from blueprintBuildService)

  blueprintCleanup.addListener<BlueprintWaveStartPayload>(
    cleanups,
    blueprintBuildService,
    'waveStart',
    (payload) => {
      bpLog.info(`[build-event] waveStart: wave ${payload.wave} (${payload.taskCount} tasks)`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_WAVE_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintWaveTaskStartPayload>(
    cleanups,
    blueprintBuildService,
    'waveTaskStart',
    (payload) => {
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_WAVE_TASK_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintWaveTaskCompletePayload>(
    cleanups,
    blueprintBuildService,
    'waveTaskComplete',
    (payload) => {
      bpLog.info(`[build-event] waveTaskComplete: ${payload.taskId} — ${payload.status}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_WAVE_TASK_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintWaveCompletePayload>(
    cleanups,
    blueprintBuildService,
    'waveComplete',
    (payload) => {
      bpLog.info(`[build-event] waveComplete: wave ${payload.wave} — ${payload.status}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_WAVE_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  // ── BlueprintSpecService events (Phase 2: Specify + Clarify) ──

  blueprintCleanup.addListener<BlueprintPhaseStartPayload>(
    cleanups,
    blueprintSpecService,
    'phaseStart',
    (payload) => {
      bpLog.info(`[spec-event] phaseStart: ${payload.phase}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseProgressPayload>(
    cleanups,
    blueprintSpecService,
    'phaseProgress',
    (payload) => {
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseCompletePayload>(
    cleanups,
    blueprintSpecService,
    'phaseComplete',
    (payload) => {
      bpLog.info(`[spec-event] phaseComplete: ${payload.phase} — ${payload.status}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseArtifactPayload>(
    cleanups,
    blueprintSpecService,
    'phaseArtifact',
    (payload) => {
      bpLog.info(`[spec-event] phaseArtifact: ${payload.phase} — ${payload.artifact.type}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  // Forward live token/context counters from spec service
  blueprintCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    blueprintSpecService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, { ...data.status })
    }
  )

  // ── BlueprintPlanService events (Phase 3: Plan) ──

  blueprintCleanup.addListener<BlueprintPhaseStartPayload>(
    cleanups,
    blueprintPlanService,
    'phaseStart',
    (payload) => {
      bpLog.info(`[plan-event] phaseStart: ${payload.phase}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseProgressPayload>(
    cleanups,
    blueprintPlanService,
    'phaseProgress',
    (payload) => {
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseCompletePayload>(
    cleanups,
    blueprintPlanService,
    'phaseComplete',
    (payload) => {
      bpLog.info(`[plan-event] phaseComplete: ${payload.phase} — ${payload.status}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseArtifactPayload>(
    cleanups,
    blueprintPlanService,
    'phaseArtifact',
    (payload) => {
      bpLog.info(`[plan-event] phaseArtifact: ${payload.phase} — ${payload.artifact.type}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  // Forward live token/context counters from plan service
  blueprintCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    blueprintPlanService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, { ...data.status })
    }
  )

  // ── BlueprintTasksService events (Phase 4: Tasks) ──

  blueprintCleanup.addListener<BlueprintPhaseStartPayload>(
    cleanups,
    blueprintTasksService,
    'phaseStart',
    (payload) => {
      bpLog.info(`[tasks-event] phaseStart: ${payload.phase}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseProgressPayload>(
    cleanups,
    blueprintTasksService,
    'phaseProgress',
    (payload) => {
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseCompletePayload>(
    cleanups,
    blueprintTasksService,
    'phaseComplete',
    (payload) => {
      bpLog.info(`[tasks-event] phaseComplete: ${payload.phase} — ${payload.status}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseArtifactPayload>(
    cleanups,
    blueprintTasksService,
    'phaseArtifact',
    (payload) => {
      bpLog.info(`[tasks-event] phaseArtifact: ${payload.phase} — ${payload.artifact.type}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  // Forward live token/context counters from tasks service
  blueprintCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    blueprintTasksService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, { ...data.status })
    }
  )

  // ── BlueprintReviewService events (Phase 5: Review) ──

  blueprintCleanup.addListener<BlueprintPhaseStartPayload>(
    cleanups,
    blueprintReviewService,
    'phaseStart',
    (payload) => {
      bpLog.info(`[review-event] phaseStart: ${payload.phase}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseProgressPayload>(
    cleanups,
    blueprintReviewService,
    'phaseProgress',
    (payload) => {
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseCompletePayload>(
    cleanups,
    blueprintReviewService,
    'phaseComplete',
    (payload) => {
      bpLog.info(`[review-event] phaseComplete: ${payload.phase} — ${payload.status}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseArtifactPayload>(
    cleanups,
    blueprintReviewService,
    'phaseArtifact',
    (payload) => {
      bpLog.info(`[review-event] phaseArtifact: ${payload.phase} — ${payload.artifact.type}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  // Forward live token/context counters from review service
  blueprintCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    blueprintReviewService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, { ...data.status })
    }
  )

  // Forward approval gate from review service
  blueprintCleanup.addListener<BlueprintApprovalNeededPayload>(
    cleanups,
    blueprintReviewService,
    'approvalNeeded',
    (payload) => {
      bpLog.info(`[review-event] approvalNeeded: ${payload.phase}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_APPROVAL_NEEDED,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  // ── BlueprintVerifyService events (Phase 7: Verify) ──

  blueprintCleanup.addListener<BlueprintPhaseStartPayload>(
    cleanups,
    blueprintVerifyService,
    'phaseStart',
    (payload) => {
      bpLog.info(`[verify-event] phaseStart: ${payload.phase}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_START,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseProgressPayload>(
    cleanups,
    blueprintVerifyService,
    'phaseProgress',
    (payload) => {
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseCompletePayload>(
    cleanups,
    blueprintVerifyService,
    'phaseComplete',
    (payload) => {
      bpLog.info(`[verify-event] phaseComplete: ${payload.phase} — ${payload.status}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  blueprintCleanup.addListener<BlueprintPhaseArtifactPayload>(
    cleanups,
    blueprintVerifyService,
    'phaseArtifact',
    (payload) => {
      bpLog.info(`[verify-event] phaseArtifact: ${payload.phase} — ${payload.artifact.type}`)
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
        workspaceId,
        payload as unknown as Record<string, unknown>
      )
    }
  )

  // Forward live token/context counters from verify service
  blueprintCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    blueprintVerifyService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, { ...data.status })
    }
  )

  // Safety net: auto-clean listeners after 180 min (7 phases + approval gates)
  blueprintCleanup.scheduleAutoCleanup(workspaceId, cleanups, 180 * 60_000)
}
