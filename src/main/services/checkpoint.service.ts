import { execSync } from 'node:child_process'
import { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { checkpointRepository } from '../db/repositories/checkpoint.repository'
import { eventLoggerService } from './event-logger.service'
import { IPC_CHANNELS } from '../../shared/constants'

const checkpointLogger = log.scope('Checkpoint')

export interface CheckpointApprovalRequest {
  id: string
  type: 'phase_gate' | 'merge_approval' | 'destructive_action'
  title: string
  summary: string
  details: {
    what: string
    why: string
    risk: string
    changedFiles?: string[]
    testResults?: string
  }
  createdAt: string
}

interface PendingCheckpointApproval {
  resolve: (approved: boolean) => void
  checkpoint: CheckpointApprovalRequest
}

/**
 * Shape of a checkpoint's saved state as read by checkpoint-context.tool.ts.
 * Checkpoints are now produced by the destructive-action confirmation flow only —
 * the old pre-execution multi-specialist snapshot path was removed.
 */
interface CheckpointState {
  activeTaskIds: string[]
  completedTaskIds: string[]
  taskResults: Record<string, string>
  taskStatuses: Record<string, 'pending' | 'running' | 'completed' | 'failed' | 'skipped'>
  metadata?: Record<string, unknown>
}

/**
 * Checkpoint service — exposes read-only access to previously-saved checkpoint
 * snapshots (see checkpoint-context.tool.ts) and a destructive `restoreGitState`
 * action driven from the UI. Write-path checkpoint creation lives with the
 * callers that still need it (currently: none in the live code path).
 */
class CheckpointService {
  private pendingApprovals = new Map<string, PendingCheckpointApproval>()

  /**
   * Requests user approval before proceeding with a critical operation.
   * Pauses execution and sends a request to the renderer; resolves when the user responds.
   * Auto-approves after 5 minutes to prevent indefinite blocking.
   */
  async requestApproval(
    request: Omit<CheckpointApprovalRequest, 'id' | 'createdAt'>
  ): Promise<boolean> {
    const id = `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const checkpoint: CheckpointApprovalRequest = {
      ...request,
      id,
      createdAt: new Date().toISOString()
    }

    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(id, { resolve, checkpoint })

      // Send to renderer via focused window
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send(IPC_CHANNELS.CHECKPOINT_APPROVAL_REQUEST, checkpoint)
      } else {
        // No window — auto-approve to avoid blocking
        this.pendingApprovals.delete(id)
        resolve(true)
      }

      // Safety timeout — auto-approve after 5 minutes
      setTimeout(
        () => {
          if (this.pendingApprovals.has(id)) {
            checkpointLogger.warn(`Checkpoint approval timed out — auto-approving: ${id}`)
            this.resolveApproval(id, true)
          }
        },
        5 * 60 * 1000
      )
    })
  }

  /**
   * Resolves a pending approval — called from the IPC handler when the user responds.
   * Also fires the appropriate declarative hook (checkpoint_approved/rejected).
   */
  resolveApproval(checkpointId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(checkpointId)
    if (!pending) return
    this.pendingApprovals.delete(checkpointId)
    checkpointLogger.info(
      `Checkpoint ${approved ? 'approved' : 'rejected'}: ${checkpointId} (${pending.checkpoint.type})`
    )

    // Fire declarative hook
    import('./hook-engine.service')
      .then(({ hookEngine }) => {
        const event = approved ? 'checkpoint_approved' : 'checkpoint_rejected'
        hookEngine
          .executeHooks(event as import('./hook-engine.service').HookEvent, {
            checkpointId,
            type: pending.checkpoint.type
          })
          .catch((err) => checkpointLogger.warn(`Hook error (${event}):`, err))
      })
      .catch(() => {
        /* non-fatal: hook engine not available — checkpoint proceeds without hooks */
      })

    pending.resolve(approved)
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
