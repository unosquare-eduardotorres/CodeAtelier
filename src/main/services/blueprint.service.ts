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
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
import { buildWorkspaceDocsBlock } from './blueprint-document-loader'
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
  GrillDecisionForBlueprint,
  BlueprintRevisionRequest
} from '../../shared/blueprint-types'
import { BLUEPRINT_PHASE_ORDER, PHASE_TO_STATUS } from '../../shared/blueprint-types'
import { BlueprintStateMachine } from './blueprint-state-machine'
import type { BlueprintPipelineSnapshot } from '../../shared/blueprint-snapshot-types'
import type {
  ClarifyFindingsBlock,
  ClarifyQuestionsBlock
} from '../../shared/blueprint-clarify-parsers'
import type { BlueprintTaskStatus } from '../../shared/blueprint-types'
import {
  modelConfigService,
  resolveAssignment,
  buildResolveOpts
} from './model-config.service'

export type { BlueprintPipelineSnapshot } from '../../shared/blueprint-snapshot-types'

const bpLog = log.scope('blueprint')

/** Per-request cap. Long enough for a real paragraph, short enough to stay quotable. */
const MAX_REVISION_FEEDBACK_CHARS = 2000
/** Ledger cap — a negotiation this long has a bigger problem than prompt size. */
const MAX_REVISION_REQUESTS = 20

// ── Phase-aware artifact relevance map ──
// Controls which artifact *types* each phase receives from prior phases.
// Eliminates the 146–214KB prompt bloat from blindly accumulating all artifacts.

