/**
 * Blueprint Artifact Parsers — shared between BlueprintSpecService and tests.
 *
 * Extracts structured completion, plan, and task artifacts from raw agent output text.
 * Looks for tagged code blocks first, then falls back to JSON pattern matching.
 *
 * Following the mpa-artifact-parsers.ts pattern: pure functions with try-catch.
 */

import log from 'electron-log'
import type { BlueprintPhaseCompletion } from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-parsers')

/**
 * Parse a blueprint-phase-complete block from streamed text.
 * Primary: ```blueprint-phase-complete ... ```
 * Fallback: any JSON with "phase" and "status" keys.
 */
export function parsePhaseCompletionBlock(text: string): BlueprintPhaseCompletion | null {
  try {
    // Look for ```blueprint-phase-complete ... ``` tagged block
    const match = text.match(/```blueprint-phase-complete\s*\n([\s\S]*?)\n```/)
    if (match?.[1]) {
      const parsed = JSON.parse(match[1])
      if (parsed.phase && parsed.status) {
        return parsed as BlueprintPhaseCompletion
      }
    }

    // Fallback: look for any JSON with "phase" and "status" keys
    const jsonMatch = text.match(
      /\{[\s\S]*"phase"\s*:\s*"[\s\S]*?"[\s\S]*"status"\s*:\s*"[\s\S]*?"[\s\S]*?\}/
    )
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.phase && parsed.status) {
        return parsed as BlueprintPhaseCompletion
      }
    }
  } catch (err) {
    bpLog.warn('[parsePhaseCompletionBlock] Failed to parse completion:', err)
  }
  return null
}

/**
 * Parse a blueprint-plan block from streamed text (Phase 3 forward).
 */
export function parseBlueprintPlan(text: string): Record<string, unknown> | null {
  try {
    const match = text.match(/```blueprint-plan\s*\n([\s\S]*?)\n```/)
    if (match?.[1]) {
      return JSON.parse(match[1]) as Record<string, unknown>
    }
  } catch (err) {
    bpLog.warn('[parseBlueprintPlan] Failed to parse plan:', err)
  }
  return null
}

/**
 * Parse a blueprint-tasks block from streamed text (Phase 3 forward).
 */
export function parseBlueprintTasks(text: string): Record<string, unknown> | null {
  try {
    const match = text.match(/```blueprint-tasks\s*\n([\s\S]*?)\n```/)
    if (match?.[1]) {
      return JSON.parse(match[1]) as Record<string, unknown>
    }
  } catch (err) {
    bpLog.warn('[parseBlueprintTasks] Failed to parse tasks:', err)
  }
  return null
}
