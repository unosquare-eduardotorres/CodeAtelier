import { EventEmitter } from 'node:events'
import type {
  BudgetTier,
  ConversationMode,
  DecomposedTask,
  HandoffBrief,
  InvestigationDepth,
  ModelTier,
  TaskExecutionProgress
} from '../../shared/types'
import { THINKING_BUDGETS } from '../../shared/constants'
import { specialistPoolLogger } from '../logger'
import {
  specialistRepository,
  worktreeRepository,
  agentSessionRepository,
  workspaceRepository,
  conversationSpecialistRepository
} from '../db/repositories'
import { promptBuilder } from './prompt-builder'
import { memoryService } from './memory.service'
import { gitWorktreeService } from './git-worktree.service'
import type { MergeResult } from './git-worktree.service'
import { modelConfigService } from './model-config.service'
import { checkpointService } from './checkpoint.service'
import { eventLoggerService } from './event-logger.service'
import { detectAbandonment, detectQualityGates } from './abandonment-detector.service'
import { gateResultRepository } from '../db/repositories/gate-result.repository'
import { costTrackerService } from './cost-tracker.service'
import { taskLoopService } from './task-loop.service'
import { taskArtifactService } from './task-artifact.service'
import { PromptBuilder } from './prompt-builder'
import { SDKExecutor } from './sdk-executor'
import type { SDKExecuteResult } from './sdk-executor'
import {
  topologicalSort as topologicalSortFn,
  detectConclusivePattern as detectConclusivePatternFn,
  getConclusivePatterns
} from './specialist/task-scheduler'
import { Semaphore } from './specialist/semaphore'
import { executionTracer } from './specialist/trace'
import type { TraceSpan } from './specialist/trace'
import { specialistHookRunner } from './specialist/hooks'
import type { BeforeRunContext } from './specialist/hooks'
import { messageBus } from './specialist/message-bus'
import { createScheduler } from './specialist/scheduling'
import type {
  SchedulingStrategy,
  SchedulingContext,
  AgentCapability
} from './specialist/scheduling'
import { validateInvestigationReport, buildFallbackReport } from './specialist/structured-output'
import { specialistRateLimiter } from './specialist/rate-limiter'
import { createStructuredLogger } from './specialist/structured-log'
import { codeGraphMcpService } from './code-graph.tool'
import { semanticSearchMcpService } from './semantic-search.tool'
import { gitContextMcpService } from './git-context.tool'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

/** Retry configuration for specialist tasks */
const RETRY_CONFIG = {
  maxRetries: 2, // Max 2 retries (3 total attempts)
  baseDelayMs: 2000, // 2s initial delay
  maxDelayMs: 30000, // 30s max delay
  backoffMultiplier: 2, // Exponential backoff
  rateLimitDelayMs: 10000 // Longer delay for rate-limited retries
}

/** Maximum time (ms) a specialist process can run before being killed — 10 minutes */
const SPECIALIST_TIMEOUT_MS = 10 * 60 * 1000
/** Circuit breaker threshold — consecutive spawn failures before stopping all tasks */
const CIRCUIT_BREAKER_THRESHOLD = 5
/** Maximum number of specialist processes running simultaneously — prevents resource exhaustion */
const MAX_CONCURRENT_SPECIALISTS = 4

/**
 * Model escalation chain — on failure retry, escalate to a more capable model.
 * Maps current tier → next tier. 'opus' is the highest, no further escalation.
 */
const MODEL_ESCALATION_CHAIN: Record<string, ModelTier> = {
  haiku: 'sonnet',
  sonnet: 'opus'
  // opus has no escalation — it's already the most capable
}

/** Maps a ModelTier to the corresponding specialist ModelAction */
function tierToModelAction(tier: string): import('../../shared/types').ModelAction {
  switch (tier) {
    case 'haiku':
      return 'specialist:simple'
    case 'sonnet':
      return 'specialist:moderate'
    case 'opus':
      return 'specialist:complex'
    default:
      return 'specialist:moderate'
  }
}

interface SpecialistProcessInfo {
  task: DecomposedTask
  output: string
  status: TaskExecutionProgress['status']
  worktreeId?: string
  dbSessionId?: string
  attempt: number
  rateLimited?: boolean
  timeoutTimer?: ReturnType<typeof setTimeout>
  /** Accumulated token usage from stream events (input + output) */
  tokenUsage: number
  /** Granular input token count */
  inputTokens: number
  /** Granular output token count */
  outputTokens: number
  /** Cache read tokens (prompt caching) */
  cacheReadTokens: number
  /** Cache creation tokens (prompt caching) */
  cacheCreationTokens: number
  /** Track model escalations during retries */
  escalations: { fromModel: string; toModel: string; attempt: number }[]
  /** AbortController for cancelling in-flight SDK queries */
  abortController?: AbortController
  /** Number of tool calls made during execution */
  toolCallCount: number
}

/**
 * Manages parallel and sequential execution of decomposed specialist tasks.
 *
 * Events emitted:
 * - `taskProgress`: TaskExecutionProgress — per-task status updates
 * - `taskChunk`: { taskId, specialist, chunk } — streaming output per task
 * - `allComplete`: void — all tasks finished
 */
export class SpecialistPoolService extends EventEmitter {
  /** Max SDK agentic turns for plan-mode specialists */
  private static readonly MAX_SPECIALIST_PLAN_TURNS = 8
  /** Max SDK agentic turns for build-mode specialists */
  private static readonly MAX_SPECIALIST_BUILD_TURNS = 50
  /** Hard circuit breaker — abort specialist after this many tool calls */
  private static readonly MAX_SPECIALIST_TOOL_CALLS = 75
  /** Hard circuit breaker for plan-mode tool calls (investigations need ≤10-12 reads) */
  private static readonly MAX_SPECIALIST_PLAN_TOOL_CALLS = 12
  /** S6: Investigation depth budgets — controls turn/tool limits for plan-mode specialists */
  private static readonly DEPTH_BUDGETS: Record<
    InvestigationDepth,
    { maxTurns: number; maxToolCalls: number }
  > = {
    quick: { maxTurns: 3, maxToolCalls: 5 },
    standard: {
      maxTurns: SpecialistPoolService.MAX_SPECIALIST_PLAN_TURNS,
      maxToolCalls: SpecialistPoolService.MAX_SPECIALIST_PLAN_TOOL_CALLS
    },
    deep: { maxTurns: 15, maxToolCalls: 25 }
  } as const
  // S9: Conclusive patterns moved to specialist/task-scheduler.ts
  // Use getConclusivePatterns() for pattern access

  private readonly log = specialistPoolLogger
  private readonly slog = createStructuredLogger(specialistPoolLogger)
  private workspacePath: string | null = null
  private workspaceId: string | null = null
  private conversationId: string | null = null
  private activeProcesses: Map<string, SpecialistProcessInfo> = new Map()
  private completedTasks: Set<string> = new Set()
  private taskResults: Map<string, string> = new Map()
  /** Track final status per task for runSpecialistTask result checking */
  private taskStatuses: Map<string, TaskExecutionProgress['status']> = new Map()
  private aborted: boolean = false
  /** Enriched handoff context from the generalist, injected into specialist prompts */
  private conversationBrief: HandoffBrief | null = null
  /** Circuit breaker: consecutive spawn failures across all tasks */
  private consecutiveSpawnFailures = 0
  /** S6: Current investigation depth (defaults to standard) */
  private investigationDepth: InvestigationDepth = 'standard'
  /** Async semaphore for concurrency control (replaces manual counting) */
  private readonly semaphore = new Semaphore(MAX_CONCURRENT_SPECIALISTS)
  /** Pluggable scheduling strategy — dependency-first is the natural default */
  private readonly schedulingStrategy: SchedulingStrategy = createScheduler('dependency-first')
  /** Current trace run ID for structured tracing correlation */
  private currentRunId: string | null = null

