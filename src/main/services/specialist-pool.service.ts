import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type {
  ConversationMode,
  DecomposedTask,
  HandoffBrief,
  TaskExecutionProgress
} from '../../shared/types'
import { MODEL_TIER_IDS } from '../../shared/constants'
import { specialistPoolLogger } from '../logger'
import {
  specialistRepository,
  worktreeRepository,
  agentSessionRepository,
  workspaceRepository
} from '../db/repositories'
import { SPECIALIST_TASK_SYSTEM_PROMPT } from './system-prompts'
import { memoryService } from './memory.service'
import { getModelId } from './complexity-scorer.service'
import { gitWorktreeService } from './git-worktree.service'
import type { MergeResult } from './git-worktree.service'
import { buildEnvWithPath } from './env-utils'

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

    const pending = new Map<string, DecomposedTask>()
    for (const task of tasks) {
      pending.set(task.id, task)
    }

    return new Promise<void>((resolve) => {
      const tryStartReady = (): void => {
        for (const [id, task] of pending) {
          if (this.aborted) break

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
   */
  private async createWorktreeAndSpawn(
    task: DecomposedTask,
    mode: ConversationMode,
    onDone: () => void,
    attempt: number = 0
  ): Promise<void> {
    let worktreeId: string | undefined

    // Create isolated worktree for build mode
    if (mode === 'build' && this.workspacePath && this.conversationId) {
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

    const childProcess = this.spawnSpecialist(task, mode, worktreeId)

    // Create DB session for token tracking
    let dbSessionId: string | undefined
    try {
      const sessionModelId = task.model ? getModelId(task.model) : MODEL_TIER_IDS.sonnet
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
      attempt
    }
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
      info.output += text

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

      // Complete DB session record
      if (info.dbSessionId) {
        try {
          agentSessionRepository.complete(
            info.dbSessionId,
            code === 0 ? 'completed' : 'failed',
            0 // Specialists don't track token usage from stream events yet
          )
        } catch (err) {
          this.log.error('Failed to complete DB session:', err)
        }
      }

      if (code === 0) {
        info.status = 'completed'
        this.taskStatuses.set(task.id, 'completed')
        this.emitProgress(task, 'completed', info.output)

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

          this.log.warn(
            `Task ${task.id} failed (attempt ${info.attempt + 1}), retrying in ${delay}ms...`
          )
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
        info.status = 'failed'
        this.taskStatuses.set(task.id, 'failed')
        this.emitProgress(task, 'failed', undefined, `Process exited with code ${code}`)

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
      info.status = 'failed'
      this.taskStatuses.set(task.id, 'failed')
      this.emitProgress(task, 'failed', undefined, err.message)

      // Complete DB session on error
      if (info.dbSessionId) {
        try {
          agentSessionRepository.complete(info.dbSessionId, 'failed', 0)
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
  private spawnSpecialist(
    task: DecomposedTask,
    mode: ConversationMode,
    worktreeId?: string
  ): ChildProcess {
    // Build specialist-specific system prompt
    let systemPrompt = SPECIALIST_TASK_SYSTEM_PROMPT

    // Augment with specialist prompt from DB
    const specialist = specialistRepository.findByAgentId(task.specialist)
    if (specialist?.prompt) {
      systemPrompt += `\n\n## Specialist Role\n${specialist.prompt}`
    }

    // Augment with skill content if specialist has skills
    if (specialist) {
      try {
        const skills = specialistRepository.getSkills(specialist.id)
        const activeSkills = skills.filter((s) => s.isActive)
        for (const skill of activeSkills) {
          try {
            const content = readFileSync(skill.filePath, 'utf-8')
            if (content.length > 5000) {
              this.log.warn(
                `Skill "${skill.name}" truncated from ${content.length} to 5000 chars for specialist ${task.specialist}`
              )
            }
            systemPrompt += `\n\n## Skill: ${skill.name}\n${content.substring(0, 5000)}`
          } catch {
            this.log.warn(`Could not read skill file: ${skill.filePath}`)
          }
        }
      } catch {
        // No skills — fine
      }
    }

    // Add workspace CLAUDE.md context
    try {
      const claudeMdPath = join(this.workspacePath!, 'CLAUDE.md')
      const workspaceContext = readFileSync(claudeMdPath, 'utf-8')
      systemPrompt += `\n\n---\n\n## Workspace Context (from CLAUDE.md)\n\n${workspaceContext}`
    } catch {
      // No CLAUDE.md — fine
    }

    // Inject enriched conversation context from handoff brief
    if (this.conversationBrief) {
      let briefContext = `\n\n## Conversation Context\n\nSummary: ${this.conversationBrief.summary}`
      if (this.conversationBrief.decisions.length > 0) {
        briefContext += `\n\nDecisions made:\n${this.conversationBrief.decisions.map((d) => `- ${d}`).join('\n')}`
      }
      if (this.conversationBrief.constraints.length > 0) {
        briefContext += `\n\nConstraints:\n${this.conversationBrief.constraints.map((c) => `- ${c}`).join('\n')}`
      }
      if (this.conversationBrief.filesDiscussed.length > 0) {
        briefContext += `\n\nFiles discussed:\n${this.conversationBrief.filesDiscussed.map((f) => `- ${f}`).join('\n')}`
      }
      systemPrompt += briefContext
    }

    // Inject filtered feedback memories for this specialist
    try {
      if (this.workspacePath) {
        const allWs = workspaceRepository.findAll()
        const ws = allWs.find((w) => w.repoPath === this.workspacePath)
        if (ws) {
          const feedbackContext = memoryService.getFeedbackForSpecialist(
            ws.id,
            task.specialist,
            2000
          )
          if (feedbackContext) {
            systemPrompt += `\n\n${feedbackContext}`
          }
        }
      }
    } catch {
      // Feedback memories unavailable — not critical
    }

    // Build context from completed dependency outputs
    let dependencyContext = ''
    for (const depId of task.dependsOn) {
      const depOutput = this.taskResults.get(depId)
      if (depOutput) {
        dependencyContext += `\n\n[Previous task ${depId} output summary]: ${depOutput.substring(0, 2000)}`
      }
    }

    const fullPrompt = dependencyContext
      ? `${task.description}${dependencyContext}`
      : task.description

    const modelId = task.model ? getModelId(task.model) : MODEL_TIER_IDS.sonnet
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
      args.push('--dangerously-skip-permissions')
    } else {
      args.push('--permission-mode', 'plan')
    }

    const env = this.buildEnvWithPath()

    // Use worktree path if available, otherwise fall back to workspace path
    let cwd = this.workspacePath!
    if (worktreeId) {
      const worktreeRecord = worktreeRepository.findById(worktreeId)
      if (worktreeRecord) {
        cwd = worktreeRecord.worktreePath
      }
    }

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

  private reset(): void {
    this.completedTasks.clear()
    this.taskResults.clear()
    this.taskBuffers.clear()
    this.taskStatuses.clear()
    this.activeProcesses.clear()
    this.aborted = false
    this.conversationBrief = null
    // Note: workspacePath and conversationId are preserved across resets
  }
}

export const specialistPoolService = new SpecialistPoolService()
