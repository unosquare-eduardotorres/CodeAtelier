import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type {
  BudgetTier,
  ConversationMode,
  DecomposedTask,
  HandoffBrief,
  ModelTier,
  TaskExecutionProgress
} from '../../shared/types'
import { THINKING_BUDGETS } from '../../shared/constants'
import { specialistPoolLogger } from '../logger'
import {
  specialistRepository,
  worktreeRepository,
  agentSessionRepository,
  workspaceRepository
} from '../db/repositories'
import { promptBuilder } from './prompt-builder'
import { agentRegistry } from './agent-registry'
import { memoryService } from './memory.service'
import { gitWorktreeService } from './git-worktree.service'
import type { MergeResult } from './git-worktree.service'
import { buildEnvWithPath } from './env-utils'
import { summarizeToolInput } from './agent-base.service'
import { modelConfigService } from './model-config.service'
import { checkpointService } from './checkpoint.service'
import { eventLoggerService } from './event-logger.service'
import { detectAbandonment, detectQualityGates } from './abandonment-detector.service'
import { gateResultRepository } from '../db/repositories/gate-result.repository'
import { costTrackerService } from './cost-tracker.service'
import { taskLoopService } from './task-loop.service'
import { taskArtifactService } from './task-artifact.service'
import { PromptBuilder } from './prompt-builder'

/** Retry configuration for specialist tasks */
const RETRY_CONFIG = {
  maxRetries: 2, // Max 2 retries (3 total attempts)
  baseDelayMs: 2000, // 2s initial delay
  maxDelayMs: 30000, // 30s max delay
  backoffMultiplier: 2, // Exponential backoff
  retryableExitCodes: [1, 137, 143], // General error, SIGKILL, SIGTERM
  rateLimitDelayMs: 10000 // Longer delay for rate-limited retries
}

