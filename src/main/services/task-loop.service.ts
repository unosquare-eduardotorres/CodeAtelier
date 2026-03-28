import log from 'electron-log/main'
import { qualityGateRunnerService } from './quality-gate-runner.service'
import type { GateRunResult } from './quality-gate-runner.service'
import type { QualityGateResult } from './abandonment-detector.service'
import { eventLoggerService } from './event-logger.service'
import { gateResultRepository } from '../db/repositories/gate-result.repository'

const loopLog = log.scope('TaskLoop')

/** Maximum iterations before giving up (original + retries) */
const MAX_ITERATIONS = 4
/** Maximum tokens for fix context injected into retry prompts */
const MAX_FIX_CONTEXT_CHARS = 4000
/** After seeing the same error N times, force model escalation */
const STUCK_DETECTION_THRESHOLD = 2

/** Tracks the state of an iterative task loop */
export interface TaskLoopState {
  taskId: string
  agentId: string
  iteration: number
  maxIterations: number
  /** History of gate results per iteration */
  gateHistory: Array<{
    iteration: number
    gates: QualityGateResult[]
    allPassed: boolean
  }>
  /** Whether stuck detection triggered a forced escalation */
  stuckDetected: boolean
  /** Final outcome */
  outcome: 'passed' | 'failed' | 'max_iterations' | 'pending'
}

/** Result of a single task loop run */
export interface TaskLoopResult {
  /** Whether the task ultimately passed all gates */
  passed: boolean
  /** Total iterations executed */
  iterations: number
  /** State object with full history */
  state: TaskLoopState
  /** Fix context for the next iteration (empty if passed) */
  fixContext: string
  /** Whether model escalation is recommended */
  shouldEscalate: boolean
}

/**
 * Task Loop Service — wraps specialist execution in iterative fix cycles.
 *
 * Pattern: Execute → Quality Gates → Pass? Done. Fail? → Build fix context → Retry
 *
 * The task loop does NOT spawn specialists itself — it provides the loop control
 * logic and fix context generation. The specialist-pool.service.ts calls into this
 * service to determine whether to re-spawn after completion.
 */
class TaskLoopService {
  /** Active loop states keyed by taskId */
  private loopStates: Map<string, TaskLoopState> = new Map()

  /**
   * Initialize a new task loop for a specialist task.
   * Call this before the first specialist spawn.
   */
  initLoop(taskId: string, agentId: string): TaskLoopState {
    const state: TaskLoopState = {
      taskId,
      agentId,
      iteration: 0,
      maxIterations: MAX_ITERATIONS,
      gateHistory: [],
      stuckDetected: false,
      outcome: 'pending'
    }
    this.loopStates.set(taskId, state)
    return state
  }

  /**
   * Run quality gates after a specialist completes and determine next action.
   *
   * @param taskId - The task that just completed
   * @param cwd - Working directory (worktree or workspace) to run gates in
   * @param conversationId - For event logging
   * @returns TaskLoopResult with pass/fail status and fix context for retry
   */
  async evaluateAndAdvance(
    taskId: string,
    cwd: string,
    conversationId?: string
  ): Promise<TaskLoopResult> {
    const state = this.loopStates.get(taskId)
    if (!state) {
      loopLog.warn(`No loop state for task ${taskId} — creating default`)
      this.initLoop(taskId, 'unknown')
      return this.evaluateAndAdvance(taskId, cwd, conversationId)
    }

    state.iteration++
    loopLog.info(
      `Task loop iteration ${state.iteration}/${state.maxIterations} for ${state.agentId}/${taskId}`
    )

    // Run quality gates
    const gateResult: GateRunResult = await qualityGateRunnerService.runGates(cwd, {
      taskId,
      agentId: state.agentId,
      failFast: false
    })

    // Record gate history
    state.gateHistory.push({
      iteration: state.iteration,
      gates: gateResult.gates,
      allPassed: gateResult.allPassed
    })

    // Persist gate results to DB
    for (const gate of gateResult.gates) {
      eventLoggerService.logGateResult({
        conversationId,
        agentId: state.agentId,
        taskId,
        gate
      })
      try {
        gateResultRepository.create({
          gateType: gate.type,
          passed: gate.passed,
          summary: gate.summary,
          conversationId,
          taskId,
          agentId: state.agentId
        })
      } catch (err) {
        loopLog.warn('Failed to persist gate result:', err)
      }
    }

    // All gates passed — success!
    if (gateResult.allPassed) {
      state.outcome = 'passed'
      loopLog.info(
        `All gates passed for ${state.agentId}/${taskId} on iteration ${state.iteration}`
      )
      return {
        passed: true,
        iterations: state.iteration,
        state,
        fixContext: '',
        shouldEscalate: false
      }
    }

    // Max iterations reached — give up
    if (state.iteration >= state.maxIterations) {
      state.outcome = 'max_iterations'
      loopLog.warn(
        `Max iterations (${state.maxIterations}) reached for ${state.agentId}/${taskId} — giving up`
      )
      return {
        passed: false,
        iterations: state.iteration,
        state,
        fixContext: gateResult.failureSummary,
        shouldEscalate: false
      }
    }

    // Check for stuck detection — same gate failing repeatedly
    const shouldEscalate = this.detectStuck(state)
    if (shouldEscalate) {
      state.stuckDetected = true
      loopLog.warn(`Stuck detected for ${state.agentId}/${taskId} — recommending model escalation`)
    }

    // Build fix context for the next iteration
    const fixContext = this.buildFixContext(state, gateResult)

    loopLog.info(
      `Gate failures for ${state.agentId}/${taskId}: ${gateResult.failureSummary.slice(0, 200)}`
    )

    return {
      passed: false,
      iterations: state.iteration,
      state,
      fixContext,
      shouldEscalate
    }
  }

