/**
 * BlueprintService — lifecycle management for the Blueprint specification pipeline.
 *
 * Manages the 7-phase pipeline: specify → clarify → plan → tasks → review → build → verify.
 * Each phase gets its own conversation (fresh context principle from GSD Core).
 *
 * Follows the MpaOrchestrationService pattern: EventEmitter, per-workspace state,
 * event forwarding to IPC layer.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import {
  blueprintRepository,
  blueprintPhaseRepository,
  blueprintTaskRepository
} from '../db/repositories/blueprint.repository'
import { workspaceRepository } from '../db/repositories'
import { ideaRepository } from '../db/repositories'
import { buildPhaseSystemPrompt } from './blueprint-prompt-loader'
import { safeParseJSON } from '../db/json-utils'
import { validateTaskGraph } from './blueprint-task-validator'
import type {
  Blueprint,
  BlueprintPhase,
  BlueprintTask,
  BlueprintWithPhases,
  BlueprintWithDetails,
  BlueprintPhaseType,
  BlueprintArtifact,
  CreateBlueprintParams,
  PhaseContext,
  BlueprintPhaseCompletion,
  GrillDecisionForBlueprint
} from '../../shared/blueprint-types'
import { BLUEPRINT_PHASE_ORDER, PHASE_TO_STATUS } from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint')

// ── Helpers ──

/** Validate and extract grill decisions from an unknown settingsJson value. */
function parseGrillDecisions(raw: unknown): GrillDecisionForBlueprint[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined
  const valid = raw.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.header === 'string' &&
      typeof item.selectedOption === 'string' &&
      typeof item.reason === 'string'
  )
  if (!valid) {
    bpLog.warn(
      '[parseGrillDecisions] Malformed grill decisions — expected {header, selectedOption, reason}[]'
    )
    return undefined
  }
  return raw as GrillDecisionForBlueprint[]
}

// ── Per-Workspace Pipeline State ──

interface BlueprintPipelineState {
  running: boolean
  blueprintId: string | null
  currentPhase: BlueprintPhaseType | null
  abortController: AbortController | null
}

// ── Service ──

export class BlueprintService extends EventEmitter {
  private pipelines = new Map<string, BlueprintPipelineState>()
  /** BP-01: Concurrency lock — prevents overlapping pipeline starts per workspace. */
  private readonly startLocks = new Set<string>()

  // ── Pipeline State ──

  private getOrCreatePipeline(workspaceId: string): BlueprintPipelineState {
    let state = this.pipelines.get(workspaceId)
    if (!state) {
      state = {
        running: false,
        blueprintId: null,
        currentPhase: null,
        abortController: null
      }
      this.pipelines.set(workspaceId, state)
    }
    return state
  }

  isRunning(workspaceId: string): boolean {
    return this.pipelines.get(workspaceId)?.running ?? false
  }

  getActiveBlueprintId(workspaceId: string): string | null {
    return this.pipelines.get(workspaceId)?.blueprintId ?? null
  }

  /** Get the abort signal for a workspace pipeline — used by phase services to race against cancel. */
  getAbortSignal(workspaceId: string): AbortSignal | null {
    return this.pipelines.get(workspaceId)?.abortController?.signal ?? null
  }

  /** Mark a pipeline as running for a workspace. Called by BlueprintSpecService. */
  markPipelineRunning(workspaceId: string, blueprintId: string, phase: BlueprintPhaseType): void {
    // BP-01: Guard against concurrent pipeline starts
    if (this.startLocks.has(workspaceId)) {
      throw new Error(`Blueprint start lock held for workspace ${workspaceId}`)
    }
    const state = this.getOrCreatePipeline(workspaceId)
    if (state.running) {
      throw new Error(`Blueprint pipeline already running for workspace ${workspaceId}`)
    }
    this.startLocks.add(workspaceId)
    state.running = true
    state.blueprintId = blueprintId
    state.currentPhase = phase
    state.abortController = new AbortController()
  }

