/**
 * MpaOrchestrationService — orchestrator for multi-phased agent pipelines.
 *
 * Runs plan → user gate → execute → verify phases sequentially,
 * each with a dedicated AgentSessionService and role adapter.
 * Emits phaseStart/phaseProgress/phaseComplete/approvalNeeded/pipelineComplete
 * events for the IPC layer to forward to the renderer.
 *
 * Follows the AuditAgentService pattern: EventEmitter, per-phase sessions,
 * synthetic conversation IDs, structured output parsing.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import { AgentSessionService } from './agent-session.service'
import { MpaPlannerAdapter } from './role-adapters/mpa/mpa-planner.adapter'
import { MpaBuilderAdapter } from './role-adapters/mpa/mpa-builder.adapter'
import { MpaVerifierAdapter } from './role-adapters/mpa/mpa-verifier.adapter'
import {
  buildPlannerGoalCondition,
  buildBuilderGoalCondition,
  buildVerifierGoalCondition
} from './mpa-goal-conditions'
import { parsePlanArtifact, parseVerifyReport } from './mpa-artifact-parsers'
import { mpaRunRepository } from '../db/repositories/mpa-run.repository'
import { mpaArtifactRepository } from '../db/repositories/mpa-artifact.repository'
import { hookEngine } from './hook-engine.service'
import type {
  MpaOrchestrateParams,
  MpaPhaseType,
  MpaArtifactType,
  MpaPlanArtifact,
  MpaVerifyReport,
  MpaGateResponse,
  MpaPhaseStartPayload,
  MpaPhaseProgressPayload,
  MpaPhaseCompletePayload,
  MpaFeedbackLoopPayload,
  MpaApprovalNeededPayload,
  MpaPipelineCompletePayload,
  MpaRun,
  MpaPhase,
  MpaArtifact
} from '../../shared/mpa-types'

const mpaLog = log.scope('mpa')

const MAX_VERIFY_ITERATIONS = 3
const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min per phase

/** Per-workspace pipeline state. */
interface MpaPipelineState {
  running: boolean
  abortController: AbortController | null
  currentPhaseSession: AgentSessionService | null
  pendingGateResolve: ((result: MpaGateResponse) => void) | null
  currentRunId: string | null
}

export class MpaOrchestrationService extends EventEmitter {
  private pipelines = new Map<string, MpaPipelineState>()

  /** Backward compat: current run ID for the most recently started pipeline. */
  get currentRunId(): string | null {
    for (const state of this.pipelines.values()) {
      if (state.running && state.currentRunId) return state.currentRunId
    }
    return null
  }

  get isRunning(): boolean {
    for (const state of this.pipelines.values()) {
      if (state.running) return true
    }
    return false
  }

  isRunningForWorkspace(workspaceId: string): boolean {
    return this.pipelines.get(workspaceId)?.running ?? false
  }

  private getOrCreatePipeline(workspaceId: string): MpaPipelineState {
    let state = this.pipelines.get(workspaceId)
    if (!state) {
      state = {
        running: false,
        abortController: null,
        currentPhaseSession: null,
        pendingGateResolve: null,
        currentRunId: null
      }
      this.pipelines.set(workspaceId, state)
    }
    return state
  }

  /** Find the pipeline tracking a given run ID. */
  private findPipelineByRunId(runId: string): MpaPipelineState | undefined {
    for (const [, pipeline] of this.pipelines) {
      if (pipeline.currentRunId === runId) return pipeline
    }
    return undefined
  }

  // ── Public API ──

