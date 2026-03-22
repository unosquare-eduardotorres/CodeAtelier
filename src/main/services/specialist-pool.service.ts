import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ConversationMode, DecomposedTask, TaskExecutionProgress } from '../../shared/types'
import { specialistPoolLogger } from '../logger'
import { specialistRepository } from '../db/repositories'
import { SPECIALIST_TASK_SYSTEM_PROMPT } from './system-prompts'

interface SpecialistProcessInfo {
  task: DecomposedTask
  process: ChildProcess
  output: string
  status: TaskExecutionProgress['status']
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
  private activeProcesses: Map<string, SpecialistProcessInfo> = new Map()
  private completedTasks: Set<string> = new Set()
  private taskResults: Map<string, string> = new Map()
  private aborted: boolean = false

  setWorkspacePath(path: string): void {
    this.workspacePath = path
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
   */
  private startTask(task: DecomposedTask, mode: ConversationMode, onDone: () => void): void {
    this.emitProgress(task, 'running')

    const process = this.spawnSpecialist(task, mode)
    const info: SpecialistProcessInfo = {
      task,
      process,
      output: '',
      status: 'running'
    }
    this.activeProcesses.set(task.id, info)

    process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      info.output += text

      // Try to extract text content from stream-json events
      const lines = text.split('\n')
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

    process.stderr?.on('data', (data: Buffer) => {
      this.log.error(`[${task.specialist}/${task.id}] stderr:`, data.toString().trim())
    })

    process.on('exit', (code) => {
      this.activeProcesses.delete(task.id)
      this.completedTasks.add(task.id)
      this.taskResults.set(task.id, info.output)

      if (code === 0) {
        info.status = 'completed'
        this.emitProgress(task, 'completed', info.output)
      } else {
        info.status = 'failed'
        this.emitProgress(task, 'failed', undefined, `Process exited with code ${code}`)
      }

      onDone()
    })

    process.on('error', (err) => {
      this.activeProcesses.delete(task.id)
      this.completedTasks.add(task.id)
      info.status = 'failed'
      this.emitProgress(task, 'failed', undefined, err.message)
      onDone()
    })
  }

  /**
   * Spawns a `claude -p` process for a single specialist task.
   */
  private spawnSpecialist(task: DecomposedTask, mode: ConversationMode): ChildProcess {
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

    const args = [
      '-p',
      fullPrompt,
      '--system-prompt',
      systemPrompt,
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

    this.log.info(
      `Spawning specialist [${task.specialist}] for task ${task.id}: ${task.description.substring(0, 100)}`
    )

    return spawn('claude', args, {
      cwd: this.workspacePath!,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    })
  }

  /**
   * Builds process environment with PATH augmented for claude CLI discovery.
   */
  private buildEnvWithPath(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    delete env.CLAUDECODE

    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    if (homeDir) {
      const localBin = `${homeDir}/.local/bin`
      if (env.PATH && !env.PATH.includes(localBin)) {
        env.PATH = `${localBin}:${env.PATH}`
      }
    }
    if (env.PATH && !env.PATH.includes('/opt/homebrew/bin')) {
      env.PATH = `/opt/homebrew/bin:${env.PATH}`
    }
    if (env.PATH && !env.PATH.includes('/usr/local/bin')) {
      env.PATH = `/usr/local/bin:${env.PATH}`
    }
    return env
  }

  /**
   * Runs a specialist task and returns its full output (used by sequential mode).
   */
  private runSpecialistTask(task: DecomposedTask, mode: ConversationMode): Promise<string> {
    return new Promise((resolve, reject) => {
      this.startTask(task, mode, () => {
        const result = this.taskResults.get(task.id)
        const info = this.activeProcesses.get(task.id)
        if (info?.status === 'failed') {
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
      this.log.info(`Stopping specialist process: ${id}`)
      try {
        info.process.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }

    // Wait briefly for processes to exit
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.activeProcesses.size === 0) {
          resolve()
        } else {
          setTimeout(check, 200)
        }
      }
      setTimeout(check, 200)
      // Force kill after 5s
      setTimeout(() => {
        for (const [, info] of this.activeProcesses) {
          try {
            info.process.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
        resolve()
      }, 5000)
    })

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
      error
    }
    this.emit('taskProgress', progress)
  }

  private reset(): void {
    this.completedTasks.clear()
    this.taskResults.clear()
    this.activeProcesses.clear()
    this.aborted = false
  }
}

export const specialistPoolService = new SpecialistPoolService()
