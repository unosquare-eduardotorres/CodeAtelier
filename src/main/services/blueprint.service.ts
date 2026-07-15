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
import { getDatabase } from '../db/index'
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
import { BlueprintStateMachine } from './blueprint-state-machine'
import type { BlueprintPipelineSnapshot } from '../../shared/blueprint-snapshot-types'
import type { ClarifyFindingsBlock, ClarifyQuestionsBlock } from '../../shared/blueprint-clarify-parsers'
import type { BlueprintTaskStatus } from '../../shared/blueprint-types'
import { resolveAssignment, buildResolveOpts } from './model-config.service'

export type { BlueprintPipelineSnapshot } from '../../shared/blueprint-snapshot-types'

const bpLog = log.scope('blueprint')

// ── Phase-aware artifact relevance map ──
// Controls which artifact *types* each phase receives from prior phases.
// Eliminates the 146–214KB prompt bloat from blindly accumulating all artifacts.

/** @internal Exported for testing */
export const PHASE_ARTIFACT_RELEVANCE: Record<BlueprintPhaseType, Set<string>> = {
  specify: new Set(),                                              // first phase — no prior artifacts
  clarify: new Set(['spec']),                                      // needs spec to ask about
  plan:    new Set(['spec']),                                      // clarify merges resolutions into spec in-place (finalizeClarifyPhase)
  tasks:   new Set(['spec', 'plan']),                              // needs spec + plan to decompose
  review:  new Set(['spec', 'plan', 'tasks', 'discoveries']),      // cross-artifact analysis needs all three
  build:   new Set(['plan', 'tasks', 'discoveries']),              // + current wave's tasks (injected separately)
  verify:  new Set(['spec', 'plan', 'build', 'discoveries']),      // NOT full tasks JSON — uses build report
}

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
  // M2: Additional fields for snapshot sync
  phaseStartedAt: number | null
  pendingApproval: { planSummary: string; completion?: Record<string, unknown>; reviewMarkdown?: string } | null
  lastError: string | null
  waveState: {
    wave: number
    taskCount: number
    tasks: Record<string, BlueprintTaskStatus>
  } | null
}

// ── Service ──

export class BlueprintService extends EventEmitter {
  private pipelines = new Map<string, BlueprintPipelineState>()
  /** Per-workspace state machines — replaces startLocks for concurrency control. */
  private machines = new Map<string, BlueprintStateMachine>()
  /**
   * Tracks auto-retry attempts per blueprint+phase to prevent retry loops.
   * Key: `${blueprintId}:${phase}`. Cleared on success or cancellation.
   */
  private autoRetryAttempts = new Set<string>()

  // ── Pipeline State ──

  private getOrCreatePipeline(workspaceId: string): BlueprintPipelineState {
    let state = this.pipelines.get(workspaceId)
    if (!state) {
      state = {
        running: false,
        blueprintId: null,
        currentPhase: null,
        abortController: null,
        phaseStartedAt: null,
        pendingApproval: null,
        lastError: null,
        waveState: null
      }
      this.pipelines.set(workspaceId, state)
    }
    return state
  }

  /** Monotonic snapshot sequence number — incremented on every publishSnapshot(). */
  private snapshotSeq = 0