  setWorkspacePath(path: string): void {
    this.workspacePath = path
  }

  setWorkspaceId(id: string): void {
    this.workspaceId = id
  }

  setConversationBrief(brief: HandoffBrief | null): void {
    this.conversationBrief = brief
  }

  setConversationId(id: string): void {
    this.conversationId = id
  }

  setInvestigationDepth(depth: InvestigationDepth): void {
    this.investigationDepth = depth
  }

  /**
   * Executes tasks sequentially — one at a time in dependency order.
   */
  async executeSequential(tasks: DecomposedTask[], mode: ConversationMode): Promise<void> {
    this.reset()
    // Start trace run for execution timeline correlation
    this.currentRunId = executionTracer.startRun(`sequential-execution: ${tasks.length} tasks`, {
      mode,
      taskCount: tasks.length,
      strategy: 'sequential'
    })
    messageBus.reset() // Fresh message bus per execution run
    messageBus.setPersistenceContext({
      conversationId: this.conversationId ?? undefined,
      runId: this.currentRunId ?? undefined
    })

    // Check budget before execution
    if (this.workspacePath) {
      try {
        const allWs = workspaceRepository.findAll()
        const ws = allWs.find((w) => w.repoPath === this.workspacePath)
        if (ws) {
          const budget = costTrackerService.checkBudget(ws.id)
          if (budget.dailyExceeded) {
            this.log.warn(`Budget exceeded for workspace ${ws.id} — aborting execution`)
            this.emit('allComplete')
            return
          }
        }
      } catch (err) {
        this.log.warn('Budget check failed (continuing execution):', err)
      }
    }

    // Auto-checkpoint before execution
    if (this.workspacePath && this.conversationId) {
      try {
        checkpointService.createPreExecutionCheckpoint({
          conversationId: this.conversationId,
          workspacePath: this.workspacePath,
          tasks
        })
      } catch (err) {
        this.log.warn('Failed to create pre-execution checkpoint:', err)
      }
    }

    const ordered = this.topologicalSort(tasks)

    for (const task of ordered) {
      if (this.aborted) break

      this.emitProgress(task, 'running')
      try {
        const output = await this.runSpecialistTask(task, mode)
        this.taskResults.set(task.id, output)
        this.completedTasks.add(task.id)
        this.emitProgress(task, 'completed', output)
      } catch (error) {
        this.emitProgress(task, 'failed', undefined, (error as Error).message)
        // Continue with remaining tasks — downstream dependents will still run
        // but without the output context from this failed task
      }
    }

    // End trace run
    if (this.currentRunId) {
      executionTracer.endRun(this.currentRunId, { tasksCompleted: this.completedTasks.size })
      this.currentRunId = null
    }
    this.emit('allComplete')
  }

  /**
   * Executes tasks in parallel, respecting dependency ordering.
   * Tasks with no unmet dependencies start immediately.
   * When a task completes, any newly-unblocked tasks are started.
   */
  async executeParallel(tasks: DecomposedTask[], mode: ConversationMode): Promise<void> {
    this.reset()
    // Start trace run for execution timeline correlation
    this.currentRunId = executionTracer.startRun(`parallel-execution: ${tasks.length} tasks`, {
      mode,
      taskCount: tasks.length,
      strategy: 'parallel'
    })
    messageBus.reset() // Fresh message bus per execution run
    messageBus.setPersistenceContext({
      conversationId: this.conversationId ?? undefined,
      runId: this.currentRunId ?? undefined
    })

    // Check budget before execution
    if (this.workspacePath) {
      try {
        const allWs = workspaceRepository.findAll()
        const ws = allWs.find((w) => w.repoPath === this.workspacePath)
        if (ws) {
          const budget = costTrackerService.checkBudget(ws.id)
          if (budget.dailyExceeded) {
            this.log.warn(`Budget exceeded for workspace ${ws.id} — aborting execution`)
            this.emit('allComplete')
            return
          }
        }
      } catch (err) {
        this.log.warn('Budget check failed (continuing execution):', err)
      }
    }

    // Auto-checkpoint before execution
    if (this.workspacePath && this.conversationId) {
      try {
        checkpointService.createPreExecutionCheckpoint({
          conversationId: this.conversationId,
          workspacePath: this.workspacePath,
          tasks
        })
      } catch (err) {
        this.log.warn('Failed to create pre-execution checkpoint:', err)
      }
    }

    // Initialize file-based artifact chain for inter-agent communication
    if (this.workspacePath && this.conversationId) {
      try {
        await taskArtifactService.initConversation(
          this.workspacePath,
          this.conversationId,
          tasks,
          mode
        )
      } catch (err) {
        this.log.warn('Failed to initialize task artifacts:', err)
      }
    }

    // Initialize task loops for each task
    for (const task of tasks) {
      taskLoopService.initLoop(task.id, task.specialist)
    }

    const pending = new Map<string, DecomposedTask>()
    for (const task of tasks) {
      pending.set(task.id, task)
    }

    return new Promise<void>((resolve) => {
      const tryStartReady = (): void => {
        if (this.aborted) return

        // Use scheduling strategy to rank pending tasks by priority
        const schedulingContext: SchedulingContext = {
          pendingTasks: [...pending.values()],
          activeTasks: new Set(this.activeProcesses.keys()),
          completedTasks: this.completedTasks,
          agents: this.buildAgentCapabilities()
        }

        const ranked = this.schedulingStrategy.rankTasks(schedulingContext)

        let startedInRound = 0
        for (const { task } of ranked) {
          if (this.aborted) break
          if (!this.semaphore.available) {
            this.slog.concurrencyEvent({
              event: 'limit_reached',
              active: this.semaphore.active,
              max: MAX_CONCURRENT_SPECIALISTS,
              queued: pending.size
            })
            break
          }

          if (!this.activeProcesses.has(task.id)) {
            pending.delete(task.id)
            startedInRound++
            this.startTask(task, mode, () => {
              // On task completion, check if more tasks can start
              if (pending.size === 0 && this.activeProcesses.size === 0) {
                if (this.currentRunId) {
                  executionTracer.endRun(this.currentRunId, {
                    tasksCompleted: this.completedTasks.size
                  })
                  this.currentRunId = null
                }
                this.emit('allComplete')
                resolve()
              } else {
                tryStartReady()
              }
            })
          }
        }

        if (ranked.length > 0) {
          this.slog.schedulingDecision({
            strategy: this.schedulingStrategy.name,
            rankedCount: ranked.length,
            startedCount: startedInRound,
            pendingCount: pending.size
          })
        }

        // If nothing is running and nothing is pending, we're done
        if (pending.size === 0 && this.activeProcesses.size === 0) {
          if (this.currentRunId) {
            executionTracer.endRun(this.currentRunId, { tasksCompleted: this.completedTasks.size })
            this.currentRunId = null
          }
          this.emit('allComplete')
          resolve()
        }
      }

      tryStartReady()
    })
  }

