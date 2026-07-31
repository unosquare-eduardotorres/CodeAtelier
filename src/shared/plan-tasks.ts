/**
 * plan-tasks — single source of truth for deriving a task manifest from a
 * StructuredPlan's phases.
 *
 * Both the renderer (plan-execution.store, via ChatExecutionPanel) and the
 * build-kickoff prompt sent to the model MUST derive taskIds the same way —
 * otherwise the model reports progress against IDs the UI never created
 * (or vice versa) and task-level tracking silently no-ops.
 *
 * taskId scheme: `${phaseId}-${index}`, 0-based index into phase.files[].
 */

import type { StructuredPlan } from './types'

export interface DerivedPlanTask {
  taskId: string
  title: string
  files: string[]
}

export interface DerivedPlanPhase {
  id: number
  title: string
  tasks: DerivedPlanTask[]
}

/** Derive per-phase task lists from a StructuredPlan. */
export function derivePlanTasks(
  plan: Pick<StructuredPlan, 'phases'> | null | undefined
): DerivedPlanPhase[] {
  return (plan?.phases ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    tasks: (p.files ?? []).map((f, i) => ({
      taskId: `${p.id}-${i}`,
      title: f.change || f.file,
      files: [f.file]
    }))
  }))
}

/** Derive a phaseId -> files[] map, used for file-activity-based fallback inference. */
export function derivePhaseFiles(
  plan: Pick<StructuredPlan, 'phases'> | null | undefined
): Record<number, string[]> {
  return Object.fromEntries(
    (plan?.phases ?? []).map((p) => [p.id, (p.files ?? []).map((f) => f.file)])
  )
}

export interface MatchedPlanTask {
  phaseId: number
  phaseTitle: string
  taskId: string
  taskTitle: string
  /** Total task count in the matched phase (for totalTasks reporting). */
  totalTasksInPhase: number
  /** Normalized (forward-slash) path that was matched. */
  touchedFile: string
}

/**
 * Match a written/edited file path against a plan's derived task manifest.
 * Used to derive task completion from OBSERVED tool activity (write/edit)
 * rather than relying solely on the model self-reporting via
 * emit_phase_progress — this is what makes chat's task tracking work even
 * when the model never calls the tool for a given task.
 *
 * Matches on the longest declared file suffix and requires a UNIQUE longest
 * match — on a length tie between two candidate tasks, returns null rather
 * than guessing (a wrong auto-completion is worse than a missed one).
 */
export function matchPlanTaskForFile(
  plan: Pick<StructuredPlan, 'phases'> | null | undefined,
  filePath: string
): MatchedPlanTask | null {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const phases = derivePlanTasks(plan)

  type Candidate = {
    phaseId: number
    phaseTitle: string
    taskId: string
    taskTitle: string
    totalTasksInPhase: number
    matchedFile: string
  }
  const candidates: Candidate[] = []

  for (const phase of phases) {
    for (const task of phase.tasks) {
      for (const f of task.files) {
        const normalizedF = f.replace(/\\/g, '/')
        // Exact match, or a path-BOUNDARY suffix match (preceded by '/').
        // A bare endsWith(normalizedF) with no boundary check would match
        // declared "store.ts" against written "my-store.ts" — a different
        // file that merely shares a substring. Condition 2 already covers
        // every legitimate case (including a bare declared filename like
        // "store.ts", matched via "/store.ts").
        if (normalizedPath === normalizedF || normalizedPath.endsWith('/' + normalizedF)) {
          candidates.push({
            phaseId: phase.id,
            phaseTitle: phase.title,
            taskId: task.taskId,
            taskTitle: task.title,
            totalTasksInPhase: phase.tasks.length,
            matchedFile: normalizedF
          })
        }
      }
    }
  }

  if (candidates.length === 0) return null

  candidates.sort((a, b) => b.matchedFile.length - a.matchedFile.length)
  const [best, second] = candidates
  if (second && second.matchedFile.length === best.matchedFile.length) {
    // Ambiguous — two equally-specific matches. Don't guess.
    return null
  }

  return {
    phaseId: best.phaseId,
    phaseTitle: best.phaseTitle,
    taskId: best.taskId,
    taskTitle: best.taskTitle,
    totalTasksInPhase: best.totalTasksInPhase,
    touchedFile: normalizedPath
  }
}

const TERMINAL_TASK_STATUSES = new Set(['complete', 'skipped', 'failed'])

/**
 * Whether every task DECLARED for a phase (via derivePlanTasks — the full
 * manifest, not just whatever happens to be persisted so far) has reached a
 * terminal status in the persisted task list. Used to auto-finalize a phase
 * from observed tool activity alone, without requiring the model to call
 * emit_phase_progress with status: 'completed'.
 *
 * Comparing against the full derived manifest (not the persisted subset) is
 * the important part — a phase with 4 declared tasks where only 1 has ever
 * been recorded must NOT be finalized just because that 1 task is done.
 * A phase with zero declared tasks (no files[]) is never auto-finalized here
 * — it stays dependent on the model's own phase-level report.
 */
export function isPhaseTaskSetComplete(
  plan: Pick<StructuredPlan, 'phases'> | null | undefined,
  phaseId: number,
  persistedTasks: Array<{ taskId: string; status: string }>
): boolean {
  const phase = derivePlanTasks(plan).find((p) => p.id === phaseId)
  if (!phase || phase.tasks.length === 0) return false

  const statusByTaskId = new Map(persistedTasks.map((t) => [t.taskId, t.status]))
  return phase.tasks.every((t) => {
    const status = statusByTaskId.get(t.taskId)
    return status !== undefined && TERMINAL_TASK_STATUSES.has(status)
  })
}

/**
 * Render a human-readable task manifest for injection into the build-kickoff
 * message, so the model reports emit_phase_progress task fields against the
 * exact taskIds the UI is already tracking (instead of inventing its own).
 */
export function renderTaskManifest(
  plan: Pick<StructuredPlan, 'phases'> | null | undefined
): string {
  const phases = derivePlanTasks(plan)
  if (!phases.length) return ''

  const lines: string[] = []
  for (const phase of phases) {
    lines.push(`Phase ${phase.id}: ${phase.title}`)
    if (!phase.tasks.length) {
      lines.push('  (no file-level tasks — report phase-level progress only)')
      continue
    }
    for (const task of phase.tasks) {
      lines.push(
        `  - taskId="${task.taskId}" title="${task.title}" files=[${task.files.join(', ')}]`
      )
    }
  }
  return lines.join('\n')
}
