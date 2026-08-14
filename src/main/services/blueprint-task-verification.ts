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
  /** Planned filePathsJson entries we looked for and did not find → warning only (plans drift). */
  missingPlanned: string[]
  /**
   * BP-VERIFY-UNVERIFIABLE-01: Planned entries that resolve outside every known
   * root, so they could never be checked at all. NOT a claim about existence —
   * absence of evidence is not evidence of absence, so these never hard-fail.
   */
  unverifiablePlanned: string[]
  /** Claimed files present but stale (mtime < taskStartedAt) → HARD FAIL when taskStartedAt is provided. */
  staleClaimed: string[]
  /** Nothing checkable — no claims and no planned path we could inspect. */
  unverifiable: boolean
}

/**
 * Outcome of resolving one path against the roots we are allowed to read.
 * `outside` means "could not be checked", which is deliberately distinct from
 * "checked and absent" — conflating the two is what made an unverifiable task
 * fail forever (R007).
 */
type Resolution = { kind: 'inside'; path: string } | { kind: 'outside' }

/**
 * Verify that files claimed by the LLM completion block actually exist on disk.
 *
 * Rules:
 * - Resolve each path against `workspacePath`. An absolute path under
 *   `mainRepoPath` is re-rooted onto `workspacePath` first — BUILD runs in a
 *   worktree of the same repo, so the same repo-relative file in the execution
 *   root is the file the plan meant. A path under neither root is refused.
 * - A refused **planned** path lands in `unverifiablePlanned`, never in
 *   `missingPlanned` — we cannot report a file absent from a tree we are not
 *   allowed to look at.
 * - `ok = false` when:
 *   - Any claimed `filesCreated`/`filesModified` entry is missing on disk, **or**
 *   - No completion block was parsed AND at least one planned path was actually
 *     checkable AND **none** of the checkable ones exist (the R029 signature:
 *     zero output, zero files).
 * - No completion block but planned files DO exist → `ok = true` (agent worked,
 *   forgot the block — current lenient behavior preserved).
 * - No claims + nothing checkable → `unverifiable: true, ok: true` (integration/
 *   wiring tasks, and tasks whose planned paths all lie outside our roots — the
 *   verify-phase net still covers those).
 *
 * @param taskStartedAt  Optional epoch ms. When provided, claimed files must also
 *   have `mtimeMs >= taskStartedAt - 60_000` (clock-skew allowance). Stale files
 *   → `staleClaimed` → `ok = false`. Omit for verify-phase scans where legitimately-
 *   unmodified files are common.
 * @param mainRepoPath  Optional. The workspace's primary checkout, when execution
 *   happens in a worktree of it. Absolute paths under it are re-rooted onto
 *   `workspacePath` before the guard.
 */