  async orchestrate(params: MpaOrchestrateParams): Promise<void> {
    const pipeline = this.getOrCreatePipeline(params.workspaceId)

    if (pipeline.running) {
      throw new Error(`MPA pipeline already running for workspace ${params.workspaceId}`)
    }

    pipeline.running = true
    pipeline.abortController = new AbortController()

    // Create DB run record
    const run = mpaRunRepository.createRun({
      workspaceId: params.workspaceId,
      title: params.title,
      goal: params.goal,
      goalType: params.goalType,
      grillSessionId: params.grillSessionId,
      configJson: {
        phases: params.phases,
        grillDecisions: params.grillDecisions,
        workspacePath: params.workspacePath
      }
    })
    pipeline.currentRunId = run.id

    mpaLog.info(`[orchestrate] Starting MPA run ${run.id} — goal: "${params.goal.slice(0, 80)}"`)

    try {
      let plan: MpaPlanArtifact | null = null
      let planArtifact: MpaArtifact | null = null

      for (let phaseIdx = 0; phaseIdx < params.phases.length; phaseIdx++) {
        if (pipeline.abortController?.signal.aborted) break

        const phaseType = params.phases[phaseIdx]

        mpaRunRepository.updateRun(run.id, { currentPhase: phaseType })

        switch (phaseType) {
          case 'plan': {
            const result = await this.runPlanPhase(run, params, plan, undefined)
            plan = result.plan
            planArtifact = result.artifact

            // Fire hook: plan phase complete
            hookEngine.executeHooks('mpa_plan_complete', {
              runId: run.id,
              goal: params.goal.slice(0, 200),
              workspaceId: params.workspaceId
            }).catch(() => { /* non-blocking */ })

            // User gate — wait for approval (with optional feedback loop)
            if (plan && planArtifact) {
              const gateResult = await this.runUserGate(run, plan, planArtifact, params)
              if (!gateResult) {
                // Rejected or cancelled
                mpaRunRepository.updateRun(run.id, {
                  status: 'cancelled',
                  completedAt: new Date().toISOString()
                })
                this.emitComplete(run.id, 'cancelled', 0)
                return
              }
              plan = gateResult.plan
              planArtifact = gateResult.artifact
            }
            break
          }

          case 'execute': {
            if (!plan) {
              mpaLog.error('[orchestrate] Execute phase requires a plan')
              break
            }
            // Fire hook: build phase start
            hookEngine.executeHooks('mpa_build_start', {
              runId: run.id,
              workspaceId: params.workspaceId
            }).catch(() => { /* non-blocking */ })

            await this.runExecutePhase(run, params, plan)

            // Fire hook: build phase complete
            hookEngine.executeHooks('mpa_build_complete', {
              runId: run.id,
              workspaceId: params.workspaceId
            }).catch(() => { /* non-blocking */ })
            break
          }

          case 'verify': {
            if (!plan) {
              mpaLog.error('[orchestrate] Verify phase requires a plan')
              break
            }
            await this.runVerifyLoop(run, params, plan)

            // Fire hook: verify phase complete
            hookEngine.executeHooks('mpa_verify_complete', {
              runId: run.id,
              workspaceId: params.workspaceId
            }).catch(() => { /* non-blocking */ })
            break
          }
        }
      }

      // Pipeline complete
      const updatedRun = mpaRunRepository.updateRun(run.id, {
        status: 'completed',
        completedAt: new Date().toISOString()
      })

      // Fire hook: goal achieved
      hookEngine.executeHooks('mpa_goal_achieved', {
        runId: run.id,
        goal: params.goal.slice(0, 200),
        workspaceId: params.workspaceId
      }).catch(() => { /* non-blocking */ })

      this.emitComplete(run.id, 'completed', updatedRun?.totalTokens ?? 0)
    } catch (err) {
      // Skip if cancelled (cancel() already emitted pipelineComplete)
      if (pipeline.abortController?.signal.aborted) return

      mpaLog.error(`[orchestrate] Pipeline failed:`, err)
      mpaRunRepository.updateRun(run.id, {
        status: 'failed',
        completedAt: new Date().toISOString()
      })

      // Fire hook: goal failed
      hookEngine.executeHooks('mpa_goal_failed', {
        runId: run.id,
        goal: params.goal.slice(0, 200),
        error: (err as Error).message?.slice(0, 200) ?? 'unknown',
        workspaceId: params.workspaceId
      }).catch(() => { /* non-blocking */ })

      this.emitComplete(run.id, 'failed', 0)
    } finally {
      pipeline.running = false
      pipeline.currentRunId = null
      pipeline.abortController = null
      pipeline.currentPhaseSession = null
      pipeline.pendingGateResolve = null
      this.pipelines.delete(params.workspaceId)
    }
  }

  /** Respond to a user gate approval/rejection. */
  respondToGate(runId: string, approved: boolean, feedback?: string): void {
    const pipeline = this.findPipelineByRunId(runId)
    if (pipeline?.pendingGateResolve) {
      pipeline.pendingGateResolve({ approved, feedback })
      pipeline.pendingGateResolve = null
    }
  }