  /** Get or lazily create the state machine for a workspace. */
  getMachine(workspaceId: string): BlueprintStateMachine {
    let machine = this.machines.get(workspaceId)
    if (!machine) {
      machine = new BlueprintStateMachine(workspaceId)
      // M2: Auto-publish snapshot on every machine state change
      machine.on('stateChange', () => {
        this.publishSnapshot(workspaceId)
      })
      this.machines.set(workspaceId, machine)
    }
    return machine
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  M2: SNAPSHOT SYNC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Assemble the full pipeline snapshot for a workspace.
   * Queries sub-services for clarify/wave data. Cheap — no DB queries.
   */
  getSnapshot(workspaceId: string): BlueprintPipelineSnapshot {
    const state = this.pipelines.get(workspaceId)
    const machine = this.getMachine(workspaceId)

    // M9: Read clarify state from local map (pushed by spec service via setClarifyState)
    // — eliminates the require() hack that was fragile and broke module bundling.
    const clarifyState = this.getClarifyStateForSnapshot(workspaceId)
    const clarifyFindings: ClarifyFindingsBlock | null = clarifyState?.findings ?? null
    const clarifyQuestions: ClarifyQuestionsBlock | null = clarifyState?.questions ?? null

    return {
      seq: this.snapshotSeq,
      workspaceId,
      blueprintId: state?.blueprintId ?? null,
      running: state?.running ?? false,
      machineState: machine.currentState,
      currentPhase: state?.currentPhase ?? null,
      phaseStartedAt: state?.phaseStartedAt ?? null,
      clarifyFindings,
      clarifyQuestions,
      pendingApproval: state?.pendingApproval ?? null,
      wave: state?.waveState ?? null,
      lastError: state?.lastError ?? null
    }
  }

  /**
   * Publish the whole-state snapshot for a workspace.
   * Increments seq and emits 'stateSync' event (forwarded to renderer by IPC layer).
   */
  publishSnapshot(workspaceId: string): void {
    this.snapshotSeq++
    const snapshot = this.getSnapshot(workspaceId)
    try {
      this.emit('stateSync', snapshot)
    } catch (err) {
      bpLog.error('[publishSnapshot] Listener threw:', err)
    }
  }

  // ── Snapshot Field Setters (called by sub-services) ──

  /** Record when a phase started (for duration tracking). */
  setPhaseStartedAt(workspaceId: string, timestamp: number): void {
    const state = this.getOrCreatePipeline(workspaceId)
    state.phaseStartedAt = timestamp
  }

  /** Set pending approval state (from review service). */
  setPendingApproval(workspaceId: string, approval: { planSummary: string; completion?: Record<string, unknown>; reviewMarkdown?: string } | null): void {
    const state = this.getOrCreatePipeline(workspaceId)
    state.pendingApproval = approval
    this.publishSnapshot(workspaceId)
  }

  /** Set last error for snapshot (from phase failures). */
  setLastError(workspaceId: string, error: string | null): void {
    const state = this.getOrCreatePipeline(workspaceId)
    state.lastError = error
  }

  /** Update wave state (from build service). */
  updateWaveState(
    workspaceId: string,
    wave: { wave: number; taskCount: number; tasks: Record<string, BlueprintTaskStatus> } | null
  ): void {
    const state = this.getOrCreatePipeline(workspaceId)
    state.waveState = wave
    this.publishSnapshot(workspaceId)
  }

  // ── M9: Clarify state pushed by spec service (removes require() hack) ──

  private clarifyStateByWorkspace = new Map<string, {
    findings: ClarifyFindingsBlock | null
    questions: ClarifyQuestionsBlock | null
  }>()

  /** Push clarify UI state from spec service — snapshot reads this instead of require() hack. */
  setClarifyState(
    workspaceId: string,
    state: { findings: ClarifyFindingsBlock | null; questions: ClarifyQuestionsBlock | null } | null
  ): void {
    if (state) {
      this.clarifyStateByWorkspace.set(workspaceId, state)
    } else {
      this.clarifyStateByWorkspace.delete(workspaceId)
    }
  }

  /** Get clarify state for snapshot (avoids require() hack). */
  getClarifyStateForSnapshot(workspaceId: string): {
    findings: ClarifyFindingsBlock | null
    questions: ClarifyQuestionsBlock | null
  } | null {
    return this.clarifyStateByWorkspace.get(workspaceId) ?? null
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

  /** Mark a pipeline as running for a workspace. Called by phase services. */
  markPipelineRunning(workspaceId: string, blueprintId: string, phase: BlueprintPhaseType): void {
    const machine = this.getMachine(workspaceId)
    // BP-01: State machine guards against concurrent starts — startPhase is only
    // valid from idle. If the machine is in any other state, the transition fails.
    if (!machine.transition('startPhase', { blueprintId, phase })) {
      throw new Error(
        `Blueprint pipeline cannot start for workspace ${workspaceId} ` +
          `— machine in state '${machine.currentState}'`
      )
    }
    // Note: machine.transition() fires stateChange synchronously which publishes
    // a snapshot. At that point state.running is still false — the snapshot is
    // transiently incoherent. We mutate state below and publish a corrective
    // snapshot (higher seq) that overwrites the transient one.
    const state = this.getOrCreatePipeline(workspaceId)
    state.running = true
    state.blueprintId = blueprintId
    state.currentPhase = phase
    state.abortController = new AbortController()
    state.phaseStartedAt = Date.now()
    state.lastError = null
    // Corrective snapshot — overwrites the transient incoherent one from stateChange
    this.publishSnapshot(workspaceId)
  }

  /** Mark a pipeline as stopped for a workspace. Called by phase services. */
  markPipelineStopped(workspaceId: string): void {
    // COHERENT-SNAPSHOT-FIX: Mutate pipeline state BEFORE machine.transition()
    // so the snapshot published by the stateChange listener already sees
    // running=false. Previously state was mutated after, causing the snapshot
    // to broadcast {machineState:'idle', running:true} → permanent "Analyzing…".
    const state = this.pipelines.get(workspaceId)
    if (state) {
      state.running = false
      state.abortController = null
      state.phaseStartedAt = null
      state.waveState = null
    }
    const machine = this.getMachine(workspaceId)
    // phaseComplete is idempotent when idle — safe to call multiple times.
    machine.transition('phaseComplete')
  }

  /**
   * M5: Fail the pipeline — transitions machine to 'failed' state.
   * Unlike markPipelineStopped (which transitions to idle via phaseComplete),
   * this explicitly marks the pipeline as failed so the renderer shows error state.
   * Valid from ALL active states (phase-running, awaiting-*).
   * If the 'fail' transition is invalid (already idle/cancelled/failed), forces reset.
   */
  failPipeline(workspaceId: string, error: string): void {
    // COHERENT-SNAPSHOT-FIX: Mutate pipeline state BEFORE machine.transition()
    // so the snapshot published by stateChange already has running=false.
    const state = this.pipelines.get(workspaceId)
    if (state) {
      state.running = false
      state.abortController = null
      state.lastError = error
    }
    const machine = this.getMachine(workspaceId)
    if (!machine.transition('fail')) {
      // Machine is in a state where 'fail' isn't valid (idle, cancelled, failed).
      // Force reset to ensure consistency.
      if (!machine.isIdle() && !machine.isTerminal()) {
        machine.forceReset()
      }
    }
  }

  // ── Auto-Retry for Transient Failures ──

  /** Error patterns that indicate transient, retryable failures. */
  private static readonly RETRYABLE_PATTERNS = [
    /timeout/i,
    /stalled/i,
    /no activity for/i,
    /CLI failed to start/i,
    /ERR_STREAM_PREMATURE_CLOSE/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /EPIPE/i,
    /zero.?token/i,
    /spawn.*ENOENT/i
  ]

  /** Error patterns that should NOT be retried (deterministic failures). */
  private static readonly NON_RETRYABLE_PATTERNS = [
    /cancelled/i,
    /Phase cancelled/i,
    /max.?turns/i,
    /budget/i,
    /parse.*fail/i,
    /Cannot retry/i,
    /not found/i
  ]

  /** Classify an error message as retryable (transient) or not. */
  isRetryableError(error: string): boolean {
    if (BlueprintService.NON_RETRYABLE_PATTERNS.some((p) => p.test(error))) return false
    return BlueprintService.RETRYABLE_PATTERNS.some((p) => p.test(error))
  }

  /**
   * Schedule a single automatic retry for a transient phase failure.
   *
   * Returns `true` if a retry was scheduled (caller should include `autoRetry: true`
   * in the phaseComplete payload so the UI shows "retrying" instead of a hard failure).
   *
   * • Only one auto-retry per blueprint+phase — second failure surfaces to user.
   * • 5-second delay before retry to let cleanup complete.
   * • Emits `autoRetry` event for the IPC layer to dispatch the phase start.
   * • Emits `phaseProgress` with a system message for the UI.
   */
  scheduleAutoRetry(ctx: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
    phase: BlueprintPhaseType
    error: string
  }): boolean {
    if (!this.isRetryableError(ctx.error)) {
      bpLog.info(`[phase-auto-retry] Error not retryable: "${ctx.error.slice(0, 100)}"`)
      return false
    }

    const key = `${ctx.blueprintId}:${ctx.phase}`
    if (this.autoRetryAttempts.has(key)) {
      bpLog.info(`[phase-auto-retry] Already retried ${ctx.phase} for blueprint ${ctx.blueprintId} — surfacing to user`)
      return false
    }

    this.autoRetryAttempts.add(key)
    bpLog.info(
      `[phase-auto-retry] Scheduling auto-retry for ${ctx.phase} phase of blueprint ${ctx.blueprintId} in 5s`
    )

    // Emit system message so the user sees the retry notice
    this.emit('phaseProgress', {
      blueprintId: ctx.blueprintId,
      workspaceId: ctx.workspaceId,
      phase: ctx.phase,
      text: `Phase failed (${ctx.error.slice(0, 80)}) — retrying automatically…`,
      kind: 'system'
    })

    // Delay to let finally blocks (session.stop, markPipelineStopped) complete
    setTimeout(() => {
      try {
        this.retryPhase(ctx.blueprintId)
        this.emit('autoRetry', {
          blueprintId: ctx.blueprintId,
          workspaceId: ctx.workspaceId,
          workspacePath: ctx.workspacePath,
          phase: ctx.phase
        })
      } catch (err) {
        bpLog.error(`[phase-auto-retry] Failed to dispatch retry:`, err)
      }
    }, 5000)

    return true
  }

  /**
   * Clear auto-retry tracking for a blueprint (call on success or cancellation).
   */
  clearAutoRetryState(blueprintId: string): void {
    for (const key of this.autoRetryAttempts) {
      if (key.startsWith(`${blueprintId}:`)) {
        this.autoRetryAttempts.delete(key)
      }
    }
  }

  /**
   * M5: Watchdog invariant — asserts machine consistency for a workspace.
   * If machine is in a non-idle, non-terminal state AND no pipeline is running
   * AND no clarify session/gate/approval is pending → machine is stranded.
   * Called on-demand from getPipelineStatus (every renderer poll self-heals).
   */
  assertMachineConsistency(workspaceId: string): void {
    const machine = this.getMachine(workspaceId)
    if (machine.isIdle() || machine.isTerminal()) return

    const state = this.pipelines.get(workspaceId)
    if (state?.running) return // Active pipeline — expected

    // Check for valid awaiting states (clarify session, pending gate, or approval)
    if (state?.pendingApproval) return // Waiting for user approval

    // Check clarify session (lazy import to avoid circular deps)
    if (state?.blueprintId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { blueprintSpecService } = require('./blueprint-spec.service') as {
          blueprintSpecService: {
            hasClarifySession: (bpId: string) => boolean
            getPendingGate: (bpId: string) => unknown
          }
        }
        if (blueprintSpecService.hasClarifySession(state.blueprintId)) return
        if (blueprintSpecService.getPendingGate(state.blueprintId)) return
      } catch {
        // Spec service not initialized yet — can't check
      }
    }

    // Machine is stranded — no running pipeline, no valid awaiting reason.
    bpLog.warn(
      `[watchdog] Machine stranded in '${machine.currentState}' for workspace ${workspaceId} ` +
        `(blueprint=${state?.blueprintId}) — forcing reset`
    )
    machine.forceReset()
    if (state) {
      state.running = false
      state.abortController = null
    }
    // Snapshot auto-published by forceReset stateChange
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

    // Snapshot model configuration for all blueprint phases
    const resolveOpts = buildResolveOpts(params.workspaceId)

    const blueprintModelSnapshot = {
      specify: resolveAssignment({ action: 'blueprint:specify', ...resolveOpts }),
      clarify: resolveAssignment({ action: 'blueprint:clarify', ...resolveOpts }),
      plan: resolveAssignment({ action: 'blueprint:plan', ...resolveOpts }),
      tasks: resolveAssignment({ action: 'blueprint:tasks', ...resolveOpts }),
      review: resolveAssignment({ action: 'blueprint:review', ...resolveOpts }),
      build: resolveAssignment({ action: 'blueprint:build', ...resolveOpts }),
      verify: resolveAssignment({ action: 'blueprint:verify', ...resolveOpts }),
      snapshotAt: new Date().toISOString()
    }

    const mergedSettings = {
      ...(params.settingsJson ?? {}),
      modelSnapshot: blueprintModelSnapshot
    }

    const blueprint = blueprintRepository.create({
      workspaceId: params.workspaceId,
      title: params.title,
      description: params.description,
      priority: params.priority,
      sourceIdeaId: params.sourceIdeaId,
      constitutionSnapshot: constitutionSnapshot ?? undefined,
      settingsJson: mergedSettings
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
   * Cancel (stop) an active Blueprint pipeline.
   * Resets any in-flight 'active' phase rows to 'pending' so a subsequent
   * resume (retryPhase) can pick up where it left off.
   */
  cancel(workspaceId: string): void {
    const state = this.pipelines.get(workspaceId)
    // BP-CANCEL-WINDOW-SILENT-01: Check blueprintId presence (identity) rather
    // than running state (activity). During the BUILD→VERIFY transition window,
    // running=false but blueprintId is still set — the user's cancel must still
    // take effect and update the DB status so VERIFY aborts on startup.
    if (!state?.blueprintId) {
      bpLog.warn('[cancel] No active blueprint pipeline to cancel')
      return
    }

    // Drive the state machine — cancel is idempotent when idle.
    const machine = this.getMachine(workspaceId)
    machine.transition('cancel')

    if (state.abortController) {
      state.abortController.abort()
    }
    state.running = false

    // M9: Wrap phase resets + status update in a transaction for atomicity.
    // Without this, a crash between phase resets and status update leaves
    // inconsistent state (pending phases + non-cancelled status).
    const db = getDatabase()
    const bpId = state.blueprintId
    db.transaction(() => {
      const phases = blueprintPhaseRepository.findByBlueprint(bpId!)
      for (const phase of phases) {
        if (phase.status === 'active') {
          blueprintPhaseRepository.updateStatus(phase.id, 'pending')
        }
      }
      blueprintRepository.updateStatus(bpId!, 'cancelled')
    })()

    bpLog.info(`[cancel] Blueprint ${state.blueprintId} cancelled`)
    this.clearAutoRetryState(state.blueprintId!)
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

  /**
   * Retry/resume a failed or cancelled (stopped) blueprint.
   * Accepts blueprints with status 'failed' or 'cancelled'.
   * Phase resolution order:
   *   1. First 'failed' phase (classic retry)
   *   2. Phase matching blueprint.currentPhase (resume after stop)
   *   3. First 'pending' phase in pipeline order (fallback)
   *
   * Resets the target phase to 'pending' and restores blueprint status.
   */
  retryPhase(blueprintId: string): { phase: BlueprintPhaseType; workspaceId: string } {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) {
      throw new Error(`Blueprint not found: ${blueprintId}`)
    }

    // BP-ORPHAN-01: Accept in-progress statuses when the pipeline is NOT running.
    // This recovers blueprints that were orphaned by a crash or app restart while
    // a phase was still active (e.g. status='clarifying' but no running pipeline).
    const MID_PIPELINE_STATUSES = new Set([
      'specifying', 'clarifying', 'planning', 'tasking', 'reviewing', 'building', 'verifying'
    ])
    const isRetryable = blueprint.status === 'failed' || blueprint.status === 'cancelled'
    const isOrphaned = MID_PIPELINE_STATUSES.has(blueprint.status) && !this.isRunning(blueprint.workspaceId)

    // BP-COMPLETE-RETRY: Allow retrying 'complete' blueprints when verification
    // found gaps — user wants another build pass.
    const isCompletedWithGaps = blueprint.status === 'complete' && (() => {
      const verifyPhaseRec = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
      if (!verifyPhaseRec) return false
      const verifyArt = verifyPhaseRec.artifactsJson?.findLast(
        (a) => a.type === 'verify' || a.type === 'verification'
      )
      const overall = (verifyArt?.contentJson as Record<string, unknown>)?.overallStatus
      return overall === 'gaps_found' || overall === 'human_needed'
    })()

    if (!isRetryable && !isOrphaned && !isCompletedWithGaps) {
      if (MID_PIPELINE_STATUSES.has(blueprint.status) && this.isRunning(blueprint.workspaceId)) {
        throw new Error(
          `Cannot retry blueprint ${blueprintId} — pipeline is currently active for workspace ${blueprint.workspaceId}`
        )
      }
      throw new Error(
        `Cannot retry blueprint ${blueprintId} — status is '${blueprint.status}', expected 'failed', 'cancelled', or an orphaned in-progress status`
      )
    }

    const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)

    // Phase resolution: failed > currentPhase (if pending or active) > first pending
    // BP-ORPHAN-01: Include 'active' status — crash orphan rows with active status
    // are reset to pending and used for retry.
    let targetPhase =
      phases.find((p) => p.status === 'failed') ??
      phases.find((p) => p.phase === blueprint.currentPhase && (p.status === 'pending' || p.status === 'active')) ??
      phases.find((p) => p.status === 'pending')

    // BP-COMPLETE-RETRY: For completed blueprints with gaps, the verify phase
    // is 'complete' (not failed/pending) — resolve it explicitly.
    if (!targetPhase && isCompletedWithGaps) {
      targetPhase = phases.find((p) => p.phase === 'verify')
    }

    if (!targetPhase) {
      throw new Error(`No retryable phase found for blueprint ${blueprintId}`)
    }

    // BP-GAPS-RETRY: When retrying a failed/complete verify phase with gaps_found,
    // target the build phase instead — re-verifying unfixed code is useless.
    if (targetPhase.phase === 'verify') {
      const verifyArtifact = targetPhase.artifactsJson?.findLast(
        (a) => a.type === 'verify' || a.type === 'verification'
      )
      const overallStatus = (verifyArtifact?.contentJson as Record<string, unknown>)?.overallStatus
      if (overallStatus === 'gaps_found') {
        // Check if remediation tasks exist (appended by verify service or fallback)
        const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)
        const hasRemediationTasks = tasks.some((t) => t.taskId.startsWith('R') && t.status !== 'complete')
        if (hasRemediationTasks) {
          bpLog.info(
            `[retryPhase] gaps_found with pending remediation tasks — targeting build instead of verify`
          )
          // Reset verify to pending (it will re-run after build completes)
          blueprintPhaseRepository.updateStatus(targetPhase.id, 'pending')
          // Find build phase and target it
          const buildPhaseRecord = phases.find((p) => p.phase === 'build')
          if (buildPhaseRecord) {
            targetPhase = buildPhaseRecord
          }
        }
      }
    }

    // Reset the target phase to pending (clears timestamps)
    if (targetPhase.status !== 'pending') {
      blueprintPhaseRepository.updateStatus(targetPhase.id, 'pending')
    }

    // BP-RETRY-TASKS-01: When retrying the build phase, reset non-complete
    // tasks to 'pending' so executeWave re-runs only what needs work.
    // Complete tasks are left untouched — they'll be skipped by BP-RESUME-01.
    if (targetPhase.phase === 'build') {
      const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)
      let resetCount = 0
      for (const task of tasks) {
        if (task.status === 'failed' || task.status === 'skipped' || task.status === 'running') {
          blueprintTaskRepository.updateStatus(task.id, 'pending')
          resetCount++
        }
      }
      if (resetCount > 0) {
        bpLog.info(`[retryPhase] Reset ${resetCount} non-complete task(s) to pending for build retry`)
      }
    }

    // Restore blueprint status to the phase-appropriate value
    blueprintRepository.update(blueprintId, {
      currentPhase: targetPhase.phase,
      status: PHASE_TO_STATUS[targetPhase.phase]
    })

    // Drive the state machine: retry transitions cancelled/failed → idle,
    // making the machine ready for the next startPhase call.
    const machine = this.getMachine(blueprint.workspaceId)
    if (machine.isTerminal()) {
      machine.transition('retry')
    } else if (!machine.isIdle()) {
      // Orphan recovery — machine may be stuck in a non-terminal state after crash.
      machine.forceReset()
    }

    bpLog.info(
      `[retryPhase] Blueprint ${blueprintId} → retrying ${targetPhase.phase} phase (was ${blueprint.status})`
    )

    return { phase: targetPhase.phase, workspaceId: blueprint.workspaceId }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CONTEXT ASSEMBLY — Feeds into Prompt Injection
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Assemble the full context needed for a phase's system prompt.
   * Collects blueprint metadata, constitution, and phase-relevant artifacts from prior phases.
   *
   * Uses PHASE_ARTIFACT_RELEVANCE to inject only the artifact types each phase needs,
   * instead of blindly accumulating all prior artifacts (which caused 146–214KB prompts).
   */
  assemblePhaseContext(blueprintId: string, phase: BlueprintPhaseType): PhaseContext {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) {
      throw new Error(`Blueprint not found: ${blueprintId}`)
    }

    const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)