/** @internal Exported for testing */
export const PHASE_ARTIFACT_RELEVANCE: Record<BlueprintPhaseType, Set<string>> = {
  specify: new Set(), // first phase — no prior artifacts
  clarify: new Set(['spec']), // needs spec to ask about
  plan: new Set(['spec']), // clarify merges resolutions into spec in-place (finalizeClarifyPhase)
  tasks: new Set(['spec', 'plan']), // needs spec + plan to decompose
  review: new Set(['spec', 'plan', 'tasks', 'discoveries']), // cross-artifact analysis needs all three
  build: new Set(['plan', 'tasks', 'discoveries']), // + current wave's tasks (injected separately)
  // Adversarial reviewer reads intent (spec/plan) and what BUILD claims it did;
  // the diff itself is injected separately by the adapter, not as an artifact.
  'code-review': new Set(['spec', 'plan', 'build']),
  verify: new Set(['spec', 'plan', 'build', 'discoveries']) // NOT full tasks JSON — uses build report
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

/**
 * The approval gate, as held in memory and published on the snapshot.
 *
 * `blueprintId` lives here rather than being read off the snapshot's own
 * `blueprintId`, which markPipelineStopped() nulls while the gate is still up.
 */
export type PendingApproval = NonNullable<BlueprintPipelineSnapshot['pendingApproval']>

interface BlueprintPipelineState {
  running: boolean
  blueprintId: string | null
  currentPhase: BlueprintPhaseType | null
  abortController: AbortController | null
  // M2: Additional fields for snapshot sync
  phaseStartedAt: number | null
  pendingApproval: PendingApproval | null
  lastError: string | null
  waveState: {
    wave: number
    taskCount: number
    tasks: Record<string, BlueprintTaskStatus>
  } | null
  /** G3: Currently running tasks during Build phase parallel execution. */
  runningTasks: Record<string, { taskId: string; description: string }> | null
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
        waveState: null,
        runningTasks: null
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
      runningTasks: state?.runningTasks ?? null,
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
  setPendingApproval(workspaceId: string, approval: PendingApproval | null): void {
    const state = this.getOrCreatePipeline(workspaceId)
    state.pendingApproval = approval
    this.publishSnapshot(workspaceId)
  }

  /** Get pending approval state (for preflight re-run updates). */
  getPendingApproval(workspaceId: string): PendingApproval | null {
    const state = this.getOrCreatePipeline(workspaceId)
    return state.pendingApproval
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

  /** G3: Update running tasks map (from build service parallel scheduler). */
  setRunningTasks(
    workspaceId: string,
    tasks: Record<string, { taskId: string; description: string }> | null
  ): void {
    const state = this.getOrCreatePipeline(workspaceId)
    state.runningTasks = tasks
    this.publishSnapshot(workspaceId)
  }

  // ── M9: Clarify state pushed by spec service (removes require() hack) ──

  private clarifyStateByWorkspace = new Map<
    string,
    {
      findings: ClarifyFindingsBlock | null
      questions: ClarifyQuestionsBlock | null
    }
  >()

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

    // Auto-recover from terminal states when starting a NEW blueprint.
    // A previous blueprint's failed/cancelled state should not block a fresh run.
    if (machine.isTerminal() && machine.blueprintId !== blueprintId) {
      bpLog.info(
        `[markPipelineRunning] Auto-resetting terminal machine (state=${machine.currentState}, ` +
          `old=${machine.blueprintId}) for new blueprint ${blueprintId}`
      )
      machine.forceReset()
    }

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
      state.blueprintId = null // Clear stale identity
      state.currentPhase = null // Clear stale phase
      state.abortController = null
      state.phaseStartedAt = null
      state.waveState = null
      state.runningTasks = null
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
    /spawn.*ENOENT/i,
    // Anthropic transient API errors — the whole point of an auto-retry.
    /rate.?limit/i,
    /overloaded/i
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
      bpLog.info(
        `[phase-auto-retry] Already retried ${ctx.phase} for blueprint ${ctx.blueprintId} — surfacing to user`
      )
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
        // Guard: if the pipeline is now running (user started another blueprint),
        // skip the auto-retry — don't interrupt the active pipeline.
        if (this.isRunning(ctx.workspaceId)) {
          bpLog.info(
            `[phase-auto-retry] Pipeline now running for workspace ${ctx.workspaceId} ` +
              `— skipping scheduled retry for blueprint ${ctx.blueprintId}`
          )
          return
        }
        this.retryPhase(ctx.blueprintId, { resetRemediation: false })
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
        // KNOWN BROKEN IN PACKAGED BUILDS — this relative require() is kept
        // verbatim by electron-vite and throws MODULE_NOT_FOUND at runtime, so
        // the clarify-session check below always falls through to the catch and
        // the stranded-pipeline warning can fire spuriously. Genuine cycle
        // (blueprint-spec.service imports blueprint.service), so the fix is the
        // M9 setter-injection pattern, not a static import. Tracked separately.
        // eslint-disable-next-line @typescript-eslint/no-require-imports, no-restricted-syntax
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
          // BP-CANCEL-CONTEXT-CLEAR: Clear retry context when cancelling to prevent
          // stale metadata from leaking into future retry attempts.
          if (phase.contextSnapshot) {
            blueprintPhaseRepository.saveContextSnapshot(phase.id, null)
          }
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
   *
   * R1.3 — interim code-review skip guard: `code-review` is an optional quality
   * layer (OFF until a model is bound to `blueprint:code-review`). Advancing
   * into it with the role disabled would strand the blueprint in a phase that
   * has no runner. Instead the phase record is marked `skipped` and the advance
   * continues to the next phase — a loop, so it also holds when the disabled
   * phase is followed by another optional phase. Subsumed by the dedicated
   * code-review phase service (M7) when that lands.
   */
  advancePhase(blueprintId: string): BlueprintPhase | null {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) {
      throw new Error(`Blueprint not found: ${blueprintId}`)
    }

    const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)
    const currentIdx = BLUEPRINT_PHASE_ORDER.indexOf(blueprint.currentPhase)
    let nextIdx = currentIdx + 1

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
      // BP-RETRY-CONTEXT-CLEAR: Clear retry context on successful completion to prevent
      // stale data from leaking into future retries (e.g., remediation cycle retries).
      if (currentPhaseRecord.contextSnapshot) {
        blueprintPhaseRepository.saveContextSnapshot(currentPhaseRecord.id, null)
      }
    }

    // R1.3: settle optional phases whose role is disabled — their records are
    // marked `skipped` so the phase journey shows the layer was deliberately
    // off — then advance past any that were settled. Scoped to advances that
    // actually reach the code-review boundary (same as the original inline
    // loop): unrelated advances must not consult role config. Subsumed by the
    // dedicated code-review phase service (M7) when that lands.
    if (BLUEPRINT_PHASE_ORDER[nextIdx] === 'code-review') {
      this.settleOptionalPhases(blueprintId)
      const workspacePath = workspaceRepository.findById(blueprint.workspaceId)?.repoPath
      if (!modelConfigService.isRoleEnabled(workspacePath, 'blueprint:code-review')) {
        while (
          nextIdx < BLUEPRINT_PHASE_ORDER.length &&
          BLUEPRINT_PHASE_ORDER[nextIdx] === 'code-review'
        ) {
          nextIdx++
        }
      }
    }

    if (nextIdx >= BLUEPRINT_PHASE_ORDER.length) {
      // Every remaining phase was optional and disabled — the run is complete.
      blueprintRepository.updateStatus(blueprintId, 'complete')
      bpLog.info(
        `[advancePhase] Blueprint ${blueprintId} — all remaining phases skipped/complete`
      )
      return null
    }

    // Activate next phase
    const nextPhaseName = BLUEPRINT_PHASE_ORDER[nextIdx]
    // Blueprints created before a phase existed have no row for it. Backfill
    // rather than throw: the alternative strands every in-flight blueprint at
    // the phase boundary with an unrecoverable "Phase record not found".
    const nextPhaseRecord =
      phases.find((p) => p.phase === nextPhaseName) ??
      blueprintPhaseRepository.create({ blueprintId, phase: nextPhaseName })

    blueprintPhaseRepository.updateStatus(nextPhaseRecord.id, 'active')
    blueprintRepository.update(blueprintId, {
      currentPhase: nextPhaseName,
      status: PHASE_TO_STATUS[nextPhaseName]
    })

    bpLog.info(`[advancePhase] Blueprint ${blueprintId} → ${nextPhaseName}`)
    return blueprintPhaseRepository.findById(nextPhaseRecord.id) ?? null
  }

  /**
   * R1.3 — settle optional phases whose role is disabled.
   *
   * `code-review` is an optional quality layer (OFF until a model is bound to
   * `blueprint:code-review`). Any of its phase records still `pending` are
   * marked `skipped` so the phase journey shows the layer was deliberately
   * off — no runner exists for them. No-op when the role is enabled, when the
   * record is missing, or when the record is already settled (`complete`,
   * `failed`, `skipped`) — an `active` record is left alone so a running phase
   * is never silently cancelled underneath its owner.
   *
   * Called from `advancePhase` (phase boundaries), from the build service's
   * `finalizeSuccess` (the build→verify boundary bypasses `advancePhase`, so
   * without this the code-review record dangles `pending` forever), and from
   * `retryPhase` (skip-and-advance when resolution lands on the dead layer).
   */
  settleOptionalPhases(blueprintId: string): void {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) return

    const workspacePath = workspaceRepository.findById(blueprint.workspaceId)?.repoPath
    if (modelConfigService.isRoleEnabled(workspacePath, 'blueprint:code-review')) return

    const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)
    for (const candidate of phases) {
      if (candidate.phase !== 'code-review') continue
      if (candidate.status !== 'pending') continue
      blueprintPhaseRepository.updateStatus(candidate.id, 'skipped')
      bpLog.info(
        `[settleOptionalPhases] Blueprint ${blueprintId} — code-review role disabled, phase record marked skipped`
      )
    }

    // Blueprints created before the phase existed have no row for it. Backfill
    // with a `skipped` record so the phase journey still shows the layer was off
    // (same backfill advancePhase performed inline before the extraction).
    if (!phases.some((p) => p.phase === 'code-review')) {
      const created = blueprintPhaseRepository.create({ blueprintId, phase: 'code-review' })
      blueprintPhaseRepository.updateStatus(created.id, 'skipped')
      bpLog.info(
        `[settleOptionalPhases] Blueprint ${blueprintId} — backfilled missing code-review record as skipped`
      )
    }
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
   * BP-TASK-USER-SKIP-01: Mark a single build task as deliberately skipped by
   * the user (or clear that mark).
   *
   * Some tasks cannot be made to pass — their planned files live outside any
   * tree BUILD may read, so no retry changes the outcome. `status = 'skipped'`
   * is not an escape hatch: retryPhase resets it to 'pending' and the failure
   * cascade writes it on its own. This records the human decision separately,
   * where neither can touch it.
   *
   * Reversible — `skipped: false` clears it.
   *
   * The same lane closes out a *failed* task the human has verified externally.
   * That is deliberate: `skipped + skipped_by_user_at` is sticky across retries,
   * carries no file claims for VERIFY to demand, and needs no new `status` value
   * (which would cost a table rebuild). `outcomeKind = 'accepted_by_user'` is
   * what lets the UI tell "I checked this, it's done" apart from "never ran".
   */
  setTaskUserSkipped(
    blueprintId: string,
    taskId: string,
    skipped: boolean,
    note?: string | null
  ): BlueprintTask {
    const task = blueprintTaskRepository
      .findByBlueprint(blueprintId)
      .find((t) => t.taskId === taskId)
    if (!task) {
      throw new Error(`Task ${taskId} not found for blueprint ${blueprintId}`)
    }

    const updated = blueprintTaskRepository.setUserSkipped(task.id, skipped, note)
    if (!updated) {
      throw new Error(`Failed to ${skipped ? 'skip' : 'unskip'} task ${taskId}`)
    }

    // Closing out a failed task is an acceptance, not a skip — record which.
    let final = updated
    if (skipped && task.status === 'failed') {
      final =
        blueprintTaskRepository.setOutcome(task.id, { outcomeKind: 'accepted_by_user' }) ?? final
    } else if (!skipped && task.outcomeKind === 'accepted_by_user') {
      final = blueprintTaskRepository.setOutcome(task.id, { outcomeKind: null }) ?? final
    }

    bpLog.info(
      `[setTaskUserSkipped] Blueprint ${blueprintId} — task ${taskId} ${skipped ? 'skipped by user' : 'un-skipped'}`
    )
    return final
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
        // BP-REWIND-CONTEXT-CLEAR: Clear stale retry context when rewinding
        // to prevent outdated failure metadata from polluting the re-run.
        if (phase.contextSnapshot) {
          blueprintPhaseRepository.saveContextSnapshot(phase.id, null)
        }
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
  retryPhase(
    blueprintId: string,
    opts?: { resetRemediation?: boolean }
  ): { phase: BlueprintPhaseType; workspaceId: string } {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) {
      throw new Error(`Blueprint not found: ${blueprintId}`)
    }

    // BP-ORPHAN-01: Accept in-progress statuses when the pipeline is NOT running.
    // This recovers blueprints that were orphaned by a crash or app restart while
    // a phase was still active (e.g. status='clarifying' but no running pipeline).
    const MID_PIPELINE_STATUSES = new Set([
      'specifying',
      'clarifying',
      'planning',
      'tasking',
      'reviewing',
      'building',
      'codeReviewing',
      'verifying'
    ])
    const isRetryable = blueprint.status === 'failed' || blueprint.status === 'cancelled'
    const isOrphaned =
      MID_PIPELINE_STATUSES.has(blueprint.status) && !this.isRunning(blueprint.workspaceId)

    // BP-COMPLETE-RETRY: Allow retrying 'complete' blueprints when verification
    // found gaps — user wants another build pass.
    const isCompletedWithGaps =
      blueprint.status === 'complete' &&
      (() => {
        const verifyPhaseRec = blueprintPhaseRepository.findByBlueprintAndPhase(
          blueprintId,
          'verify'
        )
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

    // BP-RETRY-PIPELINE-EARLY-GUARD: Check pipeline availability BEFORE any DB
    // mutations. Without this, the state machine guard at line 890 can throw
    // AFTER tasks, status, and remediationRound have already been modified,
    // orphaning the blueprint in a partially-reset state.
    if (this.isRunning(blueprint.workspaceId)) {
      throw new Error(
        `Cannot retry blueprint ${blueprintId} — pipeline is currently active for workspace ${blueprint.workspaceId}`
      )
    }

    const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)

    // Phase resolution: failed > currentPhase (if pending or active) > first pending
    // BP-ORPHAN-01: Include 'active' status — crash orphan rows with active status
    // are reset to pending and used for retry.
    let targetPhase =
      phases.find((p) => p.status === 'failed') ??
      phases.find(
        (p) =>
          p.phase === blueprint.currentPhase && (p.status === 'pending' || p.status === 'active')
      ) ??
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
        const hasRemediationTasks = tasks.some(
          (t) => t.taskId.startsWith('R') && t.status !== 'complete'
        )
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
        // else: all R-tasks complete — keep them for UI history.
        // BP-COLLISION-SAFE-RENUMBER in blueprint-verify.service.ts
        // auto-renumbers new R-task IDs to avoid collisions.
      }
    }

    // R1.3 re-wire: the optional code-review layer has no runner while its
    // role is disabled. If resolution lands on it, settle (skip) the record
    // and re-resolve so callers dispatch a phase that can actually run —
    // closing the silent "Unknown phase: code-review" retry failure.
    if (targetPhase.phase === 'code-review') {
      const workspacePath = workspaceRepository.findById(blueprint.workspaceId)?.repoPath
      if (!modelConfigService.isRoleEnabled(workspacePath, 'blueprint:code-review')) {
        this.settleOptionalPhases(blueprintId)
        const phasesAfterSettle = blueprintPhaseRepository.findByBlueprint(blueprintId)
        const nextPending = phasesAfterSettle.find(
          (p) => p.status === 'pending' && p.phase !== 'code-review'
        )
        if (!nextPending) {
          throw new Error(`No retryable phase found for blueprint ${blueprintId}`)
        }
        bpLog.info(
          `[retryPhase] Blueprint ${blueprintId} — code-review role disabled, skipping to ${nextPending.phase}`
        )
        targetPhase = nextPending
      }
    }

    // BP-RETRY-PARTIAL-CLEANUP: Keep only the most recent partial artifact
    // from the failed attempt. Without this, repeated retries would accumulate
    // stale partials and bloat the system prompt.
    // NOTE: Cleanup happens BEFORE status reset — we need the phase record in its
    // current state, and a fresh DB read guards against stale in-memory objects.
    const freshPhaseForCleanup = blueprintPhaseRepository.findByBlueprintAndPhase(
      blueprintId,
      targetPhase.phase
    )
    if (freshPhaseForCleanup && freshPhaseForCleanup.artifactsJson.length > 0) {
      const partials = freshPhaseForCleanup.artifactsJson.filter((a) => a.type.endsWith('-partial'))
      if (partials.length > 1) {
        const nonPartials = freshPhaseForCleanup.artifactsJson.filter(
          (a) => !a.type.endsWith('-partial')
        )
        const latestPartial = partials[partials.length - 1]
        blueprintPhaseRepository.saveArtifacts(freshPhaseForCleanup.id, [
          ...nonPartials,
          latestPartial
        ])
        bpLog.info(
          `[retryPhase] Cleaned ${partials.length - 1} stale partial artifact(s) for ${targetPhase.phase} phase`
        )
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
          // BP-TASK-USER-SKIP-01: a human decided this task is not worth
          // retrying — a retry does not overrule that. Read fresh: the decision
          // may have been made after `tasks` was loaded.
          const fresh = blueprintTaskRepository.findById(task.id)
          if (fresh?.skippedByUserAt) continue
          blueprintTaskRepository.updateStatus(task.id, 'pending')
          // R2.3 — silent-degradation fix: `resetForRetry` existed but was never
          // called on this path, so a retried task carried its previous gate
          // report and escalation flag into the new attempt. Clear them: the
          // new attempt's gates will repopulate both. `attempts` stays
          // monotonic on purpose — the UI shows max(attempts, 1) for ran tasks.
          blueprintTaskRepository.resetForRetry(task.id)
          resetCount++
        }
      }
      if (resetCount > 0) {
        bpLog.info(
          `[retryPhase] Reset ${resetCount} non-complete task(s) to pending for build retry`
        )
      }
    }

    // Restore blueprint status to the phase-appropriate value
    blueprintRepository.update(blueprintId, {
      currentPhase: targetPhase.phase,
      status: PHASE_TO_STATUS[targetPhase.phase]
    })

    // BP-RETRY-RESET-REMEDIATION: Reset remediationRound when manually retrying
    // so remediation can trigger again if verify finds new gaps.
    // Skip reset during auto-retry — preserves the round counter so the 2-round
    // cap is enforced across transient failures (BUG-N).
    if (
      opts?.resetRemediation !== false &&
      (targetPhase.phase === 'build' || targetPhase.phase === 'verify')
    ) {
      const settings = blueprint.settingsJson ?? {}
      if ((settings as Record<string, unknown>).remediationRound != null) {
        blueprintRepository.update(blueprintId, {
          settingsJson: { ...settings, remediationRound: 0 }
        })
        bpLog.info(`[retryPhase] Reset remediationRound to 0 for blueprint ${blueprintId}`)
      }
    }

    // Drive the state machine: retry transitions cancelled/failed → idle,
    // making the machine ready for the next startPhase call.
    const machine = this.getMachine(blueprint.workspaceId)
    if (machine.isTerminal()) {
      machine.transition('retry')
    } else if (!machine.isIdle()) {
      // Guard: if machine is phase-running, a pipeline IS actively executing.
      // Don't force-reset it — that would kill the running blueprint.
      if (machine.isRunning()) {
        throw new Error(
          `Cannot retry blueprint ${blueprintId} — pipeline is currently active ` +
            `for workspace ${blueprint.workspaceId} (machine=${machine.currentState})`
        )
      }
      // Orphan recovery — machine may be stuck in a non-terminal, non-running
      // state after crash (e.g. awaiting-clarify-input with no active session).
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
  async assemblePhaseContext(
    blueprintId: string,
    phase: BlueprintPhaseType,
    workspacePath?: string
  ): Promise<PhaseContext> {
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

    // BP-RETRY-PARTIAL-01: On retry, include the current phase's own partial artifacts.
    // Partial artifacts (e.g., 'build-partial', 'plan-partial') are saved by the catch
    // block on failure. They contain the agent's streamed output from the prior attempt.
    // Feeding them back avoids a total context reset on retry.
    const MAX_PARTIAL_CHARS = 8000
    const currentPhaseRecord = phases.find((p) => p.phase === phase)
    if (currentPhaseRecord && currentPhaseRecord.artifactsJson.length > 0) {
      for (const artifact of currentPhaseRecord.artifactsJson) {
        if (artifact.type.endsWith('-partial')) {
          if (artifact.contentMd && artifact.contentMd.length > MAX_PARTIAL_CHARS) {
            previousArtifacts.push({
              ...artifact,
              contentMd:
                artifact.contentMd.slice(0, MAX_PARTIAL_CHARS) +
                '\n\n…[truncated — prior attempt output exceeded 8K chars]'
            })
          } else {
            previousArtifacts.push(artifact)
          }
        }
      }
    }

    // Extract grill decisions from settings if available (with runtime validation)
    const grillDecisions = parseGrillDecisions(blueprint.settingsJson?.grillDecisions)

    // Pre-read workspace docs (CLAUDE.md, README.md, package.json, PLAN.md) if workspace path provided
    let workspaceDocs: string | undefined
    if (workspacePath) {
      workspaceDocs = await buildWorkspaceDocsBlock(workspacePath)
    }

    // BP-RETRY-CONTEXT-01: Read structured retry context from context_snapshot.
    // Populated by saveRetryContext() on phase failure, read back here on retry.
    let retryContext: PhaseContext['retryContext'] | undefined
    if (currentPhaseRecord?.contextSnapshot) {
      const parsed = safeParseJSON<Record<string, unknown>>(currentPhaseRecord.contextSnapshot, {})
      if (typeof parsed.attempt === 'number' && parsed.attempt > 0) {
        retryContext = {
          attempt: parsed.attempt + 1,
          previousError: String(parsed.previousError ?? 'Unknown error'),
          previousPhase: phase,
          filesModified: Array.isArray(parsed.filesModified)
            ? (parsed.filesModified as string[])
            : [],
          filesCreated: Array.isArray(parsed.filesCreated) ? (parsed.filesCreated as string[]) : [],
          tasksCompleted: typeof parsed.tasksCompleted === 'number' ? parsed.tasksCompleted : 0,
          totalTasks: typeof parsed.totalTasks === 'number' ? parsed.totalTasks : 0
        }
      }
    }

    // Write prior artifacts to disk so agents can Read them if truncated from context
    if (workspacePath && previousArtifacts.length > 0) {
      const artifactDir = resolve(
        workspacePath,
        `blueprints/${blueprint.shortName || blueprint.id}`
      )
      try {
        mkdirSync(artifactDir, { recursive: true })
        // Paths are keyed by artifact type, so two artifacts of the same type
        // would write to the same file: the second overwrites the first, and
        // the first's filePath then points at content that is not its own.
        // Number the OLDER ones and leave the canonical <type>.md to the newest —
        // review-phase.md tells the agent to Read exactly spec.md / plan.md /
        // tasks.md, so the current artifact has to own the unsuffixed path.
        // Three plans give plan-1.md, plan-2.md, plan.md.
        const writable = previousArtifacts.filter(
          (a) => !a.type.endsWith('-partial') && a.type !== 'discoveries'
        )
        const totalByType = new Map<string, number>()
        for (const a of writable) totalByType.set(a.type, (totalByType.get(a.type) ?? 0) + 1)

        const seenByType = new Map<string, number>()
        for (const a of writable) {
          const nth = (seenByType.get(a.type) ?? 0) + 1
          seenByType.set(a.type, nth)
          const suffix = nth === totalByType.get(a.type) ? '' : `-${nth}`
          const relativePath = `blueprints/${blueprint.shortName || blueprint.id}/${a.type}${suffix}.md`
          const absPath = resolve(workspacePath, relativePath)
          const content =
            a.contentMd ??
            (a.contentJson ? '```json\n' + JSON.stringify(a.contentJson, null, 2) + '\n```' : null)
          if (content) {
            writeFileSync(absPath, content, 'utf-8')
            a.filePath = relativePath // set for renderSingleArtifact() to display
          }
        }
      } catch (err) {
        bpLog.warn('[assemblePhaseContext] Failed to write artifacts to disk:', err)
      }
    }

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
      grillDecisions,
      workspaceDocs,
      retryContext,
      revisionRequests: this.getRevisionRequests(blueprintId)
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  REVISION LEDGER — what the human asked to change, and whether it stuck
  // ══════════════════════════════════════════════════════════════════════

  /** Every change request on this blueprint, oldest first. */
  getRevisionRequests(blueprintId: string): BlueprintRevisionRequest[] {
    const blueprint = blueprintRepository.findById(blueprintId)
    const raw = blueprint?.settingsJson?.revisionRequests
    if (!Array.isArray(raw)) return []
    // Runtime-validated: settingsJson is a free-form bag and this feeds a prompt.
    return raw.filter(
      (r): r is BlueprintRevisionRequest =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as BlueprintRevisionRequest).feedback === 'string' &&
        (r as BlueprintRevisionRequest).feedback.length > 0
    )
  }

  /**
   * Record a human change request. Returns the stored entry.
   *
   * Appended rather than replaced: the agent must see round 1 when acting on
   * round 3, or it re-litigates decisions that were already settled.
   */
  appendRevisionRequest(
    blueprintId: string,
    params: {
      phase: BlueprintPhaseType
      feedback: string
      disposition: 'revised' | 'rewound'
    }
  ): BlueprintRevisionRequest | null {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) return null

    const feedback = params.feedback.trim()
    if (!feedback) return null

    const existing = this.getRevisionRequests(blueprintId)
    // Derive the round from the highest round already recorded, not from the
    // list length: the ledger is capped, so once it is full every subsequent
    // request would otherwise be numbered the same.
    const highestRound = existing.reduce(
      (max, r) => (typeof r.round === 'number' && r.round > max ? r.round : max),
      0
    )
    const truncated = feedback.length > MAX_REVISION_FEEDBACK_CHARS
    const entry: BlueprintRevisionRequest = {
      round: highestRound + 1,
      at: new Date().toISOString(),
      phase: params.phase,
      feedback: feedback.slice(0, MAX_REVISION_FEEDBACK_CHARS),
      disposition: params.disposition,
      ...(truncated ? { truncated: true } : {})
    }

    // Cap the ledger so a long negotiation cannot crowd the artifacts out of
    // the prompt. The oldest entries drop first; round numbers stay truthful.
    const next = [...existing, entry].slice(-MAX_REVISION_REQUESTS)

    blueprintRepository.update(blueprintId, {
      settingsJson: { ...blueprint.settingsJson, revisionRequests: next }
    })

    bpLog.info(
      `[appendRevisionRequest] Blueprint ${blueprintId} — round ${entry.round} ` +
        `(${entry.disposition}) on ${entry.phase}: ${feedback.slice(0, 120)}`
    )
    return entry
  }

  /** Mark the newest request's disposition — used when a revision turn fails and we fall back to a rewind. */
  setLatestRevisionDisposition(blueprintId: string, disposition: 'revised' | 'rewound'): void {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) return
    const existing = this.getRevisionRequests(blueprintId)
    if (existing.length === 0) return
    const next = [...existing]
    next[next.length - 1] = { ...next[next.length - 1], disposition }
    blueprintRepository.update(blueprintId, {
      settingsJson: { ...blueprint.settingsJson, revisionRequests: next }
    })
  }

  /**
   * Build the full system prompt for a phase (convenience wrapper).
   */
  async buildSystemPrompt(
    blueprintId: string,
    phase: BlueprintPhaseType,
    workspacePath?: string
  ): Promise<string> {
    const context = await this.assemblePhaseContext(blueprintId, phase, workspacePath)
    return buildPhaseSystemPrompt(phase, context)
  }

  /**
   * Save structured retry context for a phase so the next attempt knows
   * what was accomplished and why the prior attempt failed.
   * Uses the existing context_snapshot column.
   */
  saveRetryContext(
    blueprintId: string,
    phase: BlueprintPhaseType,
    context: {
      error: string
      filesModified?: string[]
      filesCreated?: string[]
      tasksCompleted?: number
      totalTasks?: number
    }
  ): void {
    const phaseRecord = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, phase)
    if (!phaseRecord) return

    // Read existing snapshot to increment attempt counter
    const existing = safeParseJSON<Record<string, unknown>>(phaseRecord.contextSnapshot, {})
    const attempt = (typeof existing.attempt === 'number' ? existing.attempt : 0) + 1

    const snapshot = JSON.stringify({
      attempt,
      previousError: context.error.slice(0, 500),
      failedAt: new Date().toISOString(),
      filesModified: context.filesModified ?? [],
      filesCreated: context.filesCreated ?? [],
      tasksCompleted: context.tasksCompleted ?? 0,
      totalTasks: context.totalTasks ?? 0
    })

    blueprintPhaseRepository.saveContextSnapshot(phaseRecord.id, snapshot)
    bpLog.info(`[saveRetryContext] Saved retry context for ${phase} phase (attempt ${attempt})`)
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

    // TASK-02: Validate remediation task graph — cycles and duplicates only.
    // Reference integrity and cross-wave ordering produce false positives for
    // partial batches (all tasks share one wave, may depend on existing T-tasks).
    const batchTaskIds = new Set(parsedTasks.map((t) => t.taskId))
    const duplicates = parsedTasks.filter(
      (t, i) => parsedTasks.findIndex((x) => x.taskId === t.taskId) !== i
    )
    if (duplicates.length > 0) {
      bpLog.warn(
        `[appendTasks] Duplicate taskIds in remediation batch: ${duplicates.map((t) => t.taskId).join(', ')}`
      )
    }

    // Check for cycles within the batch (ignore deps on external tasks)
    const internalDeps = parsedTasks.map((t) => ({
      taskId: t.taskId,
      wave: nextWave,
      dependsOn: (t.dependsOn ?? []).filter((dep) => batchTaskIds.has(dep))
    }))
    const validation = validateTaskGraph(internalDeps)
    if (!validation.valid) {
      // Filter out cross-wave warnings (all tasks share nextWave, expected)
      const realErrors = validation.errors.filter((e) => !e.includes('must be in an earlier wave'))
      if (realErrors.length > 0) {
        bpLog.warn(
          `[appendTasks] Remediation task graph has ${realErrors.length} issue(s) for blueprint=${blueprintId}: ` +
            realErrors.join('; ')
        )
      }
    }

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
      'specifying',
      'clarifying',
      'planning',
      'tasking',
      'reviewing',
      'building',
      'codeReviewing',
      'verifying'
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
   * Reconcile blueprints that were active when the app last quit.
   *
   * C10 fix: Blueprints in 'reviewing' status with a completed review phase
   * are restored to the awaiting-approval state (not marked failed). This fixes
   * the original stale-execution bug where restarting at the approval gate
   * destroyed the blueprint.
   *
   * All other active-status blueprints are marked failed.
   */
  reconcileStaleBlueprints(): void {
    // C10: Check for reviewing blueprints that can be restored before marking stale
    const db = getDatabase()
    const reviewingRows = db
      .prepare(`SELECT id, workspace_id FROM blueprints WHERE status = 'reviewing'`)
      .all() as Array<{ id: string; workspace_id: string }>

    const restoredIds: string[] = []
    for (const row of reviewingRows) {
      const restored = this.tryRestoreAwaitingApproval(row.id, row.workspace_id)
      if (restored) restoredIds.push(row.id)
    }

    if (restoredIds.length > 0) {
      bpLog.info(
        `[reconcile] Restored ${restoredIds.length} blueprint(s) to awaiting-approval state`
      )
    }

    // R2-1 fix: pass restored IDs so markStaleAsFailed skips them — they
    // legitimately sit in status='reviewing' as the pre-restart approval gate.
    const count = blueprintRepository.markStaleAsFailed(restoredIds)
    if (count > 0) {
      bpLog.info(`[reconcile] Marked ${count} stale blueprint(s) as failed`)
    }
  }

  /**
   * Try to restore a reviewing blueprint to the awaiting-approval state.
   * Returns true if successful, false if the blueprint can't be restored.
   */
  private tryRestoreAwaitingApproval(blueprintId: string, workspaceId: string): boolean {
    try {
      // Check if review phase exists and has artifacts
      const reviewPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'review')
      if (!reviewPhase || reviewPhase.status !== 'complete') {
        return false // Review didn't finish — can't restore
      }

      // Extract review artifact for planSummary
      const reviewArtifact = reviewPhase.artifactsJson.findLast(
        (a: { type: string }) => a.type === 'review'
      )
      const completion = reviewArtifact?.contentJson as Record<string, unknown> | undefined

      // Extract persisted preflight artifact (premortem #7: read-back)
      const preflightArtifact = reviewPhase.artifactsJson.findLast(
        (a: { type: string }) => a.type === 'preflight'
      )
      const preflightResult = preflightArtifact?.contentJson as Record<string, unknown> | undefined

      // Build approval summary (mirrors review service step 11)
      const planSummary = completion
        ? this.buildApprovalSummaryFromCompletion(completion)
        : 'Review completed — restored after app restart.'

      // Restore state machine to awaiting-approval
      // Path: idle → startPhase → phase-running → approvalNeeded → awaiting-approval
      const machine = this.getMachine(workspaceId)
      machine.forceReset()
      machine.transition('startPhase', { blueprintId, phase: 'review' })
      machine.transition('approvalNeeded')

      // Rebuild pendingApproval (in-memory) from persisted artifacts
      this.setPendingApproval(workspaceId, {
        blueprintId,
        planSummary,
        completion: completion ?? undefined,
        reviewMarkdown: reviewArtifact?.contentMd || undefined,
        ...(preflightResult ? { preflight: { result: preflightResult, overridden: false } } : {})
      })

      // Mark the pipeline as having this blueprint
      const state = this.getOrCreatePipeline(workspaceId)
      state.blueprintId = blueprintId
      state.currentPhase = 'review'

      // Publish snapshot so renderer picks it up
      this.publishSnapshot(workspaceId)

      bpLog.info(
        `[reconcile] Restored blueprint ${blueprintId} to awaiting-approval for workspace ${workspaceId}`
      )
      return true
    } catch (err) {
      bpLog.warn(`[reconcile] Failed to restore blueprint ${blueprintId}:`, err)
      return false
    }
  }

  /**
   * Build approval summary from a review completion payload.
   * Mirrors BlueprintReviewService.buildApprovalSummary() but is accessible
   * without a service instance (used in reconciliation).
   */
  private buildApprovalSummaryFromCompletion(completion: Record<string, unknown>): string {
    const findings = completion.findings as
      { critical?: number; high?: number; medium?: number; low?: number } | undefined
    const recommendation =
      typeof completion.recommendation === 'string' ? completion.recommendation : 'unknown'
    const coverage = completion.coveragePercent as number | undefined

    const lines: string[] = []
    if (coverage !== undefined) {
      lines.push(`Coverage: ${coverage}% of requirements have implementation tasks`)
    }
    if (findings) {
      const parts: string[] = []
      if (findings.critical) parts.push(`${findings.critical} critical`)
      if (findings.high) parts.push(`${findings.high} high`)
      if (findings.medium) parts.push(`${findings.medium} medium`)
      if (findings.low) parts.push(`${findings.low} low`)
      lines.push(`Findings: ${parts.join(', ') || 'none'}`)
    }
    lines.push(`Recommendation: ${recommendation.replace(/_/g, ' ')}`)

    return lines.join('\n')
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