  /**
   * Starts a single specialist task process and handles its lifecycle.
   * Creates an isolated worktree for each specialist when in build mode.
   *
   * Before spawning, consults the scheduling strategy's selectAgent() to check
   * if a better-suited specialist is available. If so, dynamically reassigns
   * the task (e.g., from a busy agent to a less-busy one with matching capabilities).
   */
  private startTask(task: DecomposedTask, mode: ConversationMode, onDone: () => void): void {
    // Dynamic agent reassignment — ask scheduler if a different specialist is better suited
    const agentCapabilities = this.buildAgentCapabilities()
    const recommendedAgent = this.schedulingStrategy.selectAgent(task, agentCapabilities)
    if (recommendedAgent && recommendedAgent !== task.specialist) {
      // Verify the recommended agent exists in the DB before reassigning
      const agentDef = specialistRepository.findByAgentId(recommendedAgent)
      if (agentDef) {
        this.log.info(
          `[SCHEDULING:reassign] Task ${task.id} reassigned from ${task.specialist} to ${recommendedAgent}`
        )
        // Trace the reassignment for observability
        if (this.currentRunId) {
          executionTracer.traceEvent(this.currentRunId, 'dependency_resolved', {
            taskId: task.id,
            agentId: recommendedAgent,
            message: `Dynamic reassignment: ${task.specialist} → ${recommendedAgent}`,
            metadata: {
              previousAgent: task.specialist,
              reason: 'scheduling-strategy-recommendation'
            }
          })
        }
        task.specialist = recommendedAgent
      }
    }

    this.emitProgress(task, 'running')

    // Create worktree for isolation, then spawn the specialist
    this.createWorktreeAndSpawn(task, mode, onDone)
  }