    // Collect only phase-relevant artifacts from prior phases
    const currentIdx = BLUEPRINT_PHASE_ORDER.indexOf(phase)
    const relevantTypes = PHASE_ARTIFACT_RELEVANCE[phase]
    const previousArtifacts: BlueprintArtifact[] = []
    for (const p of phases) {
      const pIdx = BLUEPRINT_PHASE_ORDER.indexOf(p.phase)
      if (pIdx < currentIdx && p.artifactsJson.length > 0) {
        for (const artifact of p.artifactsJson) {
          if (relevantTypes.has(artifact.type)) {
            previousArtifacts.push(artifact)
          }
        }
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
   * Append remediation tasks to an existing blueprint without deleting existing tasks.
   * Assigns waves starting at maxExistingWave + 1.
   * Validates R-prefixed taskIds don't collide with existing tasks.
   */
  appendTasks(
    blueprintId: string,
    parsedTasks: Array<{
      taskId: string
      description: string
      files?: string[]
      dependsOn?: string[]
    }>
  ): BlueprintTask[] {
    if (parsedTasks.length === 0) return []

    // Validate no taskId collision with existing tasks
    const existingTasks = blueprintTaskRepository.findByBlueprint(blueprintId)
    const existingIds = new Set(existingTasks.map((t) => t.taskId))
    const collisions = parsedTasks.filter((t) => existingIds.has(t.taskId))
    if (collisions.length > 0) {
      throw new Error(
        `Remediation taskId collision: ${collisions.map((t) => t.taskId).join(', ')} already exist`
      )
    }

    // Determine next wave number
    const maxWave = blueprintTaskRepository.getWaveCount(blueprintId)
    const nextWave = maxWave + 1

    bpLog.info(
      `[appendTasks] Appending ${parsedTasks.length} remediation tasks as wave ${nextWave} for blueprint ${blueprintId}`
    )

    return blueprintTaskRepository.createBulk(
      blueprintId,
      parsedTasks.map((t) => ({
        taskId: t.taskId,
        wave: nextWave,
        description: t.description,
        filePathsJson: t.files,
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
    // M5: Watchdog — self-heal on every renderer poll
    this.assertMachineConsistency(workspaceId)

    const state = this.pipelines.get(workspaceId)
    return {
      running: state?.running ?? false,
      blueprintId: state?.blueprintId ?? null,
      currentPhase: state?.currentPhase ?? null
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ORPHAN DETECTION (crash recovery)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * BP-RESUME-02: Find a blueprint orphaned by crash/quit for a given workspace.
   * Returns the most recent blueprint whose status is mid-pipeline AND the
   * in-memory pipeline is not running. Returns null when no orphan exists.
   */
  findOrphanedBlueprint(workspaceId: string): {
    blueprintId: string
    title: string
    currentPhase: string
    tasksCompleted: number
    totalTasks: number
  } | null {
    if (this.isRunning(workspaceId)) return null

    const MID_PIPELINE_STATUSES = new Set([
      'specifying', 'clarifying', 'planning', 'tasking', 'reviewing', 'building', 'verifying'
    ])

    // Find the most recent blueprint for this workspace
    const blueprints = blueprintRepository.findByWorkspace(workspaceId, 1)
    const latest = blueprints[0]
    if (!latest || !MID_PIPELINE_STATUSES.has(latest.status)) return null

    // Count completed vs total tasks for progress display
    const tasks = blueprintTaskRepository.findByBlueprint(latest.id)
    const tasksCompleted = tasks.filter((t) => t.status === 'complete').length

    return {
      blueprintId: latest.id,
      title: latest.title,
      currentPhase: latest.currentPhase ?? latest.status,
      tasksCompleted,
      totalTasks: tasks.length
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
    // Force-reset all machines so they don't hold stale state across restarts.
    for (const [, machine] of this.machines) {
      if (!machine.isIdle()) {
        machine.forceReset()
      }
    }
    this.pipelines.clear()
    this.machines.clear()
    this.clarifyStateByWorkspace.clear()
  }
}

// ── Singleton Export ──

export const blueprintService = new BlueprintService()
