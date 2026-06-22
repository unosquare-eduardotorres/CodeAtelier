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
    (
      event,
      args: {
        workspaceId: string
        title: string
        description?: string
        priority?: BlueprintPriority
        settingsJson?: Record<string, unknown>
      }
    ) => {
      validateSender(event)
      return blueprintService.create({
        workspaceId: args.workspaceId,
        title: args.title,
        description: args.description,
        priority: args.priority,
        settingsJson: args.settingsJson
      })
    }
  )

  // ── blueprint:createFromIdea — Graduate an Idea to a Blueprint ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_CREATE_FROM_IDEA,
    (event, args: { ideaId: string; workspaceId: string }) => {
      validateSender(event)
      return blueprintService.createFromIdea(args.ideaId, args.workspaceId)
    }
  )

  // ── blueprint:get — Get a blueprint with phases ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_GET, (event, args: { id: string }) => {
    validateSender(event)
    return blueprintService.getBlueprint(args.id)
  })

  // ── blueprint:getDetails — Get a blueprint with phases + tasks ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_GET_DETAILS, (event, args: { id: string }) => {
    validateSender(event)
    return blueprintService.getBlueprintWithDetails(args.id)
  })

  // ── blueprint:list — List blueprints for a workspace ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_LIST,
    (event, args: { workspaceId: string; limit?: number }) => {
      validateSender(event)
      return blueprintService.listBlueprints(args.workspaceId, args.limit)
    }
  )

  // ── blueprint:delete — Delete a blueprint ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_DELETE, (event, args: { id: string }) => {
    validateSender(event)
    blueprintService.delete(args.id)
    return { deleted: true }
  })

  // ── blueprint:cancel — Cancel an active blueprint pipeline ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_CANCEL, async (event, args: { workspaceId: string }) => {
    validateSender(event)

    // BP-CANCEL-LOCK-01: Wrap in try/finally to guarantee blueprintService.cancel()
    // always runs — even if a phase cancel throws. Without this, a single phase
    // cancel failure orphans the startLock and permanently blocks new blueprints.
    try {
      const activeBlueprintId = blueprintService.getActiveBlueprintId(args.workspaceId)
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
      blueprintService.cancel(args.workspaceId)
    }
    return { cancelled: true }
  })

  // ── blueprint:advancePhase — Advance to next phase ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_ADVANCE_PHASE, (event, args: { blueprintId: string }) => {
    validateSender(event)
    return blueprintService.advancePhase(args.blueprintId)
  })

  // ── blueprint:skipPhase — Skip a phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_SKIP_PHASE,
    (event, args: { blueprintId: string; phase: BlueprintPhaseType }) => {
      validateSender(event)
      blueprintService.skipPhase(args.blueprintId, args.phase)
      return { skipped: true }
    }
  )

  // ── blueprint:rewindPhase — Rewind to a previous phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_REWIND_PHASE,
    (event, args: { blueprintId: string; phase: BlueprintPhaseType }) => {
      validateSender(event)
      blueprintService.rewindToPhase(args.blueprintId, args.phase)
      return { rewound: true }
    }
  )

  // ── blueprint:buildPrompt — Build system prompt for a phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_BUILD_PROMPT,
    (event, args: { blueprintId: string; phase: BlueprintPhaseType }) => {
      validateSender(event)
      return { prompt: blueprintService.buildSystemPrompt(args.blueprintId, args.phase) }
    }
  )

  // ── blueprint:saveArtifact — Save a phase artifact ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_SAVE_ARTIFACT,
    (
      event,
      args: { blueprintId: string; phase: BlueprintPhaseType; artifact: BlueprintArtifact }
    ) => {
      validateSender(event)
      blueprintService.savePhaseArtifact(args.blueprintId, args.phase, args.artifact)
      return { saved: true }
    }
  )

  // ── blueprint:getArtifacts — Get all artifacts for a blueprint ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_GET_ARTIFACTS, (event, args: { blueprintId: string }) => {
    validateSender(event)
    return blueprintService.getAllArtifacts(args.blueprintId)
  })

  // ── blueprint:populateTasks — Parse and store tasks from blueprint-tasks JSON ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_POPULATE_TASKS,
    (
      event,
      args: {
        blueprintId: string
        tasks: Array<{
          taskId: string
          wave: number
          description: string
          userStory?: string
          files?: string[]
          isParallel?: boolean
          dependsOn?: string[]
        }>
      }
    ) => {
      validateSender(event)

      // TASK-02: Validate input bounds before passing to service
      if (!args.blueprintId || typeof args.blueprintId !== 'string') {
        throw new Error('BLUEPRINT_POPULATE_TASKS: blueprintId is required')
      }
      if (!Array.isArray(args.tasks)) {
        throw new Error('BLUEPRINT_POPULATE_TASKS: tasks must be an array')
      }
      if (args.tasks.length > 500) {
        throw new Error(
          `BLUEPRINT_POPULATE_TASKS: tasks array too large (${args.tasks.length}, max 500)`
        )
      }

      return blueprintService.populateTasks(args.blueprintId, args.tasks)
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
    (event, args: { blueprintId: string; approved: boolean; feedback?: string }) => {
      validateSender(event)

      if (args.approved) {
        // Advance to BUILD phase — DB state is set by blueprintBuildService.startBuildPhase()
        bpLog.info(
          `[blueprint:approvalRespond] Blueprint ${args.blueprintId} — approved, triggering BUILD`
        )

        // Look up workspace for the repo path
        const blueprint = blueprintService.getBlueprint(args.blueprintId)
        if (blueprint) {
          const workspace = workspaceRepository.findById(blueprint.workspaceId)
          if (workspace) {
            // Wire event forwarding (may already be wired — prepareCleanups is idempotent)
            wireBlueprintEvents(blueprint.workspaceId)

            // Start the BUILD phase (non-blocking)
            blueprintBuildService
              .startBuildPhase({
                blueprintId: args.blueprintId,
                workspaceId: blueprint.workspaceId,
                workspacePath: workspace.repoPath
              })
              .catch((err) => {
                bpLog.error('[blueprint:approvalRespond] BUILD phase failed:', err)
              })
          } else {
            bpLog.error(
              `[blueprint:approvalRespond] Workspace not found for blueprint ${args.blueprintId}`
            )
          }
        } else {
          bpLog.error(`[blueprint:approvalRespond] Blueprint not found: ${args.blueprintId}`)
        }
      } else {
        // Not approved — rewind to plan phase for iteration
        blueprintService.rewindToPhase(args.blueprintId, 'plan')
        bpLog.info(
          `[blueprint:approvalRespond] Blueprint ${args.blueprintId} — rejected, rewound to plan`
        )
      }

      return { responded: true }
    }
  )

  // ── blueprint:getConstitution — Get workspace constitution ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_GET_CONSTITUTION,
    (event, args: { workspaceId: string }) => {
      validateSender(event)
      const workspace = workspaceRepository.findById(args.workspaceId)
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
    (event, args: { workspaceId: string; constitutionMd: string; version?: string }) => {
      validateSender(event)
      workspaceRepository.updateConstitution(
        args.workspaceId,
        args.constitutionMd,
        args.version ?? '1.0.0'
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
    (event, args: { blueprintId: string; workspaceId: string }) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }

      const blueprint = blueprintService.getBlueprint(args.blueprintId)
      if (!blueprint) {
        throw new Error(`Blueprint not found: ${args.blueprintId}`)
      }

      // Extract grill decisions from settings if available
      const grillDecisions = blueprint.settingsJson?.grillDecisions as
        | Array<{ header: string; selectedOption: string; reason: string }>
        | undefined

      // Wire event forwarding for this workspace
      wireBlueprintEvents(args.workspaceId)

      // Start the SPECIFY phase (non-blocking)
      blueprintSpecService
        .startSpecifyPhase({
          blueprintId: args.blueprintId,
          workspaceId: args.workspaceId,
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
    (event, args: { blueprintId: string; workspaceId: string }) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(args.workspaceId)

      // Start the CLARIFY phase (non-blocking)
      blueprintSpecService
        .startClarifyPhase({
          blueprintId: args.blueprintId,
          workspaceId: args.workspaceId,
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
    async (event, args: { blueprintId: string; workspaceId: string; message: string }) => {
      validateSender(event)

      await blueprintSpecService.sendClarifyAnswer({
        blueprintId: args.blueprintId,
        workspaceId: args.workspaceId,
        message: args.message
      })

      return { sent: true }
    }
  )

  // ── blueprint:skipClarify — Skip the CLARIFY phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_SKIP_CLARIFY,
    async (event, args: { blueprintId: string }) => {
      validateSender(event)
      await blueprintSpecService.skipClarifyPhase(args.blueprintId)
      return { skipped: true }
    }
  )

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 3: Plan Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════════

  // ── blueprint:startPlan — Start the PLAN phase ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_START_PLAN,
    (event, args: { blueprintId: string; workspaceId: string }) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(args.workspaceId)

      // Start the PLAN phase (non-blocking)
      blueprintPlanService
        .startPlanPhase({
          blueprintId: args.blueprintId,
          workspaceId: args.workspaceId,
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
    (event, args: { blueprintId: string; workspaceId: string }) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(args.workspaceId)

      // Start the TASKS phase (non-blocking)
      blueprintTasksService
        .startTasksPhase({
          blueprintId: args.blueprintId,
          workspaceId: args.workspaceId,
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
    (event, args: { blueprintId: string; workspaceId: string }) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(args.workspaceId)

      // Start the REVIEW phase (non-blocking)
      blueprintReviewService
        .startReviewPhase({
          blueprintId: args.blueprintId,
          workspaceId: args.workspaceId,
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
    (event, args: { blueprintId: string; workspaceId: string }) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(args.workspaceId)

      // Start the BUILD phase (non-blocking)
      blueprintBuildService
        .startBuildPhase({
          blueprintId: args.blueprintId,
          workspaceId: args.workspaceId,
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
    (event, args: { blueprintId: string; workspaceId: string }) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }

      // Wire event forwarding for this workspace
      wireBlueprintEvents(args.workspaceId)

      // Start the VERIFY phase (non-blocking)
      blueprintVerifyService
        .startVerifyPhase({
          blueprintId: args.blueprintId,
          workspaceId: args.workspaceId,
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