  /** Cancel the running pipeline for a workspace (or all if no workspaceId). */
  cancel(workspaceId?: string): void {
    const cancelPipeline = (pipeline: MpaPipelineState): void => {
      pipeline.abortController?.abort()
      pipeline.currentPhaseSession?.stop()
      if (pipeline.currentRunId) {
        mpaRunRepository.updateRun(pipeline.currentRunId, {
          status: 'cancelled',
          completedAt: new Date().toISOString()
        })
        this.emitComplete(pipeline.currentRunId, 'cancelled', 0)
      }
      if (pipeline.pendingGateResolve) {
        pipeline.pendingGateResolve({ approved: false })
        pipeline.pendingGateResolve = null
      }
    }

    if (workspaceId) {
      mpaLog.info(`[cancel] Cancelling MPA pipeline for workspace ${workspaceId}`)
      const pipeline = this.pipelines.get(workspaceId)
      if (pipeline) cancelPipeline(pipeline)
    } else {
      mpaLog.info('[cancel] Cancelling all MPA pipelines')
      for (const [, pipeline] of this.pipelines) {
        cancelPipeline(pipeline)
      }
    }
  }

  /** Get current pipeline status for a workspace. */
  getStatus(workspaceId?: string): {
    running: boolean
    runId: string | null
  } {
    if (workspaceId) {
      const pipeline = this.pipelines.get(workspaceId)
      return {
        running: pipeline?.running ?? false,
        runId: pipeline?.currentRunId ?? null
      }
    }
    return {
      running: this.isRunning,
      runId: this.currentRunId
    }
  }

  // ── Verify Loop ──

  /**
   * Run the verify → execute feedback loop until all items are complete
   * or MAX_VERIFY_ITERATIONS is reached. Extracted from orchestrate()
   * to reduce its cyclomatic complexity.
   */
  private async runVerifyLoop(
    run: MpaRun,
    params: MpaOrchestrateParams,
    plan: MpaPlanArtifact
  ): Promise<void> {
    let verifyIteration = 0
    let allComplete = false

    while (verifyIteration < MAX_VERIFY_ITERATIONS && !allComplete) {
      verifyIteration++
      const report = await this.runVerifyPhase(run, params, plan, verifyIteration)

      if (report?.allComplete) {
        allComplete = true
      } else if (report && verifyIteration < MAX_VERIFY_ITERATIONS) {
        this.emit('feedbackLoop', {
          runId: run.id,
          fromPhase: 'verify',
          toPhase: 'execute',
          iteration: verifyIteration + 1,
          reason: `Verifier found ${report.partial + report.missing} incomplete items`
        } satisfies MpaFeedbackLoopPayload)

        await this.runExecutePhase(run, params, plan, report)
      }
    }

    if (!allComplete && verifyIteration >= MAX_VERIFY_ITERATIONS) {
      mpaLog.warn(
        `[orchestrate] Max verify iterations (${MAX_VERIFY_ITERATIONS}) reached — completing with warnings`
      )
    }
  }

  // ── Phase Runners ──

  /**
   * Shared setup for all phase runners: set goal condition, create DB phase
   * record, and execute the agent session. Eliminates the 3-step boilerplate
   * repeated in runPlanPhase / runExecutePhase / runVerifyPhase.
   */
  private async setupAndExecutePhase(params: {
    run: MpaRun
    adapter: MpaPlannerAdapter | MpaBuilderAdapter | MpaVerifierAdapter
    phaseType: MpaPhaseType
    iteration: number
    goalCondition: string
    workspacePath: string
  }): Promise<{ phase: MpaPhase; text: string }> {
    params.adapter.setGoalCondition(params.goalCondition)

    const phase = mpaRunRepository.createPhase({
      runId: params.run.id,
      phaseType: params.phaseType,
      iteration: params.iteration,
      agentRole: params.adapter.role,
      goalCondition: params.goalCondition
    })

    const text = await this.executePhaseSession(
      params.adapter,
      params.workspacePath,
      params.run.id,
      phase.id,
      params.phaseType,
      params.iteration
    )

    return { phase, text }
  }

  private async runPlanPhase(
    run: MpaRun,
    params: MpaOrchestrateParams,
    previousPlan: MpaPlanArtifact | null,
    userFeedback: string | undefined
  ): Promise<{ plan: MpaPlanArtifact | null; artifact: MpaArtifact | null }> {
    const iteration = previousPlan ? 2 : 1

    const adapter = new MpaPlannerAdapter({
      workspaceId: params.workspaceId,
      goal: params.goal,
      grillDecisions: params.grillDecisions,
      previousPlan: previousPlan ? { contentJson: previousPlan } : undefined,
      userFeedback
    })

    const { phase, text } = await this.setupAndExecutePhase({
      run, adapter, phaseType: 'plan', iteration,
      goalCondition: buildPlannerGoalCondition(params.goal),
      workspacePath: params.workspacePath
    })

    const plan = parsePlanArtifact(text)
    const artifact = this.persistPhaseResult({
      runId: run.id, phaseId: phase.id, parsed: plan,
      rawText: text, artifactType: 'plan', iteration
    })

    return { plan, artifact }
  }

