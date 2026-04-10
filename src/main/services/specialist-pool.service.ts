import { EventEmitter } from 'node:events'
import type {
  AgentStatus,
  BudgetTier,
  ConversationMode,
  DecomposedTask,
  HandoffBrief,
  InvestigationDepth,
  InvestigationReport,
  ModelTier,
  SchedulingWeights,
  TaskExecutionProgress
} from '../../shared/types'
import {
  THINKING_BUDGETS,
  COMPLEXITY_TO_EFFORT,
  SPECIALIST_BUDGET_CAPS
} from '../../shared/constants'
import { specialistPoolLogger } from '../logger'
import {
  specialistRepository,
  worktreeRepository,
  agentSessionRepository,
  workspaceRepository,
  conversationSpecialistRepository,
  appPreferenceRepository,
  fileChangeRepository
} from '../db/repositories'
import { promptBuilder } from './prompt-builder'
import { memoryService } from './memory.service'
import { gitWorktreeService } from './git-worktree.service'
import type { MergeResult } from './git-worktree.service'
import { modelConfigService } from './model-config.service'
import { checkpointService } from './checkpoint.service'
import { eventLoggerService } from './event-logger.service'
import {
  detectAbandonment,
  detectQualityGates,
  getReEngagementPrompt
} from './abandonment-detector.service'
import { gateResultRepository } from '../db/repositories/gate-result.repository'
import { costTrackerService } from './cost-tracker.service'
import { taskLoopService } from './task-loop.service'
import { bugCouncilService } from './bug-council.service'
import { taskArtifactService } from './task-artifact.service'
import { PromptBuilder } from './prompt-builder'
import { SDKExecutor } from './sdk-executor'
import type { SDKExecuteResult } from './sdk-executor'
import {
  topologicalSort as topologicalSortFn,
  detectConclusivePattern as detectConclusivePatternFn
} from './specialist/task-scheduler'
import { Semaphore } from './specialist/semaphore'
import { executionTracer } from './specialist/trace'
import type { TraceSpan } from './specialist/trace'
import { specialistHookRunner } from './specialist/hooks'
import type { BeforeRunContext } from './specialist/hooks'
import { messageBus } from './specialist/message-bus'
import { CompositeScheduler } from './specialist/scheduling'
import type {
  SchedulingStrategy,
  SchedulingContext,
  AgentCapability
} from './specialist/scheduling'
import {
  validateInvestigationReport,
  buildFallbackReport,
  validateTaskOutput
} from './specialist/structured-output'
import { specialistRateLimiter } from './specialist/rate-limiter'
import { createStructuredLogger } from './specialist/structured-log'
import { codeGraphMcpService } from './code-graph.tool'
import { semanticSearchMcpService } from './semantic-search.tool'
import { gitContextMcpService } from './git-context.tool'
import { gitHubContextMcpService } from './github-context.tool'
import { githubService } from './github.service'
import { agentContextService } from './agent-context.service'
import { hookEngine } from './hook-engine.service'
import { createSpecialistControlMcpServer } from './specialist-control-actions.tool'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

/** Retry configuration for specialist tasks */
const RETRY_CONFIG = {
  maxRetries: 2, // Max 2 retries (3 total attempts)
  baseDelayMs: 2000, // 2s initial delay
  maxDelayMs: 30000, // 30s max delay
  backoffMultiplier: 2, // Exponential backoff
  rateLimitDelayMs: 10000 // Longer delay for rate-limited retries
}

/** Hard timeout for specialist execution — aborts if exceeded */
const SPECIALIST_TIMEOUT_MS = 10 * 60_000 // 10 minutes
/** Circuit breaker threshold — consecutive spawn failures before stopping all tasks */
const CIRCUIT_BREAKER_THRESHOLD = 5
/** R2: Max consecutive identical tool calls before aborting (loop detection) */
const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 3
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
  /** Timestamp when task started running */
  startedAt?: number
}

/** Configuration for a single SDK execution run, shared across sub-methods */
interface SDKExecutionState {
  task: DecomposedTask
  mode: ConversationMode
  info: SpecialistProcessInfo
  abortController: AbortController
  toolCallCount: number
  maxToolCalls: number
  maxTurns: number
  isInvestigationTask: boolean
  shouldEarlyExitOnReport: boolean
  abortedAfterReportDetection: boolean
  reportRegex: RegExp
  releasePermit: () => void
  /** R2: Inline loop detection — tracks consecutive identical tool call signatures */
  lastToolSignature: string | null
  consecutiveIdenticalToolCalls: number
  /** Tool-emitted investigation report (set by specialist-control MCP callback) */
  toolEmittedReport?: InvestigationReport
}

/** Summarize tool input into a short human-readable description */
function summarizeToolInput(toolName: string, toolInput: string): string {
  try {
    const parsed = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput
    switch (toolName) {
      case 'Read':
        return parsed.file_path ? `reading ${parsed.file_path.split('/').pop()}` : 'reading file'
      case 'Edit':
        return parsed.file_path ? `editing ${parsed.file_path.split('/').pop()}` : 'editing file'
      case 'Write':
        return parsed.file_path ? `writing ${parsed.file_path.split('/').pop()}` : 'writing file'
      case 'Grep':
        return parsed.pattern ? `searching "${parsed.pattern}"` : 'searching'
      case 'Glob':
        return parsed.pattern ? `finding ${parsed.pattern}` : 'finding files'
      case 'Bash':
        return parsed.command ? `running ${parsed.command.substring(0, 40)}` : 'running command'
      default:
        return ''
    }
  } catch {
    return ''
  }
}

import { isInvestigationIntent } from './specialist'

/** Map TaskExecutionProgress status → AgentStatus status */
function mapToAgentStatus(status: TaskExecutionProgress['status']): AgentStatus['status'] {
  switch (status) {
    case 'running':
      return 'thinking'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'pending':
      return 'idle'
    default:
      return 'idle'
  }
}

