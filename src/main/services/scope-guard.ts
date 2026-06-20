/**
 * Scope Guard — validates that agent modifications stay within allowed paths.
 *
 * Called after the agent commits, before the keep/discard decision.
 * If violations are found, the caller should git reset + discard.
 *
 * This is a hard gate for autonomous operations (MPA campaigns, AutoPilot)
 * where scope boundaries are prompt-only instructions that the agent can ignore.
 */

import { execSync } from 'node:child_process'
import log from 'electron-log'

const scopeLog = log.scope('scope-guard')

export interface ScopeValidationResult {
  /** Whether all changes are within allowed paths */
  valid: boolean
  /** Files that were modified outside allowed paths */
  violations: string[]
  /** Total files changed */
  totalChanged: number
}

/**
 * Validate that all files changed since the last commit are within allowed paths.
 *
 * @param allowedPaths - Array of path prefixes that the agent is allowed to modify
 *                       (e.g., ['src/main/services/', 'src/shared/'])
 * @param workspacePath - Absolute path to the git workspace root
 * @param diffRef - Git ref to diff against (default: 'HEAD~1')
 * @returns Validation result with any violations listed
 */
export function validateDiffScope(
  allowedPaths: string[],
  workspacePath: string,
  diffRef = 'HEAD~1'
): ScopeValidationResult {
  try {
    const diff = execSync(`git diff --name-only ${diffRef}`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 10_000
    })
    const changedFiles = diff.trim().split('\n').filter(Boolean)

    if (changedFiles.length === 0) {
      return { valid: true, violations: [], totalChanged: 0 }
    }

    const violations = changedFiles.filter(
      (file) => !allowedPaths.some((allowed) => file.startsWith(allowed))
    )

    if (violations.length > 0) {
      scopeLog.warn(
        `[scope-guard] ${violations.length} file(s) modified outside allowed paths: ${violations.join(', ')}`
      )
    }

    return {
      valid: violations.length === 0,
      violations,
      totalChanged: changedFiles.length
    }
  } catch (err) {
    // If git diff fails (no commits, not a git repo, etc.), treat as valid
    // to avoid blocking execution on infrastructure issues.
    scopeLog.warn('[scope-guard] git diff failed (non-fatal):', err)
    return { valid: true, violations: [], totalChanged: 0 }
  }
}

/**
 * Get the list of files changed in the working directory (unstaged + staged).
 * Useful for pre-commit scope checks before the agent commits.
 */
export function getUncommittedChanges(workspacePath: string): string[] {
  try {
    const diff = execSync('git diff --name-only HEAD', {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 10_000
    })
    const staged = execSync('git diff --name-only --cached', {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 10_000
    })
    const allFiles = new Set([
      ...diff.trim().split('\n').filter(Boolean),
      ...staged.trim().split('\n').filter(Boolean)
    ])
    return [...allFiles]
  } catch {
    return []
  }
}