  private async runExecutePhase(
    run: MpaRun,
    params: MpaOrchestrateParams,
    plan: MpaPlanArtifact,
    verifierFeedback?: MpaVerifyReport
  ): Promise<void> {
    const adapter = new MpaBuilderAdapter({
      workspaceId: params.workspaceId,
      goal: params.goal,
      plan,
      verifierFeedback
    })

    const iteration = verifierFeedback ? 2 : 1

    const { phase } = await this.setupAndExecutePhase({
      run, adapter, phaseType: 'execute', iteration,
      goalCondition: buildBuilderGoalCondition(plan),
      workspacePath: params.workspacePath
    })

    mpaRunRepository.updatePhase(phase.id, {
      status: 'completed',
      completedAt: new Date().toISOString()
    })
  }

  private async runVerifyPhase(
    run: MpaRun,
    params: MpaOrchestrateParams,
    plan: MpaPlanArtifact,
    iteration: number
  ): Promise<MpaVerifyReport | null> {
    const adapter = new MpaVerifierAdapter({
      workspaceId: params.workspaceId,
      goal: params.goal,
      plan
    })

    const { phase, text } = await this.setupAndExecutePhase({
      run, adapter, phaseType: 'verify', iteration,
      goalCondition: buildVerifierGoalCondition(plan),
      workspacePath: params.workspacePath
    })

    const report = parseVerifyReport(text)
    this.persistPhaseResult({
      runId: run.id, phaseId: phase.id, parsed: report,
      rawText: text, artifactType: 'verify_report', iteration
    })

    return report
  }

  // ── User Gate ──

  /**
   * Run the user approval gate with optional feedback loop.
   * Returns the final approved plan/artifact or null if cancelled/rejected.
   */
  private async runUserGate(
    run: MpaRun,
    plan: MpaPlanArtifact,
    planArtifact: MpaArtifact,
    params: MpaOrchestrateParams
  ): Promise<{ plan: MpaPlanArtifact; artifact: MpaArtifact } | null> {
    const gateResult = await this.requestUserApproval(run, plan, planArtifact)

    if (gateResult.approved) {
      return { plan, artifact: planArtifact }
    }

    if (!gateResult.feedback) {
      // No feedback = cancel
      return null
    }

    // Feedback loop — re-plan with user feedback
    this.emit('feedbackLoop', {
      runId: run.id,
      fromPhase: 'plan',
      toPhase: 'plan',
      iteration: 2,
      reason: gateResult.feedback
    } satisfies MpaFeedbackLoopPayload)

    const revised = await this.runPlanPhase(run, params, plan, gateResult.feedback)
    if (!revised.plan || !revised.artifact) return null

    // Second gate
    const secondGate = await this.requestUserApproval(run, revised.plan, revised.artifact)
    if (!secondGate.approved) {
      mpaLog.info(`[runUserGate] Plan rejected twice — cancelling run ${run.id}`)
      return null
    }

    return { plan: revised.plan, artifact: revised.artifact }
  }

  // ── Session Execution ──

  private async executePhaseSession(
    adapter: MpaPlannerAdapter | MpaBuilderAdapter | MpaVerifierAdapter,
    workspacePath: string,
    runId: string,
    phaseId: string,
    phaseType: MpaPhaseType,
    iteration: number
  ): Promise<string> {
    const session = new AgentSessionService(adapter)
    const ownerPipeline = this.findPipelineByRunId(runId)
    if (ownerPipeline) ownerPipeline.currentPhaseSession = session

    // Emit phase start
    this.emit('phaseStart', {
      runId,
      phaseId,
      phaseType,
      iteration,
      agentRole: adapter.role
    } satisfies MpaPhaseStartPayload)

    mpaRunRepository.updatePhase(phaseId, {
      status: 'running',
      startedAt: new Date().toISOString()
    })

    // Wire streaming
    session.on('chunk', (chunk: StreamChunk) => {
      if (chunk.type === 'text' && chunk.content) {
        this.emit('phaseProgress', {
          runId,
          phaseId,
          phaseType,
          streamChunk: chunk.content
        } satisfies MpaPhaseProgressPayload)

        // Append to DB for persistence
        mpaRunRepository.appendStreamContent(phaseId, chunk.content)
      }
    })

    const mode = phaseType === 'execute' ? 'build' : 'plan'

    try {
      // Start session
      await session.start(workspacePath, mode)

      // Send the phase message — session will run until /goal is met or timeout
      const syntheticConvId = `mpa-${phaseType}-${runId}-${iteration}-${Date.now()}`

      // Create a timeout race
      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Phase timeout')), PHASE_TIMEOUT_MS)
      })