  /** Mark a pipeline as stopped for a workspace. Called by BlueprintSpecService. */
  markPipelineStopped(workspaceId: string): void {
    this.startLocks.delete(workspaceId)
    const state = this.pipelines.get(workspaceId)
    if (state) {
      state.running = false
      state.abortController = null
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LIFECYCLE — Create, Cancel, Delete
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new Blueprint with all 7 phase records.
   * Optionally snapshots the workspace constitution at creation time.
   */
  create(params: CreateBlueprintParams): BlueprintWithPhases {
    const workspace = workspaceRepository.findById(params.workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${params.workspaceId}`)
    }

    // Snapshot constitution at creation time (frozen copy)
    const constitutionSnapshot = workspace.constitutionMd ?? null

    const blueprint = blueprintRepository.create({
      workspaceId: params.workspaceId,
      title: params.title,
      description: params.description,
      priority: params.priority,
      sourceIdeaId: params.sourceIdeaId,
      constitutionSnapshot: constitutionSnapshot ?? undefined,
      settingsJson: params.settingsJson
    })

    // Create all 7 phase records
    const phases = blueprintPhaseRepository.createAllPhases(blueprint.id)

    bpLog.info(`[create] Blueprint "${blueprint.title}" created with ${phases.length} phases`)

    return { ...blueprint, phases }
  }

  /**
   * Create a Blueprint from an existing Idea (graduation flow).
   * Pre-populates with the idea's title, description, and grill decisions.
   */
  createFromIdea(ideaId: string, workspaceId: string): BlueprintWithPhases {
    const idea = ideaRepository.findById(ideaId)
    if (!idea) {
      throw new Error(`Idea not found: ${ideaId}`)
    }

    return this.create({
      workspaceId,
      title: idea.title,
      description: idea.description,
      sourceIdeaId: ideaId,
      settingsJson: {
        grillDecisions: safeParseJSON(idea.grillDecisions ?? null, undefined),
        grillSummary: idea.grillSummary
      }
    })
  }

  /**
   * Cancel an active Blueprint pipeline.
   */
  cancel(workspaceId: string): void {
    const state = this.pipelines.get(workspaceId)
    if (!state?.running || !state.blueprintId) {
      bpLog.warn('[cancel] No active blueprint pipeline to cancel')
      return
    }

    state.abortController?.abort()
    state.running = false
    this.startLocks.delete(workspaceId)

    blueprintRepository.updateStatus(state.blueprintId, 'cancelled')

    bpLog.info(`[cancel] Blueprint ${state.blueprintId} cancelled`)
    state.blueprintId = null
    state.currentPhase = null
  }

  /**
   * Delete a Blueprint and all its phases/tasks (cascading).
   */
  delete(blueprintId: string): void {
    blueprintRepository.delete(blueprintId)
    bpLog.info(`[delete] Blueprint ${blueprintId} deleted`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE MANAGEMENT — Advance, Skip, Rewind
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Advance to the next phase in the pipeline.
   * Marks current phase as complete and activates the next one.
   */
  advancePhase(blueprintId: string): BlueprintPhase | null {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) {
      throw new Error(`Blueprint not found: ${blueprintId}`)
    }

    const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)
    const currentIdx = BLUEPRINT_PHASE_ORDER.indexOf(blueprint.currentPhase)
    const nextIdx = currentIdx + 1

    if (nextIdx >= BLUEPRINT_PHASE_ORDER.length) {
      // All phases complete
      blueprintRepository.updateStatus(blueprintId, 'complete')
      bpLog.info(`[advancePhase] Blueprint ${blueprintId} — all phases complete`)
      return null
    }

    // Mark current phase as complete
    const currentPhaseRecord = phases.find((p) => p.phase === blueprint.currentPhase)
    if (currentPhaseRecord) {
      if (currentPhaseRecord.status === 'active') {
        blueprintPhaseRepository.updateStatus(currentPhaseRecord.id, 'complete')
      } else if (currentPhaseRecord.status === 'pending') {
        bpLog.warn(
          `[advancePhase] Blueprint ${blueprintId} — phase ${blueprint.currentPhase} is still pending (was it activated?)`
        )
        // Mark pending→complete to avoid orphaned phases
        blueprintPhaseRepository.updateStatus(currentPhaseRecord.id, 'complete')
      }
    }

    // Activate next phase
    const nextPhaseName = BLUEPRINT_PHASE_ORDER[nextIdx]
    const nextPhaseRecord = phases.find((p) => p.phase === nextPhaseName)
    if (!nextPhaseRecord) {
      throw new Error(`Phase record not found for: ${nextPhaseName}`)
    }

    blueprintPhaseRepository.updateStatus(nextPhaseRecord.id, 'active')
    blueprintRepository.update(blueprintId, {
      currentPhase: nextPhaseName,
      status: PHASE_TO_STATUS[nextPhaseName]
    })

    bpLog.info(`[advancePhase] Blueprint ${blueprintId} → ${nextPhaseName}`)
    return blueprintPhaseRepository.findById(nextPhaseRecord.id) ?? null
  }

  /**
   * Skip the current phase (e.g., skip CLARIFY if spec is clear).
   */
  skipPhase(blueprintId: string, phase: BlueprintPhaseType): void {
    const phaseRecord = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, phase)
    if (!phaseRecord) {
      throw new Error(`Phase ${phase} not found for blueprint ${blueprintId}`)
    }

    blueprintPhaseRepository.updateStatus(phaseRecord.id, 'skipped')
    bpLog.info(`[skipPhase] Blueprint ${blueprintId} — skipped ${phase}`)

    // Auto-advance to next phase
    this.advancePhase(blueprintId)
  }

  /**
   * Rewind to a previous phase (e.g., go back to SPECIFY after PLAN reveals gaps).
   * Resets all phases from the target forward to 'pending'.
   */
  rewindToPhase(blueprintId: string, targetPhase: BlueprintPhaseType): void {
    const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)
    const targetIdx = BLUEPRINT_PHASE_ORDER.indexOf(targetPhase)

    for (const phase of phases) {
      const phaseIdx = BLUEPRINT_PHASE_ORDER.indexOf(phase.phase)
      if (phaseIdx >= targetIdx && phase.status !== 'pending') {
        blueprintPhaseRepository.updateStatus(phase.id, 'pending')
      }
    }

    blueprintRepository.update(blueprintId, {
      currentPhase: targetPhase,
      status: PHASE_TO_STATUS[targetPhase]
    })

    bpLog.info(`[rewindToPhase] Blueprint ${blueprintId} → rewound to ${targetPhase}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CONTEXT ASSEMBLY — Feeds into Prompt Injection
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Assemble the full context needed for a phase's system prompt.
   * Collects blueprint metadata, constitution, and all artifacts from prior phases.
   */
  assemblePhaseContext(blueprintId: string, phase: BlueprintPhaseType): PhaseContext {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) {
      throw new Error(`Blueprint not found: ${blueprintId}`)
    }

    const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)

    // Collect artifacts from all completed prior phases
    const currentIdx = BLUEPRINT_PHASE_ORDER.indexOf(phase)
    const previousArtifacts: BlueprintArtifact[] = []
    for (const p of phases) {
      const pIdx = BLUEPRINT_PHASE_ORDER.indexOf(p.phase)
      if (pIdx < currentIdx && p.artifactsJson.length > 0) {
        previousArtifacts.push(...p.artifactsJson)
      }
    }

    // Extract grill decisions from settings if available (with runtime validation)
    const grillDecisions = parseGrillDecisions(blueprint.settingsJson?.grillDecisions)

    return {
      blueprint: {
        id: blueprint.id,
        title: blueprint.title,
        shortName: blueprint.shortName,
        description: blueprint.description,
        priority: blueprint.priority,
        currentPhase: phase,
        settings: blueprint.settingsJson
      },
      constitution: blueprint.constitutionSnapshot,
      previousArtifacts,
      specFilePath: `blueprints/${blueprint.shortName || blueprint.id}/spec.md`,
      blueprintDir: `blueprints/${blueprint.shortName || blueprint.id}`,
      grillDecisions
    }
  }

  /**
   * Build the full system prompt for a phase (convenience wrapper).
   */
  buildSystemPrompt(blueprintId: string, phase: BlueprintPhaseType): string {
    const context = this.assemblePhaseContext(blueprintId, phase)
    return buildPhaseSystemPrompt(phase, context)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ARTIFACT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Save an artifact produced by a phase.
   */
  savePhaseArtifact(
    blueprintId: string,
    phase: BlueprintPhaseType,
    artifact: BlueprintArtifact
  ): void {
    const phaseRecord = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, phase)
    if (!phaseRecord) {
      throw new Error(`Phase ${phase} not found for blueprint ${blueprintId}`)
    }

    blueprintPhaseRepository.appendArtifact(phaseRecord.id, artifact)
    bpLog.info(`[saveArtifact] Blueprint ${blueprintId}/${phase} — saved ${artifact.type}`)
  }

  /**
   * Get all artifacts across all phases for a blueprint.
   */
  getAllArtifacts(blueprintId: string): Array<BlueprintArtifact & { phase: BlueprintPhaseType }> {
    const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)
    const allArtifacts: Array<BlueprintArtifact & { phase: BlueprintPhaseType }> = []

    for (const phase of phases) {
      for (const artifact of phase.artifactsJson) {
        allArtifacts.push({ ...artifact, phase: phase.phase })
      }
    }

    return allArtifacts
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TASK MANAGEMENT (Blueprint Tasks — wave-based execution)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Populate blueprint_tasks from a parsed `blueprint-tasks` JSON block.
   * Clears existing tasks first (idempotent re-generation).
   */
  populateTasks(
    blueprintId: string,
    parsedTasks: Array<{
      taskId: string
      wave: number
      description: string
      userStory?: string
      files?: string[]
      isParallel?: boolean
      dependsOn?: string[]
    }>
  ): BlueprintTask[] {
    // BP-STALE-01: Prevent task regeneration while the blueprint is being built.
    // The build service assembles a task map at start — regenerating tasks mid-build
    // would leave the in-memory map referencing stale/deleted task IDs.
    for (const [, state] of this.pipelines) {
      if (state.running && state.blueprintId === blueprintId && state.currentPhase === 'build') {
        throw new Error(
          `Cannot regenerate tasks while blueprint ${blueprintId} is being built. ` +
            `Cancel the build first.`
        )
      }
    }

    // TASK-01: Validate the task dependency graph before persisting.
    // Checks reference integrity, cycles, and cross-wave ordering.
    const validation = validateTaskGraph(parsedTasks)
    if (!validation.valid) {
      bpLog.warn(
        `[populateTasks] Task graph has ${validation.errors.length} issue(s) for blueprint=${blueprintId}. ` +
          `Proceeding with persistence but downstream build may encounter dependency issues.`
      )
    }

    // Clear existing tasks
    blueprintTaskRepository.deleteByBlueprint(blueprintId)

    // Create new tasks
    return blueprintTaskRepository.createBulk(
      blueprintId,
      parsedTasks.map((t) => ({
        taskId: t.taskId,
        wave: t.wave,
        description: t.description,
        userStory: t.userStory,
        filePathsJson: t.files,
        isParallel: t.isParallel,
        dependsOnJson: t.dependsOn
      }))
    )
  }

  /**
   * Get tasks grouped by wave for execution planning.
   */
  getTasksByWave(blueprintId: string): Map<number, BlueprintTask[]> {
    const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)
    const waves = new Map<number, BlueprintTask[]>()

    for (const task of tasks) {
      const existing = waves.get(task.wave) ?? []
      existing.push(task)
      waves.set(task.wave, existing)
    }

    return waves
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  QUERY — Read operations
  // ═══════════════════════════════════════════════════════════════════════════

  getBlueprint(id: string): BlueprintWithPhases | null {
    const blueprint = blueprintRepository.findById(id)
    if (!blueprint) return null

    const phases = blueprintPhaseRepository.findByBlueprint(id)
    return { ...blueprint, phases }
  }

  getBlueprintWithDetails(id: string): BlueprintWithDetails | null {
    const blueprint = blueprintRepository.findById(id)
    if (!blueprint) return null

    const phases = blueprintPhaseRepository.findByBlueprint(id)
    const tasks = blueprintTaskRepository.findByBlueprint(id)
    return { ...blueprint, phases, tasks }
  }

  listBlueprints(workspaceId: string, limit = 50): Blueprint[] {
    return blueprintRepository.findByWorkspace(workspaceId, limit)
  }

  getPipelineStatus(workspaceId: string): {
    running: boolean
    blueprintId: string | null
    currentPhase: BlueprintPhaseType | null
  } {
    const state = this.pipelines.get(workspaceId)
    return {
      running: state?.running ?? false,
      blueprintId: state?.blueprintId ?? null,
      currentPhase: state?.currentPhase ?? null
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE COMPLETION PARSING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Parse a `blueprint-phase-complete` JSON block from agent output.
   * Returns null if no completion block is found.
   */
  parsePhaseCompletion(text: string): BlueprintPhaseCompletion | null {
    const match = text.match(/```blueprint-phase-complete\s*\n([\s\S]*?)\n```/)
    if (!match?.[1]) return null

    try {
      return JSON.parse(match[1]) as BlueprintPhaseCompletion
    } catch (err) {
      bpLog.warn('[parsePhaseCompletion] Failed to parse completion JSON:', err)
      return null
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  STALE DETECTION & CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark any blueprints that were active when the app last quit as 'failed'.
   */
  reconcileStaleBlueprints(): void {
    const count = blueprintRepository.markStaleAsFailed()
    if (count > 0) {
      bpLog.info(`[reconcile] Marked ${count} stale blueprint(s) as failed`)
    }
  }

  /**
   * Shut down all active pipelines.
   */
  shutdown(): void {
    for (const [workspaceId, state] of this.pipelines) {
      if (state.running) {
        state.abortController?.abort()
        state.running = false
        bpLog.info(`[shutdown] Cancelled pipeline for workspace ${workspaceId}`)
      }
    }
    this.pipelines.clear()
    this.startLocks.clear()
  }
}

// ── Singleton Export ──

export const blueprintService = new BlueprintService()