/**
 * Manages parallel and sequential execution of decomposed specialist tasks.
 *
 * Events emitted:
 * - `taskProgress`: TaskExecutionProgress — per-task status updates
 * - `agentStatus`: AgentStatus — per-specialist status for Agent Monitor
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
    { maxTurns: number; maxToolCalls: number; maxOutputTokens: number }
  > = {
    quick: { maxTurns: 3, maxToolCalls: 5, maxOutputTokens: 800 },
    standard: {
      maxTurns: SpecialistPoolService.MAX_SPECIALIST_PLAN_TURNS,
      maxToolCalls: SpecialistPoolService.MAX_SPECIALIST_PLAN_TOOL_CALLS,
      maxOutputTokens: 2000
    },
    deep: { maxTurns: 15, maxToolCalls: 25, maxOutputTokens: 4000 }
  } as const
  // S9: Conclusive patterns moved to specialist/task-scheduler.ts
  // Use getConclusivePatterns() for pattern access

  /**
   * Creates a CompositeScheduler from persisted preferences or defaults.
   * Called at construction and can be re-called to refresh weights.
   */
  private static createSchedulingStrategy(): CompositeScheduler {
    try {
      const raw = appPreferenceRepository.get('scheduling.weights')
      if (raw) {
        const weights = JSON.parse(raw) as SchedulingWeights
        return new CompositeScheduler([
          { name: 'dependency-first', weight: weights.dependencyFirst },
          { name: 'capability-match', weight: weights.capabilityMatch },
          { name: 'least-busy', weight: weights.leastBusy }
        ])
      }
    } catch {
      // Fall through to default
    }
    return new CompositeScheduler([
      { name: 'dependency-first', weight: 0.6 },
      { name: 'capability-match', weight: 0.3 },
      { name: 'least-busy', weight: 0.1 }
    ])
  }

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
  /** R1: Tasks skipped due to dependency failure cascade */
  private skippedTasks: Set<string> = new Set()
  private aborted: boolean = false
  /** Enriched handoff context from the generalist, injected into specialist prompts */
  private conversationBrief: HandoffBrief | null = null
  /** Circuit breaker: consecutive spawn failures across all tasks */
  private consecutiveSpawnFailures = 0
  /** S6: Current investigation depth (defaults to standard) */
  private investigationDepth: InvestigationDepth = 'standard'
  /** Async semaphore for concurrency control (replaces manual counting) */
  private readonly semaphore = new Semaphore(MAX_CONCURRENT_SPECIALISTS)
  /** Pluggable scheduling strategy — reads weights from preferences, falls back to defaults */
  private schedulingStrategy: SchedulingStrategy = SpecialistPoolService.createSchedulingStrategy()
  /** Current trace run ID for structured tracing correlation */
  private currentRunId: string | null = null

  /**
   * Strategy λ: Session-level specialist prompt cache.
   * When the same specialist is called multiple times in a conversation, the system prompt
   * is byte-identical (brief + feedback moved to user prompt in Strategy 8). This cache
   * ensures we don't rebuild from scratch → 90% prompt cache discount on repeated calls.
   * Key: `${specialistId}:${mode}:${budgetTier}:${skillsEnabled}`
   */
  private specialistPromptCache: Map<string, string> = new Map()

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

  // ── Shared Execution Scaffolding ──

  /** Pre-execution setup: reset, trace, bus, budget, checkpoint */
  private preExecutionSetup(
    tasks: DecomposedTask[],
    mode: ConversationMode,
    strategy: 'sequential' | 'parallel'
  ): void {
    this.reset()
    this.currentRunId = executionTracer.startRun(`${strategy}-execution: ${tasks.length} tasks`, {
      mode,
      taskCount: tasks.length,
      strategy
    })
    messageBus.reset()
    messageBus.setPersistenceContext({
      conversationId: this.conversationId ?? undefined,
      runId: this.currentRunId ?? undefined
    })

    // Budget check
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

    // Auto-checkpoint
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
  }

  /** Post-execution teardown: end trace, emit allComplete */
  private postExecutionTeardown(): void {
    if (this.currentRunId) {
      executionTracer.endRun(this.currentRunId, { tasksCompleted: this.completedTasks.size })
      this.currentRunId = null
    }
    this.emit('allComplete')
  }

  /** Execute a single task with progress emission */
  private async runSingleTask(
    task: DecomposedTask,
    mode: ConversationMode
  ): Promise<{ status: string; error?: string; duration?: number }> {
    const taskStartedAt = Date.now()
    this.emitProgress(task, 'running', undefined, undefined, { startedAt: taskStartedAt })
    try {
      const output = await this.runSpecialistTask(task, mode)
      this.taskResults.set(task.id, output)
      this.completedTasks.add(task.id)
      this.emitProgress(task, 'completed', output, undefined, {
        startedAt: taskStartedAt,
        completedAt: Date.now()
      })
      return { status: 'completed', duration: Date.now() - taskStartedAt }
    } catch (error) {
      this.taskStatuses.set(task.id, 'failed')
      this.emitProgress(task, 'failed', undefined, (error as Error).message, {
        startedAt: taskStartedAt,
        completedAt: Date.now()
      })
      this.log.error(
        `[PIPELINE:task-failed] ${task.specialist}/${task.id} — ${(error as Error).message} ` +
          `elapsed=${Date.now() - taskStartedAt}ms`
      )
      return { status: 'failed', error: (error as Error).message, duration: Date.now() - taskStartedAt }
    }
  }

  /**
   * Executes tasks sequentially — one at a time in dependency order.
   */
  async executeSequential(tasks: DecomposedTask[], mode: ConversationMode): Promise<void> {
    this.preExecutionSetup(tasks, mode, 'sequential')
    if (this.aborted) { this.postExecutionTeardown(); return }

    const ordered = this.topologicalSort(tasks)

    for (const task of ordered) {
      if (this.aborted) break
      await this.runSingleTask(task, mode)
    }

    this.postExecutionTeardown()
  }

  /**
   * Executes tasks in parallel, respecting dependency ordering.
   * Tasks with no unmet dependencies start immediately.
   * When a task completes, any newly-unblocked tasks are started.
   */
  async executeParallel(tasks: DecomposedTask[], mode: ConversationMode): Promise<void> {
    this.preExecutionSetup(tasks, mode, 'parallel')
    if (this.aborted) { this.postExecutionTeardown(); return }

    // Subscribe to all bus messages for execution tracing
    const parallelRunId = this.currentRunId
    const unsubBusTrace = messageBus.subscribeAll((msg) => {
      if (parallelRunId) {
        executionTracer.traceEvent(parallelRunId, 'bus_message', {
          agentId: msg.from,
          message: `[${msg.type}] ${msg.from} → ${msg.to ?? 'broadcast'}`,
          metadata: { messageId: msg.id, taskId: msg.taskId }
        })
      }
    })

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

          // R1: Cascade skip — if any dependency failed or was skipped, skip this task
          if (this.shouldCascadeSkip(task)) {
            pending.delete(task.id)
            this.cascadeSkipTask(task, 'dependency-failed')
            continue
          }

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
                this.log.info(
                  `[PIPELINE:allComplete-from-onDone] pending=0 active=0 completed=${this.completedTasks.size}`
                )
                unsubBusTrace()
                this.postExecutionTeardown()
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

        // If nothing is running and nothing is pending, we're done.
        // Belt-and-suspenders: also require startedInRound === 0 — if tasks were just kicked off,
        // their onDone callbacks will handle the allComplete check. This guard should only fire
        // when nothing was started (e.g., all tasks were cascade-skipped).
        if (pending.size === 0 && this.activeProcesses.size === 0 && startedInRound === 0) {
          this.log.info(
            `[PIPELINE:allComplete-from-guard] pending=0 active=0 completed=${this.completedTasks.size} ` +
              `startedInRound=${startedInRound}`
          )
          unsubBusTrace()
          this.postExecutionTeardown()
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

    const startedAt = Date.now()
    this.emitProgress(task, 'running', undefined, undefined, { startedAt })

    // RACE FIX: Register placeholder in activeProcesses synchronously so the
    // completion guard in executeParallel sees pending=0 + active>0 and doesn't
    // fire allComplete before createWorktreeAndSpawn's async body sets the real entry.
    if (!this.activeProcesses.has(task.id)) {
      this.activeProcesses.set(task.id, {
        task,
        output: '',
        status: 'pending',
        worktreeId: undefined,
        dbSessionId: undefined,
        attempt: 0,
        tokenUsage: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        escalations: [],
        toolCallCount: 0,
        startedAt
      })
    }

    // Create worktree for isolation, then spawn the specialist
    // Gap 1: .catch() prevents unhandled rejection if createWorktreeAndSpawn throws
    // before its internal try/catch (e.g., semaphore error, resolveWorktree throw)
    this.createWorktreeAndSpawn(task, mode, onDone).catch((err) => {
      this.log.error(
        `[PIPELINE:startTask-unhandled] ${task.specialist}/${task.id} — ` +
          `createWorktreeAndSpawn rejected without calling onDone: ${(err as Error).message}`
      )
      // Ensure task doesn't hang forever — clean up and call onDone
      this.activeProcesses.delete(task.id)
      this.taskStatuses.set(task.id, 'failed')
      this.emitProgress(task, 'failed', undefined, (err as Error).message)
      onDone()
    })
  }

  // ── R1: Failure Cascade ──

  /**
   * R1: Check if a task should be skipped because one or more of its
   * dependencies failed or were themselves skipped (transitive cascade).
   */
  private shouldCascadeSkip(task: DecomposedTask): boolean {
    for (const depId of task.dependsOn) {
      const depStatus = this.taskStatuses.get(depId)
      if (depStatus === 'failed' || this.skippedTasks.has(depId)) {
        return true
      }
    }
    return false
  }

  /**
   * R1: Mark a task as skipped due to dependency failure and cascade
   * the skip to all transitive dependents.
   */
  private cascadeSkipTask(task: DecomposedTask, reason: string): void {
    this.skippedTasks.add(task.id)
    this.taskStatuses.set(task.id, 'skipped')
    this.completedTasks.add(task.id) // Treat as "settled" so downstream checks work

    const failedDeps = task.dependsOn.filter(
      (depId) => this.taskStatuses.get(depId) === 'failed' || this.skippedTasks.has(depId)
    )

    this.log.info(
      `[CASCADE:skip] Task ${task.id} (${task.specialist}) skipped — ` +
        `reason: ${reason}, failed dependencies: [${failedDeps.join(', ')}]`
    )

    this.emitProgress(
      task,
      'skipped',
      undefined,
      `Skipped: dependency ${failedDeps.join(', ')} failed`
    )

    // Trace the cascade event
    if (this.currentRunId) {
      executionTracer.traceEvent(this.currentRunId, 'dependency_resolved', {
        taskId: task.id,
        agentId: task.specialist,
        message: `Task skipped due to cascade failure from [${failedDeps.join(', ')}]`,
        metadata: { reason, failedDeps }
      })
    }

    // Broadcast skip to message bus so other agents know
    messageBus.broadcast({
      from: task.specialist,
      type: 'dependency',
      content: `Task ${task.id} skipped due to dependency failure`,
      taskId: task.id,
      metadata: { status: 'skipped', reason, failedDeps }
    })
  }

  // ── P2: createWorktreeAndSpawn sub-methods ──

  /**
   * Resolves or creates a worktree for specialist isolation.
   * Reuses existing worktree for task loop retries, otherwise creates a new one.
   */
  private async resolveWorktree(
    task: DecomposedTask,
    mode: ConversationMode,
    existingWorktreeId?: string
  ): Promise<string | undefined> {
    if (existingWorktreeId) {
      this.log.info(
        `Reusing worktree ${existingWorktreeId} for ${task.specialist}/${task.id} (task loop iteration)`
      )
      return existingWorktreeId
    }

    if (mode === 'build' && this.workspacePath && this.conversationId) {
      try {
        const worktreePath = await gitWorktreeService.create(
          this.workspacePath,
          task.specialist,
          task.id,
          this.conversationId
        )
        const worktreeRecord = worktreeRepository.findByTaskId(task.id)
        this.log.info(`Worktree created for ${task.specialist}/${task.id}: ${worktreePath}`)
        return worktreeRecord?.id
      } catch (error) {
        this.log.warn(
          `Failed to create worktree for ${task.specialist}/${task.id}, falling back to shared cwd:`,
          error
        )
      }
    }
    return undefined
  }

  /**
   * Initializes trace span, DB session, and SpecialistProcessInfo for a specialist execution.
   */
  private initSpecialistExecution(
    task: DecomposedTask,
    mode: ConversationMode,
    worktreeId: string | undefined,
    attempt: number
  ): { traceSpan: TraceSpan | undefined; info: SpecialistProcessInfo } {
    this.log.info(`Running ${task.specialist}/${task.id} via SDK`)

    // Fire declarative hook (non-blocking)
    hookEngine
      .executeHooks('specialist_start', { taskId: task.id, agentId: task.specialist })
      .catch((err) => this.log.warn('Hook error (specialist_start):', err))

    let traceSpan: TraceSpan | undefined
    if (this.currentRunId) {
      traceSpan = executionTracer.startSpan(this.currentRunId, 'specialist_start', {
        agentId: task.specialist,
        taskId: task.id,
        message: `Starting ${task.specialist} for task ${task.id}`,
        metadata: { mode, attempt, model: task.model, conversationId: this.conversationId }
      })
    }

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
        workspaceId: this.workspaceId ?? undefined,
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
      toolCallCount: 0,
      startedAt: Date.now()
    }

    // Set hard timeout to prevent orphaned specialists from running indefinitely
    info.timeoutTimer = setTimeout(() => {
      this.log.error(
        `[SPECIALIST:timeout] ${task.specialist}/${task.id} — execution exceeded ${SPECIALIST_TIMEOUT_MS / 60_000} minutes`
      )
      eventLoggerService.logAgentTimeout({
        agentId: task.specialist,
        conversationId: this.conversationId ?? undefined,
        elapsedMs: SPECIALIST_TIMEOUT_MS,
        toolCallCount: info.toolCallCount
      })
      if (info.abortController) {
        info.abortController.abort()
      }
    }, SPECIALIST_TIMEOUT_MS)

    return { traceSpan, info }
  }

  /**
   * Handles specialist success path: trace span, structured logging, hooks, DB session,
   * post-completion analysis, message bus broadcast, artifact write, quality gates.
   */
  private async handleSpecialistSuccess(
    task: DecomposedTask,
    info: SpecialistProcessInfo,
    mode: ConversationMode,
    traceSpan: TraceSpan | undefined,
    onDone: () => void
  ): Promise<void> {
    // Clear timeout timer to prevent stale abort after successful completion
    if (info.timeoutTimer) {
      clearTimeout(info.timeoutTimer)
      info.timeoutTimer = undefined
    }

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

    // Structured log: specialist completed successfully
    this.slog.specialistCompleted({
      taskId: task.id,
      agentId: task.specialist,
      model: task.model ?? 'sonnet',
      durationMs: spanDurationMs,
      tokenUsage: {
        input: info.inputTokens,
        output: info.outputTokens,
        cacheRead: info.cacheReadTokens,
        cacheCreation: info.cacheCreationTokens,
        total: info.tokenUsage
      }
    })

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
      attempt: info.attempt
    })

    // Fire declarative hook (specialist_complete)
    hookEngine
      .executeHooks('specialist_complete', { taskId: task.id, agentId: task.specialist })
      .catch((err) => this.log.warn('Hook error (specialist_complete):', err))

    // R3: Structured output validation — if task has outputSchema, validate before accepting
    if (task.outputSchema && info.output.length > 0) {
      const validation = validateTaskOutput(info.output, task.outputSchema)
      if (!validation.success) {
        // Auto-retry once with validation error injected into context
        if (info.attempt < 1) {
          this.log.warn(
            `[SCHEMA:validation-failed] ${task.specialist}/${task.id} schema="${task.outputSchema}" — retrying`,
            validation.errors
          )
          this.emit('taskChunk', {
            taskId: task.id,
            specialist: task.specialist,
            chunk: `\n\n⚠️ **Output validation failed** (auto-retrying):\n${validation.errors.join('\n')}\n`
          })

          // Clean up and retry with error context
          this.activeProcesses.delete(task.id)
          if (info.worktreeId) {
            gitWorktreeService.remove(info.worktreeId, true).catch((err) => {
              this.log.warn(`Failed to remove worktree before schema retry: ${err}`)
            })
          }

          // Inject validation errors into task description for retry
          const originalDesc = task.description
          task.description =
            `${originalDesc}\n\n` +
            `IMPORTANT: Your previous output failed schema validation ("${task.outputSchema}").\n` +
            `Errors:\n${validation.errors.join('\n')}\n` +
            `Please fix your output to match the required schema.`

          setTimeout(() => {
            this.createWorktreeAndSpawn(task, mode, onDone, info.attempt + 1).catch((err) => {
              this.log.error(
                `[PIPELINE:schema-retry-unhandled] ${task.specialist}/${task.id} — ${(err as Error).message}`
              )
              this.activeProcesses.delete(task.id)
              this.taskStatuses.set(task.id, 'failed')
              this.emitProgress(task, 'failed', undefined, (err as Error).message)
              onDone()
            })
            task.description = originalDesc // Restore for potential further retries
          }, 1000)
          return
        }
        // Second attempt also failed — accept output with warning
        this.log.error(
          `[SCHEMA:validation-exhausted] ${task.specialist}/${task.id} — accepting invalid output after retry`
        )
      } else {
        this.log.info(
          `[SCHEMA:validated] ${task.specialist}/${task.id} schema="${task.outputSchema}" strategy=${validation.strategy}`
        )
      }
    }

    // Persist agent context — extract summary for future specialist context injection
    if (this.conversationId && info.output.length > 0) {
      const summary = agentContextService.extractSummaryFromOutput(info.output)
      if (summary) {
        agentContextService.persistSummary(this.conversationId, task.specialist, summary, task.id)
      }
    }

    // Success path — cleanup and state updates
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
        .writeTaskOutput(this.workspacePath, this.conversationId, task.id, info.output, 'completed')
        .catch((err) => this.log.warn('Failed to write task output artifact:', err))
    }

    // Run quality gates
    const gateCwd = info.worktreeId
      ? (worktreeRepository.findById(info.worktreeId)?.worktreePath ?? this.workspacePath!)
      : this.workspacePath!

    await this.runTaskLoopGates(task, info, mode, gateCwd, onDone).catch(async (err) => {
      this.log.error(`Task loop gate evaluation failed for ${task.id}:`, err)
      await this.finalizeTaskCompletion(task, info)
      this.log.info(`[PIPELINE:onDone-called] ${task.specialist}/${task.id} path=gate-catch`)
      onDone()
    })
  }

  /**
   * Handles specialist failure path: error emit, trace span, structured logging, hooks,
   * DB session error, retry logic with exponential backoff, circuit breaker.
   */
  private async handleSpecialistFailure(
    task: DecomposedTask,
    info: SpecialistProcessInfo,
    mode: ConversationMode,
    error: Error,
    traceSpan: TraceSpan | undefined,
    onDone: () => void
  ): Promise<void> {
    // Clear timeout timer to prevent stale abort after failure handling
    if (info.timeoutTimer) {
      clearTimeout(info.timeoutTimer)
      info.timeoutTimer = undefined
    }

    // Error is surfaced via emitProgress('failed') → BuildProgressCard, not chat stream

    // End trace span on error — capture durationMs for afterRun consistency
    let errorSpanDurationMs = 0
    if (traceSpan) {
      errorSpanDurationMs = executionTracer.endSpan(traceSpan, {
        error: error.message,
        tokenUsage: {
          input: info.inputTokens,
          output: info.outputTokens,
          cacheRead: info.cacheReadTokens,
          cacheCreation: info.cacheCreationTokens
        }
      })
    }

    // Structured log: specialist failed
    this.slog.specialistFailed({
      taskId: task.id,
      agentId: task.specialist,
      model: task.model ?? 'sonnet',
      attempt: info.attempt,
      error: error.message,
      durationMs: errorSpanDurationMs,
      tokenUsage: {
        input: info.inputTokens,
        output: info.outputTokens,
        cacheRead: info.cacheReadTokens,
        cacheCreation: info.cacheCreationTokens,
        total: info.tokenUsage
      }
    })

    // Run afterRun hooks on failure
    await specialistHookRunner.runAfterRun(task.specialist, {
      task,
      output: info.output,
      success: false,
      error: error.message,
      tokenUsage: {
        input: info.inputTokens,
        output: info.outputTokens,
        cacheRead: info.cacheReadTokens,
        cacheCreation: info.cacheCreationTokens
      },
      durationMs: errorSpanDurationMs,
      toolCallCount: info.toolCallCount,
      attempt: info.attempt
    })

    // Fire declarative hook (specialist_failed)
    hookEngine
      .executeHooks('specialist_failed', { taskId: task.id, agentId: task.specialist })
      .catch((err) => this.log.warn('Hook error (specialist_failed):', err))

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
      error.message.includes('exceeded') && error.message.includes('tool calls')
    // Budget-exceeded errors should NOT retry — escalating model would hit cap faster
    const isBudgetExceeded =
      error.message.includes('error_max_budget_usd') ||
      error.message.includes('budget cap exceeded')
    const isRetryable =
      !this.aborted &&
      !isCircuitBreakerError &&
      !isBudgetExceeded &&
      info.attempt < RETRY_CONFIG.maxRetries
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
        reason: `SDK execution failed: ${error.message}`,
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
            error: error.message,
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
      this.log.info(
        `[PIPELINE:onDone-deferred] ${task.specialist}/${task.id} — ` +
          `retrying in ${delay}ms, onDone deferred to attempt ${info.attempt + 1}`
      )
      setTimeout(() => {
        this.createWorktreeAndSpawn(task, mode, onDone, info.attempt + 1).catch((err) => {
          this.log.error(
            `[PIPELINE:retry-unhandled] ${task.specialist}/${task.id} — ${(err as Error).message}`
          )
          this.activeProcesses.delete(task.id)
          this.taskStatuses.set(task.id, 'failed')
          this.emitProgress(task, 'failed', undefined, (err as Error).message)
          onDone()
        })
      }, delay)
      return
    }

    // Retries exhausted — task settled as failed (not a crash, just a result)
    // Agent failure already logged by trace-bridge via specialist_end span
    this.consecutiveSpawnFailures++
    this.log.info(`Task ${task.id} settled as failed — continuing parallel execution`)
    this.emitProgress(task, 'failed', undefined, error.message)

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
      this.log.info(`[PIPELINE:onDone-called] ${task.specialist}/${task.id} path=circuit-breaker`)
      onDone() // CRITICAL: unblock the executeParallel promise
      return
    }

    if (info.worktreeId) {
      worktreeRepository.updateStatus(info.worktreeId, 'abandoned')
    }

    // Semaphore auto-released by sem.run() — continue parallel execution
    this.log.info(`[PIPELINE:onDone-called] ${task.specialist}/${task.id} path=failure-settled`)
    onDone()
  }

  /**
   * Creates a worktree (if in build mode) and spawns the specialist process.
   * If `existingWorktreeId` is provided, reuses that worktree (for task loop retries).
   *
   * Orchestrates sub-methods: resolveWorktree → initSpecialistExecution →
   * runSpecialistViaSDK → handleSpecialistSuccess / handleSpecialistFailure.
   */
  private async createWorktreeAndSpawn(
    task: DecomposedTask,
    mode: ConversationMode,
    onDone: () => void,
    attempt: number = 0,
    existingWorktreeId?: string
  ): Promise<void> {
    await this.semaphore.run(async () => {
      const worktreeId = await this.resolveWorktree(task, mode, existingWorktreeId)
      const { traceSpan, info } = this.initSpecialistExecution(task, mode, worktreeId, attempt)
      this.activeProcesses.set(task.id, info)

      try {
        await this.runSpecialistViaSDK(task, mode, info, worktreeId)
        await this.handleSpecialistSuccess(task, info, mode, traceSpan, onDone)
      } catch (error) {
        await this.handleSpecialistFailure(task, info, mode, error as Error, traceSpan, onDone)
      }
    }) // end semaphore.run()
  }

  // ── P1: buildSpecialistContext sub-methods ──

  /**
   * Resolves specialist configuration from DB: specialist record, skills, overrides, feedback, budget.
   */
  private resolveSpecialistConfig(task: DecomposedTask): {
    specialist: ReturnType<typeof specialistRepository.findByAgentId>
    assignedSkills: ReturnType<typeof specialistRepository.getSkills>
    skillsEnabled: boolean | undefined
    skillOverrides: string[] | undefined
    feedbackContext: string | undefined
    budgetTier: BudgetTier
    model: string
  } {
    const specialist = specialistRepository.findByAgentId(task.specialist)
    const assignedSkills = specialist ? specialistRepository.getSkills(specialist.id) : []

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

    const model = task.model ?? 'sonnet'
    const budgetTier: BudgetTier =
      model === 'haiku' ? 'minimal' : model === 'opus' ? 'full' : 'standard'

    return {
      specialist,
      assignedSkills,
      skillsEnabled,
      skillOverrides,
      feedbackContext,
      budgetTier,
      model
    }
  }

  /**
   * Builds or retrieves cached system prompt for a specialist task.
   * Cache key includes all factors that affect system prompt content (Strategy λ).
   */
  private buildOrCacheSystemPrompt(
    task: DecomposedTask,
    mode: ConversationMode,
    config: ReturnType<SpecialistPoolService['resolveSpecialistConfig']>
  ): string {
    const effectiveSkillsEnabled =
      config.skillsEnabled !== undefined
        ? config.skillsEnabled
        : (task.complexity?.total ?? 5) >= 5 && (task.complexity?.filesAffected ?? 1) > 1

    // Detect which MCP servers are active for conditional tool guidance injection
    const mcpFlags = this.detectEnabledMcpServers()
    const mcpFlagKey = `${mcpFlags.codeGraph}:${mcpFlags.semanticSearch}:${mcpFlags.gitContext}:${mcpFlags.githubContext}`

    const cacheKey = `${task.specialist}:${mode}:${config.budgetTier}:${effectiveSkillsEnabled}:${config.skillOverrides?.join(',') ?? ''}:${mcpFlagKey}`
    let systemPrompt = this.specialistPromptCache.get(cacheKey)

    if (!systemPrompt) {
      const promptOptions: Parameters<typeof promptBuilder.build>[0] & {
        skillsEnabled?: boolean
        skillOverrides?: string[]
      } = {
        role: 'specialist',
        mode,
        specialistId: task.specialist,
        specialistPrompt: config.specialist?.prompt || undefined,
        assignedSkills: config.assignedSkills,
        workspacePath: this.workspacePath!,
        brief: this.conversationBrief || undefined,
        feedbackContext: config.feedbackContext,
        budgetTier: config.budgetTier,
        // S2: Only load skills for moderate+ complexity tasks (complexity >= 5)
        // Strategy D: Also skip skills for single-file changes — skills are implementation guides
        // for multi-file architectural work, not needed for simple one-file fixes.
        // This saves 400-1,140 tokens per specialist call for simple tasks.
        skillsEnabled: effectiveSkillsEnabled,
        // Conditional MCP guidance — only inject tool guidance for active servers
        enabledMcpServers: mcpFlags
      }
      if (config.skillsEnabled !== undefined) {
        promptOptions.skillsEnabled = config.skillsEnabled
      }
      if (config.skillOverrides) {
        promptOptions.skillOverrides = config.skillOverrides
      }
      systemPrompt = promptBuilder.build(promptOptions)

      // Strategy: Plan-mode specialists should not attempt file writes —
      // SDK permission enforcement catches it, but wasted tool-call attempts
      // burn tokens. Telling them explicitly avoids the round-trip.
      if (mode === 'plan') {
        systemPrompt +=
          '\n\n## Mode: Plan (read-only)\nProduce analysis and recommendations only. Do NOT write files or run commands.'
      }

      this.specialistPromptCache.set(cacheKey, systemPrompt)
      this.log.info(
        `[PIPELINE:specialist-prompt-cache] MISS — built and cached prompt for ${cacheKey} (${systemPrompt.length} chars)`
      )
    } else {
      this.log.info(
        `[PIPELINE:specialist-prompt-cache] HIT — reusing cached prompt for ${cacheKey}`
      )
    }

    return systemPrompt
  }

  /**
   * Gathers dependency outputs from artifacts/in-memory and writes task input artifact.
   */
  private async buildDependencyContext(
    task: DecomposedTask,
    budgetTier: BudgetTier
  ): Promise<string> {
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

    return dependencyContext
  }

  /**
   * Assembles the full user prompt from task description, context parts, and injections.
   */
  private buildPromptWithContext(
    task: DecomposedTask,
    config: ReturnType<SpecialistPoolService['resolveSpecialistConfig']>,
    dependencyContext: string
  ): string {
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
      feedbackContext: config.feedbackContext,
      budgetTier: config.budgetTier
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
      config.budgetTier === 'minimal'
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

    // Inject persistent agent context from prior specialist runs in this conversation
    if (this.conversationId) {
      const agentContext = agentContextService.getContextForPrompt(this.conversationId)
      if (agentContext) {
        fullPrompt = `${fullPrompt}\n\n${agentContext}`
      }
    }

    return fullPrompt
  }

  /**
   * Builds the specialist context (system prompt, full prompt, cwd, model).
   * Used by the SDK execution path.
   *
   * Orchestrates sub-methods: resolveSpecialistConfig → buildOrCacheSystemPrompt →
   * buildDependencyContext → buildPromptWithContext → resolve model/cwd.
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
    const config = this.resolveSpecialistConfig(task)
    const systemPrompt = this.buildOrCacheSystemPrompt(task, mode, config)
    const dependencyContext = await this.buildDependencyContext(task, config.budgetTier)
    const fullPrompt = this.buildPromptWithContext(task, config, dependencyContext)

    // Prompt size estimation
    const promptCheck = PromptBuilder.checkPromptSize(systemPrompt, fullPrompt, config.model)
    if (promptCheck.warning) {
      this.log.warn(`[${task.specialist}/${task.id}] ${promptCheck.warning}`)
    }

    // Resolve model
    const modelAction = task.model ? tierToModelAction(task.model) : 'specialist:moderate'
    const modelId = modelConfigService.getModel(this.workspacePath ?? undefined, modelAction)

    // Thinking budget
    const thinkingBudget =
      THINKING_BUDGETS[config.model as keyof typeof THINKING_BUDGETS] ?? THINKING_BUDGETS.sonnet

    // Resolve cwd
    let cwd = this.workspacePath!
    if (worktreeId) {
      const worktreeRecord = worktreeRepository.findById(worktreeId)
      if (worktreeRecord) {
        cwd = worktreeRecord.worktreePath
      }
    }

    // Efficiency rules appended to specialist context (MCP guidance is in system prompt via buildSpecialistMcpGuidance)
    const efficiencyRules = `

## Efficiency Rules
- Maximum 3 reads of any single file per session
- Target resolution in ≤10 tool calls for moderate tasks
- If stuck after 15 tool calls, summarize findings and stop`

    const enhancedFullPrompt = fullPrompt + efficiencyRules

    return { systemPrompt, fullPrompt: enhancedFullPrompt, cwd, modelId, thinkingBudget }
  }

  /**
   * Runs a specialist task via the Agent SDK (no child process).
   * Produces the same events as CLI-based execution.
   *
   * Decomposed into focused sub-methods:
   * - prepareSDKExecution(): hooks, config, rate limiter
   * - buildMcpServersConfig(): MCP server configuration
   * - processSDKStreamChunk(): per-chunk type dispatch
   * - handleSDKAbortError(): abort vs real error classification
   * - handleInvestigationReport(): post-execution report detection
   */
  private async runSpecialistViaSDK(
    task: DecomposedTask,
    mode: ConversationMode,
    info: SpecialistProcessInfo,
    worktreeId?: string
  ): Promise<void> {
    const { systemPrompt, fullPrompt, cwd, modelId, thinkingBudget, execState } =
      await this.prepareSDKExecution(task, mode, info, worktreeId)

    const mcpServers = this.buildMcpServersConfig(execState)

    const executor = new SDKExecutor()
    try {
      // Strategy η: Compute output token budget based on investigation depth.
      // For investigation tasks, hard-cap output to prevent verbose responses.
      // Build-mode tasks get no cap — they need full output for code generation.
      const depthBudget = SpecialistPoolService.DEPTH_BUDGETS[this.investigationDepth]
      const maxOutputTokens = execState.isInvestigationTask
        ? depthBudget.maxOutputTokens
        : undefined

      // Compute effort from complexity tier
      const effortLevel = task.complexity?.tier
        ? COMPLEXITY_TO_EFFORT[task.complexity.tier as keyof typeof COMPLEXITY_TO_EFFORT]
        : 'medium'
      // Compute budget cap from complexity tier
      const budgetCap =
        SPECIALIST_BUDGET_CAPS[
          (task.complexity?.tier ?? 'moderate') as keyof typeof SPECIALIST_BUDGET_CAPS
        ]
      const taskBudgetTotal =
        {
          simple: 10_000,
          moderate: 30_000,
          complex: 80_000
        }[(task.complexity?.tier ?? 'moderate') as string] ?? 30_000

      // Enable 1M context beta for Sonnet models
      const isSonnet = modelId.includes('sonnet')

      for await (const chunk of executor.execute({
        prompt: fullPrompt,
        systemPrompt,
        model: modelId,
        cwd,
        permissionMode: mode === 'build' ? 'auto' : 'default',
        agentId: task.specialist,
        taskId: task.id,
        // Modern thinking: adaptive for opus, budget-based for others
        thinking: modelId.includes('opus')
          ? { type: 'adaptive' as const }
          : parseInt(thinkingBudget)
            ? { type: 'enabled' as const, budgetTokens: parseInt(thinkingBudget) }
            : undefined,
        effort: effortLevel,
        // Specialists: omit thinking display — saves ~10-20% of streamed bytes (SDK 0.2.96+)
        thinkingDisplay: 'omitted',
        // taskBudget: { total: taskBudgetTotal }, // disabled until API supports beta header
        maxBudgetUsd: budgetCap,
        maxTurns: execState.maxTurns,
        abortController: execState.abortController,
        // Defense-in-depth: track file changes via SDK FileChanged hook.
        // This fires AFTER each file write/edit with the actual path and change type,
        // providing a reliable source of truth independent of streaming event ordering.
        onFileChanged: (absoluteFilePath: string, changeType: string) => {
          if (this.conversationId) {
            try {
              const relativePath =
                this.workspacePath && absoluteFilePath.startsWith(this.workspacePath)
                  ? absoluteFilePath.slice(this.workspacePath.length).replace(/^\//, '')
                  : absoluteFilePath
              fileChangeRepository.track(
                this.conversationId,
                relativePath,
                changeType === 'create'
                  ? 'created'
                  : changeType === 'delete'
                    ? 'deleted'
                    : 'modified'
              )
            } catch (e) {
              this.log.warn('FileChanged hook: failed to track file change:', e)
            }
          }
        },
        sandbox:
          mode === 'build'
            ? {
                enabled: true,
                autoAllowBashIfSandboxed: true,
                // macOS has sandbox-exec built-in; Linux may lack bubblewrap in CI
                failIfUnavailable: process.platform === 'darwin',
                allowUnsandboxedCommands: true,
                network: {
                  allowLocalBinding: true
                }
              }
            : undefined,
        // Enable 1M context window for Sonnet specialists
        ...(isSonnet ? { betas: ['context-1m-2025-08-07'] } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {})
      })) {
        const shouldBreak = this.processSDKStreamChunk(chunk, execState)
        if (shouldBreak) break
      }
    } catch (error) {
      // Loop detection and investigation-report early exits abort the SDK query,
      // which can throw "Operation aborted" from in-flight SDK control requests.
      // These are expected and should not propagate as unhandled errors.
      const isAbort = error instanceof Error && /abort/i.test(error.message)
      const isLoopAbort = execState.abortController.signal.aborted && isAbort
      if (!this.isIntentionalEarlyExitAbort(error, execState) && !isLoopAbort) {
        execState.releasePermit()
        throw error
      }
    }

    execState.releasePermit()

    if (execState.isInvestigationTask) {
      this.handleInvestigationReport(task, info, execState.reportRegex, execState.toolEmittedReport)
    }
  }

  /**
   * Prepares all configuration needed for SDK execution:
   * builds context, runs beforeRun hooks, acquires rate limiter permit,
   * and computes execution limits.
   */
  private async prepareSDKExecution(
    task: DecomposedTask,
    mode: ConversationMode,
    info: SpecialistProcessInfo,
    worktreeId?: string
  ): Promise<{
    systemPrompt: string
    fullPrompt: string
    cwd: string
    modelId: string
    thinkingBudget: string
    execState: SDKExecutionState
  }> {
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

    await specialistHookRunner.runBeforeRun(task.specialist, hookContext)

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

    const abortController = new AbortController()
    info.abortController = abortController

    const isPlanModeSpecialist = mode === 'plan'
    // Plan mode specialists produce ````plan blocks, not investigation-report blocks.
    // Only detect investigation intent in build mode to avoid maxOutputTokens capping.
    const isInvestigationTask = !isPlanModeSpecialist && isInvestigationIntent(task.description)

    const depthBudget = SpecialistPoolService.DEPTH_BUDGETS[this.investigationDepth]
    const maxToolCalls = isPlanModeSpecialist
      ? depthBudget.maxToolCalls
      : SpecialistPoolService.MAX_SPECIALIST_TOOL_CALLS
    const maxTurns = isPlanModeSpecialist
      ? depthBudget.maxTurns
      : SpecialistPoolService.MAX_SPECIALIST_BUILD_TURNS

    const releasePermit = await specialistRateLimiter.acquire()

    const execState: SDKExecutionState = {
      task,
      mode,
      info,
      abortController,
      toolCallCount: 0,
      maxToolCalls,
      maxTurns,
      isInvestigationTask,
      shouldEarlyExitOnReport: isInvestigationTask,
      abortedAfterReportDetection: false,
      reportRegex: /```investigation-report\s*\n([\s\S]*?)```/,
      releasePermit,
      // R2: Inline loop detection
      lastToolSignature: null,
      consecutiveIdenticalToolCalls: 0
    }

    return { systemPrompt, fullPrompt, cwd, modelId, thinkingBudget, execState }
  }

  /**
   * Detects which MCP servers are active for this workspace.
   * Mirrors the generalist's refreshFeatureFlags() logic — checks workspace settings
   * to determine if code graph and semantic search are enabled.
   * Used by buildOrCacheSystemPrompt() to conditionally inject tool guidance —
   * prevents specialists from trying to call phantom tools for unconfigured servers.
   */
  private detectEnabledMcpServers(): import('./default-prompts').SpecialistMcpFlags {
    let codeGraph = false
    let semanticSearch = false
    if (this.workspaceId && this.workspacePath) {
      try {
        const workspace = workspaceRepository.findById(this.workspaceId)
        if (workspace) {
          const settings = JSON.parse(workspace.settingsJson || '{}')
          codeGraph = !!settings.repomapEnabled
          semanticSearch = !!settings.semanticSearchEnabled
        }
      } catch {
        // Non-critical — default to false (no phantom tools)
      }
    }
    const gitContext = !!this.workspacePath
    const githubContext = !!(
      this.workspaceId &&
      this.workspacePath &&
      githubService.isConfigured(this.workspaceId)
    )
    return { codeGraph, semanticSearch, gitContext, githubContext }
  }

  /**
   * Builds MCP server configs for specialist access to code graph,
   * semantic search, git context, and (for investigation tasks) specialist control actions.
   */
  private buildMcpServersConfig(execState?: SDKExecutionState): Record<string, McpServerConfig> {
    const mcpServers: Record<string, McpServerConfig> = {}
    if (this.workspaceId && this.workspacePath) {
      Object.assign(
        mcpServers,
        codeGraphMcpService.getMcpServersConfig(this.workspaceId, this.workspacePath)
      )
      Object.assign(mcpServers, semanticSearchMcpService.getMcpServersConfig(this.workspaceId))
    }
    if (this.workspacePath) {
      Object.assign(mcpServers, gitContextMcpService.getMcpServersConfig(this.workspacePath))
    }
    // GitHub context: expose PR/issue tools when configured
    if (this.workspaceId && this.workspacePath && githubService.isConfigured(this.workspaceId)) {
      Object.assign(
        mcpServers,
        gitHubContextMcpService.getMcpServersConfig(this.workspaceId, this.workspacePath)
      )
    }
    // Specialist control actions — emit_investigation_report (investigation tasks only)
    if (execState?.isInvestigationTask) {
      Object.assign(
        mcpServers,
        createSpecialistControlMcpServer({
          onInvestigationReport: (report) => {
            execState.toolEmittedReport = report
          }
        })
      )
    }
    return mcpServers
  }

  /**
   * Processes a single SDK stream chunk — dispatches by type.
   * Returns true if the stream loop should break (early exit).
   */
  private processSDKStreamChunk(
    chunk: {
      type?: string
      content?: string
      error?: string
      toolName?: string
      toolId?: string
      toolInput?: string
      _meta?: unknown
    },
    state: SDKExecutionState
  ): boolean {
    const { task, info } = state

    if ('_meta' in chunk && chunk._meta) {
      this.handleMetaChunk(chunk._meta as SDKExecuteResult, task, info)
      return false
    }

    if (chunk.type === 'status' && chunk.content === 'heartbeat') {
      this.emit('taskChunk', { taskId: task.id, specialist: task.specialist, chunk: '' })
      return false
    }

    if (chunk.type === 'text' && chunk.content) {
      return this.handleTextChunk(chunk.content, state)
    }

    if (chunk.type === 'tool_use') {
      this.handleToolUseChunk(chunk, state)
      return false
    }

    if (chunk.type === 'tool_result') {
      return this.handleToolResultChunk(chunk, state)
    }

    if (chunk.type === 'error') {
      return this.handleErrorChunk(chunk, state)
    }

    return false
  }

  /** Handle _meta chunk — accumulate token usage */
  private handleMetaChunk(
    meta: SDKExecuteResult,
    task: DecomposedTask,
    info: SpecialistProcessInfo
  ): void {
    info.tokenUsage += meta.tokenUsage.input + meta.tokenUsage.output
    info.inputTokens += meta.tokenUsage.input
    info.outputTokens += meta.tokenUsage.output
    info.cacheReadTokens += meta.tokenUsage.cacheReadInputTokens
    info.cacheCreationTokens += meta.tokenUsage.cacheCreationInputTokens
    const { cacheReadInputTokens, cacheCreationInputTokens } = meta.tokenUsage
    if (cacheReadInputTokens > 0 || cacheCreationInputTokens > 0) {
      this.log.info(
        `[PIPELINE:specialist-cache] ${task.specialist}/${task.id} read=${cacheReadInputTokens} creation=${cacheCreationInputTokens}`
      )
    }
  }

  /** Handle text chunk — accumulate output, check for early exit patterns */
  private handleTextChunk(content: string, state: SDKExecutionState): boolean {
    const { task, info } = state
    info.output += content
    this.emit('taskChunk', { taskId: task.id, specialist: task.specialist, chunk: content })

    if (state.shouldEarlyExitOnReport && !state.abortedAfterReportDetection) {
      const matchedPattern = this.detectConclusivePattern(info.output)
      if (matchedPattern) {
        state.abortedAfterReportDetection = true
        this.log.info(
          `[PIPELINE:conclusive-pattern-early-exit] ${task.specialist}/${task.id} pattern=${matchedPattern}`
        )
        state.abortController.abort()
      }
    }
    return false
  }

  /** Handle tool_use chunk — fire hooks, enforce circuit breaker + inline loop detection (R2) */
  private handleToolUseChunk(
    chunk: { toolName?: string; toolId?: string; toolInput?: string },
    state: SDKExecutionState
  ): void {
    const { task, info } = state
    state.toolCallCount++
    info.toolCallCount = state.toolCallCount

    specialistHookRunner.fireToolCall(task.specialist, {
      task,
      toolName: chunk.toolName ?? 'Unknown',
      toolInput: chunk.toolInput ?? undefined,
      toolCallIndex: state.toolCallCount
    })

    // R2: Inline loop detection — track consecutive identical tool+input pairs
    const toolSignature = `${chunk.toolName ?? ''}:${chunk.toolInput ?? ''}`
    if (toolSignature === state.lastToolSignature) {
      state.consecutiveIdenticalToolCalls++
    } else {
      state.lastToolSignature = toolSignature
      state.consecutiveIdenticalToolCalls = 1
    }

    if (state.consecutiveIdenticalToolCalls >= MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS) {
      this.log.warn(
        `[LOOP:detected] ${task.specialist}/${task.id} — ` +
          `${state.consecutiveIdenticalToolCalls} consecutive identical tool calls: ${chunk.toolName}`
      )
      this.slog.toolCallLimitReached({
        taskId: task.id,
        agentId: task.specialist,
        model: task.model ?? 'sonnet',
        toolCallCount: state.toolCallCount,
        maxToolCalls: state.maxToolCalls
      })
      state.abortController.abort()
      throw new Error(
        `Specialist ${task.specialist} stuck in loop — ${state.consecutiveIdenticalToolCalls} identical ` +
          `${chunk.toolName} calls with same input`
      )
    }

    if (state.toolCallCount >= state.maxToolCalls) {
      this.slog.toolCallLimitReached({
        taskId: task.id,
        agentId: task.specialist,
        model: task.model ?? 'sonnet',
        toolCallCount: state.toolCallCount,
        maxToolCalls: state.maxToolCalls
      })
      state.abortController.abort()
      throw new Error(
        `Specialist ${task.specialist} exceeded ${state.maxToolCalls} tool calls — likely stuck in a loop`
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

    // Emit enriched progress with live tool activity
    this.emitProgress(task, 'running', undefined, undefined, {
      currentTool: chunk.toolName ?? 'Unknown',
      currentToolSummary: summarizeToolInput(chunk.toolName ?? '', chunk.toolInput ?? ''),
      toolCallCount: state.toolCallCount,
      startedAt: info.startedAt
    })
  }

  /** Handle tool_result chunk — fire observation hooks. Returns true to break (early exit). */
  private handleToolResultChunk(
    chunk: { toolName?: string; toolId?: string; content?: string },
    state: SDKExecutionState
  ): boolean {
    const { task } = state
    specialistHookRunner.fireToolResult(task.specialist, {
      task,
      toolName: chunk.toolName ?? 'Unknown',
      result: chunk.content ?? undefined,
      toolCallIndex: state.toolCallCount
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

    // Early exit after tool-emitted investigation report
    if (
      state.toolEmittedReport &&
      state.shouldEarlyExitOnReport &&
      !state.abortedAfterReportDetection
    ) {
      this.log.info(
        `[PIPELINE:investigation-report-tool-early-exit] ${task.specialist}/${task.id} — aborting after tool-emitted report`
      )
      state.abortedAfterReportDetection = true
      state.abortController.abort()
      return true // break stream loop
    }

    return false
  }

  /** Handle error chunk — distinguish intentional abort from real errors. Returns true to break. */
  private handleErrorChunk(chunk: { error?: string }, state: SDKExecutionState): boolean {
    const { task } = state
    if (
      state.abortedAfterReportDetection &&
      typeof chunk.error === 'string' &&
      /abort/i.test(chunk.error)
    ) {
      this.log.debug(
        `[PIPELINE:investigation-report-early-exit] ${task.specialist}/${task.id} — received abort error chunk after report detection`
      )
      return true // break the stream loop
    }
    // Error will surface via emitProgress('failed') in BuildProgressCard, not chat stream
    throw new Error(chunk.error)
  }

  /** Classify whether an error is an intentional early-exit abort */
  private isIntentionalEarlyExitAbort(error: unknown, state: SDKExecutionState): boolean {
    const errorName =
      typeof error === 'object' && error !== null && 'name' in error
        ? String((error as { name: unknown }).name)
        : ''
    const errorMessage =
      error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    const isAbortErrorByName = errorName === 'AbortError'
    const isAbortErrorByMessage = /abort/i.test(errorMessage)
    return (
      state.abortedAfterReportDetection &&
      state.abortController.signal.aborted &&
      (isAbortErrorByName || isAbortErrorByMessage)
    )
  }

  /**
   * Post-execution: detect and validate investigation reports in specialist output.
   * Uses multi-strategy JSON extraction (code-fence → bracket-match → direct-parse)
   * plus schema validation with field-level error reporting.
   */
  private handleInvestigationReport(
    task: DecomposedTask,
    info: SpecialistProcessInfo,
    reportRegex: RegExp,
    toolEmittedReport?: InvestigationReport
  ): void {
    // Prefer tool-emitted report — already validated by Zod schema
    if (toolEmittedReport) {
      const report = toolEmittedReport
      this.log.info(
        `[PIPELINE:investigation-report-detected] ${task.specialist}/${task.id} strategy=tool`,
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

      // Persist as agent context
      if (this.conversationId) {
        const findingSummary = [
          report.problem ? `Problem: ${report.problem}` : '',
          report.impact ? `Impact: ${report.impact}` : '',
          report.rootCause ? `Root cause: ${report.rootCause}` : ''
        ]
          .filter(Boolean)
          .join('. ')
        if (findingSummary) {
          agentContextService.persistFinding(
            this.conversationId,
            task.specialist,
            findingSummary,
            task.id
          )
        }
      }

      messageBus.broadcast({
        from: task.specialist,
        type: 'finding',
        content: JSON.stringify(report),
        taskId: task.id,
        metadata: { reportType: 'investigation', impact: report.impact }
      })
      return // Tool path handled — skip fence fallback
    }

    // Fallback: fence-based detection (existing code)
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

      // Persist investigation finding as agent context for future specialists
      if (this.conversationId) {
        const findingSummary = [
          report.problem ? `Problem: ${report.problem}` : '',
          report.impact ? `Impact: ${report.impact}` : '',
          report.rootCause ? `Root cause: ${report.rootCause}` : ''
        ]
          .filter(Boolean)
          .join('. ')
        if (findingSummary) {
          agentContextService.persistFinding(
            this.conversationId,
            task.specialist,
            findingSummary,
            task.id
          )
        }
      }

      messageBus.broadcast({
        from: task.specialist,
        type: 'finding',
        content: JSON.stringify(report),
        taskId: task.id,
        metadata: { reportType: 'investigation', impact: report.impact }
      })
    } else if (!validationResult.success && info.output.match(reportRegex)) {
      this.log.error(
        `[PIPELINE:investigation-report-validation-failed] ${task.specialist}/${task.id}:`,
        validationResult.errors,
        '\nRaw text (first 500 chars):\n',
        validationResult.rawText
      )
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

    // Summary telemetry: capture what's being aborted before clearing
    const abortedTasks = [...this.activeProcesses.entries()].map(([id, info]) => ({
      taskId: id,
      specialist: info.task.specialist,
      status: info.status,
      toolCalls: info.toolCallCount
    }))

    this.log.info(
      `[PIPELINE:stopAll] Aborting ${abortedTasks.length} active tasks: ` +
        abortedTasks.map((t) => `${t.specialist}/${t.taskId}(${t.status})`).join(', ')
    )

    // End trace run on abort — prevents memory leak in tracer's activeRuns map
    if (this.currentRunId) {
      executionTracer.endRun(this.currentRunId, {
        aborted: true,
        abortedTasks: abortedTasks.length
      })
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
    error?: string,
    extras?: Partial<
      Pick<
        TaskExecutionProgress,
        'currentTool' | 'currentToolSummary' | 'toolCallCount' | 'startedAt' | 'completedAt'
      >
    >
  ): void {
    const progress: TaskExecutionProgress = {
      taskId: task.id,
      specialist: task.specialist,
      status,
      output,
      error,
      model: task.model,
      complexityTier: task.complexity?.tier,
      ...extras
    }
    this.emit('taskProgress', progress)

    // Emit agent status for Agent Monitor — uses specialist agent ID (not task ID)
    // so one card per specialist in the monitor panel.
    const info = this.activeProcesses.get(task.id)
    const agentStatus: AgentStatus = {
      agentId: task.specialist,
      agentType: 'specialist',
      status: mapToAgentStatus(status),
      currentTask: task.description,
      elapsedMs: extras?.startedAt
        ? Date.now() - extras.startedAt
        : info?.startedAt
          ? Date.now() - info.startedAt
          : 0,
      tokenUsage: info?.tokenUsage ?? 0,
      model: task.model,
      complexityTier: task.complexity?.tier
    }
    this.emit('agentStatus', agentStatus)
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
      await this.finalizeTaskCompletion(task, info)
      this.log.info(`[PIPELINE:onDone-called] ${task.specialist}/${task.id} path=non-build-mode`)
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
      hookEngine
        .executeHooks('gate_passed', { taskId: task.id, agentId: task.specialist })
        .catch((err) => this.log.warn('Hook error (gate_passed):', err))

      // Phase 10B: Record council success if this was a council-guided retry
      const councilSessionId = (task.metadata as Record<string, unknown>)?.bugCouncilSessionId
      if (councilSessionId) {
        bugCouncilService.updateFinalAttemptResult(councilSessionId as string, true)
        this.emit('taskChunk', {
          taskId: task.id,
          specialist: task.specialist,
          chunk: `\n\n✅ Bug Council guidance resolved the issue!`
        })
      }

      await this.finalizeTaskCompletion(task, info)
      this.log.info(`[PIPELINE:onDone-called] ${task.specialist}/${task.id} path=gates-passed`)
      onDone()
      return
    }

    if (loopResult.iterations >= loopResult.state.maxIterations) {
      // Phase 10B: Bug Council — if max iterations exhausted AND model is already Opus,
      // convene the Bug Council for diagnostic analysis before giving up.
      const currentModel = task.model ?? 'sonnet'
      const isOpus = currentModel === 'opus'
      const hasCouncilAlready = (task.metadata as Record<string, unknown>)?.bugCouncilSessionId

      if (isOpus && !hasCouncilAlready) {
        this.log.info(
          `Task ${task.id} exhausted ${loopResult.iterations} iterations at Opus — convening Bug Council`
        )

        this.emit('taskChunk', {
          taskId: task.id,
          specialist: task.specialist,
          chunk: `\n\n🏛️ Bug Council activated — 5 diagnostic agents analyzing the recurring failure...`
        })

        // Emit Bug Council activated event for UI
        this.emit('bugCouncilActivated', {
          sessionId: '', // will be filled after convene
          taskId: task.id,
          agentId: task.specialist,
          taskDescription: task.description.substring(0, 500)
        })

        try {
          // Collect failure history from gate results
          const gateHistory = loopResult.state.gateHistory as Array<{
            iteration: number
            gates: Array<{ type: string; passed: boolean; summary: string }>
            allPassed: boolean
          }>
          const failureHistory = gateHistory
            .filter((h) => !h.allPassed)
            .map((h) =>
              h.gates
                .filter((g) => !g.passed)
                .map((g) => `[${g.type}] ${g.summary}`)
                .join('\n')
            )

          const councilResult = await bugCouncilService.convene({
            taskId: task.id,
            agentId: task.specialist,
            taskDescription: task.description.substring(0, 2000),
            failureHistory,
            conversationId: this.conversationId ?? undefined,
            cwd: gateCwd
          })

          if (councilResult.status === 'complete' && councilResult.synthesizedSolution) {
            // Inject council guidance into task and retry one final time
            this.emit('taskChunk', {
              taskId: task.id,
              specialist: task.specialist,
              chunk: `\n\n🏛️ Bug Council solution ready — attempting final fix with council guidance...`
            })

            // Emit Bug Council complete event for UI
            this.emit('bugCouncilComplete', { result: councilResult })

            // Mark that we've used the council for this task (prevent infinite loop)
            if (!task.metadata) task.metadata = {}
            ;(task.metadata as Record<string, unknown>).bugCouncilSessionId =
              councilResult.sessionId

            // Append council guidance to task description
            task.description =
              task.description +
              `\n\n--- BUG COUNCIL GUIDANCE ---\n` +
              `The following solution was synthesized by 5 diagnostic agents analyzing your recurring failure:\n\n` +
              councilResult.synthesizedSolution +
              `\n\nRisk assessment: ${councilResult.riskAssessment}` +
              `\n--- END COUNCIL GUIDANCE ---`

            // Reset loop for one final attempt
            taskLoopService.cleanup(task.id)
            taskLoopService.initLoop(task.id, task.specialist)

            // Remove from completed to allow re-start
            this.completedTasks.delete(task.id)
            this.taskResults.delete(task.id)

            // Re-spawn with council guidance
            this.createWorktreeAndSpawn(task, mode, onDone, info.attempt, info.worktreeId).catch(
              (err) => {
                this.log.error(
                  `[PIPELINE:council-retry-unhandled] ${task.specialist}/${task.id} — ${(err as Error).message}`
                )
                this.activeProcesses.delete(task.id)
                this.taskStatuses.set(task.id, 'failed')
                this.emitProgress(task, 'failed', undefined, (err as Error).message)
                onDone()
              }
            )
            return
          }
        } catch (councilError) {
          this.log.error('Bug Council failed:', councilError)
          this.emit('taskChunk', {
            taskId: task.id,
            specialist: task.specialist,
            chunk: `\n\n⚠️ Bug Council analysis failed — completing with known issues.`
          })
        }
      }

      // Max iterations reached (or council already tried) — complete with warning
      this.log.warn(
        `Task ${task.id} failed quality gates after ${loopResult.iterations} iterations — completing anyway`
      )
      this.emit('taskChunk', {
        taskId: task.id,
        specialist: task.specialist,
        chunk: `\n\n⚠️ Quality gates still failing after ${loopResult.iterations} fix attempts. Completing with known issues.`
      })

      // Update council session with final result if applicable
      if (hasCouncilAlready) {
        bugCouncilService.updateFinalAttemptResult(hasCouncilAlready as string, false)
      }

      await this.finalizeTaskCompletion(task, info)
      this.log.info(
        `[PIPELINE:onDone-called] ${task.specialist}/${task.id} path=max-iterations-exhausted`
      )
      onDone()
      return
    }

    // Gates failed, iterations remaining — re-spawn with fix context
    hookEngine
      .executeHooks('gate_failed', { taskId: task.id, agentId: task.specialist })
      .catch((err) => this.log.warn('Hook error (gate_failed):', err))
    this.log.info(
      `Task ${task.id} failed quality gates (iteration ${loopResult.iterations}) — re-spawning with fix context`
    )

    // Model escalation on stuck detection
    if (loopResult.shouldEscalate) {
      hookEngine
        .executeHooks('escalation', {
          taskId: task.id,
          agentId: task.specialist,
          from: task.model ?? 'sonnet'
        })
        .catch((err) => this.log.warn('Hook error (escalation):', err))
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

        // Persist escalation decision for cross-agent context
        if (this.conversationId) {
          agentContextService.persistDecision(
            this.conversationId,
            task.specialist,
            `Model escalated from ${previousModel} to ${escalatedModel}: stuck detection — same gates failing for ${loopResult.iterations} iterations`,
            task.id
          )
        }
      }
    }

    // Append fix context to task description for retry
    task.description = task.description + loopResult.fixContext

    // Inject re-engagement prompt if abandonment was detected during post-completion analysis
    const reEngagement =
      ((task.metadata as Record<string, unknown>)?.reEngagementPrompt as string) ?? ''
    if (reEngagement) {
      task.description = task.description + '\n\n' + reEngagement
      // Clear after injection to avoid stacking on subsequent retries
      delete (task.metadata as Record<string, unknown>).reEngagementPrompt
    }

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
    this.createWorktreeAndSpawn(task, mode, onDone, info.attempt, info.worktreeId).catch((err) => {
      this.log.error(
        `[PIPELINE:gate-retry-unhandled] ${task.specialist}/${task.id} — ${(err as Error).message}`
      )
      this.activeProcesses.delete(task.id)
      this.taskStatuses.set(task.id, 'failed')
      this.emitProgress(task, 'failed', undefined, (err as Error).message)
      onDone()
    })
  }

  /**
   * Finalize task completion — mark as completed, merge worktree, clean up task loop.
   */
  private async finalizeTaskCompletion(
    task: DecomposedTask,
    info: SpecialistProcessInfo
  ): Promise<void> {
    // Guard against duplicate completion — can happen if both runTaskLoopGates
    // and its catch handler call finalizeTaskCompletion for the same task.
    if (this.taskStatuses.get(task.id) === 'completed') {
      this.log.warn(`[PIPELINE:duplicate-completion-blocked] taskId=${task.id} — already finalized`)
      return
    }

    info.status = 'completed'
    this.taskStatuses.set(task.id, 'completed')
    this.emitProgress(task, 'completed', info.output, undefined, {
      startedAt: info.startedAt,
      completedAt: Date.now()
    })

    // Clean up task loop state
    taskLoopService.cleanup(task.id)

    // Attempt to merge worktree if one was created
    if (info.worktreeId) {
      // Checkpoint approval — pause for user confirmation before irreversible merge
      const approved = await checkpointService.requestApproval({
        type: 'merge_approval',
        title: `Merge ${task.specialist} Work`,
        summary: `Merge worktree for task "${task.id}" into main branch`,
        details: {
          what: `Git merge of ${task.specialist}'s isolated work into the main workspace`,
          why: 'Merging changes is irreversible without manual git intervention',
          risk: 'Potential merge conflicts with other specialists or manual changes'
        }
      })

      if (!approved) {
        this.log.info(
          `[PIPELINE:merge-rejected] ${task.specialist}/${task.id} — user rejected merge`
        )
        eventLoggerService.logMergeRejected({
          conversationId: this.conversationId ?? undefined,
          agentId: task.specialist,
          taskId: task.id,
          reason: 'user_rejected'
        })
        worktreeRepository.updateStatus(info.worktreeId, 'abandoned')

        // Fire checkpoint_rejected hook
        hookEngine
          .executeHooks('checkpoint_rejected', { taskId: task.id, agentId: task.specialist })
          .catch((err) => this.log.warn('Hook error (checkpoint_rejected):', err))
        return // skip merge, keep worktree
      }

      // Fire checkpoint_approved hook
      hookEngine
        .executeHooks('checkpoint_approved', { taskId: task.id, agentId: task.specialist })
        .catch((err) => this.log.warn('Hook error (checkpoint_approved):', err))

      // Run pre_merge hooks — allow blocking
      const preHookResults = await hookEngine.executeHooks('pre_merge', {
        taskId: task.id,
        agentId: task.specialist
      })
      const blocked = preHookResults.some((r) => r.exitCode !== 0 && r.exitCode !== null)
      if (blocked) {
        this.log.warn(
          `[PIPELINE:merge-blocked] ${task.specialist}/${task.id} — pre-merge hook returned non-zero`
        )
        eventLoggerService.logMergeRejected({
          conversationId: this.conversationId ?? undefined,
          agentId: task.specialist,
          taskId: task.id,
          reason: 'pre_merge_hook_blocked'
        })
        return
      }

      try {
        const mergeResult: MergeResult = await gitWorktreeService.merge(info.worktreeId)
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
          // Fire post_merge hook (non-blocking)
          hookEngine
            .executeHooks('post_merge', { taskId: task.id, agentId: task.specialist })
            .catch((err) => this.log.warn('Hook error (post_merge):', err))

          // Clean up worktree after successful merge
          gitWorktreeService.remove(info.worktreeId!, true).catch((err) => {
            this.log.warn(`Failed to remove worktree after merge: ${err}`)
          })
        }
      } catch (err) {
        this.log.error(`Failed to merge worktree for ${task.specialist}/${task.id}:`, err)
        this.emit('mergeConflict', {
          agentId: task.specialist,
          taskId: task.id,
          conflictedFiles: []
        })
      }
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
      // Abandonment detection with re-engagement loop
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

        // Fire abandonment hook
        hookEngine
          .executeHooks('abandonment_detected', {
            taskId: task.id,
            agentId: task.specialist,
            pattern: abandonment.pattern ?? 'unknown'
          })
          .catch((err) => this.log.warn('Hook error (abandonment_detected):', err))

        // Re-engagement: inject motivational prompt for next retry (max 2 attempts)
        const meta = (task.metadata ?? {}) as Record<string, unknown>
        const abandonmentCount = ((meta.abandonmentCount as number) ?? 0) + 1
        meta.abandonmentCount = abandonmentCount
        task.metadata = meta

        if (abandonmentCount <= 2) {
          const reEngagement = getReEngagementPrompt(abandonment)
          meta.reEngagementPrompt = reEngagement
          this.log.info(
            `Re-engaging ${task.specialist} on task ${task.id} (attempt ${abandonmentCount})`
          )
          this.emit('taskChunk', {
            taskId: task.id,
            specialist: task.specialist,
            chunk: `\n\n⚡ Agent attempted to give up — re-engaging with alternative approach (attempt ${abandonmentCount}/2)\n`
          })
        }
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
    this.skippedTasks.clear()
    this.activeProcesses.clear()
    this.aborted = false
    this.conversationBrief = null
    this.consecutiveSpawnFailures = 0
    this.investigationDepth = 'standard'
    this.currentRunId = null
    this.semaphore.drain()
    taskLoopService.reset()
    // Strategy λ: Clear specialist prompt cache on reset (new conversation = new context)
    this.specialistPromptCache.clear()
    // Refresh scheduling strategy from preferences (may have changed in settings)
    this.schedulingStrategy = SpecialistPoolService.createSchedulingStrategy()
    // Note: workspacePath and conversationId are preserved across resets
  }
}

export const specialistPoolService = new SpecialistPoolService()