  /**
   * Creates a worktree (if in build mode) and spawns the specialist process.
   * If `existingWorktreeId` is provided, reuses that worktree (for task loop retries).
   */
  private async createWorktreeAndSpawn(
    task: DecomposedTask,
    mode: ConversationMode,
    onDone: () => void,
    attempt: number = 0,
    existingWorktreeId?: string
  ): Promise<void> {
    await this.semaphore.run(async () => {
      let worktreeId: string | undefined = existingWorktreeId

      // Reuse existing worktree for task loop retries, otherwise create a new one
      if (worktreeId) {
        this.log.info(
          `Reusing worktree ${worktreeId} for ${task.specialist}/${task.id} (task loop iteration)`
        )
      } else if (mode === 'build' && this.workspacePath && this.conversationId) {
        try {
          const worktreePath = await gitWorktreeService.create(
            this.workspacePath,
            task.specialist,
            task.id,
            this.conversationId
          )
          const worktreeRecord = worktreeRepository.findByTaskId(task.id)
          worktreeId = worktreeRecord?.id
          this.log.info(`Worktree created for ${task.specialist}/${task.id}: ${worktreePath}`)
        } catch (error) {
          this.log.warn(
            `Failed to create worktree for ${task.specialist}/${task.id}, falling back to shared cwd:`,
            error
          )
        }
      }

      // ── SDK execution path — no ChildProcess needed ──
      {
        this.log.info(`Running ${task.specialist}/${task.id} via SDK`)
        // Start trace span for this specialist execution
        let traceSpan: TraceSpan | undefined
        if (this.currentRunId) {
          traceSpan = executionTracer.startSpan(this.currentRunId, 'specialist_start', {
            agentId: task.specialist,
            taskId: task.id,
            message: `Starting ${task.specialist} for task ${task.id}`,
            metadata: { mode, attempt, model: task.model, conversationId: this.conversationId }
          })
        }
        // Create DB session for token tracking (SDK path)
        let dbSessionId: string | undefined
        try {
          const sessionAction = task.model ? tierToModelAction(task.model) : 'specialist:moderate'
          const sessionModelId = modelConfigService.getModel(
            this.workspacePath ?? undefined,
            sessionAction
          )
          const session = agentSessionRepository.create(task.specialist, {
            taskId: task.id,
            pid: undefined,
            conversationId: this.conversationId ?? undefined,
            workspaceId: undefined,
            complexityScore: task.complexity?.total,
            modelUsed: sessionModelId,
            complexityTier: task.complexity?.tier
          })
          dbSessionId = session.id
        } catch (err) {
          this.log.error('Failed to create DB session for specialist (SDK):', err)
        }

        const info: SpecialistProcessInfo = {
          task,
          output: '',
          status: 'running',
          worktreeId,
          dbSessionId,
          attempt,
          tokenUsage: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          escalations: [],
          toolCallCount: 0
        }

        // Agent started event now handled by trace-bridge via specialist_start span
        this.activeProcesses.set(task.id, info)

        try {
          await this.runSpecialistViaSDK(task, mode, info, worktreeId)

          // End trace span on success — capture durationMs for afterRun consistency
          let spanDurationMs = 0
          if (traceSpan) {
            spanDurationMs = executionTracer.endSpan(traceSpan, {
              tokenUsage: {
                input: info.inputTokens,
                output: info.outputTokens,
                cacheRead: info.cacheReadTokens,
                cacheCreation: info.cacheCreationTokens
              },
              message: `Completed ${task.specialist}/${task.id}`
            })
          }

          // Run afterRun hooks (observation only — errors caught internally)
          await specialistHookRunner.runAfterRun(task.specialist, {
            task,
            output: info.output,
            success: true,
            tokenUsage: {
              input: info.inputTokens,
              output: info.outputTokens,
              cacheRead: info.cacheReadTokens,
              cacheCreation: info.cacheCreationTokens
            },
            durationMs: spanDurationMs,
            toolCallCount: info.toolCallCount,
            attempt
          })

          // Success path — reuse existing completion logic
          this.activeProcesses.delete(task.id)
          this.completedTasks.add(task.id)
          this.taskResults.set(task.id, info.output)
          this.consecutiveSpawnFailures = 0

          // Complete DB session with granular token breakdown
          if (info.dbSessionId) {
            try {
              agentSessionRepository.completeWithBreakdown(info.dbSessionId, 'completed', {
                total: info.tokenUsage,
                input: info.inputTokens,
                output: info.outputTokens,
                cacheRead: info.cacheReadTokens,
                cacheCreation: info.cacheCreationTokens
              })
            } catch (err) {
              this.log.error('Failed to complete DB session:', err)
            }
          }

          // Post-completion analysis
          this.runPostCompletionAnalysis(task, info)

          // Broadcast task result to the message bus for downstream specialists
          messageBus.broadcast({
            from: task.specialist,
            type: 'dependency',
            content:
              info.output.length > 2000
                ? info.output.substring(0, 2000) + '\n... (truncated)'
                : info.output,
            taskId: task.id,
            metadata: { status: 'completed', tokenUsage: info.tokenUsage }
          })

          // Write output artifact
          if (this.workspacePath && this.conversationId) {
            taskArtifactService
              .writeTaskOutput(
                this.workspacePath,
                this.conversationId,
                task.id,
                info.output,
                'completed'
              )
              .catch((err) => this.log.warn('Failed to write task output artifact:', err))
          }

          // Run quality gates
          const gateCwd = info.worktreeId
            ? (worktreeRepository.findById(info.worktreeId)?.worktreePath ?? this.workspacePath!)
            : this.workspacePath!

          await this.runTaskLoopGates(task, info, mode, gateCwd, onDone).catch((err) => {
            this.log.error(`Task loop gate evaluation failed for ${task.id}:`, err)
            this.finalizeTaskCompletion(task, info)
            onDone()
          })
          return
        } catch (error) {
          // Emit error as visible chat chunk so user sees what happened
          this.emit('taskChunk', {
            taskId: task.id,
            specialist: task.specialist,
            chunk: `\n\n❌ **Error:** ${(error as Error).message}\n`
          })

          // End trace span on error — capture durationMs for afterRun consistency
          let errorSpanDurationMs = 0
          if (traceSpan) {
            errorSpanDurationMs = executionTracer.endSpan(traceSpan, {
              error: (error as Error).message,
              tokenUsage: {
                input: info.inputTokens,
                output: info.outputTokens,
                cacheRead: info.cacheReadTokens,
                cacheCreation: info.cacheCreationTokens
              }
            })
          }

          // Run afterRun hooks on failure
          await specialistHookRunner.runAfterRun(task.specialist, {
            task,
            output: info.output,
            success: false,
            error: (error as Error).message,
            tokenUsage: {
              input: info.inputTokens,
              output: info.outputTokens,
              cacheRead: info.cacheReadTokens,
              cacheCreation: info.cacheCreationTokens
            },
            durationMs: errorSpanDurationMs,
            toolCallCount: info.toolCallCount,
            attempt
          })

          // Error path — handle retry/circuit-breaker
          this.activeProcesses.delete(task.id)
          info.status = 'failed'
          this.taskStatuses.set(task.id, 'failed')

          // Complete DB session with error (granular token breakdown)
          if (info.dbSessionId) {
            try {
              agentSessionRepository.completeWithBreakdown(info.dbSessionId, 'failed', {
                total: info.tokenUsage,
                input: info.inputTokens,
                output: info.outputTokens,
                cacheRead: info.cacheReadTokens,
                cacheCreation: info.cacheCreationTokens
              })
            } catch (dbErr) {
              this.log.error('Failed to complete DB session on error:', dbErr)
            }
          }

          // Check if retryable — circuit breaker errors should NOT retry (retrying a loop just loops again)
          const isCircuitBreakerError =
            (error as Error).message.includes('exceeded') &&
            (error as Error).message.includes('tool calls')
          const isRetryable =
            !this.aborted && !isCircuitBreakerError && info.attempt < RETRY_CONFIG.maxRetries
          if (isRetryable) {
            const delay = Math.min(
              RETRY_CONFIG.baseDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, info.attempt),
              RETRY_CONFIG.maxDelayMs
            )

            this.slog.taskRetried({
              taskId: task.id,
              agentId: task.specialist,
              model: task.model,
              attempt: info.attempt + 1,
              maxRetries: RETRY_CONFIG.maxRetries,
              reason: `SDK execution failed: ${(error as Error).message}`,
              durationMs: delay
            })
            // Trace retry event — bridge auto-logs to EventLogger
            if (this.currentRunId) {
              executionTracer.traceEvent(this.currentRunId, 'task_retry', {
                agentId: task.specialist,
                taskId: task.id,
                message: `Retry ${info.attempt + 1}/${RETRY_CONFIG.maxRetries} in ${delay}ms`,
                metadata: {
                  delay,
                  attempt: info.attempt + 1,
                  error: (error as Error).message,
                  conversationId: this.conversationId
                }
              })
            }

            // Clean up worktree before retry
            if (info.worktreeId) {
              gitWorktreeService.remove(info.worktreeId, true).catch((err) => {
                this.log.warn(`Failed to remove worktree before retry: ${err}`)
              })
            }

            this.completedTasks.delete(task.id)
            this.taskResults.delete(task.id)

            // Semaphore auto-released by sem.run() — next attempt will re-acquire
            setTimeout(() => {
              this.createWorktreeAndSpawn(task, mode, onDone, info.attempt + 1)
            }, delay)
            return
          }

          // Retries exhausted — task settled as failed (not a crash, just a result)
          // Agent failure already logged by trace-bridge via specialist_end span
          this.consecutiveSpawnFailures++
          this.log.info(`Task ${task.id} settled as failed — continuing parallel execution`)
          this.emitProgress(task, 'failed', undefined, (error as Error).message)

          if (this.consecutiveSpawnFailures >= CIRCUIT_BREAKER_THRESHOLD) {
            this.log.error(
              `Circuit breaker tripped: ${this.consecutiveSpawnFailures} consecutive failures`
            )
            eventLoggerService.logCircuitBreakerTripped({
              conversationId: this.conversationId ?? undefined,
              failures: this.consecutiveSpawnFailures
            })
            this.emit('circuitBreakerTripped', { failures: this.consecutiveSpawnFailures })
            this.stopAll()
            return
          }

          if (info.worktreeId) {
            worktreeRepository.updateStatus(info.worktreeId, 'abandoned')
          }

          // Semaphore auto-released by sem.run() — continue parallel execution
          onDone()
          return
        }
      }
    }) // end semaphore.run()
  }

  /**
   * Builds the specialist context (system prompt, full prompt, cwd, model).
   * Used by the SDK execution path.
   */
  private async buildSpecialistContext(
    task: DecomposedTask,
    mode: ConversationMode,
    worktreeId?: string
  ): Promise<{
    systemPrompt: string
    fullPrompt: string
    cwd: string
    modelId: string
    thinkingBudget: string
  }> {
    // Resolve specialist prompt from DB
    const specialist = specialistRepository.findByAgentId(task.specialist)

    // Resolve skills from DB (specialist_skills junction table)
    const assignedSkills = specialist ? specialistRepository.getSkills(specialist.id) : []

    // Resolve per-conversation specialist overrides (skills enabled + skill subset)
    let skillsEnabled: boolean | undefined
    let skillOverrides: string[] | undefined
    if (this.conversationId && specialist?.id) {
      const override = conversationSpecialistRepository.findByConversationAndSpecialist(
        this.conversationId,
        specialist.id
      )
      if (override) {
        skillsEnabled = override.skillsEnabled
        skillOverrides = override.skillOverrides ?? undefined
      }
    }

    // Resolve feedback memories
    let feedbackContext: string | undefined
    try {
      if (this.workspacePath) {
        const allWs = workspaceRepository.findAll()
        const ws = allWs.find((w) => w.repoPath === this.workspacePath)
        if (ws) {
          const ctx = memoryService.getFeedbackForSpecialist(ws.id, task.specialist, 2000)
          if (ctx) feedbackContext = ctx
        }
      }
    } catch {
      // Feedback memories unavailable — not critical
    }

    // Model-aware prompt budgeting
    const model = task.model ?? 'sonnet'
    const budgetTier: BudgetTier =
      model === 'haiku' ? 'minimal' : model === 'opus' ? 'full' : 'standard'

    // Build system prompt via centralized PromptBuilder
    const promptOptions: Parameters<typeof promptBuilder.build>[0] & {
      skillsEnabled?: boolean
      skillOverrides?: string[]
    } = {
      role: 'specialist',
      mode,
      specialistId: task.specialist,
      specialistPrompt: specialist?.prompt || undefined,
      assignedSkills,
      workspacePath: this.workspacePath!,
      brief: this.conversationBrief || undefined,
      feedbackContext,
      budgetTier,
      // S2: Only load skills for moderate+ complexity tasks (complexity >= 5)
      // Strategy D: Also skip skills for single-file changes — skills are implementation guides
      // for multi-file architectural work, not needed for simple one-file fixes.
      // This saves 400-1,140 tokens per specialist call for simple tasks.
      skillsEnabled: (task.complexity?.total ?? 5) >= 5 && (task.complexity?.filesAffected ?? 1) > 1
    }
    if (skillsEnabled !== undefined) {
      promptOptions.skillsEnabled = skillsEnabled
    }
    if (skillOverrides) {
      promptOptions.skillOverrides = skillOverrides
    }
    const systemPrompt = promptBuilder.build(promptOptions)

    // Build context from completed dependency outputs
    let dependencyContext = ''
    for (const depId of task.dependsOn) {
      let depOutput: string | null = null
      if (this.workspacePath && this.conversationId) {
        try {
          depOutput = await taskArtifactService.readTaskOutput(
            this.workspacePath,
            this.conversationId,
            depId
          )
        } catch {
          // Artifact unavailable — fall back to in-memory
        }
      }
      if (!depOutput) {
        depOutput = this.taskResults.get(depId) ?? null
      }
      if (depOutput) {
        const maxLen = budgetTier === 'minimal' ? 1000 : budgetTier === 'full' ? 8000 : 4000
        dependencyContext += `\n\n[Previous task ${depId} output]:\n${depOutput.substring(0, maxLen)}`
        if (depOutput.length > maxLen) {
          dependencyContext += `\n[Output truncated — ${depOutput.length - maxLen} chars omitted]`
        }
      }
    }

    // Write task input artifact for auditability
    if (this.workspacePath && this.conversationId) {
      const depOutputs = new Map<string, string>()
      for (const depId of task.dependsOn) {
        const out = this.taskResults.get(depId)
        if (out) depOutputs.set(depId, out)
      }
      taskArtifactService
        .writeTaskInput(this.workspacePath, this.conversationId, task, depOutputs)
        .catch((err) => this.log.warn('Failed to write task input artifact:', err))
    }

    // Append verification command
    const verificationSuffix = task.verificationCommand
      ? `\n\nVerification command (run before finishing): \`${task.verificationCommand}\``
      : ''

    let scopeConstraint = ''
    if (this.conversationBrief?.filesDiscussed?.length) {
      scopeConstraint = [
        '\n\nSCOPE CONSTRAINT: Focus exclusively on these files and their immediate dependencies:',
        ...this.conversationBrief.filesDiscussed.map((f) => `- ${f}`),
        'Do NOT explore unrelated parts of the codebase.'
      ].join('\n')
    }

    // Strategy 8: Build dynamic per-task context (brief + feedback) as user prompt prefix
    // instead of system prompt suffix. This keeps the system prompt stable across tasks
    // for the same specialist, maximizing Claude prompt cache hits (90% discount).
    const dynamicContext = promptBuilder.buildDynamicContext({
      role: 'specialist',
      brief: this.conversationBrief || undefined,
      feedbackContext,
      budgetTier
    })

    // Strategy K: Depth-aware investigation instructions.
    // For "quick" depth, the specialist skips verbose investigation-report formatting
    // and answers directly — saves ~300 tokens of report overhead + reduces file reads.
    const depthInstructions: Record<string, string> = {
      quick:
        'QUICK INVESTIGATION: Read ≤3 files. One-paragraph answer. No investigation-report block needed — just answer the question directly.\n\n',
      standard: '',
      deep: 'DEEP INVESTIGATION: Thorough analysis. Check all related files, trace dependencies, verify assumptions.\n\n'
    }
    const depthPrefix = depthInstructions[this.investigationDepth] ?? ''

    // Strategy 5: Ultra-minimal haiku prompt — skip scope constraint and dependency context
    // for minimal-budget tasks. Haiku tasks are single-file, don't need extra guidance (~340 tokens saved).
    let fullPrompt =
      budgetTier === 'minimal'
        ? task.description
        : `${depthPrefix}${dynamicContext}${task.description}${scopeConstraint}${verificationSuffix}${dependencyContext}`

    // Inject inter-agent messages from the bus (dependency task outputs, findings, etc.)
    const unreadMessages = messageBus.getUnread(task.specialist)
    if (unreadMessages.length > 0) {
      const busContext = unreadMessages
        .map((msg) => `[From ${msg.from}] (${msg.type}): ${msg.content}`)
        .join('\n')
      fullPrompt = `${fullPrompt}\n\n<inter-agent-context>\nMessages from other specialists:\n${busContext}\n</inter-agent-context>`
    }

    // Prompt size estimation
    const promptCheck = PromptBuilder.checkPromptSize(systemPrompt, fullPrompt, model)
    if (promptCheck.warning) {
      this.log.warn(`[${task.specialist}/${task.id}] ${promptCheck.warning}`)
    }

    // Resolve model
    const modelAction = task.model ? tierToModelAction(task.model) : 'specialist:moderate'
    const modelId = modelConfigService.getModel(this.workspacePath ?? undefined, modelAction)

    // Thinking budget
    const thinkingBudget =
      THINKING_BUDGETS[model as keyof typeof THINKING_BUDGETS] ?? THINKING_BUDGETS.sonnet

    // Resolve cwd
    let cwd = this.workspacePath!
    if (worktreeId) {
      const worktreeRecord = worktreeRepository.findById(worktreeId)
      if (worktreeRecord) {
        cwd = worktreeRecord.worktreePath
      }
    }

    return { systemPrompt, fullPrompt, cwd, modelId, thinkingBudget }
  }

  /**
   * Runs a specialist task via the Agent SDK (no child process).
   * Produces the same events as CLI-based execution.
   */
  private async runSpecialistViaSDK(
    task: DecomposedTask,
    mode: ConversationMode,
    info: SpecialistProcessInfo,
    worktreeId?: string
  ): Promise<void> {
    const context = await this.buildSpecialistContext(task, mode, worktreeId)

    // Mutable hook context — hooks can modify systemPrompt, fullPrompt, model
    const hookContext: BeforeRunContext = {
      task,
      mode,
      systemPrompt: context.systemPrompt,
      fullPrompt: context.fullPrompt,
      cwd: context.cwd,
      model: context.modelId,
      modelTier: task.model,
      attempt: info.attempt,
      conversationId: this.conversationId ?? undefined
    }

    // Run beforeRun hooks — can modify prompts, model, etc.
    await specialistHookRunner.runBeforeRun(task.specialist, hookContext)

    // Use potentially modified values from hooks
    const { systemPrompt, fullPrompt, cwd } = hookContext
    const modelId = hookContext.model
    const thinkingBudget = context.thinkingBudget

    this.slog.specialistStarted({
      taskId: task.id,
      agentId: task.specialist,
      model: task.model ?? 'sonnet',
      mode,
      cwd
    })

    // Create AbortController for cancellation support (stopAll)
    const abortController = new AbortController()
    info.abortController = abortController

    let toolCallCount = 0
    const isPlanModeSpecialist = mode === 'plan'
    const descLower = task.description.toLowerCase()
    const isInvestigationTask =
      descLower.includes('investigation report') ||
      descLower.includes('investigate') ||
      descLower.includes('analyze') ||
      descLower.includes('diagnose') ||
      descLower.includes('audit') ||
      descLower.includes('review')
    // Strategy 11: Enable early exit for investigation tasks in ANY mode (not just plan).
    // Build-mode tasks with investigation keywords (e.g. "investigate before fixing") should also
    // benefit from early exit once the investigation conclusion is reached.
    const shouldEarlyExitOnReport = isInvestigationTask
    const depthBudget = SpecialistPoolService.DEPTH_BUDGETS[this.investigationDepth]
    const maxToolCalls = isPlanModeSpecialist
      ? depthBudget.maxToolCalls
      : SpecialistPoolService.MAX_SPECIALIST_TOOL_CALLS
    const maxTurns = isPlanModeSpecialist
      ? depthBudget.maxTurns
      : SpecialistPoolService.MAX_SPECIALIST_BUILD_TURNS
    const reportRegex = /```investigation-report\s*\n([\s\S]*?)```/
    let abortedAfterReportDetection = false

    // Strategy L: Acquire rate limiter permit before firing SDK call.
    // Prevents cascading timeouts when parallel specialists exhaust the per-minute rate limit.
    const releasePermit = await specialistRateLimiter.acquire()

    // Build MCP server configs for specialist access to code graph + semantic search + git context
    const mcpServers: Record<string, McpServerConfig> = {}
    if (this.workspaceId && this.workspacePath) {
      Object.assign(
        mcpServers,
        codeGraphMcpService.getMcpServersConfig(this.workspaceId, this.workspacePath)
      )
      Object.assign(mcpServers, semanticSearchMcpService.getMcpServersConfig(this.workspaceId))
    }
    // Git context: always available to specialists
    if (this.workspacePath) {
      Object.assign(mcpServers, gitContextMcpService.getMcpServersConfig(this.workspacePath))
    }
    // NOTE: task-context, checkpoint-context, github-context are NOT exposed to specialists

    const executor = new SDKExecutor()
    try {
      for await (const chunk of executor.execute({
        prompt: fullPrompt,
        systemPrompt,
        model: modelId,
        cwd,
        permissionMode: mode === 'build' ? 'bypassPermissions' : 'plan',
        maxThinkingTokens: parseInt(thinkingBudget) || undefined,
        maxTurns,
        abortController,
        // Expose code graph + semantic search MCP tools to specialists
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {})
      })) {
        if ('_meta' in chunk && chunk._meta) {
          const meta = chunk._meta as SDKExecuteResult
          info.tokenUsage += meta.tokenUsage.input + meta.tokenUsage.output
          info.inputTokens += meta.tokenUsage.input
          info.outputTokens += meta.tokenUsage.output
          info.cacheReadTokens += meta.tokenUsage.cacheReadInputTokens
          info.cacheCreationTokens += meta.tokenUsage.cacheCreationInputTokens
          // S8: Log specialist prompt cache metrics
          const { cacheReadInputTokens, cacheCreationInputTokens } = meta.tokenUsage
          if (cacheReadInputTokens > 0 || cacheCreationInputTokens > 0) {
            this.log.info(
              `[PIPELINE:specialist-cache] ${task.specialist}/${task.id} read=${cacheReadInputTokens} creation=${cacheCreationInputTokens}`
            )
          }
        } else if (chunk.type === 'status' && chunk.content === 'heartbeat') {
          // Forward heartbeat for liveness detection
          this.emit('taskChunk', {
            taskId: task.id,
            specialist: task.specialist,
            chunk: '' // Empty chunk — renderer uses timestamp for liveness detection
          })
        } else if (chunk.type === 'text' && chunk.content) {
          info.output += chunk.content
          this.emit('taskChunk', {
            taskId: task.id,
            specialist: task.specialist,
            chunk: chunk.content
          })

          // S9: Detect any conclusive pattern (not just investigation-report)
          const matchedPattern =
            shouldEarlyExitOnReport && !abortedAfterReportDetection
              ? this.detectConclusivePattern(info.output)
              : null
          if (matchedPattern) {
            abortedAfterReportDetection = true
            this.log.info(
              `[PIPELINE:conclusive-pattern-early-exit] ${task.specialist}/${task.id} pattern=${matchedPattern}`
            )
            abortController.abort()
          }
        } else if (chunk.type === 'tool_use') {
          toolCallCount++
          info.toolCallCount = toolCallCount

          // Fire tool call observation hooks (best-effort, non-blocking)
          specialistHookRunner.fireToolCall(task.specialist, {
            task,
            toolName: chunk.toolName ?? 'Unknown',
            toolInput: chunk.toolInput ?? undefined,
            toolCallIndex: toolCallCount
          })

          if (toolCallCount >= maxToolCalls) {
            this.log.error(
              `Specialist circuit breaker: ${task.specialist} hit ${toolCallCount} tool calls on task ${task.id}`
            )
            abortController.abort()
            throw new Error(
              `Specialist ${task.specialist} exceeded ${maxToolCalls} tool calls — likely stuck in a loop`
            )
          }
          this.emit('taskChunk', {
            taskId: task.id,
            specialist: task.specialist,
            chunk: '',
            toolActivity: {
              type: 'tool_use',
              toolName: chunk.toolName ?? 'Unknown',
              toolId: chunk.toolId,
              input: chunk.toolInput ?? ''
            }
          })
        } else if (chunk.type === 'tool_result') {
          // Fire tool result observation hooks (best-effort, non-blocking)
          specialistHookRunner.fireToolResult(task.specialist, {
            task,
            toolName: chunk.toolName ?? 'Unknown',
            result: chunk.content ?? undefined,
            toolCallIndex: toolCallCount
          })

          this.emit('taskChunk', {
            taskId: task.id,
            specialist: task.specialist,
            chunk: '',
            toolActivity: {
              type: 'tool_result',
              toolName: chunk.toolName ?? 'Unknown',
              toolId: chunk.toolId,
              input: chunk.content ?? undefined
            }
          })
        } else if (chunk.type === 'error') {
          if (
            abortedAfterReportDetection &&
            typeof chunk.error === 'string' &&
            /abort/i.test(chunk.error)
          ) {
            this.log.debug(
              `[PIPELINE:investigation-report-early-exit] ${task.specialist}/${task.id} — received abort error chunk after report detection`
            )
            break
          }
          this.emit('taskChunk', {
            taskId: task.id,
            specialist: task.specialist,
            chunk: `\n⚠️ ${chunk.error}\n`
          })
          throw new Error(chunk.error)
        }
      }
    } catch (error) {
      const errorName =
        typeof error === 'object' && error !== null && 'name' in error
          ? String((error as { name: unknown }).name)
          : ''
      const errorMessage =
        error instanceof Error ? error.message : typeof error === 'string' ? error : ''
      const isAbortErrorByName = errorName === 'AbortError'
      const isAbortErrorByMessage = /abort/i.test(errorMessage)
      const isIntentionalEarlyExitAbort =
        abortedAfterReportDetection &&
        abortController.signal.aborted &&
        (isAbortErrorByName || isAbortErrorByMessage)
      if (!isIntentionalEarlyExitAbort) {
        releasePermit() // Strategy L: release rate limiter permit on error
        throw error
      }
    }

    // Strategy L: Release rate limiter permit after SDK call completes.
    // This happens on both success and intentional early-exit abort paths.
    releasePermit()

    // Detect investigation report in specialist output using structured validation.
    // Uses multi-strategy JSON extraction (code-fence → bracket-match → direct-parse)
    // plus schema validation with field-level error reporting.
    // GUARD: Only attempt structured report validation for investigation tasks.
    // Non-investigation specialists can emit JSON with matching field names (false positive).
    if (isInvestigationTask) {
      const validationResult = validateInvestigationReport(info.output)
      if (validationResult.success) {
        const report = validationResult.data
        this.log.info(
          `[PIPELINE:investigation-report-detected] ${task.specialist}/${task.id} strategy=${validationResult.strategy}`,
          {
            problem: report.problem?.substring(0, 80),
            impact: report.impact,
            filesAffected: report.filesAffected?.length ?? 0
          }
        )
        eventLoggerService.logInvestigationReportDetected({
          conversationId: this.conversationId ?? undefined,
          agentId: task.specialist,
          taskId: task.id,
          impact: report.impact,
          filesAffected: report.filesAffected?.length ?? 0
        })
        this.emit('investigationReport', {
          taskId: task.id,
          specialist: task.specialist,
          report
        })

        // Publish report to message bus for inter-agent communication
        messageBus.broadcast({
          from: task.specialist,
          type: 'finding',
          content: JSON.stringify(report),
          taskId: task.id,
          metadata: { reportType: 'investigation', impact: report.impact }
        })
      } else if (!validationResult.success && info.output.match(reportRegex)) {
        // Found a report block but validation failed — emit degraded report with specific errors
        this.log.error(
          `[PIPELINE:investigation-report-validation-failed] ${task.specialist}/${task.id}:`,
          validationResult.errors,
          '\nRaw text (first 500 chars):\n',
          validationResult.rawText
        )
        // Attempt to build a fallback from whatever fields are valid
        let partialData: Record<string, unknown> | null = null
        try {
          const match = info.output.match(reportRegex)
          if (match) partialData = JSON.parse(match[1].trim())
        } catch {
          /* ignore — fallback will use defaults */
        }

        this.emit('investigationReport', {
          taskId: task.id,
          specialist: task.specialist,
          report: buildFallbackReport(
            partialData,
            `Validation errors: ${validationResult.errors.join('; ')}`
          )
        })
      } else {
        // Investigation task that should have produced a report but didn't
        this.log.warn(
          `[PIPELINE:investigation-report-missing] ${task.specialist}/${task.id} — no block found`,
          `Output length: ${info.output.length} chars, last 200 chars: "${info.output.slice(-200)}"`
        )
        eventLoggerService.logInvestigationReportMissing({
          conversationId: this.conversationId ?? undefined,
          agentId: task.specialist,
          taskId: task.id,
          outputLength: info.output.length
        })
        // Emit fallback report so user knows the investigation ran
        this.emit('investigationReport', {
          taskId: task.id,
          specialist: task.specialist,
          report: buildFallbackReport(
            null,
            'The specialist did not emit an investigation-report block. Review the output above for findings.'
          )
        })
      }
    }
  }

  /**
   * Runs a specialist task and returns its full output (used by sequential mode).
   */
  private runSpecialistTask(task: DecomposedTask, mode: ConversationMode): Promise<string> {
    return new Promise((resolve, reject) => {
      this.startTask(task, mode, () => {
        const result = this.taskResults.get(task.id)
        // Check taskStatuses instead of activeProcesses (which is already deleted in exit handler)
        const status = this.taskStatuses.get(task.id)
        if (status === 'failed') {
          reject(new Error(`Task ${task.id} failed`))
        } else {
          resolve(result ?? '')
        }
      })
    })
  }

  /**
   * Topological sort for sequential execution — respects dependsOn ordering.
   * Delegates to extracted specialist/task-scheduler module.
   */
  private topologicalSort(tasks: DecomposedTask[]): DecomposedTask[] {
    return topologicalSortFn(tasks)
  }

  /**
   * Aborts all running specialist processes.
   */
  async stopAll(): Promise<void> {
    this.aborted = true

    // End trace run on abort — prevents memory leak in tracer's activeRuns map
    if (this.currentRunId) {
      executionTracer.endRun(this.currentRunId, { aborted: true })
      this.currentRunId = null
    }

    for (const [id, info] of this.activeProcesses) {
      this.log.info(`Stopping specialist: ${id}`)
      if (info.timeoutTimer) clearTimeout(info.timeoutTimer)

      // Abort SDK query via AbortController
      if (info.abortController) {
        this.log.info(`Aborting SDK query for task: ${id}`)
        info.abortController.abort()
      }
    }

    this.activeProcesses.clear()
  }

  private emitProgress(
    task: DecomposedTask,
    status: TaskExecutionProgress['status'],
    output?: string,
    error?: string
  ): void {
    const progress: TaskExecutionProgress = {
      taskId: task.id,
      specialist: task.specialist,
      status,
      output,
      error,
      model: task.model,
      complexityTier: task.complexity?.tier
    }
    this.emit('taskProgress', progress)
  }

  /**
   * Task loop gate evaluation — runs explicit quality gates after a specialist exits with code 0.
   * If gates fail and iterations remain, re-spawns the specialist with fix context in the same worktree.
   * If gates pass or iterations are exhausted, proceeds to normal completion (merge + onDone).
   */
  private async runTaskLoopGates(
    task: DecomposedTask,
    info: SpecialistProcessInfo,
    mode: ConversationMode,
    gateCwd: string,
    onDone: () => void
  ): Promise<void> {
    // Only run task loop in build mode — plan mode doesn't produce code to validate
    if (mode !== 'build') {
      this.finalizeTaskCompletion(task, info)
      onDone()
      return
    }

    const loopResult = await taskLoopService.evaluateAndAdvance(
      task.id,
      gateCwd,
      this.conversationId ?? undefined
    )

    // Write gate results as artifacts
    if (this.workspacePath && this.conversationId) {
      taskArtifactService
        .writeGateResults(
          this.workspacePath,
          this.conversationId,
          task.id,
          loopResult.state.gateHistory[loopResult.state.gateHistory.length - 1]?.gates ?? [],
          loopResult.state
        )
        .catch((err) => this.log.warn('Failed to write gate artifacts:', err))
    }

    if (loopResult.passed) {
      // All gates passed — finalize normally
      this.log.info(`Task ${task.id} passed quality gates on iteration ${loopResult.iterations}`)
      this.finalizeTaskCompletion(task, info)
      onDone()
      return
    }

    if (loopResult.iterations >= loopResult.state.maxIterations) {
      // Max iterations reached — complete with warning
      this.log.warn(
        `Task ${task.id} failed quality gates after ${loopResult.iterations} iterations — completing anyway`
      )
      this.emit('taskChunk', {
        taskId: task.id,
        specialist: task.specialist,
        chunk: `\n\n⚠️ Quality gates still failing after ${loopResult.iterations} fix attempts. Completing with known issues.`
      })
      this.finalizeTaskCompletion(task, info)
      onDone()
      return
    }

    // Gates failed, iterations remaining — re-spawn with fix context
    this.log.info(
      `Task ${task.id} failed quality gates (iteration ${loopResult.iterations}) — re-spawning with fix context`
    )

    // Model escalation on stuck detection
    if (loopResult.shouldEscalate) {
      const currentModel = task.model ?? 'sonnet'
      const escalatedModel = MODEL_ESCALATION_CHAIN[currentModel]
      if (escalatedModel) {
        const previousModel = task.model ?? 'sonnet'
        task.model = escalatedModel
        info.escalations.push({
          fromModel: previousModel,
          toModel: escalatedModel,
          attempt: info.attempt + 1
        })
        eventLoggerService.logModelEscalation({
          conversationId: this.conversationId ?? undefined,
          agentId: task.specialist,
          taskId: task.id,
          fromModel: previousModel,
          toModel: escalatedModel,
          reason: `Stuck detection — same gates failing for ${loopResult.iterations} iterations`,
          attempt: info.attempt + 1
        })
      }
    }

    // Append fix context to task description for retry
    task.description = task.description + loopResult.fixContext

    // Determine escalation info for this retry (last escalation if it just happened)
    const lastEscalation =
      info.escalations.length > 0 ? info.escalations[info.escalations.length - 1] : undefined
    const retryReason =
      loopResult.shouldEscalate && lastEscalation
        ? `Quality gate failure + model escalated from ${lastEscalation.fromModel} to ${lastEscalation.toModel}`
        : `Quality gate failure — retrying iteration ${loopResult.iterations + 1}/${loopResult.state.maxIterations}`

    this.emit('taskRetry', {
      taskId: task.id,
      specialist: task.specialist,
      attempt: loopResult.iterations,
      maxRetries: loopResult.state.maxIterations,
      escalation: lastEscalation
        ? { fromModel: lastEscalation.fromModel, toModel: lastEscalation.toModel }
        : undefined,
      reason: retryReason
    })

    // Structured retry event for persistent logging
    eventLoggerService.logTaskRetry({
      conversationId: this.conversationId ?? undefined,
      agentId: task.specialist,
      taskId: task.id,
      attempt: loopResult.iterations,
      maxRetries: loopResult.state.maxIterations,
      escalation: lastEscalation
        ? { fromModel: lastEscalation.fromModel, toModel: lastEscalation.toModel }
        : undefined,
      reason: retryReason
    })

    this.emit('taskChunk', {
      taskId: task.id,
      specialist: task.specialist,
      chunk: `\n\n🔄 Quality gate failure — retrying (iteration ${loopResult.iterations + 1}/${loopResult.state.maxIterations})…`
    })

    // Remove from completed to allow re-start
    this.completedTasks.delete(task.id)
    this.taskResults.delete(task.id)

    // Re-spawn in the SAME worktree (reuse for fix iteration)
    this.createWorktreeAndSpawn(task, mode, onDone, info.attempt, info.worktreeId)
  }

  /**
   * Finalize task completion — mark as completed, merge worktree, clean up task loop.
   */
  private finalizeTaskCompletion(task: DecomposedTask, info: SpecialistProcessInfo): void {
    // Guard against duplicate completion — can happen if both runTaskLoopGates
    // and its catch handler call finalizeTaskCompletion for the same task.
    if (this.taskStatuses.get(task.id) === 'completed') {
      this.log.warn(`[PIPELINE:duplicate-completion-blocked] taskId=${task.id} — already finalized`)
      return
    }

    info.status = 'completed'
    this.taskStatuses.set(task.id, 'completed')
    this.emitProgress(task, 'completed', info.output)

    // Clean up task loop state
    taskLoopService.cleanup(task.id)

    // Attempt to merge worktree if one was created
    if (info.worktreeId) {
      gitWorktreeService
        .merge(info.worktreeId)
        .then((mergeResult: MergeResult) => {
          if (!mergeResult.success) {
            this.log.warn(
              `Merge conflict for ${task.specialist}/${task.id}:`,
              mergeResult.conflictedFiles
            )
            this.emit('mergeConflict', {
              agentId: task.specialist,
              taskId: task.id,
              conflictedFiles: mergeResult.conflictedFiles ?? []
            })
          } else {
            // Clean up worktree after successful merge
            gitWorktreeService.remove(info.worktreeId!, true).catch((err) => {
              this.log.warn(`Failed to remove worktree after merge: ${err}`)
            })
          }
        })
        .catch((err) => {
          this.log.error(`Failed to merge worktree for ${task.specialist}/${task.id}:`, err)
          this.emit('mergeConflict', {
            agentId: task.specialist,
            taskId: task.id,
            conflictedFiles: []
          })
        })
    }
  }

  /**
   * Runs post-completion analysis on specialist output:
   * - Abandonment detection (give-up patterns)
   * - Quality gate detection (test/lint/build results)
   * Logs events and stores gate results in the DB.
   */
  private runPostCompletionAnalysis(task: DecomposedTask, info: SpecialistProcessInfo): void {
    try {
      // Abandonment detection
      const abandonment = detectAbandonment(info.output)
      if (abandonment.detected) {
        this.log.warn(
          `Abandonment detected in ${task.specialist}/${task.id}: "${abandonment.pattern}"`
        )
        eventLoggerService.logAbandonmentDetected({
          conversationId: this.conversationId ?? undefined,
          agentId: task.specialist,
          taskId: task.id,
          pattern: abandonment.pattern ?? 'unknown',
          context: abandonment.context
        })
        this.emit('abandonmentDetected', {
          taskId: task.id,
          specialist: task.specialist,
          pattern: abandonment.pattern
        })
      }

      // Quality gate detection
      const gates = detectQualityGates(info.output)
      for (const gate of gates) {
        eventLoggerService.logGateResult({
          conversationId: this.conversationId ?? undefined,
          agentId: task.specialist,
          taskId: task.id,
          gate
        })

        // Persist gate results to DB
        try {
          gateResultRepository.create({
            gateType: gate.type,
            passed: gate.passed,
            summary: gate.summary,
            sessionId: info.dbSessionId,
            conversationId: this.conversationId ?? undefined,
            taskId: task.id,
            agentId: task.specialist
          })
        } catch (err) {
          this.log.warn('Failed to persist gate result:', err)
        }

        if (!gate.passed) {
          this.log.warn(
            `Quality gate FAILED for ${task.specialist}/${task.id}: ${gate.type} — ${gate.summary}`
          )
          this.emit('gateFailure', {
            taskId: task.id,
            specialist: task.specialist,
            gate
          })
        }
      }

      // Agent completion event now handled by trace-bridge via specialist_end span
    } catch (err) {
      this.log.warn('Post-completion analysis failed:', err)
    }
  }

  /** S9: Identify which conclusive pattern matched (for logging).
   * Delegates to extracted specialist/task-scheduler module. */
  private detectConclusivePattern(output: string): string | null {
    return detectConclusivePatternFn(output)
  }

  /**
   * Strategy 15: Aggregate cache metrics across all tasks for the current/last execution.
   * Returns cache hit rate and token breakdown for the cache dashboard.
   */
  getCacheMetrics(): {
    totalInputTokens: number
    totalOutputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    cacheHitRate: number
    taskCount: number
  } {
    let totalInput = 0
    let totalOutput = 0
    let cacheRead = 0
    let cacheCreation = 0

    for (const info of this.activeProcesses.values()) {
      totalInput += info.inputTokens
      totalOutput += info.outputTokens
      cacheRead += info.cacheReadTokens
      cacheCreation += info.cacheCreationTokens
    }

    const totalCacheable = totalInput + cacheRead + cacheCreation
    const cacheHitRate = totalCacheable > 0 ? (cacheRead / totalCacheable) * 100 : 0

    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      cacheHitRate: Math.round(cacheHitRate * 10) / 10,
      taskCount: this.activeProcesses.size
    }
  }

  /**
   * Build agent capability descriptors from the DB for scheduling strategies.
   * Maps active specialists + live process counts into AgentCapability interface.
   */
  private buildAgentCapabilities(): AgentCapability[] {
    const dbSpecialists = specialistRepository.findActive()
    if (dbSpecialists.length === 0) return []

    // Count active tasks per agent
    const activeCountByAgent = new Map<string, number>()
    for (const info of this.activeProcesses.values()) {
      const agentId = info.task.specialist
      activeCountByAgent.set(agentId, (activeCountByAgent.get(agentId) ?? 0) + 1)
    }

    return dbSpecialists.map((specialist) => {
      const skills = specialistRepository.getSkills(specialist.id)
      return {
        agentId: specialist.agentId,
        keywords: [
          // Extract keywords from description (first sentence, split on spaces)
          ...(specialist.description || specialist.prompt || '')
            .split(/[.!?\n]/)[0]
            .toLowerCase()
            .split(/\s+/)
            .filter((w: string) => w.length > 3),
          // Skill names are excellent capability keywords
          ...skills.map((s) => s.name.toLowerCase().replace(/\s+/g, '-')),
          // Agent ID components (e.g., 'frontend-architect' → ['frontend', 'architect'])
          ...specialist.agentId.split('-')
        ],
        activeTaskCount: activeCountByAgent.get(specialist.agentId) ?? 0,
        maxConcurrent: MAX_CONCURRENT_SPECIALISTS
      }
    })
  }

  private reset(): void {
    this.completedTasks.clear()
    this.taskResults.clear()
    this.taskStatuses.clear()
    this.activeProcesses.clear()
    this.aborted = false
    this.conversationBrief = null
    this.consecutiveSpawnFailures = 0
    this.investigationDepth = 'standard'
    this.currentRunId = null
    this.semaphore.drain()
    taskLoopService.reset()
    // Note: workspacePath and conversationId are preserved across resets
  }

  /** Expose tracer for external consumers (e.g., IPC handlers for UI trace display) */
  get tracer(): typeof executionTracer {
    return executionTracer
  }

  /** Expose message bus for external consumers */
  get bus(): typeof messageBus {
    return messageBus
  }

  /** Expose hook runner for external registration */
  get hooks(): typeof specialistHookRunner {
    return specialistHookRunner
  }
}

export const specialistPoolService = new SpecialistPoolService()
