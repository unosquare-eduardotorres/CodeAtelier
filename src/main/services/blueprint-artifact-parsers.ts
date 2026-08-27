/**
 * Blueprint Artifact Parsers — shared between BlueprintSpecService and tests.
 *
 * Plan and tasks parsers are now in the shared module (importable by renderer).
 * This file re-exports them for backward compatibility and keeps the main-only
 * parsePhaseCompletionBlock (which uses electron-log).
 */

import log from 'electron-log'
import type {
  BlueprintPhaseCompletion,
  BlueprintPhaseType,
  BlueprintPlanRevision
} from '../../shared/blueprint-types'

// Re-export shared parsers so existing main-process imports keep working
export { parseBlueprintPlan, parseBlueprintTasks } from '../../shared/blueprint-artifact-parsers'

/** Coerce an unknown LLM value to a string array, discarding non-string elements. */
export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []
}

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

/**
 * Parse a ```blueprint-plan-revision``` block emitted by a plan-revision turn.
 *
 * `planMarkdown` is the load-bearing field — a revision that does not carry a
 * complete revised plan is not a revision, so it is rejected rather than
 * half-applied. `concerns` is kept even when the plan is unchanged: an agent
 * pushing back on a request is a legitimate outcome the human needs to see.
 */
export function parsePlanRevisionBlock(text: string): BlueprintPlanRevision | null {
  // Same guard as parsePhaseCompletionBlock — don't run a regex over a corrupted
  // multi-megabyte stream.
  if (text.length > 500_000) {
    bpLog.warn(`[parsePlanRevisionBlock] Input too large (${text.length} chars) — skipping`)
    return null
  }

  try {
    const match = text.match(/```blueprint-plan-revision\s*\n([\s\S]*?)\n```/)
    if (!match?.[1]) return null

    const parsed: unknown = JSON.parse(match[1])
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>

    const planMarkdown = typeof obj.planMarkdown === 'string' ? obj.planMarkdown.trim() : ''
    if (!planMarkdown) {
      bpLog.warn('[parsePlanRevisionBlock] Block present but planMarkdown missing/empty')
      return null
    }

    return {
      summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
      changes: asStringArray(obj.changes),
      concerns: asStringArray(obj.concerns),
      planMarkdown
    }
  } catch (err) {
    bpLog.warn(`[parsePlanRevisionBlock] Malformed block: ${String(err)}`)
    return null
  }
}

export function parsePhaseCompletionBlock(
  text: string,
  expectedPhase?: BlueprintPhaseType
): BlueprintPhaseCompletion | null {
  // BP-PARSER-GUARD: Reject oversized inputs before hitting regex.
  // LLM outputs shouldn't exceed 500KB; anything larger is likely corrupted.
  if (text.length > 500_000) {
    bpLog.warn(`[parsePhaseCompletionBlock] Input too large (${text.length} chars) — skipping`)
    return null
  }

  try {
    // Look for ```blueprint-phase-complete ... ``` tagged block
    const match = text.match(/```blueprint-phase-complete\s*\n([\s\S]*?)\n```/)
    if (match?.[1]) {
      const parsed = JSON.parse(match[1])
      if (parsed.phase && parsed.status) {
        return parsed as BlueprintPhaseCompletion
      }
    }

    // Fallback 1: look for any JSON with "phase" and "status" keys.
    // BP-REDOS-01: Use indexOf to locate keys first, then extract the smallest
    // enclosing JSON object via brace-counting — avoids catastrophic backtracking
    // from the previous [\s\S]* regex on large inputs.
    const phaseIdx = text.indexOf('"phase"')
    const statusIdx = text.indexOf('"status"')
    if (phaseIdx > -1 && statusIdx > -1) {
      const startBrace = text.lastIndexOf('{', Math.min(phaseIdx, statusIdx))
      if (startBrace > -1) {
        // Find matching closing brace via counting
        let depth = 0
        let endBrace = -1
        for (let i = startBrace; i < text.length; i++) {
          if (text[i] === '{') depth++
          else if (text[i] === '}') {
            depth--
            if (depth === 0) {
              endBrace = i
              break
            }
          }
        }
        if (endBrace > -1) {
          try {
            const parsed = JSON.parse(text.substring(startBrace, endBrace + 1))
            if (parsed.phase && parsed.status) {
              return parsed as BlueprintPhaseCompletion
            }
          } catch {
            /* not valid JSON — continue to next fallback */
          }
        }
      }
    }

    // Fallback 2: verify-style JSON with "overallStatus" but missing "phase"/"status".
    // Only activates for verify phase (or when caller doesn't specify a phase).
    // The verify agent sometimes omits the tagged block or the phase/status keys.
    if (expectedPhase === 'verify' || expectedPhase === undefined) {
      // BP-NESTED-JSON-01: Use brace-counting to extract the full JSON object
      // from inside a fenced code block. The old non-greedy regex stopped at the
      // first '}', breaking on nested objects like { artifacts: { missing: 0 } }.
      const fenceMatch = text.match(/```(?:json)?\s*\n(\{)/)
      if (fenceMatch?.index != null) {
        const jsonStart = fenceMatch.index + fenceMatch[0].length - 1
        let depth = 0
        let jsonEnd = -1
        for (let i = jsonStart; i < text.length; i++) {
          if (text[i] === '{') depth++
          else if (text[i] === '}') {
            depth--
            if (depth === 0) {
              jsonEnd = i
              break
            }
          }
        }
        if (jsonEnd > -1) {
          const jsonStr = text.substring(jsonStart, jsonEnd + 1)
          try {
            const parsed = JSON.parse(jsonStr)
            if (parsed.overallStatus) {
              bpLog.info(
                `[parsePhaseCompletionBlock] Used verify-style fallback — overallStatus: ${parsed.overallStatus}`
              )
              return {
                ...parsed,
                phase: expectedPhase ?? 'verify',
                status: 'complete'
              } as BlueprintPhaseCompletion
            }
          } catch {
            /* malformed JSON — continue */
          }
        }
      }
    }

    // BP-PARSE-OBSERVABILITY: Log when all fallback paths fail on non-trivial output.
    // Helps distinguish "agent didn't emit completion" from "parsing failed silently".
    if (text.length > 200) {
      bpLog.warn(
        `[parsePhaseCompletionBlock] No completion block found in ${text.length}-char output` +
          (expectedPhase ? ` (expectedPhase: ${expectedPhase})` : '')
      )
    }
  } catch (err) {
    bpLog.warn('[parsePhaseCompletionBlock] Failed to parse completion:', err)
  }
  return null
}
