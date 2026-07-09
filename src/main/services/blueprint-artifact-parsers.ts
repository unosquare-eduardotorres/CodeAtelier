/**
 * Blueprint Artifact Parsers — shared between BlueprintSpecService and tests.
 *
 * Plan and tasks parsers are now in the shared module (importable by renderer).
 * This file re-exports them for backward compatibility and keeps the main-only
 * parsePhaseCompletionBlock (which uses electron-log).
 */

import log from 'electron-log'
import type { BlueprintPhaseCompletion } from '../../shared/blueprint-types'

// Re-export shared parsers so existing main-process imports keep working
export { parseBlueprintPlan, parseBlueprintTasks } from '../../shared/blueprint-artifact-parsers'

const bpLog = log.scope('blueprint-parsers')

/**
 * Parse a blueprint-phase-complete block from streamed text.
 * Primary: ```blueprint-phase-complete ... ```
 * Fallback: any JSON with "phase" and "status" keys.
 */
/**
 * Parse a ```blueprint-discoveries``` block from streamed text.
 * Returns an array of discovery strings (max 10, each truncated to 250 chars),
 * or null if the block is absent or malformed.
 */
export function parseDiscoveriesBlock(text: string): string[] | null {
  try {
    const match = text.match(/```blueprint-discoveries\s*\n([\s\S]*?)\n```/)
    if (!match?.[1]) return null

    const parsed: unknown = JSON.parse(match[1])
    if (!Array.isArray(parsed)) return null

    const entries = parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .slice(0, 10)
      .map((entry) => (entry.length > 250 ? entry.slice(0, 250) : entry))

    return entries.length > 0 ? entries : null
  } catch {
    return null
  }
}

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