  /**
   * Detect if the task is stuck — same gate type failing for STUCK_DETECTION_THRESHOLD
   * consecutive iterations.
   */
  private detectStuck(state: TaskLoopState): boolean {
    if (state.gateHistory.length < STUCK_DETECTION_THRESHOLD) return false

    // Get the last N iterations
    const recent = state.gateHistory.slice(-STUCK_DETECTION_THRESHOLD)

    // Check if the same gate types are failing in all recent iterations
    const failingGateTypes = recent.map((h) =>
      h.gates
        .filter((g) => !g.passed)
        .map((g) => g.type)
        .sort()
        .join(',')
    )

    // If the exact same set of gates is failing, we're stuck
    const allSame = failingGateTypes.every((f) => f === failingGateTypes[0] && f.length > 0)
    return allSame
  }

  /**
   * Build fix context to inject into the specialist's retry prompt.
   * Summarizes gate failures and previous iteration context.
   * Capped at MAX_FIX_CONTEXT_CHARS to prevent context overflow.
   */
  private buildFixContext(state: TaskLoopState, currentResult: GateRunResult): string {
    const parts: string[] = []

    parts.push(`\n\n--- TASK LOOP: Iteration ${state.iteration}/${state.maxIterations} ---`)
    parts.push(
      `Your previous attempt completed but FAILED quality gates. You MUST fix these issues before finishing.`
    )

    // Current failures
    parts.push(`\nCurrent failures:`)
    for (const gate of currentResult.gates) {
      if (!gate.passed) {
        parts.push(`- [${gate.type.toUpperCase()}] ${gate.summary}`)
      }
    }

    // Add brief history of previous iterations (if any)
    if (state.gateHistory.length > 1) {
      const prevIterations = state.gateHistory.slice(0, -1)
      parts.push(`\nPrevious iteration(s):`)
      for (const hist of prevIterations) {
        const failedGates = hist.gates.filter((g) => !g.passed)
        if (failedGates.length > 0) {
          parts.push(
            `  Iteration ${hist.iteration}: ${failedGates.map((g) => `${g.type}:FAIL`).join(', ')}`
          )
        }
      }
    }

    if (state.stuckDetected) {
      parts.push(
        `\n⚠️ STUCK DETECTION: The same gates have been failing repeatedly. Try a DIFFERENT approach — refactor the code, check imports, or simplify the implementation.`
      )
    }

    parts.push(
      `\nFocus ONLY on fixing the failing gates. Do not introduce new features or changes.`
    )
    parts.push(`--- END TASK LOOP CONTEXT ---\n`)

    const fullContext = parts.join('\n')

    // Cap context size
    if (fullContext.length > MAX_FIX_CONTEXT_CHARS) {
      return fullContext.slice(0, MAX_FIX_CONTEXT_CHARS) + '\n[Fix context truncated]'
    }

    return fullContext
  }

  /**
   * Get the current loop state for a task.
   */
  getState(taskId: string): TaskLoopState | undefined {
    return this.loopStates.get(taskId)
  }

  /**
   * Check if a task has an active loop.
   */
  hasLoop(taskId: string): boolean {
    return this.loopStates.has(taskId)
  }

  /**
   * Clean up loop state for a task.
   */
  cleanup(taskId: string): void {
    this.loopStates.delete(taskId)
  }

  /**
   * Clean up all loop states (on reset).
   */
  reset(): void {
    this.loopStates.clear()
  }
}

export const taskLoopService = new TaskLoopService()
