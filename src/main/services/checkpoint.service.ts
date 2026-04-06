import { execSync } from 'node:child_process'
import log from 'electron-log/main'
import { checkpointRepository } from '../db/repositories/checkpoint.repository'
import { eventLoggerService } from './event-logger.service'
import type { DecomposedTask, TaskExecutionProgress } from '../../shared/types'

const checkpointLogger = log.scope('Checkpoint')

interface CheckpointState {
  /** Active task IDs at time of checkpoint */
  activeTaskIds: string[]
  /** Completed task IDs at time of checkpoint */
  completedTaskIds: string[]
  /** Task results (taskId → output summary) */
  taskResults: Record<string, string>
  /** Task statuses */
  taskStatuses: Record<string, TaskExecutionProgress['status']>
  /** Full task plan for re-execution */
  tasks?: DecomposedTask[]
  /** Any additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Checkpoint service — snapshots orchestration state before risky operations
 * (parallel execution, multi-specialist tasks) to enable rollback on failure.
 *
 * Saves: git state (branch + commit SHA), task progress, and task plan.
 */
class CheckpointService {
  /**
   * Creates a checkpoint before execution begins.
   * Captures git state and task plan for potential rollback.
   */
  createCheckpoint(opts: {
    conversationId: string
    workspaceId?: string
    workspacePath: string
    label: string
    state: CheckpointState
  }): string {
    let gitBranch: string | undefined
    let gitCommitSha: string | undefined

    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: opts.workspacePath,
        encoding: 'utf-8',
        timeout: 5000
      }).trim()

      gitCommitSha = execSync('git rev-parse HEAD', {
        cwd: opts.workspacePath,
        encoding: 'utf-8',
        timeout: 5000
      }).trim()
    } catch (err) {
      checkpointLogger.warn('Failed to capture git state for checkpoint:', err)
    }

    const checkpoint = checkpointRepository.create({
      conversationId: opts.conversationId,
      workspaceId: opts.workspaceId,
      label: opts.label,
      state: opts.state as unknown as Record<string, unknown>,
      gitBranch,
      gitCommitSha,
      activeTaskIds: opts.state.activeTaskIds
    })

    eventLoggerService.logCheckpointCreated({
      conversationId: opts.conversationId,
      workspaceId: opts.workspaceId,
      checkpointId: checkpoint.id,
      label: opts.label
    })

    checkpointLogger.info(
      `Checkpoint "${opts.label}" created: ${checkpoint.id} (git: ${gitBranch}@${gitCommitSha?.slice(0, 7) ?? 'unknown'})`
    )

    // Prune old checkpoints — keep last 5 per conversation
    checkpointRepository.pruneKeepRecent(opts.conversationId, 5)

    return checkpoint.id
  }

  /**
   * Creates a pre-execution checkpoint automatically before parallel/sequential execution.
   */
  createPreExecutionCheckpoint(opts: {
    conversationId: string
    workspaceId?: string
    workspacePath: string
    tasks: DecomposedTask[]
  }): string {
    const taskCount = opts.tasks.length
    const specialistNames = [...new Set(opts.tasks.map((t) => t.specialist))].join(', ')

    return this.createCheckpoint({
      conversationId: opts.conversationId,
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      label: `Pre-execution: ${taskCount} tasks (${specialistNames})`,
      state: {
        activeTaskIds: [],
        completedTaskIds: [],
        taskResults: {},
        taskStatuses: Object.fromEntries(opts.tasks.map((t) => [t.id, 'pending' as const])),
        tasks: opts.tasks
      }
    })
  }

  /**
   * Retrieves a checkpoint and its saved state.
   */
  getCheckpoint(
    checkpointId: string
  ): { state: CheckpointState; gitBranch?: string; gitCommitSha?: string } | null {
    const record = checkpointRepository.findById(checkpointId)
    if (!record) return null

    try {
      const state = JSON.parse(record.stateJson) as CheckpointState
      return {
        state,
        gitBranch: record.gitBranch ?? undefined,
        gitCommitSha: record.gitCommitSha ?? undefined
      }
    } catch {
      checkpointLogger.error(`Failed to parse checkpoint state: ${checkpointId}`)
      return null
    }
  }

  /**
   * Lists all checkpoints for a conversation (metadata only, no parsed state).
   */
  listCheckpoints(conversationId: string): {
    id: string
    label: string
    gitBranch?: string
    gitCommitSha?: string
    createdAt: string
  }[] {
    return checkpointRepository.findByConversation(conversationId).map((r) => ({
      id: r.id,
      label: r.label,
      gitBranch: r.gitBranch ?? undefined,
      gitCommitSha: r.gitCommitSha ?? undefined,
      createdAt: r.createdAt
    }))
  }

  /**
   * Attempts to restore git state from a checkpoint.
   * Returns true if git reset succeeded, false if skipped/failed.
   *
   * NOTE: This only resets git state. Task re-execution must be handled
   * by the caller using the checkpoint's task plan.
   */
  restoreGitState(
    checkpointId: string,
    workspacePath: string
  ): { success: boolean; message: string } {
    const checkpoint = this.getCheckpoint(checkpointId)
    if (!checkpoint) {
      return { success: false, message: 'Checkpoint not found' }
    }

    if (!checkpoint.gitCommitSha) {
      return { success: false, message: 'Checkpoint has no git state to restore' }
    }

    try {
      // Check for uncommitted changes first
      const status = execSync('git status --porcelain', {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 5000
      }).trim()

      if (status) {
        checkpointLogger.warn(`Uncommitted changes detected — stashing before restore`)
        execSync('git stash push -m "checkpoint-restore-auto-stash"', {
          cwd: workspacePath,
          encoding: 'utf-8',
          timeout: 10000
        })
      }

      // Reset to the checkpoint commit
      execSync(`git reset --hard ${checkpoint.gitCommitSha}`, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 10000
      })

      const record = checkpointRepository.findById(checkpointId)
      if (record) {
        eventLoggerService.logCheckpointRestored({
          conversationId: record.conversationId,
          workspaceId: record.workspaceId ?? undefined,
          checkpointId,
          label: record.label
        })
      }

      checkpointLogger.info(
        `Git state restored to ${checkpoint.gitCommitSha.slice(0, 7)} from checkpoint ${checkpointId}`
      )

      return {
        success: true,
        message: `Restored to commit ${checkpoint.gitCommitSha.slice(0, 7)}`
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      checkpointLogger.error(`Failed to restore git state: ${errorMsg}`)
      return { success: false, message: `Git restore failed: ${errorMsg}` }
    }
  }
}

export const checkpointService = new CheckpointService()
