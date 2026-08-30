/**
 * Pure helpers for humanizing persisted blueprint task failure reasons.
 *
 * The Retry screen used to show only the ephemeral `lastError` (null after a
 * reload) or a generic "An error occurred during this phase" — even though the
 * real per-task reasons ARE persisted in `blueprint_tasks.failure_reason` and
 * the missing-file list sits in the build phase's `verification-failure`
 * artifact. These helpers turn that persisted data into display strings.
 *
 * Pure (no React, no I/O) so the pattern mapping is unit-testable.
 */

import type { BlueprintTask } from '../../../shared/blueprint-types'

export interface TaskFailureDisplay {
  /** Short label, e.g. "T003" */
  title: string
  /** Humanized explanation of why the task failed. */
  hint: string
  /** Attempts spent (including the first) — rendered as a badge. */
  attempts: number
  /** Top missing files from the verification-failure artifact (max 3). */
  missingFiles: string[]
}

/** Extract up to `max` missing-file paths from a verification-failure artifact. */
export function extractMissingFiles(
  artifactContentMd: string | null | undefined,
  max = 3
): string[] {
  if (!artifactContentMd) return []
  const files: string[] = []
  // Artifact format: "- `path/to/file.ext`" bullets under bold section headers.
  const bulletRe = /^- `([^`]+)`/gm
  let m: RegExpExecArray | null
  while ((m = bulletRe.exec(artifactContentMd)) !== null) {
    files.push(m[1])
    if (files.length >= max) break
  }
  return files
}

/**
 * Map a persisted failureReason to a human-readable explanation.
 * Patterns are ordered — first match wins.
 */
export function humanizeFailureReason(reason: string | null | undefined): string {
  if (!reason) return 'Task failed — no reason was recorded.'

  // Executor-level error captured from the stream (Fix 2) — already actionable.
  if (/^executor error:/i.test(reason)) {
    return reason.replace(/^executor error:\s*/i, 'Executor error: ')
  }

  if (/planned missing/i.test(reason)) {
    return (
      'Builder session died before writing any files — the OpenCode server ' +
      'failed to start or was killed mid-task (parallel-wave port conflict).'
    )
  }

  if (/stalled — no activity/i.test(reason)) {
    return 'Session went silent mid-task — its server was killed by a sibling task\u2019s teardown.'
  }

  if (/Phase cancelled/i.test(reason)) {
    return 'Cancelled before finishing.'
  }

  if (/no-write-activity/i.test(reason)) {
    return (
      'The session claimed files but never invoked a write tool — files on disk ' +
      'are stale from a prior run.'
    )
  }

  if (/^overload$/i.test(reason)) {
    return 'The model was overloaded — retried until attempts ran out.'
  }

  if (/^turn_limit_exhausted$/i.test(reason)) {
    return 'The session hit its turn limit before completing the task.'
  }

  if (/^context_overflow$/i.test(reason)) {
    return 'The session ran out of context window before completing the task.'
  }

  if (/quality gate failed/i.test(reason)) {
    return 'The task output failed a deterministic quality gate.'
  }

  // Unknown reason — surface verbatim rather than hiding it.
  return reason
}

/**
 * Derive the display shape for one failed task.
 * `verificationArtifact` is the build phase's `verification-failure` artifact
 * content (contentMd) for this task, if any.
 */
export function deriveTaskFailureDisplay(
  task: Pick<BlueprintTask, 'taskId' | 'failureReason' | 'attempts'>,
  verificationArtifact?: string | null
): TaskFailureDisplay {
  return {
    title: task.taskId,
    hint: humanizeFailureReason(task.failureReason),
    attempts: task.attempts,
    missingFiles: extractMissingFiles(verificationArtifact)
  }
}

/** Cap the rendered list: first `max` entries plus a "+N more" count. */
export function capTaskList<T>(tasks: T[], max = 5): { shown: T[]; hiddenCount: number } {
  if (tasks.length <= max) return { shown: tasks, hiddenCount: 0 }
  return { shown: tasks.slice(0, max), hiddenCount: tasks.length - max }
}