/** Maximum time (ms) a specialist process can run before being killed — 10 minutes */
const SPECIALIST_TIMEOUT_MS = 10 * 60 * 1000
/** Grace period (ms) between SIGTERM and SIGKILL escalation */
const SIGKILL_GRACE_MS = 5000
/** Maximum accumulated output size per specialist (5MB) — prevents unbounded memory growth */
const MAX_OUTPUT_SIZE = 5 * 1024 * 1024
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
  process: ChildProcess
  output: string
  status: TaskExecutionProgress['status']
  worktreeId?: string
  dbSessionId?: string
  attempt: number
  rateLimited?: boolean
  timeoutTimer?: ReturnType<typeof setTimeout>
  /** Accumulated token usage from stream events (input + output) */
  tokenUsage: number
  /** Track model escalations during retries */
  escalations: { fromModel: string; toModel: string; attempt: number }[]
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
  private readonly log = specialistPoolLogger
  private workspacePath: string | null = null
  private conversationId: string | null = null
  private activeProcesses: Map<string, SpecialistProcessInfo> = new Map()
  private completedTasks: Set<string> = new Set()
  private taskResults: Map<string, string> = new Map()
  /** Per-task NDJSON buffer for handling partial lines across data events */
  private taskBuffers: Map<string, string> = new Map()
  /** Track final status per task for runSpecialistTask result checking */
  private taskStatuses: Map<string, TaskExecutionProgress['status']> = new Map()
  private aborted: boolean = false
  /** Enriched handoff context from the generalist, injected into specialist prompts */
  private conversationBrief: HandoffBrief | null = null
  /** Circuit breaker: consecutive spawn failures across all tasks */
  private consecutiveSpawnFailures = 0

  setWorkspacePath(path: string): void {
    this.workspacePath = path
  }

  setConversationBrief(brief: HandoffBrief | null): void {
    this.conversationBrief = brief
  }

  setConversationId(id: string): void {
    this.conversationId = id
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

    const childProcess = await this.spawnSpecialist(task, mode, worktreeId)

    // Create DB session for token tracking
    let dbSessionId: string | undefined
    try {
      const sessionAction = task.model ? tierToModelAction(task.model) : 'specialist:moderate'
      const sessionModelId = modelConfigService.getModel(
        this.workspacePath ?? undefined,
        sessionAction
      )
      const session = agentSessionRepository.create(task.specialist, {
        taskId: task.id,
        pid: childProcess.pid,
        conversationId: this.conversationId ?? undefined,
        workspaceId: undefined, // workspace DB ID not available here
        complexityScore: task.complexity?.total,
        modelUsed: sessionModelId,
        complexityTier: task.complexity?.tier
      })
      dbSessionId = session.id
    } catch (err) {
      this.log.error('Failed to create DB session for specialist:', err)
    }

    const info: SpecialistProcessInfo = {
      task,
      process: childProcess,
      output: '',
      status: 'running',
      worktreeId,
      dbSessionId,
      attempt,
      tokenUsage: 0,
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

    // Set a timeout to kill stuck specialist processes (SIGTERM → SIGKILL escalation)
    info.timeoutTimer = setTimeout(() => {
      if (childProcess.exitCode === null && !childProcess.killed) {
        this.log.warn(
          `Specialist [${task.specialist}] task ${task.id} timed out after ${SPECIALIST_TIMEOUT_MS / 1000}s — sending SIGTERM`
        )
        this.emit('taskChunk', {
          taskId: task.id,
          specialist: task.specialist,
          chunk: `\n\n⚠️ Task timed out after ${SPECIALIST_TIMEOUT_MS / 60000} minutes. Terminating…`
        })
        childProcess.kill('SIGTERM')

        // Escalate to SIGKILL if SIGTERM doesn't work
        setTimeout(() => {
          if (childProcess.exitCode === null && !childProcess.killed) {
            this.log.warn(
              `Specialist [${task.specialist}] task ${task.id} did not exit after SIGTERM — sending SIGKILL`
            )
            childProcess.kill('SIGKILL')
          }
        }, SIGKILL_GRACE_MS)
      }
    }, SPECIALIST_TIMEOUT_MS)

    // Initialize NDJSON buffer for this task
    this.taskBuffers.set(task.id, '')

    childProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      // Cap output size to prevent unbounded memory growth from verbose specialists
      if (info.output.length < MAX_OUTPUT_SIZE) {
        info.output += text
        if (info.output.length >= MAX_OUTPUT_SIZE) {
          info.output += '\n\n[Output truncated at 5MB]'
          this.log.warn(
            `Specialist ${task.specialist}/${task.id} output truncated at ${MAX_OUTPUT_SIZE} bytes`
          )
        }
      }

      // Buffer-aware NDJSON parsing — handles partial lines across data events
      const existingBuffer = this.taskBuffers.get(task.id) ?? ''
      const buffered = existingBuffer + text
      const lines = buffered.split('\n')
      // Keep the last (possibly incomplete) line in the buffer
      this.taskBuffers.set(task.id, lines.pop() ?? '')

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          if (event.type === 'assistant') {
            const content = event.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  this.emit('taskChunk', {
                    taskId: task.id,
                    specialist: task.specialist,
                    chunk: block.text
                  })
                }
              }
            }
          } else if (event.type === 'content_block_start') {
            const cb = event.content_block
            if (cb?.type === 'text' && cb.text) {
              this.emit('taskChunk', {
                taskId: task.id,
                specialist: task.specialist,
                chunk: cb.text
              })
            } else if (cb?.type === 'tool_use') {
              // Emit tool activity so user sees what the agent is doing
              const toolName = cb.name as string
              const toolInput = cb.input as Record<string, unknown> | undefined
              const summary = toolInput ? summarizeToolInput(toolName, toolInput) : ''
              this.emit('taskChunk', {
                taskId: task.id,
                specialist: task.specialist,
                chunk: `\n🔧 **${toolName}** ${summary}\n`
              })
            }
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta
            if (delta?.type === 'text_delta' && delta.text) {
              this.emit('taskChunk', {
                taskId: task.id,
                specialist: task.specialist,
                chunk: delta.text
              })
            }
          } else if (event.type === 'result' && event.result) {
            this.emit('taskChunk', {
              taskId: task.id,
              specialist: task.specialist,
              chunk: event.result as string
            })
          }

          // Extract token usage from all stream event types:
          // - message_start: carries input_tokens in event.message.usage
          // - message_delta: carries output_tokens in event.usage
          // - result/assistant: carry usage in event.usage (already handled)
          if (event.type === 'message_start' && event.message?.usage) {
            const msgUsage = event.message.usage as Record<string, number>
            info.tokenUsage += msgUsage.input_tokens ?? 0
          } else if (event.type === 'message_delta' && event.usage) {
            const deltaUsage = event.usage as Record<string, number>
            info.tokenUsage += deltaUsage.output_tokens ?? 0
          } else {
            const usage = event.usage as Record<string, number> | undefined
            if (usage) {
              const inputTokens = usage.input_tokens ?? 0
              const outputTokens = usage.output_tokens ?? 0
              info.tokenUsage += inputTokens + outputTokens
            }
          }
        } catch {
          // Not JSON — emit raw text
          if (trimmed) {
            this.emit('taskChunk', {
              taskId: task.id,
              specialist: task.specialist,
              chunk: trimmed
            })
          }
        }
      }
    })

    childProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      this.log.error(`[${task.specialist}/${task.id}] stderr:`, text)

      // Forward stderr to agent monitor so users can see errors
      if (text) {
        this.emit('taskChunk', {
          taskId: task.id,
          specialist: task.specialist,
          chunk: `\n⚠️ ${text}\n`
        })
      }

      // Detect rate limiting from Claude CLI
      if (text.includes('rate limit') || text.includes('429') || text.includes('overloaded')) {
        this.log.warn(`Rate limit detected for ${task.specialist}/${task.id}`)
        info.rateLimited = true
      }
    })

    childProcess.on('exit', (code) => {
      // Clear the timeout timer — process exited normally
      if (info.timeoutTimer) clearTimeout(info.timeoutTimer)

      // Flush any remaining NDJSON buffer content
      const remainingBuffer = this.taskBuffers.get(task.id)?.trim()
      if (remainingBuffer) {
        try {
          const event = JSON.parse(remainingBuffer)
          if (event.type === 'result' && event.result) {
            this.emit('taskChunk', {
              taskId: task.id,
              specialist: task.specialist,
              chunk: event.result as string
            })
          }
        } catch {
          this.emit('taskChunk', {
            taskId: task.id,
            specialist: task.specialist,
            chunk: remainingBuffer
          })
        }
      }
      this.taskBuffers.delete(task.id)

      this.activeProcesses.delete(task.id)
      this.completedTasks.add(task.id)
      this.taskResults.set(task.id, info.output)

      // Complete DB session record with accumulated token usage
      if (info.dbSessionId) {
        try {
          agentSessionRepository.complete(
            info.dbSessionId,
            code === 0 ? 'completed' : 'failed',
            info.tokenUsage
          )
        } catch (err) {
          this.log.error('Failed to complete DB session:', err)
        }
      }

      if (code === 0) {
        // Reset circuit breaker on successful completion
        this.consecutiveSpawnFailures = 0

        // Post-completion analysis: abandonment detection + passive quality gates
        this.runPostCompletionAnalysis(task, info)

        // Write output artifact for downstream specialists
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

        // Task Loop: Run explicit quality gates and retry if they fail
        // Resolve the cwd for gate execution (worktree or workspace)
        const gateCwd = info.worktreeId
          ? (worktreeRepository.findById(info.worktreeId)?.worktreePath ?? this.workspacePath!)
          : this.workspacePath!

        // Run quality gates asynchronously — if they fail, re-spawn in the same worktree
        this.runTaskLoopGates(task, info, mode, gateCwd, onDone).catch((err) => {
          this.log.error(`Task loop gate evaluation failed for ${task.id}:`, err)
          // Fall through to normal completion on error
          this.finalizeTaskCompletion(task, info)
          onDone()
        })
        return // Don't call onDone yet — task loop will handle it
      } else {
        // Check if we should retry
        const exitCode = code ?? 0
        const isRetryable =
          info.attempt < RETRY_CONFIG.maxRetries &&
          RETRY_CONFIG.retryableExitCodes.includes(exitCode)

        if (isRetryable) {
          const baseDelay = info.rateLimited
            ? RETRY_CONFIG.rateLimitDelayMs
            : RETRY_CONFIG.baseDelayMs
          const delay = Math.min(
            baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, info.attempt),
            RETRY_CONFIG.maxDelayMs
          )

          // Failure-based model escalation: upgrade tier for the retry
          const currentModel = task.model ?? 'sonnet'
          const escalatedModel = MODEL_ESCALATION_CHAIN[currentModel]
          if (escalatedModel && !info.rateLimited) {
            const previousModel = task.model ?? 'sonnet'
            task.model = escalatedModel
            info.escalations.push({
              fromModel: previousModel,
              toModel: escalatedModel,
              attempt: info.attempt + 1
            })
            this.log.info(
              `Escalating model for ${task.specialist}/${task.id}: ${previousModel} → ${escalatedModel} (attempt ${info.attempt + 1})`
            )
            eventLoggerService.logModelEscalation({
              conversationId: this.conversationId ?? undefined,
              agentId: task.specialist,
              taskId: task.id,
              fromModel: previousModel,
              toModel: escalatedModel,
              reason: `Failure on attempt ${info.attempt + 1} with exit code ${exitCode}`,
              attempt: info.attempt + 1
            })
          }

          this.log.warn(
            `Task ${task.id} failed (attempt ${info.attempt + 1}), retrying in ${delay}ms...`
          )

          // Log failed attempt event
          eventLoggerService.logAgentFailed({
            conversationId: this.conversationId ?? undefined,
            agentId: task.specialist,
            taskId: task.id,
            error: `Exit code ${exitCode}`,
            attempt: info.attempt
          })

          this.emit('taskRetry', {
            taskId: task.id,
            specialist: task.specialist,
            attempt: info.attempt + 1,
            maxRetries: RETRY_CONFIG.maxRetries
          })

          // Clean up failed worktree before retry
          if (info.worktreeId) {
            gitWorktreeService.remove(info.worktreeId, true).catch((err) => {
              this.log.warn(`Failed to remove worktree before retry: ${err}`)
            })
          }

          // Remove from completed (will re-add on retry completion)
          this.completedTasks.delete(task.id)
          this.taskResults.delete(task.id)

          setTimeout(() => {
            this.createWorktreeAndSpawn(task, mode, onDone, info.attempt + 1)
          }, delay)
          return // Don't call onDone yet — retry will handle it
        }

        // Retries exhausted or non-retryable — mark as failed
        this.consecutiveSpawnFailures++
        info.status = 'failed'
        this.taskStatuses.set(task.id, 'failed')
        this.emitProgress(task, 'failed', undefined, `Process exited with code ${code}`)

        // Log final failure event
        eventLoggerService.logAgentFailed({
          conversationId: this.conversationId ?? undefined,
          agentId: task.specialist,
          taskId: task.id,
          error: `Process exited with code ${code} after ${info.attempt + 1} attempt(s)`,
          attempt: info.attempt
        })

        // Circuit breaker: stop all tasks if too many consecutive failures
        if (this.consecutiveSpawnFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          this.log.error(
            `Circuit breaker tripped: ${this.consecutiveSpawnFailures} consecutive failures — stopping all tasks`
          )
          eventLoggerService.logCircuitBreakerTripped({
            conversationId: this.conversationId ?? undefined,
            failures: this.consecutiveSpawnFailures
          })
          this.emit('circuitBreakerTripped', {
            failures: this.consecutiveSpawnFailures
          })
          this.stopAll()
          return
        }

        // Abandon worktree on failure
        if (info.worktreeId) {
          worktreeRepository.updateStatus(info.worktreeId, 'abandoned')
        }
      }

      onDone()
    })

    childProcess.on('error', (err) => {
      if (info.timeoutTimer) clearTimeout(info.timeoutTimer)
      this.taskBuffers.delete(task.id)
      this.activeProcesses.delete(task.id)
      this.completedTasks.add(task.id)
      this.consecutiveSpawnFailures++
      info.status = 'failed'
      this.taskStatuses.set(task.id, 'failed')
      this.emitProgress(task, 'failed', undefined, err.message)

      // Circuit breaker: stop all tasks if too many consecutive failures
      if (this.consecutiveSpawnFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.log.error(
          `Circuit breaker tripped: ${this.consecutiveSpawnFailures} consecutive spawn errors — stopping all tasks`
        )
        eventLoggerService.logCircuitBreakerTripped({
          conversationId: this.conversationId ?? undefined,
          failures: this.consecutiveSpawnFailures
        })
        this.emit('circuitBreakerTripped', {
          failures: this.consecutiveSpawnFailures
        })
        this.stopAll()
      }

      // Complete DB session on error with whatever tokens were consumed
      if (info.dbSessionId) {
        try {
          agentSessionRepository.complete(info.dbSessionId, 'failed', info.tokenUsage)
        } catch (dbErr) {
          this.log.error('Failed to complete DB session on error:', dbErr)
        }
      }

      // Abandon worktree on error
      if (info.worktreeId) {
        worktreeRepository.updateStatus(info.worktreeId, 'abandoned')
      }

      onDone()
    })
  }

  /**
   * Spawns a `claude -p` process for a single specialist task.
   * If a worktreeId is provided, the process runs in the isolated worktree directory.
   */
  private async spawnSpecialist(
    task: DecomposedTask,
    mode: ConversationMode,
    worktreeId?: string
  ): Promise<ChildProcess> {
    // Resolve specialist prompt from DB
    const specialist = specialistRepository.findByAgentId(task.specialist)

    // Resolve skills deterministically via AgentRegistry (no LLM matching)
    const assignedSkills = agentRegistry.getSkillsForAgent(task.specialist)

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

    // Strategy 4: Model-aware prompt budgeting — scale context size by model tier.
    // Haiku tasks: minimal context (skip CLAUDE.md, tiny skill content)
    // Sonnet tasks: standard context (trimmed CLAUDE.md per Strategy 1)
    // Opus tasks: full context (complete skills and project context)
    const model = task.model ?? 'sonnet'
    const budgetTier: BudgetTier =
      model === 'haiku' ? 'minimal' : model === 'opus' ? 'full' : 'standard'

    // Build system prompt via centralized PromptBuilder
    const systemPrompt = promptBuilder.build({
      role: 'specialist',
      mode,
      specialistId: task.specialist,
      specialistPrompt: specialist?.prompt || undefined,
      assignedSkills,
      workspacePath: this.workspacePath!,
      brief: this.conversationBrief || undefined,
      feedbackContext,
      budgetTier
    })

    // Build context from completed dependency outputs
    // Prefer file-based artifacts (full output) over in-memory (truncated to 2000 chars)
    let dependencyContext = ''
    for (const depId of task.dependsOn) {
      // Try artifact file first (full content, capped at 8000 chars)
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
      // Fall back to in-memory if artifact not available
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

    // Append verification command to task description if provided
    const verificationSuffix = task.verificationCommand
      ? `\n\nVerification command (run before finishing): \`${task.verificationCommand}\``
      : ''

    const fullPrompt = dependencyContext
      ? `${task.description}${verificationSuffix}${dependencyContext}`
      : `${task.description}${verificationSuffix}`

    // Prompt size estimation — warn if approaching model limits
    const promptCheck = PromptBuilder.checkPromptSize(systemPrompt, fullPrompt, model)
    if (promptCheck.warning) {
      this.log.warn(`[${task.specialist}/${task.id}] ${promptCheck.warning}`)
    }

    // Check for per-action model override, falling back to complexity-scored tier model
    const modelAction = task.model ? tierToModelAction(task.model) : 'specialist:moderate'
    const modelId = modelConfigService.getModel(this.workspacePath ?? undefined, modelAction)
    const args = [
      '-p',
      fullPrompt,
      '--system-prompt',
      systemPrompt,
      '--model',
      modelId,
      '--output-format',
      'stream-json',
      '--verbose'
    ]

    if (mode === 'build') {
      args.push('--permission-mode', 'bypassPermissions')
    } else {
      args.push('--permission-mode', 'plan')
    }

    // Hooks are configured declaratively via .claude/hooks/hooks.json
    // (CLI flags --pre-tool-use-hook / --post-tool-use-hook are not supported)

    // Set thinking budget based on model tier — Opus gets full thinking, Haiku skips it
    const thinkingBudget =
      THINKING_BUDGETS[model as keyof typeof THINKING_BUDGETS] ?? THINKING_BUDGETS.sonnet
    const env: Record<string, string | undefined> = {
      ...this.buildEnvWithPath(),
      MAX_THINKING_TOKENS: thinkingBudget
    }

    // Use worktree path if available, otherwise fall back to workspace path
    let cwd = this.workspacePath!
    if (worktreeId) {
      const worktreeRecord = worktreeRepository.findById(worktreeId)
      if (worktreeRecord) {
        cwd = worktreeRecord.worktreePath
      }
    }

    // Set AGENT_SCOPE for pre-tool-use hook file path restrictions
    // At minimum, restrict the specialist to its working directory (worktree or workspace)
    env.AGENT_SCOPE = cwd

    this.log.info(
      `Spawning specialist [${task.specialist}] model=${task.model ?? 'sonnet'} complexity=${task.complexity?.total ?? '?'} for task ${task.id} in ${cwd}: ${task.description.substring(0, 100)}`
    )

    return spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    })
  }

  /**
   * Builds process environment with PATH augmented for claude CLI discovery.
   * Delegates to shared env-utils for cross-platform PATH construction.
   */
  private buildEnvWithPath(): NodeJS.ProcessEnv {
    return buildEnvWithPath()
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

    const exitPromises: Promise<void>[] = []

    for (const [id, info] of this.activeProcesses) {
      this.log.info(`Stopping specialist process: ${id}`)
      if (info.timeoutTimer) clearTimeout(info.timeoutTimer)

      exitPromises.push(
        new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            try {
              info.process.kill('SIGKILL')
            } catch {
              /* ignore */
            }
            resolve()
          }, 5000)

          info.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })

          try {
            info.process.kill('SIGTERM')
          } catch {
            clearTimeout(timeout)
            resolve()
          }
        })
      )
    }

    await Promise.allSettled(exitPromises)
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

  private reset(): void {
    this.completedTasks.clear()
    this.taskResults.clear()
    this.taskBuffers.clear()
    this.taskStatuses.clear()
    this.activeProcesses.clear()
    this.aborted = false
    this.conversationBrief = null
    this.consecutiveSpawnFailures = 0
    taskLoopService.reset()
    // Note: workspacePath and conversationId are preserved across resets
  }
}

export const specialistPoolService = new SpecialistPoolService()
