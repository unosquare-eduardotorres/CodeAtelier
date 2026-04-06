/**
 * Task scheduling utilities for specialist task execution.
 * Extracted from SpecialistPoolService to reduce complexity.
 */
import type { DecomposedTask } from '../../../shared/types'

/**
 * Topological sort for sequential execution — respects dependsOn ordering.
 * Returns tasks in dependency order (dependencies before dependents).
 */
export function topologicalSort(tasks: DecomposedTask[]): DecomposedTask[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const visited = new Set<string>()
  const result: DecomposedTask[] = []

  const visit = (id: string): void => {
    if (visited.has(id)) return
    visited.add(id)

    const task = taskMap.get(id)
    if (!task) return

    for (const dep of task.dependsOn) {
      visit(dep)
    }
    result.push(task)
  }

  for (const task of tasks) {
    visit(task.id)
  }

  return result
}

/**
 * Strategy 11: Extended conclusive patterns for aggressive early exit.
 * When detected mid-stream in plan mode, the caller can abort to save unnecessary turns.
 * Each pattern saves 30-50% of remaining specialist tokens on investigation tasks.
 */
const CONCLUSIVE_PATTERNS: RegExp[] = [
  /```investigation-report\s*\n[\s\S]*?```/, // Structured report
  /## Summary of Findings\b/, // Common investigation conclusion header
  /## Root Cause\b/, // Root cause identified
  /\b(?:In summary|In conclusion|To summarize),\s/, // Natural language conclusions
  /## Recommendations?\b/, // Recommendation section header
  /\bThe root cause is\b/i, // Direct diagnosis statement
  /\bThe issue is caused by\b/i, // Direct diagnosis statement
  /\bBased on my (?:analysis|investigation|review)\b/i, // Analysis wrap-up
  /## (?:Conclusion|Analysis Complete|Investigation Results?)\b/, // Formal conclusion headers
  /\b(?:To conclude|In closing|Having investigated)\b/i // Formal wrap-up phrases
]

const CONCLUSIVE_LABELS = [
  'investigation-report',
  'summary-of-findings',
  'root-cause',
  'natural-conclusion',
  'recommendations',
  'root-cause-direct',
  'issue-caused-by',
  'analysis-wrap-up',
  'conclusion-header',
  'formal-wrap-up'
]

/**
 * Identify which conclusive pattern matched in the output (for logging).
 * Returns the pattern label or null if no conclusive pattern is detected.
 */
export function detectConclusivePattern(output: string): string | null {
  for (let i = 0; i < CONCLUSIVE_PATTERNS.length; i++) {
    if (CONCLUSIVE_PATTERNS[i].test(output)) {
      return CONCLUSIVE_LABELS[i]
    }
  }
  return null
}