export function verifyTaskFileClaims(
  workspacePath: string,
  completion: Record<string, unknown> | null,
  plannedFiles: string[],
  taskStartedAt?: number,
  mainRepoPath?: string
): TaskVerificationResult {
  const missingClaimed: string[] = []
  const missingPlanned: string[] = []
  const unverifiablePlanned: string[] = []
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
      // A claim about a path outside our roots stays a hard failure: the agent
      // asserted it wrote that file, and we cannot confirm the assertion.
      const res = resolveAndGuard(workspacePath, filePath, mainRepoPath)
      if (res.kind === 'outside' || !existsSync(res.path)) {
        missingClaimed.push(filePath)
      } else if (freshnessThreshold != null) {
        // FIX-3: Check mtime freshness — stale files from a prior run must not pass
        try {
          const mtime = statSync(res.path).mtimeMs
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
      if (allClaimed.includes(filePath)) continue
      const res = resolveAndGuard(workspacePath, filePath, mainRepoPath)
      if (res.kind === 'outside') {
        unverifiablePlanned.push(filePath)
      } else if (!existsSync(res.path)) {
        missingPlanned.push(filePath)
      }
    }

    return {
      ok: missingClaimed.length === 0 && staleClaimed.length === 0,
      missingClaimed,
      missingPlanned,
      unverifiablePlanned,
      staleClaimed,
      unverifiable: false
    }
  }

  // ── Case 2: No claims in completion block ──
  if (plannedFiles.length === 0) {
    // No claims + no planned files → unverifiable (integration/wiring task)
    return {
      ok: true,
      missingClaimed: [],
      missingPlanned: [],
      unverifiablePlanned: [],
      staleClaimed: [],
      unverifiable: true
    }
  }

  // Check if ANY planned files exist on disk
  let anyPlannedExists = false
  for (const filePath of plannedFiles) {
    const res = resolveAndGuard(workspacePath, filePath, mainRepoPath)
    if (res.kind === 'outside') {
      unverifiablePlanned.push(filePath)
    } else if (existsSync(res.path)) {
      anyPlannedExists = true
    } else {
      missingPlanned.push(filePath)
    }
  }

  // BP-VERIFY-UNVERIFIABLE-01: Hard-fail only when something was actually
  // checkable. When every planned path lies outside our roots we know nothing
  // about this task — reporting "the agent produced nothing" would be a claim
  // we never tested, and it fails identically on every retry (R007).
  const anyCheckable = plannedFiles.length > unverifiablePlanned.length

  if (!completion && !anyPlannedExists && anyCheckable) {
    // R029 signature: no completion block AND none of the checkable planned
    // files exist → the agent produced nothing
    return {
      ok: false,
      missingClaimed: [],
      missingPlanned,
      unverifiablePlanned,
      staleClaimed: [],
      unverifiable: false
    }
  }

  if (!completion && !anyPlannedExists) {
    // Nothing was checkable — pass, but flag it so the caller can surface it.
    return {
      ok: true,
      missingClaimed: [],
      missingPlanned,
      unverifiablePlanned,
      staleClaimed: [],
      unverifiable: true
    }
  }

  // FIX-3: Lenient path with freshness — if taskStartedAt is provided and
  // no completion block, check that at least one planned file is fresh.
  // Stale planned files from a prior run shouldn't excuse a missing completion.
  if (freshnessThreshold != null && !completion) {
    let anyFresh = false
    for (const filePath of plannedFiles) {
      const res = resolveAndGuard(workspacePath, filePath, mainRepoPath)
      if (res.kind === 'inside' && existsSync(res.path)) {
        try {
          if (statSync(res.path).mtimeMs >= freshnessThreshold) {
            anyFresh = true
            break
          }
        } catch {
          /* stat failed — skip */
        }
      }
    }
    // BP-VERIFY-UNVERIFIABLE-01: same rule as above — staleness is only a
    // verdict on paths we could actually stat.
    if (!anyFresh && anyCheckable) {
      return {
        ok: false,
        missingClaimed: [],
        missingPlanned,
        unverifiablePlanned,
        staleClaimed: [],
        unverifiable: false
      }
    }
  }

  // Some planned files exist (and are fresh if taskStartedAt was given)
  // → agent worked, just forgot the completion block
  return {
    ok: true,
    missingClaimed: [],
    missingPlanned,
    unverifiablePlanned,
    staleClaimed: [],
    unverifiable: false
  }
}

/**
 * BUILD's task verification, with both roots named rather than positional.
 *
 * `verifyTaskFileClaims` takes the primary checkout as an *optional fifth*
 * argument. BUILD omitted it, so every claim naming an absolute path in the
 * primary tree resolved `outside` and was reported as `missingClaimed` — which
 * is how a blueprint whose tasks all completed still failed its build phase
 * (R007: "1 claimed missing" for a file that existed in both trees). Planned
 * paths are recorded as absolute primary-tree paths, so agents naturally claim
 * them back in that form.
 *
 * Requiring both roots as named fields makes that omission a type error instead
 * of a silent verification failure.
 */
