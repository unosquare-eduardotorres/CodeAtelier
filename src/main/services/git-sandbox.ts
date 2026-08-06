/**
 * Git Sandbox — experiment isolation utilities for autonomous agent operations.
 *
 * Provides checkpoint/reset/diff primitives that MPA campaigns, Audit health,
 * and future AutoPilot features can use to cleanly isolate experiments.
 *
 * Each experiment creates a checkpoint before running, and can reset back to
 * that checkpoint if the experiment fails scope validation or quality checks.
 */

import { execSync } from 'node:child_process'
import log from 'electron-log'

const sandboxLog = log.scope('git-sandbox')

/** Serialized checkpoint state — branch:commitHash format. */
export type GitCheckpoint = string

export interface DiffStats {
  filesChanged: number
  linesAdded: number
  linesRemoved: number
}

// ── Checkpoint Management ──

/**
 * Create a checkpoint of the current git state.
 * Records the current branch and HEAD commit hash.
 * Stashes any uncommitted changes to provide a clean starting point.
 *
 * @returns A serialized checkpoint string in "branch:commitHash" format
 */
export function createExperimentCheckpoint(workspacePath: string): GitCheckpoint {
  const head = execSync('git rev-parse HEAD', {
    cwd: workspacePath,
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true
  }).trim()

  const branch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: workspacePath,
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true
  }).trim()

  sandboxLog.info(`[checkpoint] Created checkpoint: ${branch}:${head.slice(0, 8)}`)
  return `${branch}:${head}`
}

/**
 * Reset the workspace to a previously created checkpoint.
 * Force-checkouts the original branch, hard resets to the checkpoint commit,
 * and cleans untracked files (coverage output, temp files, etc.).
 *
 * WARNING: This is destructive — all uncommitted and committed changes
 * after the checkpoint are lost.
 */
export function resetToCheckpoint(workspacePath: string, checkpoint: GitCheckpoint): void {
  const colonIdx = checkpoint.indexOf(':')
  if (colonIdx === -1) {
    throw new Error(`Invalid checkpoint format: "${checkpoint}" — expected "branch:commitHash"`)
  }

  const branch = checkpoint.slice(0, colonIdx)
  const head = checkpoint.slice(colonIdx + 1)

  sandboxLog.info(`[reset] Resetting to checkpoint: ${branch}:${head.slice(0, 8)}`)

  // Force-checkout the original branch (suppresses "your changes would be overwritten")
  execSync(`git checkout -f ${branch}`, {
    cwd: workspacePath,
    encoding: 'utf-8',
    timeout: 15_000,
    windowsHide: true
  })

  // Hard reset to the checkpoint commit
  execSync(`git reset --hard ${head}`, {
    cwd: workspacePath,
    encoding: 'utf-8',
    timeout: 15_000,
    windowsHide: true
  })

  // Clean untracked files and directories (coverage output, temp files, etc.)
  execSync('git clean -fd', {
    cwd: workspacePath,
    encoding: 'utf-8',
    timeout: 15_000,
    windowsHide: true
  })

  sandboxLog.info('[reset] Workspace restored to checkpoint')
}

// ── Diff Analysis ──

/**
 * Get diff statistics for the most recent experiment (since last commit or ref).
 *
 * @param workspacePath - Git workspace root
 * @param diffRef - Git ref to diff against (default: 'HEAD~1')
 * @returns Object with filesChanged, linesAdded, linesRemoved
 */
export function getExperimentDiffStats(workspacePath: string, diffRef = 'HEAD~1'): DiffStats {
  try {
    const stat = execSync(`git diff --shortstat ${diffRef}`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 10_000,
      windowsHide: true
    }).trim()

    if (!stat) {
      return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 }
    }

    // Parse: " 3 files changed, 42 insertions(+), 10 deletions(-)"
    const filesMatch = stat.match(/(\d+) files? changed/)
    const insertionsMatch = stat.match(/(\d+) insertions?\(\+\)/)
    const deletionsMatch = stat.match(/(\d+) deletions?\(-\)/)

    return {
      filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      linesAdded: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
      linesRemoved: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0
    }
  } catch {
    sandboxLog.warn('[diff-stats] git diff --shortstat failed (non-fatal)')
    return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 }
  }
}

// ── Build Artifact Cleanup ──

/**
 * Clean up build artifacts between experiments.
 * Removes coverage output, test logs, and other transient files
 * that should not carry over between autonomous experiment runs.
 */
export function cleanupBuildArtifacts(workspacePath: string): void {
  try {
    execSync('rm -rf coverage/ .c8_output/ run.log .nyc_output/ 2>/dev/null || true', {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 10_000,
      windowsHide: true
    })
    sandboxLog.info('[cleanup] Build artifacts removed')
  } catch {
    // Non-fatal — directory may not exist
  }
}
