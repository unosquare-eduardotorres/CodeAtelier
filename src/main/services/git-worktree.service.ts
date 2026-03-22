import simpleGit from 'simple-git'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync } from 'node:fs'
import { worktreeRepository } from '../db/repositories'
import { gitWorktreeLogger } from '../logger'

const log = gitWorktreeLogger

/** Directory name inside the user's repo for agent worktrees */
const WORKTREE_DIR = '.agent-studio/worktrees'

export interface MergeResult {
  success: boolean
  conflictedFiles?: string[]
}

export interface MergeAllResult {
  merged: string[] // agentIds that merged successfully
  conflicted?: {
    agentId: string
    files: string[]
  }
  pending: string[] // agentIds not yet attempted
}

export class GitWorktreeService {
  /**
   * Creates a worktree + branch for a specialist task.
   * Path: {repoPath}/.agent-studio/worktrees/{agentId}-{taskId}
   * Branch: agent/{agentId}/{taskId}
   */
  async create(
    repoPath: string,
    agentId: string,
    taskId: string,
    conversationId: string
  ): Promise<string> {
    const git = simpleGit(repoPath)

    // Ensure .agent-studio/worktrees directory exists
    const worktreeBase = join(repoPath, WORKTREE_DIR)
    if (!existsSync(worktreeBase)) {
      mkdirSync(worktreeBase, { recursive: true })
    }

    // Auto-append .agent-studio/ to .gitignore if not already present
    this.ensureGitignore(repoPath)

    // Determine worktree path and branch name
    const safeName = `${agentId}-${taskId}`.replace(/[^a-z0-9-]/gi, '_')
    const worktreePath = join(worktreeBase, safeName)
    const branchName = `agent/${agentId}/${taskId}`

    // Get current branch as base
    const baseBranch = await git.revparse(['--abbrev-ref', 'HEAD'])

    // Create the worktree with a new branch
    log.info(`Creating worktree: ${worktreePath} on branch ${branchName}`)
    await git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])

    // Record in database
    const record = worktreeRepository.create(
      conversationId,
      agentId,
      taskId,
      worktreePath,
      branchName,
      baseBranch
    )
    log.info(`Worktree created: ${record.id} at ${worktreePath}`)

    return worktreePath
  }

  /**
   * Merges a worktree branch back into the base branch.
   * Returns { success: true } or { success: false, conflictedFiles: string[] }
   */
  async merge(worktreeId: string): Promise<MergeResult> {
    const worktree = worktreeRepository.findById(worktreeId)
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`)
    }

    // Find the repo root by going up from the worktree path
    const repoPath = this.getRepoPath(worktree.worktreePath)
    const git = simpleGit(repoPath)

    worktreeRepository.updateStatus(worktreeId, 'merging')
    log.info(`Merging worktree ${worktreeId}: ${worktree.branchName} → ${worktree.baseBranch}`)

    try {
      // Ensure we're on the base branch in the main repo
      await git.checkout(worktree.baseBranch)

      // Attempt the merge
      const mergeResult = await git.merge([
        worktree.branchName,
        '--no-ff',
        '-m',
        `Merge agent work: ${worktree.agentId} (task ${worktree.taskId})`
      ])

      if (mergeResult.failed) {
        // Get list of conflicted files
        const status = await git.status()
        const conflictedFiles = status.conflicted

        worktreeRepository.updateStatus(worktreeId, 'conflict')
        log.warn(`Merge conflict in worktree ${worktreeId}:`, conflictedFiles)

        // Abort the merge to restore clean state
        await git.merge(['--abort'])

        return { success: false, conflictedFiles }
      }

      worktreeRepository.updateStatus(worktreeId, 'merged', new Date().toISOString())
      log.info(`Worktree ${worktreeId} merged successfully`)

      return { success: true }
    } catch (error) {
      // If merge threw, it likely means conflict
      try {
        const status = await git.status()
        const conflictedFiles = status.conflicted

        if (conflictedFiles.length > 0) {
          worktreeRepository.updateStatus(worktreeId, 'conflict')
          await git.merge(['--abort'])
          return { success: false, conflictedFiles }
        }
      } catch {
        // If even status check fails, just abort
        try {
          await git.merge(['--abort'])
        } catch {
          /* ignore */
        }
      }

      worktreeRepository.updateStatus(worktreeId, 'conflict')
      throw error
    }
  }

  /**
   * Removes a worktree and optionally deletes its branch.
   */
  async remove(worktreeId: string, deleteBranch = true): Promise<void> {
    const worktree = worktreeRepository.findById(worktreeId)
    if (!worktree) {
      log.warn(`Worktree not found for removal: ${worktreeId}`)
      return
    }

    const repoPath = this.getRepoPath(worktree.worktreePath)
    const git = simpleGit(repoPath)

    log.info(`Removing worktree ${worktreeId}: ${worktree.worktreePath}`)

    try {
      // Remove the worktree directory
      await git.raw(['worktree', 'remove', worktree.worktreePath, '--force'])
    } catch {
      // If git worktree remove fails, try manual cleanup
      try {
        if (existsSync(worktree.worktreePath)) {
          rmSync(worktree.worktreePath, { recursive: true, force: true })
        }
        await git.raw(['worktree', 'prune'])
      } catch (cleanupError) {
        log.error(`Failed to clean up worktree directory: ${worktree.worktreePath}`, cleanupError)
      }
    }

    // Optionally delete the branch
    if (deleteBranch) {
      try {
        await git.branch(['-D', worktree.branchName])
        log.info(`Deleted branch: ${worktree.branchName}`)
      } catch {
        log.warn(`Could not delete branch: ${worktree.branchName} (may already be deleted)`)
      }
    }

    worktreeRepository.updateStatus(worktreeId, 'pruned')
  }

  /**
   * Returns the diff between the worktree branch and base branch.
   */
  async getDiff(worktreeId: string): Promise<string> {
    const worktree = worktreeRepository.findById(worktreeId)
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`)
    }

    const repoPath = this.getRepoPath(worktree.worktreePath)
    const git = simpleGit(repoPath)

    return git.diff([`${worktree.baseBranch}...${worktree.branchName}`])
  }

  /**
   * Cleans up all stale/orphaned worktrees for a repo.
   * Called on app startup and conversation close.
   */
  async pruneAll(repoPath: string): Promise<void> {
    const git = simpleGit(repoPath)

    // Run git worktree prune to clean up stale entries
    try {
      await git.raw(['worktree', 'prune'])
      log.info(`Pruned stale git worktrees in ${repoPath}`)
    } catch (error) {
      log.error(`Failed to prune worktrees in ${repoPath}:`, error)
    }

    // Clean up .agent-studio/worktrees directory if it exists
    const worktreeBase = join(repoPath, WORKTREE_DIR)
    if (existsSync(worktreeBase)) {
      try {
        rmSync(worktreeBase, { recursive: true, force: true })
        log.info(`Cleaned up worktree directory: ${worktreeBase}`)
      } catch (error) {
        log.error(`Failed to clean up worktree directory: ${worktreeBase}`, error)
      }
    }

    // Mark active DB records as pruned
    const activeWorktrees = worktreeRepository.findActive()
    const stalIds = activeWorktrees
      .filter((w) => w.worktreePath.startsWith(repoPath))
      .map((w) => w.id)
    if (stalIds.length > 0) {
      worktreeRepository.markPruned(stalIds)
      log.info(`Marked ${stalIds.length} stale worktree records as pruned`)
    }
  }

  /**
   * Merges all active worktrees for a conversation sequentially.
   * Stops on first conflict and reports which agent caused it.
   */
  async mergeAll(conversationId: string): Promise<MergeAllResult> {
    const worktrees = worktreeRepository.findByConversation(conversationId)
    const activeWorktrees = worktrees.filter((w) => w.status === 'active')

    const merged: string[] = []
    const pending: string[] = activeWorktrees.map((w) => w.agentId)

    for (const worktree of activeWorktrees) {
      try {
        const result = await this.merge(worktree.id)

        if (result.success) {
          merged.push(worktree.agentId)
          pending.splice(pending.indexOf(worktree.agentId), 1)

          // Clean up the worktree after successful merge
          await this.remove(worktree.id, true)
        } else {
          // Conflict — stop merging
          pending.splice(pending.indexOf(worktree.agentId), 1)
          return {
            merged,
            conflicted: {
              agentId: worktree.agentId,
              files: result.conflictedFiles ?? []
            },
            pending
          }
        }
      } catch (error) {
        log.error(`Failed to merge worktree for agent ${worktree.agentId}:`, error)
        pending.splice(pending.indexOf(worktree.agentId), 1)
        return {
          merged,
          conflicted: {
            agentId: worktree.agentId,
            files: []
          },
          pending
        }
      }
    }

    return { merged, pending: [] }
  }

  /**
   * Ensures .agent-studio/ is in the repo's .gitignore.
   */
  private ensureGitignore(repoPath: string): void {
    const gitignorePath = join(repoPath, '.gitignore')
    const ignoreEntry = '.agent-studio/'

    try {
      if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, 'utf-8')
        if (content.includes(ignoreEntry)) return
        appendFileSync(gitignorePath, `\n# Agent Studio worktrees\n${ignoreEntry}\n`)
      } else {
        appendFileSync(gitignorePath, `# Agent Studio worktrees\n${ignoreEntry}\n`)
      }
      log.info(`Added ${ignoreEntry} to .gitignore`)
    } catch (error) {
      log.warn('Could not update .gitignore:', error)
    }
  }

  /**
   * Derives the main repo path from a worktree path.
   * Worktree paths are: {repoPath}/.agent-studio/worktrees/{name}
   */
  private getRepoPath(worktreePath: string): string {
    // Navigate up from worktree path: .../worktrees/{name} → .../worktrees → .agent-studio → repo
    const parts = worktreePath.split('/')
    const worktreesIdx = parts.lastIndexOf('worktrees')
    if (worktreesIdx >= 2) {
      // Go up past 'worktrees' and '.agent-studio'
      return parts.slice(0, worktreesIdx - 1).join('/')
    }
    // Fallback: try going up 3 levels
    return join(worktreePath, '..', '..', '..')
  }
}

export const gitWorktreeService = new GitWorktreeService()
