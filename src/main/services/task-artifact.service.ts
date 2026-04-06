import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { DecomposedTask, ConversationMode } from '../../shared/types'
import type { QualityGateResult } from './abandonment-detector.service'
import type { TaskLoopState } from './task-loop.service'

const artifactLog = log.scope('TaskArtifact')

/** Root directory name under the workspace for artifact storage */
const ARTIFACT_DIR = '.agentstudio'

/**
 * Execution state persisted to disk for crash recovery.
 */
interface PlanExecutionState {
  conversationId: string
  mode: ConversationMode
  startedAt: string
  tasks: Array<{
    id: string
    specialist: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    startedAt?: string
    completedAt?: string
    iterations?: number
  }>
  lastUpdated: string
}

/**
 * Per-task artifact written to disk.
 */
interface TaskArtifact {
  taskId: string
  specialist: string
  description: string
  dependsOn: string[]
  input: string
  output?: string
  gateResults?: QualityGateResult[]
  loopState?: Partial<TaskLoopState>
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed'
}

/**
 * Task Artifact Service — Manages file-based artifact chain for agent communication.
 *
 * Directory structure:
 * ```
 * {workspace}/.agentstudio/{conversation-id}/
 * ├── state.json           — Plan execution state (for crash recovery)
 * └── tasks/
 *     ├── {task-id}/
 *     │   ├── input.md     — Task description + dependency context
 *     │   ├── output.md    — Specialist result output
 *     │   └── gates.json   — Quality gate results
 *     └── {task-id}/
 *         └── ...
 * ```
 */
class TaskArtifactService {
  /**
   * Initialize artifact directory structure for a conversation.
   */
  async initConversation(
    workspacePath: string,
    conversationId: string,
    tasks: DecomposedTask[],
    mode: ConversationMode
  ): Promise<void> {
    const conversationDir = this.getConversationDir(workspacePath, conversationId)
    const tasksDir = join(conversationDir, 'tasks')

    try {
      await mkdir(tasksDir, { recursive: true })

      // Create task directories
      for (const task of tasks) {
        await mkdir(join(tasksDir, task.id), { recursive: true })
      }

      // Write initial plan state
      const state: PlanExecutionState = {
        conversationId,
        mode,
        startedAt: new Date().toISOString(),
        tasks: tasks.map((t) => ({
          id: t.id,
          specialist: t.specialist,
          status: 'pending'
        })),
        lastUpdated: new Date().toISOString()
      }
      await this.writeJson(join(conversationDir, 'state.json'), state)

      // Ensure .agentstudio is in .gitignore
      await this.ensureGitignore(workspacePath)

      artifactLog.info(
        `Initialized artifact directory for ${conversationId} with ${tasks.length} tasks`
      )
    } catch (err) {
      artifactLog.error(`Failed to initialize artifact directory:`, err)
    }
  }

  /**
   * Write the input artifact for a task — includes task description and dependency context.
   */
  async writeTaskInput(
    workspacePath: string,
    conversationId: string,
    task: DecomposedTask,
    dependencyOutputs: Map<string, string>
  ): Promise<void> {
    const taskDir = this.getTaskDir(workspacePath, conversationId, task.id)

    try {
      await mkdir(taskDir, { recursive: true })

      // Build input.md content
      const parts: string[] = []
      parts.push(`# Task: ${task.id}`)
      parts.push(`**Specialist:** ${task.specialist}`)
      parts.push(`**Model:** ${task.model ?? 'sonnet'}`)
      if (task.complexity) {
        parts.push(`**Complexity:** ${task.complexity.tier} (score: ${task.complexity.total})`)
      }
      parts.push(``)
      parts.push(`## Description`)
      parts.push(task.description)

      if (task.verificationCommand) {
        parts.push(``)
        parts.push(`## Verification Command`)
        parts.push(`\`\`\`bash`)
        parts.push(task.verificationCommand)
        parts.push(`\`\`\``)
      }

      // Add dependency outputs (full content, not truncated)
      if (task.dependsOn.length > 0) {
        parts.push(``)
        parts.push(`## Dependency Outputs`)
        for (const depId of task.dependsOn) {
          const output = dependencyOutputs.get(depId)
          if (output) {
            parts.push(``)
            parts.push(`### From task ${depId}`)
            // Use the full output from the artifact file, capped at 10K chars
            parts.push(output.substring(0, 10000))
            if (output.length > 10000) {
              parts.push(`\n[Output truncated — see tasks/${depId}/output.md for full content]`)
            }
          }
        }
      }

      await writeFile(join(taskDir, 'input.md'), parts.join('\n'), 'utf-8')

      // Update plan state
      await this.updateTaskStatus(workspacePath, conversationId, task.id, 'running')

      artifactLog.debug(`Wrote input artifact for task ${task.id}`)
    } catch (err) {
      artifactLog.warn(`Failed to write task input artifact:`, err)
    }
  }

