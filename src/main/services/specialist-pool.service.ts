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
import { agentRegistry } from './agent-registry'
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
  /** S9: Patterns that indicate a specialist has reached a conclusion.
   * When detected mid-stream in plan mode, we abort to save unnecessary turns. */
  private static readonly CONCLUSIVE_PATTERNS: RegExp[] = [
    /```investigation-report\s*\n[\s\S]*?```/, // Existing: structured report
    /## Summary of Findings\b/, // Common investigation conclusion header
    /## Root Cause\b/, // Root cause identified
    /\b(?:In summary|In conclusion|To summarize),\s/, // Natural language conclusions
    /## Recommendations?\b/ // Recommendation section header
  ]

  private readonly log = specialistPoolLogger
  private workspacePath: string | null = null
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

  setWorkspacePath(path: string): void {
    this.workspacePath = path
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

    this.emit('allComplete')
  }

  /**
   * Executes tasks in parallel, respecting dependency ordering.
   * Tasks with no unmet dependencies start immediately.
   * When a task completes, any newly-unblocked tasks are started.
   */
  async executeParallel(tasks: DecomposedTask[], mode: ConversationMode): Promise<void> {
    this.reset()

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
        for (const [id, task] of pending) {
          if (this.aborted) break

          // Concurrency limit — don't start more tasks than allowed
          if (this.activeProcesses.size >= MAX_CONCURRENT_SPECIALISTS) {
            this.log.debug(
              `Concurrency limit reached (${this.activeProcesses.size}/${MAX_CONCURRENT_SPECIALISTS}), ${pending.size} task(s) queued`
            )
            break
          }

          const depsReady = task.dependsOn.every((dep) => this.completedTasks.has(dep))
          if (depsReady && !this.activeProcesses.has(id)) {
            pending.delete(id)
            this.startTask(task, mode, () => {
              // On task completion, check if more tasks can start
              if (pending.size === 0 && this.activeProcesses.size === 0) {
                this.emit('allComplete')
                resolve()
              } else {
                tryStartReady()
              }
            })
          }
        }

        // If nothing is running and nothing is pending, we're done
        if (pending.size === 0 && this.activeProcesses.size === 0) {
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
   */
  private startTask(task: DecomposedTask, mode: ConversationMode, onDone: () => void): void {
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
        escalations: []
      }

      // Log agent started event
      eventLoggerService.logAgentStarted({
        conversationId: this.conversationId ?? undefined,
        agentId: task.specialist,
        taskId: task.id,
        model: task.model,
        complexityTier: task.complexity?.tier
      })
      this.activeProcesses.set(task.id, info)

      try {
        await this.runSpecialistViaSDK(task, mode, info, worktreeId)

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

        this.runTaskLoopGates(task, info, mode, gateCwd, onDone).catch((err) => {
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

          this.log.warn(`Task ${task.id} failed via SDK (attempt ${info.attempt + 1}), retrying in ${delay}ms...`)
          eventLoggerService.logAgentFailed({
            conversationId: this.conversationId ?? undefined,
            agentId: task.specialist,
            taskId: task.id,
            error: (error as Error).message,
            attempt: info.attempt
          })

          // Clean up worktree before retry
          if (info.worktreeId) {
            gitWorktreeService.remove(info.worktreeId, true).catch((err) => {
              this.log.warn(`Failed to remove worktree before retry: ${err}`)
            })
          }

          this.completedTasks.delete(task.id)
          this.taskResults.delete(task.id)

          setTimeout(() => {
            this.createWorktreeAndSpawn(task, mode, onDone, info.attempt + 1)
          }, delay)
          return
        }

        // Retries exhausted
        this.consecutiveSpawnFailures++
        this.emitProgress(task, 'failed', undefined, (error as Error).message)

        eventLoggerService.logAgentFailed({
          conversationId: this.conversationId ?? undefined,
          agentId: task.specialist,
          taskId: task.id,
          error: `SDK error after ${info.attempt + 1} attempt(s): ${(error as Error).message}`,
          attempt: info.attempt
        })

        if (this.consecutiveSpawnFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          this.log.error(`Circuit breaker tripped: ${this.consecutiveSpawnFailures} consecutive failures`)
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

        onDone()
        return
      }
    }
  }

  /**
   * Builds the specialist context (system prompt, full prompt, cwd, model).
   * Used by the SDK execution path.
   */
  private async buildSpecialistContext(
    task: DecomposedTask,
    mode: ConversationMode,
    worktreeId?: string
  ): Promise<{ systemPrompt: string; fullPrompt: string; cwd: string; modelId: string; thinkingBudget: string }> {
    // Resolve specialist prompt from DB
    const specialist = specialistRepository.findByAgentId(task.specialist)

    // Resolve skills deterministically via AgentRegistry
    const assignedSkills = agentRegistry.getSkillsForAgent(task.specialist)

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
      skillsEnabled: (task.complexity?.total ?? 5) >= 5
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

    const fullPrompt = `${task.description}${scopeConstraint}${verificationSuffix}${dependencyContext}`

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
    const { systemPrompt, fullPrompt, cwd, modelId, thinkingBudget } =
      await this.buildSpecialistContext(task, mode, worktreeId)

    this.log.info(
      `Running specialist via SDK [${task.specialist}] model=${task.model ?? 'sonnet'} for task ${task.id} in ${cwd}`
    )

    // Create AbortController for cancellation support (stopAll)
    const abortController = new AbortController()
    info.abortController = abortController

    let toolCallCount = 0
    const isPlanModeSpecialist = mode === 'plan'
    const isInvestigationTask =
      task.description.toLowerCase().includes('investigation report') ||
      task.description.toLowerCase().includes('investigate')
    const shouldEarlyExitOnReport = isPlanModeSpecialist && isInvestigationTask
    const depthBudget = SpecialistPoolService.DEPTH_BUDGETS[this.investigationDepth]
    const maxToolCalls = isPlanModeSpecialist
      ? depthBudget.maxToolCalls
      : SpecialistPoolService.MAX_SPECIALIST_TOOL_CALLS
    const maxTurns = isPlanModeSpecialist
      ? depthBudget.maxTurns
      : SpecialistPoolService.MAX_SPECIALIST_BUILD_TURNS
    const reportRegex = /```investigation-report\s*\n([\s\S]*?)```/
    let abortedAfterReportDetection = false

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
        abortController
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
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : ''
      const isAbortErrorByName = errorName === 'AbortError'
      const isAbortErrorByMessage = /abort/i.test(errorMessage)
      const isIntentionalEarlyExitAbort =
        abortedAfterReportDetection &&
        abortController.signal.aborted &&
        (isAbortErrorByName || isAbortErrorByMessage)
      if (!isIntentionalEarlyExitAbort) {
        throw error
      }
    }

    // Detect investigation report in specialist output
    // Support both exact and slightly varied formats (extra whitespace, trailing content)
    const reportMatch = info.output.match(reportRegex)
    if (reportMatch) {
      try {
        const rawJson = reportMatch[1].trim()
        const report = JSON.parse(rawJson)
        this.log.info(
          `[PIPELINE:investigation-report-detected] ${task.specialist}/${task.id}`,
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
      } catch (parseErr) {
        this.log.error(
          `[PIPELINE:investigation-report-parse-failed] ${task.specialist}/${task.id}:`,
          parseErr,
          '\nRaw JSON (first 500 chars):\n',
          reportMatch[1].substring(0, 500)
        )
        // Emit a degraded report so the user sees SOMETHING
        this.emit('investigationReport', {
          taskId: task.id,
          specialist: task.specialist,
          report: {
            problem: 'Investigation completed but the report could not be parsed.',
            rootCause: 'The specialist produced a report in an unexpected format.',
            proposedFix: 'Check the specialist output above for details.',
            filesAffected: [],
            impact: 'medium' as const,
            impactReason: 'Report parsing failed — review specialist output manually.'
          }
        })
      }
    } else {
      // Check if this was an investigation task that should have produced a report
      if (isInvestigationTask) {
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
          report: {
            problem: 'Investigation completed but no structured report was produced.',
            rootCause:
              'The specialist did not emit an investigation-report block. Review the output above for findings.',
            proposedFix:
              'Review the specialist output above and create a fix plan manually.',
            filesAffected: [],
            impact: 'medium' as const,
            impactReason:
              'No structured report — specialist output may contain useful findings.'
          }
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
   */
  private topologicalSort(tasks: DecomposedTask[]): DecomposedTask[] {
    const taskMap = new Map(tasks.map((t) => [t.id, t]))
    const visited = new Set<string>()
    const result: DecomposedTask[] = []

    const visit = (id: string): void => {
      if (visited.has(id)) return
      visited.add(id)

      const task = taskMap.get(id)
      if (!task) return

      for (const dep of task.dependsOn) {
        visit(dep)
      }
      result.push(task)
    }

    for (const task of tasks) {
      visit(task.id)
    }

    return result
  }

  /**
   * Aborts all running specialist processes.
   */
  async stopAll(): Promise<void> {
    this.aborted = true

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

    this.emit('taskRetry', {
      taskId: task.id,
      specialist: task.specialist,
      attempt: loopResult.iterations,
      maxRetries: loopResult.state.maxIterations
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

      // Log successful completion event
      eventLoggerService.logAgentCompleted({
        conversationId: this.conversationId ?? undefined,
        agentId: task.specialist,
        taskId: task.id,
        tokenUsage: info.tokenUsage
      })
    } catch (err) {
      this.log.warn('Post-completion analysis failed:', err)
    }
  }

  /** S9: Identify which conclusive pattern matched (for logging) */
  private detectConclusivePattern(output: string): string | null {
    const labels = [
      'investigation-report',
      'summary-of-findings',
      'root-cause',
      'natural-conclusion',
      'recommendations'
    ]
    for (let i = 0; i < SpecialistPoolService.CONCLUSIVE_PATTERNS.length; i++) {
      if (SpecialistPoolService.CONCLUSIVE_PATTERNS[i].test(output)) {
        return labels[i]
      }
    }
    return null
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
    taskLoopService.reset()
    // Note: workspacePath and conversationId are preserved across resets
  }
}

export const specialistPoolService = new SpecialistPoolService()
