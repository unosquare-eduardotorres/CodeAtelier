/**
 * Blueprint IPC handlers.
 *
 * Follows the mpa.ipc.ts pattern:
 * - ipcMain.handle for request/response (CRUD, phase management, artifacts)
 * - webContents.send for event forwarding (phaseStart, phaseProgress, etc.)
 */

import { app, ipcMain, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, copyFileSync, statSync, rmSync } from 'node:fs'
import { join, isAbsolute, basename, normalize, sep } from 'node:path'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString, optionalNumber } from './validate-args'
import { extractGrillDecisions, extractReferenceDocuments } from './blueprint-ipc-handlers'
import { parseBlueprintPlan, parseBlueprintTasks } from '../../shared/blueprint-artifact-parsers'
import { memoryEngineService } from '../services/memory-engine.service'
import { setManagedDocsRoot } from '../services/blueprint-document-loader'
// M6: Wire-once pattern — listeners registered once in registerBlueprintIpc, no TTL cleanup needed
import { blueprintService } from '../services/blueprint.service'
import { blueprintSpecService } from '../services/blueprint-spec.service'
import { blueprintPlanService } from '../services/blueprint-plan.service'
import { blueprintTasksService } from '../services/blueprint-tasks.service'
import { blueprintReviewService } from '../services/blueprint-review.service'
import { blueprintBuildService } from '../services/blueprint-build.service'
import { blueprintVerifyService } from '../services/blueprint-verify.service'
import { workspaceRepository, conversationRepository } from '../db/repositories'
import { trackRepository } from '../db/repositories/track.repository'
import { repoService } from '../services/repo.service'
import { repoHasCommits } from '../services/blueprint-track'
import { buildBranchOptions, NO_COMMITS_BRANCH_OPTIONS } from '../services/branch-options'
import {
  blueprintRepository,
  blueprintPhaseRepository,
  blueprintTaskRepository
} from '../db/repositories/blueprint.repository'
import { blueprintEventRepository } from '../db/repositories/blueprint-event.repository'
import { getSessionEventRouter } from '../services/session-event-router'
import { notificationService } from '../services/notification.service'
import { resolveWorkspaceName } from './resolve-workspace-name'
import type { AgentStatus } from '../../shared/types'
import { createAccumulator } from '../services/blueprint-agent-accumulator'
import type {
  BlueprintPhaseType,
  BlueprintArtifact,
  BlueprintPriority
} from '../../shared/blueprint-types'
import { runPreflightChecks } from '../services/blueprint-preflight.service'

const bpLog = log.scope('blueprint-ipc')

// M6: No per-workspace cleanup needed — listeners are registered once and route by payload.workspaceId

// ── Phase 5.1: Managed docs directory for copy-on-attach ──

/** Max file size for copy-on-attach (25MB) */
const COPY_ON_ATTACH_MAX_BYTES = 25 * 1024 * 1024

/** Root directory for managed blueprint reference docs */
function getManagedDocsRoot(): string {
  return join(app.getPath('userData'), 'blueprint-docs')
}

/** Get the managed docs directory for a specific blueprint */
export function getManagedDocsDir(workspaceId: string, blueprintId: string): string {
  return join(getManagedDocsRoot(), workspaceId, blueprintId)
}

/**
 * Phase 5.1: Copy file-type reference docs with absolute paths outside the workspace
 * into a managed directory under userData. Returns the (possibly rewritten) docs array.
 */
function copyOnAttach(
  workspaceId: string,
  blueprintId: string,
  docs: Array<{ type: string; path: string; name?: string }>,
  workspacePath?: string
): Array<{ type: string; path: string; name?: string }> {
  return docs.map((doc, i) => {
    if (doc.type !== 'file' || !isAbsolute(doc.path)) return doc

    // Check if the path is inside the workspace — if so, no copy needed
    // MINOR-FIX: Normalize paths + trailing-separator check to avoid
    // false positives (e.g. /ws2 matching /ws prefix)
    if (workspacePath) {
      const normDoc = normalize(doc.path)
      const normWs = normalize(workspacePath) + (normalize(workspacePath).endsWith(sep) ? '' : sep)
      if (normDoc.startsWith(normWs) || normDoc === normalize(workspacePath)) return doc
    }

    try {
      const stat = statSync(doc.path)
      if (stat.size > COPY_ON_ATTACH_MAX_BYTES) {
        bpLog.warn(
          `[copy-on-attach] File too large (${stat.size} bytes), keeping original: ${doc.path}`
        )
        return doc
      }

      const managedDir = getManagedDocsDir(workspaceId, blueprintId)
      mkdirSync(managedDir, { recursive: true })
      // BASENAME-COLLISION-FIX: Prefix with map index to prevent two docs
      // with the same basename (e.g. both named spec.pdf) from silently
      // overwriting each other in the managed directory.
      const destPath = join(managedDir, `${i}-${basename(doc.path)}`)
      copyFileSync(doc.path, destPath)
      bpLog.info(`[copy-on-attach] Copied "${doc.path}" → "${destPath}"`)
      return { ...doc, path: destPath }
    } catch (err) {
      bpLog.warn(`[copy-on-attach] Failed to copy "${doc.path}": ${err} — keeping original`)
      return doc
    }
  })
}

/**
 * Clean up managed docs when a blueprint is deleted.
 */
function cleanupManagedDocs(workspaceId: string, blueprintId: string): void {
  try {
    const dir = getManagedDocsDir(workspaceId, blueprintId)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      bpLog.info(`[managed-docs] Cleaned up ${dir}`)
    }
  } catch (err) {
    bpLog.warn(`[managed-docs] Cleanup failed: ${err}`)
  }
}

// ── Main Registration ──

