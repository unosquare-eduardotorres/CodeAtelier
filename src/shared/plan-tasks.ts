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
