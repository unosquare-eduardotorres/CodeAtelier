/**
 * task-readiness.ts — pure UI derivations for DAG-scheduled builds.
 *
 * The BUILD scheduler dispatches by `dependsOn` readiness (waves are advisory
 * grouping), so the UI needs two derived signals that never lived in the DB:
 *  - per-task ready/blocked state, from dependsOnJson ∩ live statuses
 *  - per-wave completion, derived when every task of the wave is terminal
 *
 * Pure by design: no React, no store, no IPC — the same functions are unit
 * tested directly (blueprint-dag-ui.test.ts).
 */

/** Minimal task shape the derivations need. */
export interface ReadinessTask {
  taskId: string
  wave: number
  status: string
  skippedByUserAt?: string | null
  dependsOnJson?: string[] | null
}

/** Terminal = the task will not be dispatched again this run. */
export function isTerminalTask(t: ReadinessTask): boolean {
  return (
    t.status === 'complete' ||
    t.status === 'failed' ||
    (t.status === 'skipped' && Boolean(t.skippedByUserAt))
  )
}

/**
 * Dep settled ⇔ complete ∨ user-skipped — the scheduler's isDepSatisfied
 * rule. A FAILED dep is terminal for wave completion but does NOT satisfy
 * readiness: the dependent is heading for the skip cascade, so "blocked"
 * (naming the failed dep) is the honest chip.
 */
function isDepSettled(dep: ReadinessTask): boolean {
  return dep.status === 'complete' || (dep.status === 'skipped' && Boolean(dep.skippedByUserAt))
}

/**
 * Ready ⇔ task is pending/running-eligible and every declared dep is settled
 * (complete, or user-skipped — the same rule the scheduler enforces).
 * Blocked ⇔ not terminal and at least one dep is unsettled.
 */
export function taskReadiness(
  tasks: ReadinessTask[]
): Map<string, { ready: boolean; blockedBy: string[] }> {
  const byId = new Map(tasks.map((t) => [t.taskId, t]))
  const settled = (id: string): boolean => {
    const dep = byId.get(id)
    if (!dep) return true // unknown dep — scheduler ignores it, so do we
    return isDepSettled(dep)
  }
  const out = new Map<string, { ready: boolean; blockedBy: string[] }>()
  for (const t of tasks) {
    if (isTerminalTask(t)) {
      out.set(t.taskId, { ready: false, blockedBy: [] })
      continue
    }
    const blockedBy = (t.dependsOnJson ?? []).filter((d) => d !== t.taskId && !settled(d))
    out.set(t.taskId, { ready: blockedBy.length === 0, blockedBy })
  }
  return out
}

/**
 * Derived waveComplete: a wave is complete when ALL its tasks are terminal.
 * Under DAG scheduling there is no waveComplete event — the wave barrier is
 * gone — so the UI derives it from statuses instead.
 */
export function waveCompletion(tasks: ReadinessTask[]): Map<number, boolean> {
  const waves = new Map<number, { total: number; terminal: number }>()
  for (const t of tasks) {
    const entry = waves.get(t.wave) ?? { total: 0, terminal: 0 }
    entry.total++
    if (isTerminalTask(t)) entry.terminal++
    waves.set(t.wave, entry)
  }
  const out = new Map<number, boolean>()
  for (const [wave, { total, terminal }] of waves) {
    out.set(wave, total > 0 && terminal === total)
  }
  return out
}
