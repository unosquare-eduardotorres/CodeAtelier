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
import { extractGrillDecisions, extractReferenceDocuments } from './blueprint-ipc-handlers'
import { memoryEngineService } from '../services/memory-engine.service'
// M6: Wire-once pattern — listeners registered once in registerBlueprintIpc, no TTL cleanup needed
import { blueprintService } from '../services/blueprint.service'
import { blueprintSpecService } from '../services/blueprint-spec.service'
import { blueprintPlanService } from '../services/blueprint-plan.service'
import { blueprintTasksService } from '../services/blueprint-tasks.service'
import { blueprintReviewService } from '../services/blueprint-review.service'
import { blueprintBuildService } from '../services/blueprint-build.service'
import { blueprintVerifyService } from '../services/blueprint-verify.service'
import { workspaceRepository } from '../db/repositories'
import { blueprintEventRepository } from '../db/repositories/blueprint-event.repository'
import { getSessionEventRouter } from '../services/session-event-router'
import type { AgentStatus } from '../../shared/types'
import type {
  BlueprintPhaseType,
  BlueprintArtifact,
  BlueprintPriority
} from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-ipc')

// M6: No per-workspace cleanup needed — listeners are registered once and route by payload.workspaceId

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
      const blueprint = blueprintService.create({ workspaceId, title, description, priority, settingsJson })

      // MEM-DOC-SPECIFY-01: Doc extraction moved to startSpecifyPhase() —
      // covers create, createFromIdea, resume, and retry paths in one place.

      return blueprint
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
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_BUILD_PROMPT
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const phase = requireString(args, 'phase', ch) as BlueprintPhaseType
      return { prompt: await blueprintService.buildSystemPrompt(blueprintId, phase) }
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
      const status = blueprintService.getPipelineStatus(args.workspaceId)

      // B2-FIX: Enrich with clarify UI state for renderer reload hydration
      if (status.running && status.blueprintId && status.currentPhase === 'clarify') {
        const clarifyState = blueprintSpecService.getClarifyUiState(status.blueprintId)
        return { ...status, clarifyState }
      }

      // BP-RESUME-02: When pipeline is idle, check for crash-orphaned blueprints
      // so the renderer can show a resume banner on startup.
      if (!status.running) {
        const orphan = blueprintService.findOrphanedBlueprint(args.workspaceId)
        if (orphan) {
          return { ...status, orphanedBlueprint: orphan }
        }
      }

      return status
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
        // Drive state machine: awaiting-approval → idle
        const blueprint = blueprintService.getBlueprint(blueprintId)
        if (blueprint) {
          // M2: Clear approval state before machine transition (snapshot publishes on transition)
          blueprintService.setPendingApproval(blueprint.workspaceId, null)
          const machine = blueprintService.getMachine(blueprint.workspaceId)
          machine.transition('approvalResponded')
        }

        // Advance to BUILD phase — DB state is set by blueprintBuildService.startBuildPhase()
        bpLog.info(
          `[blueprint:approvalRespond] Blueprint ${blueprintId} — approved, triggering BUILD`
        )

        // Look up workspace for the repo path
        // (blueprint already fetched above for machine transition)
        if (blueprint) {
          const workspace = workspaceRepository.findById(blueprint.workspaceId)
          if (workspace) {
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
        // Drive state machine: awaiting-approval → idle (so rewind can start fresh)
        const rejBlueprint = blueprintService.getBlueprint(blueprintId)
        if (rejBlueprint) {
          // M2: Clear approval state
          blueprintService.setPendingApproval(rejBlueprint.workspaceId, null)
          const machine = blueprintService.getMachine(rejBlueprint.workspaceId)
          machine.transition('approvalResponded')
        }
        blueprintService.rewindToPhase(blueprintId, 'plan')
        bpLog.info(
          `[blueprint:approvalRespond] Blueprint ${blueprintId} — rejected, rewound to plan`
        )
      }

      // MEM-BP-APPROVAL-01: Write approval/rejection as a direct decision fact.
      // Human approval is the highest-value memory — captured verbatim, no LLM needed.
      const bpForFact = blueprintService.getBlueprint(blueprintId)
      if (bpForFact) {
        const bpSettings = workspaceRepository.getSettings(bpForFact.workspaceId)
        const bpCaptureEnabled = (bpSettings as any).memoryCaptureBlueprints !== false
        if (bpCaptureEnabled) {
          const decision = approved ? 'approved' : 'rejected'
          // Assemble a plan summary from the plan phase artifact
          const planPhase = bpForFact.phases?.find((p: any) => p.phase === 'plan')
          const planArtifact = planPhase?.artifactsJson?.find((a: any) => a.type === 'plan')
          const planSummary = planArtifact?.contentMd
            ? planArtifact.contentMd.substring(0, 2000)
            : bpForFact.description ?? ''

          memoryEngineService.writeFact({
            workspaceId: bpForFact.workspaceId,
            category: 'decision',
            title: `Blueprint ${decision}: ${bpForFact.title}`,
            content: `Plan was ${decision} by the user.\n\n### Plan Summary\n${planSummary}`,
            tags: ['blueprint', `blueprint:${blueprintId}`, decision],
            sourceType: 'blueprint',
            sourceRef: blueprintId,
            workspacePath: workspaceRepository.findById(bpForFact.workspaceId)?.repoPath
          }).catch((err) => {
            bpLog.warn(`[blueprint:approvalRespond] Failed to write approval fact: ${err}`)
          })
        }
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

      // Extract grill decisions and reference documents from settings (validated)
      const grillDecisions = extractGrillDecisions(blueprint.settingsJson as Record<string, unknown> | null)
      const referenceDocuments = extractReferenceDocuments(blueprint.settingsJson as Record<string, unknown> | null)

      // Start the SPECIFY phase (non-blocking)
      blueprintSpecService
        .startSpecifyPhase({
          blueprintId,
          workspaceId,
          workspacePath: workspace.repoPath,
          description: blueprint.description,
          grillDecisions,
          referenceDocuments
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

      // M8: Journal user answer before sending (append is best-effort)
      try {
        blueprintEventRepository.append(blueprintId, 'user', { message })
      } catch { /* best effort */ }

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

  // ── blueprint:clarifyProceed — User proceeds through the clarify gate ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_CLARIFY_PROCEED,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_CLARIFY_PROCEED
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      requireString(args, 'workspaceId', ch)

      await blueprintSpecService.proceedClarifyGate(blueprintId)
      return { proceeded: true }
    }
  )

  // ── blueprint:clarifyIterate — User requests more clarification rounds ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_CLARIFY_ITERATE,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_CLARIFY_ITERATE
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      requireString(args, 'workspaceId', ch)

      await blueprintSpecService.iterateClarify(blueprintId)
      return { iterated: true }
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

  // ── blueprint:retryPhase — Retry the failed phase of a blueprint ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_RETRY_PHASE,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_RETRY_PHASE
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const workspaceId = requireString(args, 'workspaceId', ch)

      // retryPhase resets the failed phase → pending and returns the phase type
      const { phase } = blueprintService.retryPhase(blueprintId)

      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`)
      }

      const blueprint = blueprintService.getBlueprint(blueprintId)
      if (!blueprint) throw new Error(`Blueprint not found: ${blueprintId}`)

      // Extract grill decisions and reference documents from settings (for specify retry)
      const grillDecisions = extractGrillDecisions(blueprint.settingsJson as Record<string, unknown> | null)
      const referenceDocuments = extractReferenceDocuments(blueprint.settingsJson as Record<string, unknown> | null)

      // Dispatch to the matching sub-service (non-blocking)
      const phaseDispatch: Record<string, () => Promise<void>> = {
        specify: () =>
          blueprintSpecService.startSpecifyPhase({
            blueprintId,
            workspaceId,
            workspacePath: workspace.repoPath,
            description: blueprint.description,
            grillDecisions,
            referenceDocuments
          }),
        clarify: () =>
          blueprintSpecService.startClarifyPhase({
            blueprintId,
            workspaceId,
            workspacePath: workspace.repoPath
          }),
        plan: () =>
          blueprintPlanService.startPlanPhase({
            blueprintId,
            workspaceId,
            workspacePath: workspace.repoPath
          }),
        tasks: () =>
          blueprintTasksService.startTasksPhase({
            blueprintId,
            workspaceId,
            workspacePath: workspace.repoPath
          }),
        review: () =>
          blueprintReviewService.startReviewPhase({
            blueprintId,
            workspaceId,
            workspacePath: workspace.repoPath
          }),
        build: () =>
          blueprintBuildService.startBuildPhase({
            blueprintId,
            workspaceId,
            workspacePath: workspace.repoPath
          }),
        verify: () =>
          blueprintVerifyService.startVerifyPhase({
            blueprintId,
            workspaceId,
            workspacePath: workspace.repoPath
          })
      }

      const dispatch = phaseDispatch[phase]
      if (dispatch) {
        dispatch().catch((err) => {
          bpLog.error(`[blueprint:retryPhase] ${phase} phase retry failed:`, err)
        })
      } else {
        bpLog.error(`[blueprint:retryPhase] Unknown phase: ${phase}`)
      }

      return { retrying: true, phase }
    }
  )

  // ── M3: blueprint:getTranscript — Retrieve journal entries for a blueprint ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_GET_TRANSCRIPT,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_GET_TRANSCRIPT
      const args = requireObject(rawArgs, ch)
      const blueprintId = requireString(args, 'blueprintId', ch)
      const afterSeq = optionalNumber(args, 'afterSeq', ch)

      if (afterSeq !== undefined && afterSeq !== null) {
        return blueprintEventRepository.findByBlueprintAfterSeq(blueprintId, afterSeq)
      }
      return blueprintEventRepository.findByBlueprint(blueprintId)
    }
  )

  // ── M7: blueprint:getSnapshot — Pull-based snapshot seed ──

  ipcMain.handle(
    IPC_CHANNELS.BLUEPRINT_GET_SNAPSHOT,
    (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.BLUEPRINT_GET_SNAPSHOT
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      return blueprintService.getSnapshot(workspaceId)
    }
  )

  // ── Stale blueprint detection on registration ──
  blueprintService.reconcileStaleBlueprints()

  // M6: Wire-once event forwarding — registered once, routes by payload.workspaceId.
  // Eliminates 13 wireBlueprintEvents call sites + 180-min TTL cleanup.
  wireOnceEventForwarding()
}

// ── M6: Wire-Once Event Forwarding ──
// Registered once during IPC registration. Routes by payload.workspaceId.
// No TTL, no per-workspace cleanup, no re-wire dance.

function wireOnceEventForwarding(): void {

  // Helper: safe event forwarding with error isolation
  function forward(emitter: EventEmitterLike, event: string, channel: string, logPrefix?: string): void {
    emitter.on(event, (...args: unknown[]) => {
      try {
        const payload = args[0] as Record<string, unknown>
        const wsId = payload?.workspaceId as string | undefined
        if (!wsId) return
        if (logPrefix) bpLog.info(`[${logPrefix}] ${event}: ${payload.phase ?? ''}`)
        getSessionEventRouter().sendWorkspaceEvent(channel, wsId, payload)
      } catch (err) {
        bpLog.error(`[event-forward] '${event}' handler threw:`, err)
      }
    })
  }

  // Helper: forward status events (different shape: { workspaceId?, status })
  function forwardStatus(emitter: EventEmitterLike): void {
    emitter.on('status', (...args: unknown[]) => {
      try {
        const data = args[0] as { workspaceId?: string; status: AgentStatus }
        if (!data?.workspaceId) return
        getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, data.workspaceId, { ...data.status })
      } catch (err) {
        bpLog.error(`[event-forward] 'status' handler threw:`, err)
      }
    })
  }

  type EventEmitterLike = { on: (event: string, handler: (...args: unknown[]) => void) => void }

  // ── BlueprintService (orchestrator) ──

  // M2: Forward whole-state snapshot on every state mutation
  blueprintService.on('stateSync', (...args: unknown[]) => {
    try {
      const snapshot = args[0] as Record<string, unknown>
      const wsId = snapshot?.workspaceId as string | undefined
      if (!wsId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.BLUEPRINT_STATE_SYNC, wsId, snapshot)
    } catch (err) {
      bpLog.error('[event-forward] stateSync handler threw:', err)
    }
  })

  forward(blueprintService, 'phaseStart', IPC_CHANNELS.BLUEPRINT_PHASE_START, 'event')
  forward(blueprintService, 'phaseProgress', IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS)

  forward(blueprintService, 'phaseComplete', IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE, 'event')
  forward(blueprintService, 'phaseArtifact', IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT, 'event')

  // ── BlueprintBuildService events (Phase 6: Build) ──
  forward(blueprintBuildService as unknown as EventEmitterLike, 'phaseStart', IPC_CHANNELS.BLUEPRINT_PHASE_START, 'build-event')
  forward(blueprintBuildService as unknown as EventEmitterLike, 'phaseProgress', IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS)
  forward(blueprintBuildService as unknown as EventEmitterLike, 'phaseComplete', IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE, 'build-event')
  forward(blueprintBuildService as unknown as EventEmitterLike, 'phaseArtifact', IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT, 'build-event')
  forwardStatus(blueprintBuildService as unknown as EventEmitterLike)

  // Wave execution events
  forward(blueprintBuildService as unknown as EventEmitterLike, 'waveStart', IPC_CHANNELS.BLUEPRINT_WAVE_START, 'build-event')
  forward(blueprintBuildService as unknown as EventEmitterLike, 'waveTaskStart', IPC_CHANNELS.BLUEPRINT_WAVE_TASK_START)
  forward(blueprintBuildService as unknown as EventEmitterLike, 'waveTaskComplete', IPC_CHANNELS.BLUEPRINT_WAVE_TASK_COMPLETE, 'build-event')
  forward(blueprintBuildService as unknown as EventEmitterLike, 'waveComplete', IPC_CHANNELS.BLUEPRINT_WAVE_COMPLETE, 'build-event')

  // ── BlueprintSpecService events (Phase 2: Specify + Clarify) ──
  forward(blueprintSpecService as unknown as EventEmitterLike, 'phaseStart', IPC_CHANNELS.BLUEPRINT_PHASE_START, 'spec-event')
  forward(blueprintSpecService as unknown as EventEmitterLike, 'phaseProgress', IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS)
  forward(blueprintSpecService as unknown as EventEmitterLike, 'phaseComplete', IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE, 'spec-event')
  forward(blueprintSpecService as unknown as EventEmitterLike, 'phaseArtifact', IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT, 'spec-event')
  forward(blueprintSpecService as unknown as EventEmitterLike, 'clarifyAwaitingInput', IPC_CHANNELS.BLUEPRINT_CLARIFY_AWAITING_INPUT, 'spec-event')
  forward(blueprintSpecService as unknown as EventEmitterLike, 'clarifyFindings', IPC_CHANNELS.BLUEPRINT_CLARIFY_FINDINGS, 'spec-event')
  forward(blueprintSpecService as unknown as EventEmitterLike, 'clarifyQuestions', IPC_CHANNELS.BLUEPRINT_CLARIFY_QUESTIONS, 'spec-event')
  forward(blueprintSpecService as unknown as EventEmitterLike, 'clarifyGateReady', IPC_CHANNELS.BLUEPRINT_CLARIFY_GATE, 'spec-event')
  forwardStatus(blueprintSpecService as unknown as EventEmitterLike)

  // ── BlueprintPlanService events (Phase 3: Plan) ──
  forward(blueprintPlanService as unknown as EventEmitterLike, 'phaseStart', IPC_CHANNELS.BLUEPRINT_PHASE_START, 'plan-event')
  forward(blueprintPlanService as unknown as EventEmitterLike, 'phaseProgress', IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS)
  forward(blueprintPlanService as unknown as EventEmitterLike, 'phaseComplete', IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE, 'plan-event')
  forward(blueprintPlanService as unknown as EventEmitterLike, 'phaseArtifact', IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT, 'plan-event')
  forwardStatus(blueprintPlanService as unknown as EventEmitterLike)

  // ── BlueprintTasksService events (Phase 4: Tasks) ──
  forward(blueprintTasksService as unknown as EventEmitterLike, 'phaseStart', IPC_CHANNELS.BLUEPRINT_PHASE_START, 'tasks-event')
  forward(blueprintTasksService as unknown as EventEmitterLike, 'phaseProgress', IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS)
  forward(blueprintTasksService as unknown as EventEmitterLike, 'phaseComplete', IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE, 'tasks-event')
  forward(blueprintTasksService as unknown as EventEmitterLike, 'phaseArtifact', IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT, 'tasks-event')
  forwardStatus(blueprintTasksService as unknown as EventEmitterLike)

  // ── BlueprintReviewService events (Phase 5: Review) ──
  forward(blueprintReviewService as unknown as EventEmitterLike, 'phaseStart', IPC_CHANNELS.BLUEPRINT_PHASE_START, 'review-event')
  forward(blueprintReviewService as unknown as EventEmitterLike, 'phaseProgress', IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS)
  forward(blueprintReviewService as unknown as EventEmitterLike, 'phaseComplete', IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE, 'review-event')
  forward(blueprintReviewService as unknown as EventEmitterLike, 'phaseArtifact', IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT, 'review-event')
  forwardStatus(blueprintReviewService as unknown as EventEmitterLike)
  forward(blueprintReviewService as unknown as EventEmitterLike, 'approvalNeeded', IPC_CHANNELS.BLUEPRINT_APPROVAL_NEEDED, 'review-event')

  // ── BlueprintVerifyService events (Phase 7: Verify) ──
  forward(blueprintVerifyService as unknown as EventEmitterLike, 'phaseStart', IPC_CHANNELS.BLUEPRINT_PHASE_START, 'verify-event')
  forward(blueprintVerifyService as unknown as EventEmitterLike, 'phaseProgress', IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS)
  forward(blueprintVerifyService as unknown as EventEmitterLike, 'phaseComplete', IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE, 'verify-event')
  forward(blueprintVerifyService as unknown as EventEmitterLike, 'phaseArtifact', IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT, 'verify-event')
  forwardStatus(blueprintVerifyService as unknown as EventEmitterLike)

  // ───────────────────────────────────────────────────────────────────────
  // M8: Journal writers — append events to blueprint_events table.
  // Best-effort: failures are logged but don't block the pipeline.
  // ───────────────────────────────────────────────────────────────────────

  function journalAppend(blueprintId: string, type: string, payload: Record<string, unknown>): void {
    try {
      blueprintEventRepository.append(
        blueprintId,
        type as 'system' | 'agent' | 'user' | 'findings' | 'qa' | 'plan' | 'tasks',
        payload
      )
    } catch (err) {
      bpLog.warn(`[journal] Failed to append ${type} event for ${blueprintId}:`, err)
    }
  }

  // Journal: phaseStart / phaseComplete → 'system' entries
  // Listen on all phase service emitters that emit phaseStart/phaseComplete
  const allPhaseEmitters = [
    blueprintService, blueprintSpecService, blueprintPlanService,
    blueprintTasksService, blueprintReviewService, blueprintBuildService,
    blueprintVerifyService
  ] as unknown as EventEmitterLike[]

  for (const emitter of allPhaseEmitters) {
    emitter.on('phaseStart', (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown>
      const bpId = payload?.blueprintId as string | undefined
      if (bpId) journalAppend(bpId, 'system', { event: 'phaseStart', phase: payload.phase })
    })
    emitter.on('phaseComplete', (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown>
      const bpId = payload?.blueprintId as string | undefined
      if (bpId) journalAppend(bpId, 'system', { event: 'phaseComplete', phase: payload.phase, status: payload.status, error: payload.error })
    })
  }

  // Journal: phaseArtifact → type-specific entries (plan, tasks, agent)
  for (const emitter of allPhaseEmitters) {
    emitter.on('phaseArtifact', (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown>
      const bpId = payload?.blueprintId as string | undefined
      const artifact = payload?.artifact as { type?: string; contentMd?: string } | undefined
      if (!bpId || !artifact) return
      const journalType = artifact.type === 'plan' ? 'plan'
        : artifact.type === 'tasks' ? 'tasks'
        : 'agent'
      journalAppend(bpId, journalType, { phase: payload.phase, artifactType: artifact.type, contentMd: artifact.contentMd })
    })
  }

  // Journal: clarify findings → 'findings' entries
  ;(blueprintSpecService as unknown as EventEmitterLike).on('clarifyFindings', (...args: unknown[]) => {
    const payload = args[0] as Record<string, unknown>
    const bpId = payload?.blueprintId as string | undefined
    if (bpId) journalAppend(bpId, 'findings', { findings: payload.findings })
  })

  // Journal: clarify questions → 'qa' entries
  ;(blueprintSpecService as unknown as EventEmitterLike).on('clarifyQuestions', (...args: unknown[]) => {
    const payload = args[0] as Record<string, unknown>
    const bpId = payload?.blueprintId as string | undefined
    if (bpId) journalAppend(bpId, 'qa', { questions: payload.questions })
  })

  // Journal: clarify gate → 'qa' entry
  ;(blueprintSpecService as unknown as EventEmitterLike).on('clarifyGateReady', (...args: unknown[]) => {
    const payload = args[0] as Record<string, unknown>
    const bpId = payload?.blueprintId as string | undefined
    if (bpId) journalAppend(bpId, 'qa', { event: 'gateReady', findings: payload.findings })
  })

  // Journal: wave markers → 'system' entries
  ;(blueprintBuildService as unknown as EventEmitterLike).on('waveStart', (...args: unknown[]) => {
    const payload = args[0] as Record<string, unknown>
    const bpId = payload?.blueprintId as string | undefined
    if (bpId) journalAppend(bpId, 'system', { event: 'waveStart', wave: payload.wave, taskCount: payload.taskCount })
  })
  ;(blueprintBuildService as unknown as EventEmitterLike).on('waveComplete', (...args: unknown[]) => {
    const payload = args[0] as Record<string, unknown>
    const bpId = payload?.blueprintId as string | undefined
    if (bpId) journalAppend(bpId, 'system', { event: 'waveComplete', wave: payload.wave, status: payload.status })
  })

  // ── Auto-retry dispatch for transient phase failures ──
  // blueprintService.scheduleAutoRetry() emits 'autoRetry' after a 5s delay.
  // The IPC layer dispatches the phase start — same logic as the manual retry handler.
  blueprintService.on('autoRetry', (payload: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
    phase: BlueprintPhaseType
  }) => {
    const { blueprintId, workspaceId, workspacePath, phase } = payload
    bpLog.info(`[auto-retry] Dispatching ${phase} for blueprint ${blueprintId}`)

    const phaseDispatch: Record<string, () => Promise<void>> = {
      specify: () => {
        const bp = blueprintService.getBlueprint(blueprintId)
        const grillDecisions = extractGrillDecisions(bp?.settingsJson as Record<string, unknown> | null)
        const referenceDocuments = extractReferenceDocuments(bp?.settingsJson as Record<string, unknown> | null)
        return blueprintSpecService.startSpecifyPhase({
          blueprintId, workspaceId, workspacePath,
          description: bp?.description ?? '',
          grillDecisions,
          referenceDocuments
        })
      },
      clarify: () => blueprintSpecService.startClarifyPhase({ blueprintId, workspaceId, workspacePath }),
      plan: () => blueprintPlanService.startPlanPhase({ blueprintId, workspaceId, workspacePath }),
      tasks: () => blueprintTasksService.startTasksPhase({ blueprintId, workspaceId, workspacePath }),
      review: () => blueprintReviewService.startReviewPhase({ blueprintId, workspaceId, workspacePath }),
      build: () => blueprintBuildService.startBuildPhase({ blueprintId, workspaceId, workspacePath }),
      verify: () => blueprintVerifyService.startVerifyPhase({ blueprintId, workspaceId, workspacePath })
    }

    const dispatch = phaseDispatch[phase]
    if (dispatch) {
      dispatch().catch((err) => {
        bpLog.error(`[auto-retry] ${phase} phase auto-retry failed:`, err)
      })
    } else {
      bpLog.error(`[auto-retry] Unknown phase: ${phase}`)
    }
  })

  // ── Remediation dispatch (gaps_found → rebuild → re-verify) ──
  // BP-REMEDIATION-01: blueprintVerifyService emits 'remediationNeeded' after a 5s
  // delay when verification finds gaps and remediation tasks are appended.
  // Same dispatch pattern as autoRetry — build phase re-runs, BP-RESUME-01 skips
  // all complete tasks, only new remediation waves execute.
  ;(blueprintVerifyService as unknown as EventEmitterLike).on('remediationNeeded', (...args: unknown[]) => {
    const payload = args[0] as { blueprintId: string; workspaceId: string; workspacePath: string }
    const { blueprintId, workspaceId, workspacePath } = payload
    bpLog.info(`[remediation] Dispatching build for remediation tasks — blueprint ${blueprintId}`)
    blueprintBuildService.startBuildPhase({ blueprintId, workspaceId, workspacePath })
      .catch((err) => {
        bpLog.error(`[remediation] Build phase for remediation failed:`, err)
      })
  })
}