export function verifyBuildTaskFiles(opts: {
  /** The worktree BUILD is writing into — the root claims are resolved against. */
  executionPath: string
  /** The primary checkout. Absolute paths under it are re-rooted onto `executionPath`. */
  workspacePath: string
  completion: Record<string, unknown> | null
  plannedFiles: string[]
  taskStartedAt?: number
}): TaskVerificationResult {
  return verifyTaskFileClaims(
    opts.executionPath,
    opts.completion,
    opts.plannedFiles,
    opts.taskStartedAt,
    opts.workspacePath
  )
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
 * BP-VERIFY-UNVERIFIABLE-01: planned paths that resolve outside every root are
 * skipped entirely — neither `missingClaimed` nor `driftFiles`. VERIFY must not
 * downgrade a task over a file it was never able to look at.
 *
 * Returns a Map of taskId → { missingClaimed, driftFiles }.
 *
 * @param mainRepoPath  Optional primary checkout; absolute paths under it are
 *   re-rooted onto `workspacePath` (same rule as verifyTaskFileClaims).
 */
export function scanCompletedTaskFiles(
  workspacePath: string,
  tasks: Array<{
    taskId: string
    status: string
    filePathsJson: string[]
    completionJson?: { filesCreated: string[]; filesModified: string[] } | null
  }>,
  mainRepoPath?: string
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
        const res = resolveAndGuard(workspacePath, filePath, mainRepoPath)
        if (res.kind === 'outside' || !existsSync(res.path)) {
          missingClaimed.push(filePath)
        }
      }

      // Planned-but-not-claimed = drift (informational only)
      if (task.filePathsJson?.length) {
        const claimedSet = new Set(claimed.map((p) => p.toLowerCase()))
        for (const filePath of task.filePathsJson) {
          if (claimedSet.has(filePath.toLowerCase())) continue
          const res = resolveAndGuard(workspacePath, filePath, mainRepoPath)
          if (res.kind === 'outside') continue // unverifiable — not drift
          if (!existsSync(res.path)) {
            driftFiles.push(filePath)
          }
        }
      }
    } else {
      // No completion data (legacy/pre-migration) → fall back to checking planned files
      // Treat as missingClaimed for backward compatibility
      if (!task.filePathsJson?.length) continue
      for (const filePath of task.filePathsJson) {
        const res = resolveAndGuard(workspacePath, filePath, mainRepoPath)
        if (res.kind === 'outside') continue // unverifiable — never a hard failure
        if (!existsSync(res.path)) {
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
  const tasksWithClaimedMissing = [...missingByTask.entries()].filter(
    ([, v]) => v.missingClaimed.length > 0
  )

  if (tasksWithClaimedMissing.length === 0) {
    // Only drift — inject informational finding but DON'T downgrade status
    const driftCount = [...missingByTask.values()].reduce((sum, v) => sum + v.driftFiles.length, 0)
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
 * Resolve a file path against the execution root.
 *
 * When `mainRepoPath` is given and the path is an absolute location inside the
 * primary checkout, it is re-rooted onto `workspacePath`: BUILD executes in a
 * worktree of the same repo, so the same repo-relative file under the execution
 * root is the file the plan named. A path under neither root is refused
 * (`outside`) — refusal means "not checkable here", never "missing".
 */
function resolveAndGuard(
  workspacePath: string,
  filePath: string,
  mainRepoPath?: string
): Resolution {
  const direct = containedIn(workspacePath, filePath)
  if (direct) return { kind: 'inside', path: direct }

  if (mainRepoPath && isAbsolute(filePath)) {
    const rel = relative(mainRepoPath, filePath)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return { kind: 'inside', path: resolve(workspacePath, rel) }
    }
  }

  return { kind: 'outside' }
}

/**
 * Resolve `filePath` against `root`, returning it only when it stays inside
 * (path traversal protection). Returns null otherwise.
 */
function containedIn(root: string, filePath: string): string | null {
  const resolved = isAbsolute(filePath) ? filePath : resolve(root, filePath)
  const rel = relative(root, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null
  }
  return resolved
}
