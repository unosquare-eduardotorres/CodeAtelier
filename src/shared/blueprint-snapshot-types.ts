/**
 * BlueprintPipelineSnapshot — whole-state snapshot for snapshot sync.
 *
 * Published on BLUEPRINT_STATE_SYNC after every state mutation in the main process.
 * The renderer drops any snapshot with seq <= lastSeq, making late/reordered events harmless.
 * High-frequency phaseProgress chunks stay incremental (only they need to be).
 */

import type { BlueprintPhaseType, BlueprintTaskStatus } from './blueprint-types'
import type { ClarifyFindingsBlock, ClarifyQuestionsBlock } from './blueprint-clarify-parsers'

// ── Machine state type (shared between main and renderer) ──

export type BlueprintMachineState =
  | 'idle'
  | 'phase-running'
  | 'awaiting-clarify-input'
  | 'awaiting-clarify-questions'
  | 'awaiting-clarify-gate'
  | 'awaiting-approval'
  | 'cancelled'
  | 'failed'

// ── Snapshot ──

export interface BlueprintPipelineSnapshot {
  /** Monotonic sequence number — renderer drops anything ≤ last seen. */
  seq: number
  workspaceId: string
  blueprintId: string | null
  running: boolean
  machineState: BlueprintMachineState
  currentPhase: BlueprintPhaseType | null
  phaseStartedAt: number | null
  clarifyFindings: ClarifyFindingsBlock | null
  clarifyQuestions: ClarifyQuestionsBlock | null
  pendingApproval: {
    /**
     * The blueprint this gate belongs to, carried on the gate itself.
     *
     * Deliberately not read from `snapshot.blueprintId`: markPipelineStopped()
     * nulls the pipeline's identity in REVIEW's `finally`, so any snapshot
     * published afterwards would hand the renderer a gate with no blueprint.
     */
    blueprintId: string
    planSummary: string
    completion?: Record<string, unknown>
    reviewMarkdown?: string
    /**
     * The revised plan from the last revision turn. Kept separate from
     * `reviewMarkdown` so the gate can label it "Revised Plan" — rendering a
     * plan under "Full Review Report" tells the human it was reviewed when it
     * has not been.
     */
    revisedPlanMarkdown?: string
    preflight?: { result: Record<string, unknown>; overridden: boolean }
  } | null
  wave: { wave: number; taskCount: number; tasks: Record<string, BlueprintTaskStatus> } | null
  /** Currently executing tasks during Build phase (G3: replaces singular currentTask). */
  runningTasks: Record<string, { taskId: string; description: string }> | null
  lastError: string | null
}
