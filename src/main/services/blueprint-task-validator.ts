/**
 * blueprint-task-validator — Validates the dependency graph of blueprint tasks
 * before bulk-inserting them into the database.
 *
 * Checks:
 *  1. Reference integrity: all dependsOn IDs exist in the task set
 *  2. Cycle detection: no circular dependencies (DFS-based)
 *  3. Cross-wave ordering: a task's dependencies must be in earlier waves
 *
 * TASK-01: Blueprint task dependencies were entirely unvalidated — no cycle
 * detection, no FK integrity, no cross-wave checks. This module fills that gap.
 */

import log from 'electron-log'

const validatorLog = log.scope('blueprint-task-validator')

export interface TaskForValidation {
  taskId: string
  wave: number
  dependsOn?: string[]
}

export interface TaskValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate the dependency graph of a set of blueprint tasks.
 * Returns { valid: true } if all checks pass, otherwise returns
 * the list of errors found. Errors are logged but non-fatal —
 * callers decide whether to reject or warn.
 */
export function validateTaskGraph(tasks: TaskForValidation[]): TaskValidationResult {
  const errors: string[] = []
  const taskIds = new Set(tasks.map((t) => t.taskId))
  const taskMap = new Map(tasks.map((t) => [t.taskId, t]))

  // 1. Uniqueness — detect duplicate task IDs
  if (taskIds.size !== tasks.length) {
    const seen = new Set<string>()
    for (const t of tasks) {
      if (seen.has(t.taskId)) {
        errors.push(`Duplicate taskId: "${t.taskId}"`)
      }
      seen.add(t.taskId)
    }
  }

  // 2. Reference integrity — all dependsOn IDs must exist
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!taskIds.has(dep)) {
        errors.push(`Task "${task.taskId}": dependency "${dep}" not found in task set`)
      }
    }
  }

  // 3. Cycle detection (DFS with visiting/visited sets)
  const visited = new Set<string>()
  const visiting = new Set<string>()

  function hasCycle(id: string, path: string[]): boolean {
    if (visited.has(id)) return false
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id)
      const cyclePath = path.slice(cycleStart).concat(id)
      errors.push(`Circular dependency: ${cyclePath.join(' → ')}`)
      return true
    }
    visiting.add(id)
    path.push(id)
    for (const dep of taskMap.get(id)?.dependsOn ?? []) {
      // Only check deps that exist (missing deps already flagged above)
      if (taskIds.has(dep) && hasCycle(dep, path)) return true
    }
    path.pop()
    visiting.delete(id)
    visited.add(id)
    return false
  }

  for (const t of tasks) {
    if (!visited.has(t.taskId)) {
      hasCycle(t.taskId, [])
    }
  }

  // 4. Cross-wave ordering — dependencies must be in strictly earlier waves
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      const depTask = taskMap.get(dep)
      if (depTask && depTask.wave >= task.wave) {
        errors.push(
          `Task "${task.taskId}" (wave ${task.wave}) depends on "${dep}" (wave ${depTask.wave}) — dependency must be in an earlier wave`
        )
      }
    }
  }

  if (errors.length > 0) {
    validatorLog.warn(
      `[task-validator] Found ${errors.length} issue(s) in task graph:\n  ${errors.join('\n  ')}`
    )
  }

  return { valid: errors.length === 0, errors }
}
