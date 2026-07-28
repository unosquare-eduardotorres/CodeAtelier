/**
 * blueprint-task-verification.ts — Deterministic file verification for build tasks.
 *
 * After each task completes, verify that files the LLM *claimed* to create/modify
 * actually exist on disk. This catches the false-positive pattern where a session
 * ends cleanly but produced no output (the R029 signature: zero files, zero errors,
 * status "Complete").
 *
 * Pure functions — no side effects, no I/O beyond existsSync. Fully testable.
 */

import { existsSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { asStringArray } from './blueprint-artifact-parsers'

export interface TaskVerificationResult {
  /** Verification passed — all claimed files confirmed on disk. */
  ok: boolean
  /** Claimed filesCreated/filesModified entries absent from disk → HARD FAIL. */
  missingClaimed: string[]
  /** Planned filePathsJson entries absent → warning only (plans drift). */
  missingPlanned: string[]
  /** Claimed files present but stale (mtime < taskStartedAt) → HARD FAIL when taskStartedAt is provided. */
  staleClaimed: string[]
  /** No claims AND no planned files — nothing to check (integration/wiring tasks). */
  unverifiable: boolean
}

/**
 * Verify that files claimed by the LLM completion block actually exist on disk.
 *
 * Rules:
 * - Resolve each path against `workspacePath`; a claimed path resolving **outside**
 *   the workspace (traversal) counts as missing.
 * - `ok = false` when:
 *   - Any claimed `filesCreated`/`filesModified` entry is missing on disk, **or**
 *   - No completion block was parsed AND `plannedFiles` is non-empty AND **none**
 *     of them exist (the R029 signature: zero output, zero files).
 * - No completion block but planned files DO exist → `ok = true` (agent worked,
 *   forgot the block — current lenient behavior preserved).
 * - No claims + no planned files → `unverifiable: true, ok: true` (integration/
 *   wiring tasks — the verify-phase net still covers them).
 *
 * @param taskStartedAt  Optional epoch ms. When provided, claimed files must also
 *   have `mtimeMs >= taskStartedAt - 60_000` (clock-skew allowance). Stale files
 *   → `staleClaimed` → `ok = false`. Omit for verify-phase scans where legitimately-
 *   unmodified files are common.
 */
export function verifyTaskFileClaims(
  workspacePath: string,
  completion: Record<string, unknown> | null,
  plannedFiles: string[],
  taskStartedAt?: number
): TaskVerificationResult {
  const missingClaimed: string[] = []
  const missingPlanned: string[] = []
  const staleClaimed: string[] = []

  // FIX-3: Freshness threshold — files must have been written during this task execution.
  // 60-second clock-skew allowance for filesystem/OS timing discrepancies.
  const freshnessThreshold = taskStartedAt != null ? taskStartedAt - 60_000 : undefined

  // Extract claimed files from the completion block
  const claimedCreated = asStringArray(completion?.filesCreated)
  const claimedModified = asStringArray(completion?.filesModified)
  const allClaimed = [...claimedCreated, ...claimedModified]

  // ── Case 1: Completion block exists with file claims → verify each one ──
  if (allClaimed.length > 0) {
    for (const filePath of allClaimed) {
      const resolved = resolveAndGuard(workspacePath, filePath)
      if (!resolved || !existsSync(resolved)) {
        missingClaimed.push(filePath)
      } else if (freshnessThreshold != null) {
        // FIX-3: Check mtime freshness — stale files from a prior run must not pass
        try {
          const mtime = statSync(resolved).mtimeMs
          if (mtime < freshnessThreshold) {
            staleClaimed.push(filePath)
          }
        } catch {
          // stat failed — treat as missing
          missingClaimed.push(filePath)
        }
      }
    }

    // Also check planned files for drift warnings (non-fatal)
    for (const filePath of plannedFiles) {
      const resolved = resolveAndGuard(workspacePath, filePath)
      if (resolved && !existsSync(resolved) && !allClaimed.includes(filePath)) {
        missingPlanned.push(filePath)
      }
    }

    return {
      ok: missingClaimed.length === 0 && staleClaimed.length === 0,
      missingClaimed,
      missingPlanned,
      staleClaimed,
      unverifiable: false
    }
  }

  // ── Case 2: No claims in completion block ──
  if (plannedFiles.length === 0) {
    // No claims + no planned files → unverifiable (integration/wiring task)
    return { ok: true, missingClaimed: [], missingPlanned: [], staleClaimed: [], unverifiable: true }
  }

  // Check if ANY planned files exist on disk
  let anyPlannedExists = false
  for (const filePath of plannedFiles) {
    const resolved = resolveAndGuard(workspacePath, filePath)
    if (resolved && existsSync(resolved)) {
      anyPlannedExists = true
    } else {
      missingPlanned.push(filePath)
    }
  }

  if (!completion && !anyPlannedExists) {
    // R029 signature: no completion block AND none of the planned files exist
    // → the agent produced nothing
    return { ok: false, missingClaimed: [], missingPlanned, staleClaimed: [], unverifiable: false }
  }

  // FIX-3: Lenient path with freshness — if taskStartedAt is provided and
  // no completion block, check that at least one planned file is fresh.
  // Stale planned files from a prior run shouldn't excuse a missing completion.
  if (freshnessThreshold != null && !completion) {
    let anyFresh = false
    for (const filePath of plannedFiles) {
      const resolved = resolveAndGuard(workspacePath, filePath)
      if (resolved && existsSync(resolved)) {
        try {
          if (statSync(resolved).mtimeMs >= freshnessThreshold) {
            anyFresh = true
            break
          }
        } catch { /* stat failed — skip */ }
      }
    }
    if (!anyFresh) {
      return { ok: false, missingClaimed: [], missingPlanned, staleClaimed: [], unverifiable: false }
    }
  }

  // Some planned files exist (and are fresh if taskStartedAt was given)
  // → agent worked, just forgot the completion block
  return { ok: true, missingClaimed: [], missingPlanned, staleClaimed: [], unverifiable: false }
}

/**
 * Scan all 'complete' tasks for a blueprint and collect files missing from disk.
 * When a task has `completionJson`, only files the agent *claimed* to create/modify
 * are treated as hard failures (`missingClaimed`). Planned-but-not-claimed files
 * are recorded as `driftFiles` (informational — normal plan drift).
 *
 * Tasks without `completionJson` (pre-migration or unparsed) fall back to checking
 * all planned files as `missingClaimed` for backward compatibility.
 *
 * Returns a Map of taskId → { missingClaimed, driftFiles }.
 */
export function scanCompletedTaskFiles(
  workspacePath: string,
  tasks: Array<{
    taskId: string
    status: string
    filePathsJson: string[]
    completionJson?: { filesCreated: string[]; filesModified: string[] } | null
  }>
): Map<string, { missingClaimed: string[]; driftFiles: string[] }> {
  const resultMap = new Map<string, { missingClaimed: string[]; driftFiles: string[] }>()

  for (const task of tasks) {
    if (task.status !== 'complete') continue
    if (!task.filePathsJson?.length && !task.completionJson) continue

    const missingClaimed: string[] = []
    const driftFiles: string[] = []

    if (task.completionJson) {
      // Has completion data → check CLAIMED files against disk (hard failure)
      const claimed = [
        ...(task.completionJson.filesCreated ?? []),
        ...(task.completionJson.filesModified ?? [])
      ]
      for (const filePath of claimed) {
        const resolved = resolveAndGuard(workspacePath, filePath)
        if (!resolved || !existsSync(resolved)) {
          missingClaimed.push(filePath)
        }
      }

      // Planned-but-not-claimed = drift (informational only)
      if (task.filePathsJson?.length) {
        const claimedSet = new Set(claimed.map(p => p.toLowerCase()))
        for (const filePath of task.filePathsJson) {
          if (claimedSet.has(filePath.toLowerCase())) continue
          const resolved = resolveAndGuard(workspacePath, filePath)
          if (!resolved || !existsSync(resolved)) {
            driftFiles.push(filePath)
          }
        }
      }
    } else {
      // No completion data (legacy/pre-migration) → fall back to checking planned files
      // Treat as missingClaimed for backward compatibility
      if (!task.filePathsJson?.length) continue
      for (const filePath of task.filePathsJson) {
        const resolved = resolveAndGuard(workspacePath, filePath)
        if (!resolved || !existsSync(resolved)) {
          missingClaimed.push(filePath)
        }
      }
    }

    if (missingClaimed.length > 0 || driftFiles.length > 0) {
      resultMap.set(task.taskId, { missingClaimed, driftFiles })
    }
  }

  return resultMap
}

/**
 * Apply a deterministic file-existence check on top of the verify-phase
 * completion block. Only `missingClaimed` files (agent said it created them
 * but they don't exist) force a status downgrade. `driftFiles` (planned but
 * never claimed) are recorded as informational findings without triggering
 * remediation.
 *
 * Pure function — mutates nothing, returns a new completion or the original.
 */
export function applyDeterministicFileCheck(
  completion: Record<string, unknown> | undefined,
  missingByTask: Map<string, { missingClaimed: string[]; driftFiles: string[] }>
): Record<string, unknown> | undefined {
  if (missingByTask.size === 0) return completion
  if (!completion) return completion

  // Count only missingClaimed — drift doesn't force downgrade
  const tasksWithClaimedMissing = [...missingByTask.entries()]
    .filter(([, v]) => v.missingClaimed.length > 0)

  if (tasksWithClaimedMissing.length === 0) {
    // Only drift — inject informational finding but DON'T downgrade status
    const driftCount = [...missingByTask.values()]
      .reduce((sum, v) => sum + v.driftFiles.length, 0)
    if (driftCount > 0) {
      const existingFindings = Array.isArray(completion.findings) ? completion.findings : []
      return {
        ...completion,
        findings: [
          ...existingFindings,
          {
            source: 'deterministic-disk-check-drift',
            severity: 'info',
            description: `${missingByTask.size} task(s) have ${driftCount} planned file(s) not created (plan drift — not a failure)`
          }
        ]
      }
    }
    return completion
  }

  // Has genuine missingClaimed → downgrade as before
  const overallStatus = String(completion.overallStatus ?? '')

  // FIX-5a: Downgrade both 'passed' AND 'human_needed' when files are missing.
  if (overallStatus === 'passed' || overallStatus === 'human_needed') {
    return injectClaimedFindings(
      { ...completion, overallStatus: 'gaps_found' },
      tasksWithClaimedMissing
    )
  }

  // Already gaps_found or other status — just inject findings
  return injectClaimedFindings(completion, tasksWithClaimedMissing)
}

/** Inject deterministic disk-check findings for claimed-but-missing files. */
function injectClaimedFindings(
  completion: Record<string, unknown>,
  tasksWithClaimedMissing: Array<[string, { missingClaimed: string[]; driftFiles: string[] }]>
): Record<string, unknown> {
  const deterministicFindings: Array<{ taskId: string; missingFiles: string[] }> = []
  for (const [taskId, { missingClaimed }] of tasksWithClaimedMissing) {
    deterministicFindings.push({ taskId, missingFiles: missingClaimed })
  }

  const existingFindings = Array.isArray(completion.findings) ? completion.findings : []
  return {
    ...completion,
    findings: [
      ...existingFindings,
      {
        source: 'deterministic-disk-check',
        severity: 'error',
        description: `${tasksWithClaimedMissing.length} task(s) have claimed files missing on disk`,
        tasks: deterministicFindings
      }
    ]
  }
}

/**
 * Resolve a file path against the workspace root, returning null if the
 * resolved path escapes the workspace (path traversal protection).
 */
function resolveAndGuard(workspacePath: string, filePath: string): string | null {
  // Handle absolute paths: check if they're within the workspace
  const resolved = isAbsolute(filePath) ? filePath : resolve(workspacePath, filePath)
  const rel = relative(workspacePath, resolved)

  // If the relative path starts with '..' it escapes the workspace
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null
  }
  return resolved
}