      const sendPromise = session.send('Begin.', syntheticConvId)

      try {
        await Promise.race([sendPromise, timeoutPromise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }

      const text = session.getStreamedContent()

      // Emit phase complete
      this.emit('phaseComplete', {
        runId,
        phaseId,
        phaseType,
        status: 'completed',
        tokensUsed: 0
      } satisfies MpaPhaseCompletePayload)

      return text
    } catch (err) {
      mpaLog.error(`[executePhaseSession] Phase ${phaseType} failed:`, err)

      this.emit('phaseComplete', {
        runId,
        phaseId,
        phaseType,
        status: 'failed',
        tokensUsed: 0
      } satisfies MpaPhaseCompletePayload)

      return session.getStreamedContent()
    } finally {
      await session.stop()
      if (ownerPipeline) ownerPipeline.currentPhaseSession = null
    }
  }

  private requestUserApproval(
    run: MpaRun,
    plan: MpaPlanArtifact,
    artifact: MpaArtifact
  ): Promise<MpaGateResponse> {
    mpaRunRepository.updateRun(run.id, { status: 'paused' })

    this.emit('approvalNeeded', {
      runId: run.id,
      phaseId: artifact.phaseId ?? '',
      artifactId: artifact.id,
      artifact: plan
    } satisfies MpaApprovalNeededPayload)

    return new Promise<MpaGateResponse>((resolve) => {
      const pipeline = this.findPipelineByRunId(run.id)
      if (pipeline) {
        pipeline.pendingGateResolve = resolve
      } else {
        // Fallback: shouldn't happen but resolve immediately to avoid hang
        resolve({ approved: false })
      }
    })
  }

  // ── Helpers ──

  /**
   * Persist parsed artifact to DB and update phase status.
   * Shared by plan and verify phase runners to eliminate duplication.
   */
  private persistPhaseResult<T>(params: {
    runId: string
    phaseId: string
    parsed: T | null
    rawText: string
    artifactType: MpaArtifactType
    iteration: number
  }): MpaArtifact | null {
    const { runId, phaseId, parsed, rawText, artifactType, iteration } = params

    if (parsed) {
      const artifact = mpaArtifactRepository.create({
        runId,
        phaseId,
        artifactType,
        contentJson: parsed as unknown as Record<string, unknown>,
        contentMd: rawText,
        version: iteration
      })

      mpaRunRepository.updatePhase(phaseId, {
        status: 'completed',
        outputArtifactId: artifact.id,
        completedAt: new Date().toISOString()
      })

      return artifact
    }

    mpaRunRepository.updatePhase(phaseId, {
      status: 'failed',
      completedAt: new Date().toISOString()
    })

    return null
  }

  private emitComplete(
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    totalTokens: number
  ): void {
    this.emit('pipelineComplete', {
      runId,
      status,
      totalTokens
    } satisfies MpaPipelineCompletePayload)
  }
  // ── Resume ──