// GAP-6: Module-level deferred reference to accumulator cleanup.
// Assigned in wireOnceEventForwarding (where accumulators live),
// called from the cancel handler in registerBlueprintIpc.
let accumulatorCleanup: ((blueprintId: string) => void) | null = null

export function registerBlueprintIpc(_mainWindow: BrowserWindow): void {
  // Phase 5.2: Register managed docs root for loader whitelist
  setManagedDocsRoot(getManagedDocsRoot())

  // ── blueprint:create — Create a new blueprint ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_CREATE, (event, rawArgs: unknown) => {
    validateSender(event)
    // BP-IPC-NO-VALIDATION-01: Runtime validation matching grill/chat pattern.
    const ch = IPC_CHANNELS.BLUEPRINT_CREATE
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const title = requireString(args, 'title', ch)
    const description = optionalString(args, 'description', ch)
    const priority = optionalString(args, 'priority', ch) as BlueprintPriority | undefined
    const settingsJson = args.settingsJson as Record<string, unknown> | undefined
    const blueprint = blueprintService.create({
      workspaceId,
      title,
      description,
      priority,
      settingsJson
    })

    // Phase 5.1: Copy-on-attach — copy external file docs into managed dir,
    // then update the stored settingsJson with rewritten paths.
    const refDocs = settingsJson?.referenceDocuments as
      Array<{ type: string; path: string; name?: string }> | undefined
    if (refDocs?.length && blueprint.id) {
      const ws = workspaceRepository.findById(workspaceId)
      const rewritten = copyOnAttach(workspaceId, blueprint.id, refDocs, ws?.repoPath)
      // Check if any paths were rewritten
      const anyRewritten = rewritten.some((d, i) => d.path !== refDocs[i].path)
      if (anyRewritten) {
        const updatedSettings = { ...(settingsJson ?? {}), referenceDocuments: rewritten }
        blueprintRepository.update(blueprint.id, { settingsJson: updatedSettings })
        bpLog.info(
          `[copy-on-attach] Updated settingsJson for ${blueprint.id} with managed doc paths`
        )
      }
    }

    // MEM-DOC-SPECIFY-01: Doc extraction moved to startSpecifyPhase() —
    // covers create, createFromIdea, resume, and retry paths in one place.

    return blueprint
  })

  // ── blueprint:createFromIdea — Graduate an Idea to a Blueprint ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_CREATE_FROM_IDEA, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_CREATE_FROM_IDEA
    const args = requireObject(rawArgs, ch)
    const ideaId = requireString(args, 'ideaId', ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    return blueprintService.createFromIdea(ideaId, workspaceId)
  })

  // ── blueprint:branchOptions — what the branch picker may offer ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_BRANCH_OPTIONS, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_BRANCH_OPTIONS
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)

    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    // An unborn HEAD has no branches and nothing to fork from, and git rejects
    // `worktree add` outright — there is no list to build.
    if (!(await repoHasCommits(workspace.repoPath))) return NO_COMMITS_BRANCH_OPTIONS

    const { local, current } = await repoService.listBranches(workspace.repoPath)

    return buildBranchOptions({
      repoHasCommits: true,
      local,
      current,
      tracks: trackRepository.findByWorkspace(workspaceId),
      chatTitle: (id) => conversationRepository.findById(id)?.title ?? null
    })
  })

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

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_LIST, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_LIST
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const limit = optionalNumber(args, 'limit', ch)
    return blueprintService.listBlueprints(workspaceId, limit)
  })

  // ── blueprint:delete — Delete a blueprint ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_DELETE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_DELETE)
    const id = requireString(args, 'id', IPC_CHANNELS.BLUEPRINT_DELETE)
    // Phase 5.1: Look up workspaceId before delete for managed-docs cleanup
    const bp = blueprintRepository.findById(id)
    blueprintService.delete(id)
    // Phase 5.1: Clean up managed docs directory
    if (bp?.workspaceId) cleanupManagedDocs(bp.workspaceId, id)
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
        // GAP-6 FIX: Flush + clean up agent accumulators before cancel
        // (cancel doesn't emit phaseComplete, so accumulators would leak).
        // Uses the deferred reference assigned later in the accumulator section.
        accumulatorCleanup?.(activeBlueprintId)

        // Best-effort cancel each phase service — don't let one failure block others
        const phaseServices = [
          blueprintSpecService,
          blueprintPlanService,
          blueprintTasksService,
          blueprintReviewService,
          blueprintBuildService,
          blueprintVerifyService
        ]
        for (const svc of phaseServices) {
          try {
            await svc.cancelBlueprint(activeBlueprintId)
          } catch (e) {
            bpLog.error(`[cancel] Phase cancel failed:`, e)
          }
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

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_SKIP_PHASE, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_SKIP_PHASE
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)
    const phase = requireString(args, 'phase', ch) as BlueprintPhaseType
    blueprintService.skipPhase(blueprintId, phase)
    return { skipped: true }
  })

  // ── blueprint:skipTask — User-skip a single build task (reversible) ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_SKIP_TASK, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_SKIP_TASK
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)
    const taskId = requireString(args, 'taskId', ch)
    // Default true so a bare { blueprintId, taskId } skips; pass false to clear.
    const skipped = args.skipped === undefined ? true : args.skipped === true
    const task = blueprintService.setTaskUserSkipped(blueprintId, taskId, skipped)
    return { skipped: task.skippedByUserAt != null, skippedAt: task.skippedByUserAt }
  })

  // ── blueprint:rewindPhase — Rewind to a previous phase ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_REWIND_PHASE, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_REWIND_PHASE
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)
    const phase = requireString(args, 'phase', ch) as BlueprintPhaseType
    blueprintService.rewindToPhase(blueprintId, phase)
    return { rewound: true }
  })

  // ── blueprint:buildPrompt — Build system prompt for a phase ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_BUILD_PROMPT, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_BUILD_PROMPT
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)
    const phase = requireString(args, 'phase', ch) as BlueprintPhaseType
    return { prompt: await blueprintService.buildSystemPrompt(blueprintId, phase) }
  })

  // ── blueprint:saveArtifact — Save a phase artifact ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_SAVE_ARTIFACT, (event, rawArgs: unknown) => {
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
  })

  // ── blueprint:getArtifacts — Get all artifacts for a blueprint ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_GET_ARTIFACTS, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_GET_ARTIFACTS)
    const blueprintId = requireString(args, 'blueprintId', IPC_CHANNELS.BLUEPRINT_GET_ARTIFACTS)
    return blueprintService.getAllArtifacts(blueprintId)
  })

  // ── blueprint:populateTasks — Parse and store tasks from blueprint-tasks JSON ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_POPULATE_TASKS, (event, rawArgs: unknown) => {
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

    return blueprintService.populateTasks(
      blueprintId,
      args.tasks as Array<{
        taskId: string
        wave: number
        description: string
        userStory?: string
        files?: string[]
        isParallel?: boolean
        dependsOn?: string[]
      }>
    )
  })

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

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_APPROVAL_RESPOND, (event, rawArgs: unknown) => {
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
        // G9: If preflight had blockers, persist preflightOverride in settingsJson
        // so remediation/retry paths inherit the override
        const pendingApproval = blueprintService.getPendingApproval(blueprint.workspaceId)
        if (pendingApproval?.preflight) {
          const pfResult = pendingApproval.preflight.result as Record<string, unknown>
          if (pfResult.hasBlockers) {
            blueprintRepository.update(blueprintId, {
              settingsJson: {
                ...blueprint.settingsJson,
                preflightOverride: true
              }
            })
            bpLog.info(
              `[blueprint:approvalRespond] Preflight override persisted for ${blueprintId}`
            )
          }
        }

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
      bpLog.info(`[blueprint:approvalRespond] Blueprint ${blueprintId} — rejected, rewound to plan`)
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
          : (bpForFact.description ?? '')

        memoryEngineService
          .writeFact({
            workspaceId: bpForFact.workspaceId,
            category: 'decision',
            title: `Blueprint ${decision}: ${bpForFact.title}`,
            content: `Plan was ${decision} by the user.\n\n### Plan Summary\n${planSummary}`,
            tags: ['blueprint', `blueprint:${blueprintId}`, decision],
            sourceType: 'blueprint',
            sourceRef: blueprintId,
            workspacePath: workspaceRepository.findById(bpForFact.workspaceId)?.repoPath
          })
          .catch((err) => {
            bpLog.warn(`[blueprint:approvalRespond] Failed to write approval fact: ${err}`)
          })
      }
    }

    return { responded: true }
  })

  // ── blueprint:preflightRun — Re-run preflight checks (G6: manual re-run) ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_PREFLIGHT_RUN, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_PREFLIGHT_RUN
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)
    const workspaceId = requireString(args, 'workspaceId', ch)

    // A5 fix: derive workspacePath server-side from workspaceId (don't trust renderer)
    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace?.repoPath) {
      bpLog.warn(`[blueprint:preflightRun] No workspace found for ${workspaceId}`)
      return null
    }
    const workspacePath = workspace.repoPath

    bpLog.info(`[blueprint:preflightRun] Re-running preflight for ${blueprintId}`)

    // Gather task descriptions for keyword detection (G10)
    const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)
    const taskDescriptions = tasks.map((t: { description: string }) => t.description)

    const result = await runPreflightChecks(workspacePath, taskDescriptions)

    // A6+R2-2 fix: atomic replace — fresh read inside repo avoids stale artifacts
    const reviewPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'review')
    if (reviewPhase) {
      blueprintPhaseRepository.replaceArtifactOfType(reviewPhase.id, 'preflight', {
        type: 'preflight',
        contentJson: result as unknown as Record<string, unknown>
      })
    }

    // Update pending approval with new preflight data
    const pendingApproval = blueprintService.getPendingApproval(workspaceId)
    if (pendingApproval) {
      blueprintService.setPendingApproval(workspaceId, {
        ...pendingApproval,
        preflight: { result: result as unknown as Record<string, unknown>, overridden: false }
      })
    }

    // Broadcast result to renderer
    try {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send(IPC_CHANNELS.BLUEPRINT_PREFLIGHT_RESULT, {
          blueprintId,
          workspaceId,
          result
        })
      }
    } catch {
      /* non-fatal */
    }

    return result
  })

  // ── blueprint:getConstitution — Get workspace constitution ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_GET_CONSTITUTION, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_GET_CONSTITUTION)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.BLUEPRINT_GET_CONSTITUTION)
    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace) return null
    return {
      constitutionMd: workspace.constitutionMd ?? null,
      constitutionVersion: workspace.constitutionVersion ?? '1.0.0'
    }
  })

  // ── blueprint:saveConstitution — Save workspace constitution ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_SAVE_CONSTITUTION, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_SAVE_CONSTITUTION
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const constitutionMd = requireString(args, 'constitutionMd', ch)
    const version = optionalString(args, 'version', ch)
    workspaceRepository.updateConstitution(workspaceId, constitutionMd, version ?? '1.0.0')
    return { saved: true }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 2: Specify + Clarify Pipeline Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  // ── blueprint:startSpecify — Start the SPECIFY phase ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_START_SPECIFY, (event, rawArgs: unknown) => {
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
    const grillDecisions = extractGrillDecisions(
      blueprint.settingsJson as Record<string, unknown> | null
    )
    const referenceDocuments = extractReferenceDocuments(
      blueprint.settingsJson as Record<string, unknown> | null
    )

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
  })

  // ── blueprint:startClarify — Start the CLARIFY phase ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_START_CLARIFY, (event, rawArgs: unknown) => {
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
  })

  // ── blueprint:clarifyAnswer — Send a user answer during CLARIFY ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_CLARIFY_ANSWER, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_CLARIFY_ANSWER
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const message = requireString(args, 'message', ch)

    // M8: Journal user answer before sending (append is best-effort)
    try {
      blueprintEventRepository.append(blueprintId, 'user', { message })
    } catch {
      /* best effort */
    }

    await blueprintSpecService.sendClarifyAnswer({
      blueprintId,
      workspaceId,
      message
    })

    return { sent: true }
  })

  // ── blueprint:skipClarify — Skip the CLARIFY phase ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_SKIP_CLARIFY, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.BLUEPRINT_SKIP_CLARIFY)
    const blueprintId = requireString(args, 'blueprintId', IPC_CHANNELS.BLUEPRINT_SKIP_CLARIFY)

    await blueprintSpecService.skipClarifyPhase(blueprintId)
    return { skipped: true }
  })

  // ── blueprint:clarifyProceed — User proceeds through the clarify gate ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_CLARIFY_PROCEED, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_CLARIFY_PROCEED
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)
    requireString(args, 'workspaceId', ch)

    await blueprintSpecService.proceedClarifyGate(blueprintId)
    return { proceeded: true }
  })

  // ── blueprint:clarifyIterate — User requests more clarification rounds ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_CLARIFY_ITERATE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_CLARIFY_ITERATE
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)
    requireString(args, 'workspaceId', ch)

    await blueprintSpecService.iterateClarify(blueprintId)
    return { iterated: true }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 3: Plan Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════════

  // ── blueprint:startPlan — Start the PLAN phase ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_START_PLAN, (event, rawArgs: unknown) => {
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
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 4: Tasks Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════════

  // ── blueprint:startTasks — Start the TASKS phase ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_START_TASKS, (event, rawArgs: unknown) => {
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
  })

  // ═══════════════════════════════════════════════════════════════════════
  //  Phase 5: Review Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════

  // ── blueprint:startReview — Start the REVIEW phase ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_START_REVIEW, (event, rawArgs: unknown) => {
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
  })

  // ═══════════════════════════════════════════════════════════════════════
  //  Phase 6: Build Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════

  // ── blueprint:startBuild — Start the BUILD phase (manual trigger) ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_START_BUILD, (event, rawArgs: unknown) => {
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
  })

  // ═══════════════════════════════════════════════════════════════════════
  //  Phase 7: Verify Pipeline Handler
  // ═══════════════════════════════════════════════════════════════════════

  // ── blueprint:startVerify — Start the VERIFY phase (manual trigger or auto from BUILD) ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_START_VERIFY, (event, rawArgs: unknown) => {
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
  })

  // ── blueprint:retryPhase — Retry the failed phase of a blueprint ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_RETRY_PHASE, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_RETRY_PHASE
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)
    const workspaceId = requireString(args, 'workspaceId', ch)

    // retryPhase resets the failed phase → pending and returns the phase type
    const { phase } = blueprintService.retryPhase(blueprintId)

    // RETRY-JOURNAL: Record retry dispatch in journal so hydrated transcripts
    // show a divider explaining why a phase started again.
    try {
      blueprintEventRepository.append(blueprintId, 'system', {
        event: 'retryPhase',
        message: `Retrying ${phase} phase`
      })
    } catch {
      /* best effort */
    }

    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`)
    }

    const blueprint = blueprintService.getBlueprint(blueprintId)
    if (!blueprint) throw new Error(`Blueprint not found: ${blueprintId}`)

    // Extract grill decisions and reference documents from settings (for specify retry)
    const grillDecisions = extractGrillDecisions(
      blueprint.settingsJson as Record<string, unknown> | null
    )
    const referenceDocuments = extractReferenceDocuments(
      blueprint.settingsJson as Record<string, unknown> | null
    )

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
  })

  // ── blueprint:acknowledgeReview — Mark human-needed verify as reviewed ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_ACKNOWLEDGE_REVIEW, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_ACKNOWLEDGE_REVIEW
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)

    const phase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
    if (!phase) {
      throw new Error(`Verify phase not found for blueprint: ${blueprintId}`)
    }

    // Find verify artifact and stamp acknowledgement on its contentJson
    const artifacts = [...phase.artifactsJson]
    const artIdx = artifacts.findIndex((a) => a.type === 'verify' || a.type === 'verification')
    if (artIdx >= 0) {
      const art = artifacts[artIdx]
      const contentJson = (art.contentJson ?? {}) as Record<string, unknown>
      contentJson.humanReviewAcknowledged = true
      contentJson.acknowledgedAt = new Date().toISOString()
      artifacts[artIdx] = { ...art, contentJson }
    }

    blueprintPhaseRepository.saveArtifacts(phase.id, artifacts)

    // Journal beat for transcript audit trail
    try {
      blueprintEventRepository.append(blueprintId, 'system', {
        event: 'humanReviewAcknowledged',
        message: 'Human review completed — verification acknowledged by user'
      })
    } catch {
      /* best effort */
    }

    return { acknowledged: true }
  })

  // ── M3: blueprint:getTranscript — Retrieve journal entries for a blueprint ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_GET_TRANSCRIPT, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_GET_TRANSCRIPT
    const args = requireObject(rawArgs, ch)
    const blueprintId = requireString(args, 'blueprintId', ch)
    const afterSeq = optionalNumber(args, 'afterSeq', ch)

    if (afterSeq !== undefined && afterSeq !== null) {
      return blueprintEventRepository.findByBlueprintAfterSeq(blueprintId, afterSeq)
    }
    return blueprintEventRepository.findByBlueprint(blueprintId)
  })

  // ── M7: blueprint:getSnapshot — Pull-based snapshot seed ──

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_GET_SNAPSHOT, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_GET_SNAPSHOT
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    return blueprintService.getSnapshot(workspaceId)
  })

  // ── Stale blueprint detection on registration ──
  blueprintService.reconcileStaleBlueprints()

  // M6: Wire-once event forwarding — registered once, routes by payload.workspaceId.
  // Eliminates 13 wireBlueprintEvents call sites + 180-min TTL cleanup.
  wireOnceEventForwarding()
}

// ── M6: Wire-Once Event Forwarding ──
// Registered once during IPC registration. Routes by payload.workspaceId.
// No TTL, no per-workspace cleanup, no re-wire dance.

let wireOnceEventForwardingCalled = false
function wireOnceEventForwarding(): void {
  // Guard: prevent double-registration if called more than once.
  // EventEmitter.on stacks handlers, so a second call would duplicate
  // every journal append and event forward.
  if (wireOnceEventForwardingCalled) {
    bpLog.warn('[wireOnceEventForwarding] Already called — skipping duplicate registration')
    return
  }
  wireOnceEventForwardingCalled = true

  // Helper: safe event forwarding with error isolation
  function forward(
    emitter: EventEmitterLike,
    event: string,
    channel: string,
    logPrefix?: string
  ): void {
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
        getSessionEventRouter().sendWorkspaceEvent(
          IPC_CHANNELS.AGENT_STATUS_UPDATE,
          data.workspaceId,
          { ...data.status }
        )
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
  forward(
    blueprintBuildService as unknown as EventEmitterLike,
    'phaseStart',
    IPC_CHANNELS.BLUEPRINT_PHASE_START,
    'build-event'
  )
  forward(
    blueprintBuildService as unknown as EventEmitterLike,
    'phaseProgress',
    IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS
  )
  forward(
    blueprintBuildService as unknown as EventEmitterLike,
    'phaseComplete',
    IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
    'build-event'
  )
  forward(
    blueprintBuildService as unknown as EventEmitterLike,
    'phaseArtifact',
    IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
    'build-event'
  )
  forwardStatus(blueprintBuildService as unknown as EventEmitterLike)

  // Wave execution events
  forward(
    blueprintBuildService as unknown as EventEmitterLike,
    'waveStart',
    IPC_CHANNELS.BLUEPRINT_WAVE_START,
    'build-event'
  )
  forward(
    blueprintBuildService as unknown as EventEmitterLike,
    'waveTaskStart',
    IPC_CHANNELS.BLUEPRINT_WAVE_TASK_START
  )
  forward(
    blueprintBuildService as unknown as EventEmitterLike,
    'waveTaskComplete',
    IPC_CHANNELS.BLUEPRINT_WAVE_TASK_COMPLETE,
    'build-event'
  )
  forward(
    blueprintBuildService as unknown as EventEmitterLike,
    'waveComplete',
    IPC_CHANNELS.BLUEPRINT_WAVE_COMPLETE,
    'build-event'
  )

  // ── BlueprintSpecService events (Phase 2: Specify + Clarify) ──
  forward(
    blueprintSpecService as unknown as EventEmitterLike,
    'phaseStart',
    IPC_CHANNELS.BLUEPRINT_PHASE_START,
    'spec-event'
  )
  forward(
    blueprintSpecService as unknown as EventEmitterLike,
    'phaseProgress',
    IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS
  )
  forward(
    blueprintSpecService as unknown as EventEmitterLike,
    'phaseComplete',
    IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
    'spec-event'
  )
  forward(
    blueprintSpecService as unknown as EventEmitterLike,
    'phaseArtifact',
    IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
    'spec-event'
  )
  forward(
    blueprintSpecService as unknown as EventEmitterLike,
    'clarifyAwaitingInput',
    IPC_CHANNELS.BLUEPRINT_CLARIFY_AWAITING_INPUT,
    'spec-event'
  )
  forward(
    blueprintSpecService as unknown as EventEmitterLike,
    'clarifyFindings',
    IPC_CHANNELS.BLUEPRINT_CLARIFY_FINDINGS,
    'spec-event'
  )
  forward(
    blueprintSpecService as unknown as EventEmitterLike,
    'clarifyQuestions',
    IPC_CHANNELS.BLUEPRINT_CLARIFY_QUESTIONS,
    'spec-event'
  )

  // OS notification: Blueprint needs user input (clarify phase)
  ;(blueprintSpecService as unknown as EventEmitterLike).on(
    'clarifyAwaitingInput',
    (...args: unknown[]) => {
      try {
        const payload = args[0] as Record<string, unknown>
        const wsId = payload?.workspaceId as string | undefined
        if (!wsId) return
        notificationService.dispatch({
          workspaceId: wsId,
          workspaceName: resolveWorkspaceName(wsId),
          service: 'blueprint',
          status: 'needs_input',
          summary: 'Blueprint has questions — your input shapes the spec',
          targetPage: 'blueprints',
          entityId: payload.blueprintId as string | undefined
        })
      } catch {
        /* non-fatal */
      }
    }
  )
  forward(
    blueprintSpecService as unknown as EventEmitterLike,
    'clarifyGateReady',
    IPC_CHANNELS.BLUEPRINT_CLARIFY_GATE,
    'spec-event'
  )
  forwardStatus(blueprintSpecService as unknown as EventEmitterLike)

  // ── BlueprintPlanService events (Phase 3: Plan) ──
  forward(
    blueprintPlanService as unknown as EventEmitterLike,
    'phaseStart',
    IPC_CHANNELS.BLUEPRINT_PHASE_START,
    'plan-event'
  )
  forward(
    blueprintPlanService as unknown as EventEmitterLike,
    'phaseProgress',
    IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS
  )
  forward(
    blueprintPlanService as unknown as EventEmitterLike,
    'phaseComplete',
    IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
    'plan-event'
  )
  forward(
    blueprintPlanService as unknown as EventEmitterLike,
    'phaseArtifact',
    IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
    'plan-event'
  )
  forwardStatus(blueprintPlanService as unknown as EventEmitterLike)

  // ── BlueprintTasksService events (Phase 4: Tasks) ──
  forward(
    blueprintTasksService as unknown as EventEmitterLike,
    'phaseStart',
    IPC_CHANNELS.BLUEPRINT_PHASE_START,
    'tasks-event'
  )
  forward(
    blueprintTasksService as unknown as EventEmitterLike,
    'phaseProgress',
    IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS
  )
  forward(
    blueprintTasksService as unknown as EventEmitterLike,
    'phaseComplete',
    IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
    'tasks-event'
  )
  forward(
    blueprintTasksService as unknown as EventEmitterLike,
    'phaseArtifact',
    IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
    'tasks-event'
  )
  forwardStatus(blueprintTasksService as unknown as EventEmitterLike)

  // ── BlueprintReviewService events (Phase 5: Review) ──
  forward(
    blueprintReviewService as unknown as EventEmitterLike,
    'phaseStart',
    IPC_CHANNELS.BLUEPRINT_PHASE_START,
    'review-event'
  )
  forward(
    blueprintReviewService as unknown as EventEmitterLike,
    'phaseProgress',
    IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS
  )
  forward(
    blueprintReviewService as unknown as EventEmitterLike,
    'phaseComplete',
    IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
    'review-event'
  )
  forward(
    blueprintReviewService as unknown as EventEmitterLike,
    'phaseArtifact',
    IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
    'review-event'
  )
  forwardStatus(blueprintReviewService as unknown as EventEmitterLike)
  forward(
    blueprintReviewService as unknown as EventEmitterLike,
    'approvalNeeded',
    IPC_CHANNELS.BLUEPRINT_APPROVAL_NEEDED,
    'review-event'
  )
  forward(
    blueprintReviewService as unknown as EventEmitterLike,
    'preflightResult',
    IPC_CHANNELS.BLUEPRINT_PREFLIGHT_RESULT,
    'review-event'
  )

  // OS notification: Blueprint review complete — needs approval
  ;(blueprintReviewService as unknown as EventEmitterLike).on(
    'approvalNeeded',
    (...args: unknown[]) => {
      try {
        const payload = args[0] as Record<string, unknown>
        const wsId = payload?.workspaceId as string | undefined
        if (!wsId) return
        notificationService.dispatch({
          workspaceId: wsId,
          workspaceName: resolveWorkspaceName(wsId),
          service: 'blueprint',
          status: 'needs_input',
          summary: 'Blueprint review complete — approve to start build',
          targetPage: 'blueprints',
          entityId: payload.blueprintId as string | undefined
        })
      } catch {
        /* non-fatal */
      }
    }
  )

  // ── BlueprintVerifyService events (Phase 7: Verify) ──
  forward(
    blueprintVerifyService as unknown as EventEmitterLike,
    'phaseStart',
    IPC_CHANNELS.BLUEPRINT_PHASE_START,
    'verify-event'
  )
  forward(
    blueprintVerifyService as unknown as EventEmitterLike,
    'phaseProgress',
    IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS
  )
  forward(
    blueprintVerifyService as unknown as EventEmitterLike,
    'phaseComplete',
    IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE,
    'verify-event'
  )
  forward(
    blueprintVerifyService as unknown as EventEmitterLike,
    'phaseArtifact',
    IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT,
    'verify-event'
  )
  forwardStatus(blueprintVerifyService as unknown as EventEmitterLike)

  // OS notification: Blueprint phase completed or failed
  // Fires for all phases — summary is phase-aware.

  /**
   * Prefix a phase summary with the blueprint's title.
   *
   * The notification title is a generic "Blueprint — ✓ Complete" and the body
   * was a phase string with no identity, so a user with several blueprints had
   * no way to tell which one had finished. entityId already carries the id —
   * this surfaces something human-readable.
   */
  function withBlueprintTitle(blueprintId: string | undefined, summary: string): string {
    if (!blueprintId) return summary
    try {
      const title = blueprintRepository.findById(blueprintId)?.title?.trim()
      return title ? `${title} — ${summary}` : summary
    } catch (err) {
      bpLog.warn(`[notify] Failed to resolve blueprint title for ${blueprintId}:`, err)
      return summary
    }
  }

  function buildBlueprintPhaseSummary(
    phase: string,
    status: string,
    payload: Record<string, unknown>
  ): string {
    if (status !== 'complete') return `Blueprint ${phase} phase failed`
    switch (phase) {
      case 'specify':
        return 'Specification complete — moving to clarification'
      case 'clarify':
        return 'Clarification complete — moving to planning'
      case 'plan':
        return 'Plan complete — moving to task decomposition'
      case 'tasks':
        return 'Tasks generated — moving to review'
      case 'review':
        return 'Review complete — ready for build'
      case 'build':
        return `Build complete: ${(payload.completion as Record<string, unknown>)?.tasksCompleted ?? 0} tasks done`
      case 'verify':
        return 'Blueprint finished — all phases complete'
      default:
        return `Blueprint ${phase} phase complete`
    }
  }

  for (const svc of [
    blueprintSpecService as unknown as EventEmitterLike,
    blueprintPlanService as unknown as EventEmitterLike,
    blueprintTasksService as unknown as EventEmitterLike,
    blueprintReviewService as unknown as EventEmitterLike,
    blueprintBuildService as unknown as EventEmitterLike,
    blueprintVerifyService as unknown as EventEmitterLike
  ]) {
    svc.on('phaseComplete', (...args: unknown[]) => {
      try {
        const payload = args[0] as Record<string, unknown>
        const wsId = payload?.workspaceId as string | undefined
        if (!wsId) return
        // AUDIT-R2: remediation handoff is not a terminal completion — no notification
        if (payload.remediationTriggered === true) return
        // Skip 'skipped' status (e.g. clarify skip) — not interesting to notify
        if (payload.status === 'skipped') return
        const phase = payload.phase as string
        const status = payload.status as string
        const blueprintId = payload.blueprintId as string | undefined
        notificationService.dispatch({
          workspaceId: wsId,
          workspaceName: resolveWorkspaceName(wsId),
          service: 'blueprint',
          status: status === 'complete' ? 'completed' : 'failed',
          summary: withBlueprintTitle(
            blueprintId,
            buildBlueprintPhaseSummary(phase, status, payload)
          ),
          targetPage: 'blueprints',
          entityId: blueprintId
        })
      } catch (err) {
        bpLog.warn('[notify] Failed to dispatch blueprint phase notification:', err)
      }
    })
  }

  // ───────────────────────────────────────────────────────────────────────
  // M8: Journal writers — append events to blueprint_events table.
  // Best-effort: failures are logged but don't block the pipeline.
  // ───────────────────────────────────────────────────────────────────────

  function journalAppend(
    blueprintId: string,
    type: string,
    payload: Record<string, unknown>
  ): void {
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
    blueprintService,
    blueprintSpecService,
    blueprintPlanService,
    blueprintTasksService,
    blueprintReviewService,
    blueprintBuildService,
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
      if (bpId)
        journalAppend(bpId, 'system', {
          event: 'phaseComplete',
          phase: payload.phase,
          status: payload.status,
          error: payload.error
        })
    })
  }

  // Journal: phaseArtifact → type-specific entries (plan, tasks, agent)
  for (const emitter of allPhaseEmitters) {
    emitter.on('phaseArtifact', (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown>
      const bpId = payload?.blueprintId as string | undefined
      const artifact = payload?.artifact as { type?: string; contentMd?: string } | undefined
      if (!bpId || !artifact) return
      const journalType =
        artifact.type === 'plan' ? 'plan' : artifact.type === 'tasks' ? 'tasks' : 'agent'
      // Phase 2: Include contentJson for plan/tasks so hydration avoids re-parsing
      const journalPayload: Record<string, unknown> = {
        phase: payload.phase,
        artifactType: artifact.type,
        contentMd: artifact.contentMd
      }
      if (artifact.type === 'plan' && artifact.contentMd) {
        try {
          const parsed = parseBlueprintPlan(artifact.contentMd)
          if (parsed) journalPayload.contentJson = parsed
        } catch {
          /* best effort */
        }
      }
      if (artifact.type === 'tasks' && artifact.contentMd) {
        try {
          const parsed = parseBlueprintTasks(artifact.contentMd)
          if (parsed) journalPayload.contentJson = parsed
        } catch {
          /* best effort */
        }
      }
      journalAppend(bpId, journalType, journalPayload)
    })
  }

  // Journal: clarify findings → 'findings' entries
  ;(blueprintSpecService as unknown as EventEmitterLike).on(
    'clarifyFindings',
    (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown>
      const bpId = payload?.blueprintId as string | undefined
      if (bpId) journalAppend(bpId, 'findings', { findings: payload.findings })
    }
  )

  // Journal: clarify questions → 'qa' entries
  ;(blueprintSpecService as unknown as EventEmitterLike).on(
    'clarifyQuestions',
    (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown>
      const bpId = payload?.blueprintId as string | undefined
      if (bpId) journalAppend(bpId, 'qa', { questions: payload.questions })
    }
  )

  // Journal: clarify gate → 'qa' entry
  ;(blueprintSpecService as unknown as EventEmitterLike).on(
    'clarifyGateReady',
    (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown>
      const bpId = payload?.blueprintId as string | undefined
      if (bpId) journalAppend(bpId, 'qa', { event: 'gateReady', findings: payload.findings })
    }
  )

  // Journal: wave markers → 'system' entries
  ;(blueprintBuildService as unknown as EventEmitterLike).on('waveStart', (...args: unknown[]) => {
    const payload = args[0] as Record<string, unknown>
    const bpId = payload?.blueprintId as string | undefined
    if (bpId)
      journalAppend(bpId, 'system', {
        event: 'waveStart',
        wave: payload.wave,
        taskCount: payload.taskCount
      })
  })
  ;(blueprintBuildService as unknown as EventEmitterLike).on(
    'waveComplete',
    (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown>
      const bpId = payload?.blueprintId as string | undefined
      if (bpId)
        journalAppend(bpId, 'system', {
          event: 'waveComplete',
          wave: payload.wave,
          status: payload.status
        })
    }
  )

  // ───────────────────────────────────────────────────────────────────────
  // M8b: Agent stream accumulator — extracted to blueprint-agent-accumulator.ts.
  // Buffers phaseProgress chunks into 'agent' journal entries.
  // Flushes at tool-activity boundaries and on phaseComplete.
  // Caps: 32KB per entry, ~1MB per (blueprintId, phase).
  // ───────────────────────────────────────────────────────────────────────

  const accumulator = createAccumulator(journalAppend)

  /** GAP-6 FIX: Flush + delete ALL accumulator entries for a given blueprintId. */
  accumulatorCleanup = (blueprintId: string): void => {
    accumulator.flushAllForBlueprint(blueprintId)
  }

  // Tap phaseProgress on all emitters for agent journaling
  for (const emitter of allPhaseEmitters) {
    emitter.on('phaseProgress', (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown>
      const bpId = payload?.blueprintId as string | undefined
      const phase = payload?.phase as string | undefined
      if (!bpId || !phase) return

      accumulator.handleChunk(
        bpId,
        phase,
        payload.kind as string | undefined,
        payload.text as string | undefined,
        payload.toolActivity as Record<string, unknown> | undefined,
        payload.taskId as string | undefined
      )
    })
  }

  // Flush accumulator on phaseComplete (including cancel/failure)
  for (const emitter of allPhaseEmitters) {
    emitter.on('phaseComplete', (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown>
      const bpId = payload?.blueprintId as string | undefined
      const phase = payload?.phase as string | undefined
      if (!bpId || !phase) return

      accumulator.flushAllForPhase(bpId, phase)
    })
  }

  // ── Auto-retry dispatch for transient phase failures ──
  // blueprintService.scheduleAutoRetry() emits 'autoRetry' after a 5s delay.
  // The IPC layer dispatches the phase start — same logic as the manual retry handler.
  blueprintService.on(
    'autoRetry',
    (payload: {
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
          const grillDecisions = extractGrillDecisions(
            bp?.settingsJson as Record<string, unknown> | null
          )
          const referenceDocuments = extractReferenceDocuments(
            bp?.settingsJson as Record<string, unknown> | null
          )
          return blueprintSpecService.startSpecifyPhase({
            blueprintId,
            workspaceId,
            workspacePath,
            description: bp?.description ?? '',
            grillDecisions,
            referenceDocuments
          })
        },
        clarify: () =>
          blueprintSpecService.startClarifyPhase({ blueprintId, workspaceId, workspacePath }),
        plan: () =>
          blueprintPlanService.startPlanPhase({ blueprintId, workspaceId, workspacePath }),
        tasks: () =>
          blueprintTasksService.startTasksPhase({ blueprintId, workspaceId, workspacePath }),
        review: () =>
          blueprintReviewService.startReviewPhase({ blueprintId, workspaceId, workspacePath }),
        build: () =>
          blueprintBuildService.startBuildPhase({ blueprintId, workspaceId, workspacePath }),
        verify: () =>
          blueprintVerifyService.startVerifyPhase({ blueprintId, workspaceId, workspacePath })
      }

      const dispatch = phaseDispatch[phase]
      if (dispatch) {
        dispatch().catch((err) => {
          bpLog.error(`[auto-retry] ${phase} phase auto-retry failed:`, err)
        })
      } else {
        bpLog.error(`[auto-retry] Unknown phase: ${phase}`)
      }
    }
  )

  // ── Remediation dispatch (gaps_found → rebuild → re-verify) ──
  // BP-REMEDIATION-01: blueprintVerifyService emits 'remediationNeeded' via deferred
  // dispatch (setImmediate after finally) when verification finds gaps and remediation
  // tasks are appended. Same dispatch pattern as autoRetry — build phase re-runs,
  // BP-RESUME-01 skips all complete tasks, only new remediation waves execute.
  ;(blueprintVerifyService as unknown as EventEmitterLike).on(
    'remediationNeeded',
    (...args: unknown[]) => {
      const payload = args[0] as { blueprintId: string; workspaceId: string; workspacePath: string }
      const { blueprintId, workspaceId, workspacePath } = payload

      // BP-REMEDIATION-CANCEL-GUARD: Verify blueprint wasn't cancelled during
      // the deferred dispatch window before dispatching build.
      const blueprint = blueprintRepository.findById(blueprintId)
      if (!blueprint || blueprint.status === 'cancelled' || blueprint.status === 'failed') {
        bpLog.info(
          `[remediation] Skipping build dispatch — blueprint ${blueprintId} is ${blueprint?.status ?? 'missing'}`
        )
        return
      }

      // BP-REMEDIATION-PIPELINE-GUARD: If the pipeline is occupied, decide
      // based on WHICH blueprint owns it.
      if (blueprintService.isRunning(workspaceId)) {
        // Same blueprint already running (e.g. user clicked Resume during the
        // dispatch window) → skip silently. Do NOT mark it failed while it runs.
        if (blueprintService.getActiveBlueprintId(workspaceId) === blueprintId) {
          bpLog.info(
            `[remediation] Blueprint ${blueprintId} already running — skipping duplicate dispatch`
          )
          return
        }
        // A DIFFERENT blueprint took the pipeline → mark this one failed
        bpLog.warn(
          `[remediation] Pipeline occupied for workspace ${workspaceId} — ` +
            `cannot dispatch remediation build for blueprint ${blueprintId}. Marking failed.`
        )
        // Reset orphaned phase statuses from remediation setup
        // (verify set build='active', verify='pending' before releasing the pipeline)
        const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
        if (buildPhase?.status === 'active') {
          blueprintPhaseRepository.updateStatus(buildPhase.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
        return
      }

      bpLog.info(`[remediation] Dispatching build for remediation tasks — blueprint ${blueprintId}`)

      // REMEDIATION-JOURNAL: Record remediation dispatch in journal so hydrated
      // transcripts explain why a build phase restarted after verify.
      journalAppend(blueprintId, 'system', {
        event: 'remediationStart',
        message: 'Verification found gaps — dispatching remediation build'
      })

      blueprintBuildService
        .startBuildPhase({ blueprintId, workspaceId, workspacePath })
        .catch((err) => {
          bpLog.error(`[remediation] Build phase for remediation failed:`, err)
        })
    }
  )
}
