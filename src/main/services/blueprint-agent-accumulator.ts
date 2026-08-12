/**
 * Blueprint Agent Accumulator — buffers phaseProgress stream chunks into
 * agent journal entries. Extracted from blueprint.ipc.ts for testability.
 *
 * Flushes at:
 * - Tool-activity boundaries (text → tool transition)
 * - phaseComplete events (flushAllForPhase)
 * - Cancel events (flushAllForBlueprint)
 *
 * Caps:
 * - 32KB per journal entry (AGENT_ENTRY_CHAR_CAP)
 * - ~1MB per (blueprintId, phase, taskId) lane (AGENT_PHASE_CHAR_CAP)
 *   NOTE: The cap is per-lane, not per-phase. With N parallel build agents,
 *   the total per build phase can reach ~N×1MB. This is bounded and accepted
 *   (6 agents ≈ 6MB worst case for one build phase).
 */

// ── Constants (exported for tests) ──

export const AGENT_ENTRY_CHAR_CAP = 32_768
export const AGENT_PHASE_CHAR_CAP = 1_048_576

// ── Types ──

export interface AgentAccumulator {
  text: string
  toolActivities: Array<Record<string, unknown>>
  phaseTotal: number
}

/** Callback shape for persisting flushed entries */
export type JournalAppendFn = (
  blueprintId: string,
  type: string,
  payload: Record<string, unknown>
) => void

// ── Factory ──

export interface AccumulatorInstance {
  /** Get or create the accumulator for a given key */
  getAccumulator(blueprintId: string, phase: string, taskId?: string): AgentAccumulator
  /** Flush the accumulator for a given key to the journal */
  flush(blueprintId: string, phase: string, taskId?: string): void
  /** Flush all keys matching blueprintId:phase (including taskId variants) */
  flushAllForPhase(blueprintId: string, phase: string): void
  /** Flush + delete ALL accumulator entries for a given blueprintId */
  flushAllForBlueprint(blueprintId: string): void
  /** Handle a phaseProgress event (text or tool chunk) */
  handleChunk(
    blueprintId: string,
    phase: string,
    kind: string | undefined,
    text?: string,
    toolActivity?: Record<string, unknown>,
    taskId?: string
  ): void
}

/** Extended interface exposing internals for tests only */
export interface AccumulatorTestInstance extends AccumulatorInstance {
  readonly _accumulators: ReadonlyMap<string, AgentAccumulator>
}

/**
 * Create an accumulator instance wired to a journal-append function.
 * The IPC layer calls this once and wires the returned methods into
 * event handlers.
 */
export function createAccumulator(journalAppend: JournalAppendFn): AccumulatorInstance {
  const accumulators = new Map<string, AgentAccumulator>()

  function accKey(blueprintId: string, phase: string, taskId?: string): string {
    return taskId ? `${blueprintId}:${phase}:${taskId}` : `${blueprintId}:${phase}`
  }

  function getAccumulator(blueprintId: string, phase: string, taskId?: string): AgentAccumulator {
    const key = accKey(blueprintId, phase, taskId)
    let acc = accumulators.get(key)
    if (!acc) {
      acc = { text: '', toolActivities: [], phaseTotal: 0 }
      accumulators.set(key, acc)
    }
    return acc
  }

  function flush(blueprintId: string, phase: string, taskId?: string): void {
    const key = accKey(blueprintId, phase, taskId)
    const acc = accumulators.get(key)
    if (!acc || (!acc.text.trim() && acc.toolActivities.length === 0)) return

    // Cap per-entry text
    let content = acc.text
    if (content.length > AGENT_ENTRY_CHAR_CAP) {
      content = content.slice(0, AGENT_ENTRY_CHAR_CAP) + '\n\n[… truncated at 32KB]'
    }

    // Check per-phase cap
    if (acc.phaseTotal < AGENT_PHASE_CHAR_CAP) {
      journalAppend(blueprintId, 'agent', {
        phase,
        content,
        contentMd: content,
        toolActivities: acc.toolActivities,
        // Include taskId in payload so hydrated parallel-lane
        // bubbles retain lane identity.
        ...(taskId ? { taskId } : {})
      })
      acc.phaseTotal += content.length
    }

    // Reset accumulator text/tools but keep phaseTotal
    acc.text = ''
    acc.toolActivities = []
  }

  function flushAllForPhase(blueprintId: string, phase: string): void {
    for (const key of [...accumulators.keys()]) {
      if (key === `${blueprintId}:${phase}` || key.startsWith(`${blueprintId}:${phase}:`)) {
        const parts = key.split(':')
        flush(blueprintId, phase, parts[2])
        accumulators.delete(key)
      }
    }
  }

  function flushAllForBlueprint(blueprintId: string): void {
    for (const key of [...accumulators.keys()]) {
      if (key.startsWith(`${blueprintId}:`)) {
        const parts = key.split(':')
        const phase = parts[1]
        const taskId = parts[2] // may be undefined
        flush(blueprintId, phase, taskId)
        accumulators.delete(key)
      }
    }
  }

  function handleChunk(
    blueprintId: string,
    phase: string,
    kind: string | undefined,
    text?: string,
    toolActivity?: Record<string, unknown>,
    taskId?: string
  ): void {
    const acc = getAccumulator(blueprintId, phase, taskId)

    if (kind === 'tool') {
      // Tool event = boundary — flush text accumulated so far, then record tool
      if (acc.text.trim()) {
        flush(blueprintId, phase, taskId)
      }
      if (toolActivity) {
        acc.toolActivities.push(toolActivity)
      }
    } else {
      // Text chunk — accumulate
      if (text) acc.text += text
    }
  }

  return {
    getAccumulator,
    flush,
    flushAllForPhase,
    flushAllForBlueprint,
    handleChunk
  }
}
