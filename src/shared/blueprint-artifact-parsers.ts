/**
 * Shared Blueprint Artifact Parsers — plan and tasks block extraction.
 * Pure functions — no electron-log dependency. Importable by both main and renderer.
 *
 * Main process re-exports these to keep its existing API.
 */

// ── Plan block ──

const PLAN_REGEX = /```blueprint-plan\s*\n([\s\S]*?)```/g

/**
 * Parse the last blueprint-plan block from streamed text.
 * Returns null if no block found or parsing fails.
 */
export function parseBlueprintPlan(text: string): Record<string, unknown> | null {
  const matches = [...text.matchAll(PLAN_REGEX)]
  if (matches.length === 0) return null

  const lastMatch = matches[matches.length - 1]
  const jsonStr = lastMatch[1].trim()

  try {
    return JSON.parse(jsonStr) as Record<string, unknown>
  } catch {
    return null
  }
}

// ── Tasks block ──

const TASKS_REGEX = /```blueprint-tasks\s*\n([\s\S]*?)```/g

/**
 * Parse the last blueprint-tasks block from streamed text.
 * Returns null if no block found or parsing fails.
 */
export function parseBlueprintTasks(text: string): Record<string, unknown> | null {
  const matches = [...text.matchAll(TASKS_REGEX)]
  if (matches.length === 0) return null

  const lastMatch = matches[matches.length - 1]
  const jsonStr = lastMatch[1].trim()

  try {
    return JSON.parse(jsonStr) as Record<string, unknown>
  } catch {
    return null
  }
}