  /**
   * Resume a failed or stale MPA run from where it left off.
   * Reconstructs pipeline state from DB, determines remaining phases,
   * and re-enters the orchestration loop.
   */
  async resumeRun(runId: string): Promise<void> {
    mpaLog.info(`[resume] Attempting to resume run ${runId}`)

    // 1. Load run from DB
    const run = mpaRunRepository.findById(runId)
    if (!run) throw new Error(`Run ${runId} not found`)
    if (run.status === 'completed') throw new Error('Run already completed')
    if (run.status === 'cancelled') throw new Error('Run was cancelled')

    // 2. Get workspace pipeline and check for conflicts
    const pipeline = this.getOrCreatePipeline(run.workspaceId)
    if (pipeline.running) {
      throw new Error(`Pipeline already running for workspace ${run.workspaceId}`)
    }

    // 3. Find completed phases and the plan artifact
    const phases = mpaRunRepository.findPhasesByRun(runId)
    const artifacts = mpaArtifactRepository.findByRun(runId)
    const planArtifact = artifacts.find(a => a.artifactType === 'plan')
    const plan: MpaPlanArtifact | null = planArtifact
      ? (planArtifact.contentJson as unknown as MpaPlanArtifact)
      : null

    // 4. Determine which phases remain
    const config = run.configJson as {
      phases: MpaPhaseType[]
      grillDecisions?: unknown[]
      workspacePath: string
    }
    const workspacePath = config.workspacePath
    if (!workspacePath) throw new Error('Run config missing workspacePath — cannot resume')

    const completedPhaseTypes = new Set(
      phases.filter(p => p.status === 'completed').map(p => p.phaseType)
    )
    const remainingPhases = config.phases.filter(p => !completedPhaseTypes.has(p))

    if (remainingPhases.length === 0) {
      mpaLog.info('[resume] All phases already completed — marking as completed')
      mpaRunRepository.updateRun(runId, { status: 'completed', completedAt: new Date().toISOString() })
      this.emitComplete(runId, 'completed', run.totalTokens)
      return
    }

    mpaLog.info(`[resume] Resuming run ${runId} — ${remainingPhases.length} phase(s) remaining: ${remainingPhases.join(', ')}`)

    // 5. Reset run status and activate pipeline
    pipeline.running = true
    pipeline.abortController = new AbortController()
    pipeline.currentRunId = runId
    mpaRunRepository.updateRun(runId, { status: 'running' })

    // 6. Reconstruct params for phase runners
    const params: MpaOrchestrateParams = {
      workspaceId: run.workspaceId,
      workspacePath,
      goal: run.goal,
      title: run.title,
      goalType: run.goalType,
      phases: remainingPhases,
      grillSessionId: run.grillSessionId ?? undefined,
      grillDecisions: (config.grillDecisions as import('../../shared/mpa-types').GrillDecision[] | undefined)
    }

    try {
      let currentPlan = plan

      for (const phaseType of remainingPhases) {
        if (pipeline.abortController?.signal.aborted) break

        mpaRunRepository.updateRun(runId, { currentPhase: phaseType })

        switch (phaseType) {
          case 'plan': {
            const result = await this.runPlanPhase(run, params, currentPlan, undefined)
            currentPlan = result.plan

            // User gate for new plan
            if (currentPlan && result.artifact) {
              const gateResult = await this.runUserGate(run, currentPlan, result.artifact, params)
              if (!gateResult) {
                mpaRunRepository.updateRun(runId, { status: 'cancelled', completedAt: new Date().toISOString() })
                this.emitComplete(runId, 'cancelled', 0)
                return
              }
              currentPlan = gateResult.plan
            }
            break
          }

          case 'execute': {
            if (!currentPlan) {
              mpaLog.error('[resume] Execute phase requires a plan')
              break
            }
            await this.runExecutePhase(run, params, currentPlan)
            break
          }

          case 'verify': {
            if (!currentPlan) {
              mpaLog.error('[resume] Verify phase requires a plan')
              break
            }
            await this.runVerifyLoop(run, params, currentPlan)
            break
          }
        }
      }

      mpaRunRepository.updateRun(runId, { status: 'completed', completedAt: new Date().toISOString() })
      this.emitComplete(runId, 'completed', 0)
    } catch (err) {
      if (pipeline.abortController?.signal.aborted) return

      mpaLog.error(`[resume] Pipeline failed:`, err)
      mpaRunRepository.updateRun(runId, { status: 'failed', completedAt: new Date().toISOString() })
      this.emitComplete(runId, 'failed', 0)
    } finally {
      pipeline.running = false
      pipeline.currentRunId = null
      pipeline.abortController = null
      pipeline.currentPhaseSession = null
      pipeline.pendingGateResolve = null
      this.pipelines.delete(run.workspaceId)
    }
  }

  /**
   * Mark stale 'running' runs as 'failed'.
   * Called on app startup to detect runs that were interrupted by crash/restart.
   */
  reconcileStaleRuns(): void {
    const staleCount = mpaRunRepository.markStaleAsFailed()
    if (staleCount > 0) {
      mpaLog.info(`[reconcile] Marked ${staleCount} stale MPA run(s) as failed`)
    }
  }

  /** Graceful shutdown — cancel all pipelines and clear state. Called on app quit. */
  async shutdown(): Promise<void> {
    mpaLog.info(`[mpa] Shutdown initiated — ${this.pipelines.size} active pipelines`)
    this.cancel() // Cancels all workspace pipelines
    this.pipelines.clear()
  }
}

// Singleton
export const mpaOrchestrationService = new MpaOrchestrationService()