  /**
   * Write the output artifact for a completed task.
   */
  async writeTaskOutput(
    workspacePath: string,
    conversationId: string,
    taskId: string,
    output: string,
    status: 'completed' | 'failed'
  ): Promise<void> {
    const taskDir = this.getTaskDir(workspacePath, conversationId, taskId)

    try {
      await mkdir(taskDir, { recursive: true })
      await writeFile(join(taskDir, 'output.md'), output, 'utf-8')
      await this.updateTaskStatus(workspacePath, conversationId, taskId, status)
      artifactLog.debug(`Wrote output artifact for task ${taskId} (${status})`)
    } catch (err) {
      artifactLog.warn(`Failed to write task output artifact:`, err)
    }
  }

  /**
   * Write quality gate results for a task.
   */
  async writeGateResults(
    workspacePath: string,
    conversationId: string,
    taskId: string,
    gates: QualityGateResult[],
    loopState?: Partial<TaskLoopState>
  ): Promise<void> {
    const taskDir = this.getTaskDir(workspacePath, conversationId, taskId)

    try {
      await mkdir(taskDir, { recursive: true })
      await this.writeJson(join(taskDir, 'gates.json'), {
        gates,
        loopState,
        timestamp: new Date().toISOString()
      })
      artifactLog.debug(`Wrote gate results for task ${taskId}`)
    } catch (err) {
      artifactLog.warn(`Failed to write gate results:`, err)
    }
  }

  /**
   * Read the output artifact from a dependency task.
   * Used by downstream specialists to get full (not truncated) context.
   */
  async readTaskOutput(
    workspacePath: string,
    conversationId: string,
    taskId: string
  ): Promise<string | null> {
    const outputPath = join(this.getTaskDir(workspacePath, conversationId, taskId), 'output.md')

    try {
      return await readFile(outputPath, 'utf-8')
    } catch {
      return null
    }
  }

  /**
   * Read the plan execution state for crash recovery.
   */
  async readPlanState(
    workspacePath: string,
    conversationId: string
  ): Promise<PlanExecutionState | null> {
    const statePath = join(this.getConversationDir(workspacePath, conversationId), 'state.json')

    try {
      const content = await readFile(statePath, 'utf-8')
      return JSON.parse(content) as PlanExecutionState
    } catch {
      return null
    }
  }

  // ── Private Helpers ──

  private getConversationDir(workspacePath: string, conversationId: string): string {
    return join(workspacePath, ARTIFACT_DIR, conversationId)
  }

  private getTaskDir(workspacePath: string, conversationId: string, taskId: string): string {
    return join(workspacePath, ARTIFACT_DIR, conversationId, 'tasks', taskId)
  }

  private async updateTaskStatus(
    workspacePath: string,
    conversationId: string,
    taskId: string,
    status: PlanExecutionState['tasks'][0]['status']
  ): Promise<void> {
    try {
      const state = await this.readPlanState(workspacePath, conversationId)
      if (!state) return

      const task = state.tasks.find((t) => t.id === taskId)
      if (task) {
        task.status = status
        if (status === 'running') {
          task.startedAt = new Date().toISOString()
        } else if (status === 'completed' || status === 'failed') {
          task.completedAt = new Date().toISOString()
        }
      }
      state.lastUpdated = new Date().toISOString()

      const statePath = join(this.getConversationDir(workspacePath, conversationId), 'state.json')
      await this.writeJson(statePath, state)
    } catch (err) {
      artifactLog.warn('Failed to update task status in plan state:', err)
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  /**
   * Ensure .agentstudio is in .gitignore
   */
  private async ensureGitignore(workspacePath: string): Promise<void> {
    const gitignorePath = join(workspacePath, '.gitignore')

    try {
      let content = ''
      try {
        content = await readFile(gitignorePath, 'utf-8')
      } catch {
        // No .gitignore — will create one
      }

      if (!content.includes('.agentstudio')) {
        const entry =
          content.endsWith('\n') || content.length === 0 ? '.agentstudio/\n' : '\n.agentstudio/\n'
        await writeFile(gitignorePath, content + entry, 'utf-8')
        artifactLog.info('Added .agentstudio/ to .gitignore')
      }
    } catch (err) {
      artifactLog.warn('Failed to update .gitignore:', err)
    }
  }
}

export const taskArtifactService = new TaskArtifactService()
