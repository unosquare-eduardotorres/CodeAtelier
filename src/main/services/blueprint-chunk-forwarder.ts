/**
 * Blueprint Chunk Forwarder — shared helper that replaces the 7 duplicated
 * inline chunk handlers across blueprint phase services.
 *
 * Delegates tool chunk processing to `processToolChunk()` from the
 * tool-chunk-processor module so blueprint sessions get the same rich
 * ToolActivity objects (input, result, resultDetail, filePath, lineRange,
 * operationType) that regular chat sessions enjoy — enabling expandable
 * tool details in the Blueprint chat UI.
 */

import type { StreamChunk } from './agent-base.service'
import type { BlueprintPhaseProgressPayload } from '../../shared/blueprint-types'
import type { BlueprintPhaseType } from '../../shared/blueprint-types'
import type { ConversationMode } from '../../shared/types'
import { processToolChunk } from '../ipc/tool-chunk-processor'

// ── Public types ──

export interface BlueprintChunkForwarderCtx {
  blueprintId: string
  workspaceId: string
  phase: BlueprintPhaseType
  workspacePath?: string
  /** Conversation mode — 'plan' for plan-mode phases suppresses false-positive
   *  bug reports for blocked Write/Edit calls. */
  mode?: ConversationMode
  /** Build-phase task ID — routes progress into the correct per-task lane. */
  taskId?: string
}

export type BlueprintEmitFn = (
  event: 'phaseProgress',
  payload: BlueprintPhaseProgressPayload
) => void

// ── Core forwarder ──

/**
 * Forward a StreamChunk from a blueprint phase session, producing a
 * `phaseProgress` emission.
 *
 * - `text` chunks → emit text progress (unchanged from the old inline handlers)
 * - `tool_use` / `tool_result` / `tool_progress` → run through `processToolChunk`
 *   to produce a full ToolActivity, then emit with `kind: 'tool'` and the
 *   `toolActivity` payload.  Falls back to tool-name-only when processing fails.
 * - All other chunk types are silently ignored.
 */
export function forwardBlueprintChunk(
  emit: BlueprintEmitFn,
  chunk: StreamChunk,
  ctx: BlueprintChunkForwarderCtx
): void {
  // ── Text chunks ──
  if (chunk.type === 'text' && chunk.content) {
    emit('phaseProgress', {
      blueprintId: ctx.blueprintId,
      workspaceId: ctx.workspaceId,
      phase: ctx.phase,
      text: chunk.content,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {})
    })
    return
  }

  // ── Tool chunks (tool_use / tool_result / tool_progress) ──
  if (chunk.type === 'tool_use' || chunk.type === 'tool_result' || chunk.type === 'tool_progress') {
    const processed = processToolChunk(chunk, {
      agentType: 'blueprint',
      workspacePath: ctx.workspacePath,
      workspaceId: ctx.workspaceId,
      mode: ctx.mode
    })

    if (processed) {
      const ta = processed.toolActivity
      emit('phaseProgress', {
        blueprintId: ctx.blueprintId,
        workspaceId: ctx.workspaceId,
        phase: ctx.phase,
        text: ta.toolName,
        kind: 'tool',
        toolActivity: {
          id: ta.id,
          toolName: ta.toolName,
          status: ta.status,
          input: ta.input,
          result: ta.result,
          resultDetail: ta.resultDetail,
          startedAt: ta.startedAt,
          completedAt: ta.completedAt,
          elapsedSeconds: ta.elapsedSeconds,
          filePath: ta.filePath,
          lineRange: ta.lineRange,
          operationType: ta.operationType,
          // Only when present — an explicit undefined at tool_result time would
          // clobber diffs captured at tool_use time in the accumulator merge.
          ...(ta.editDiffs
            ? { editDiffs: ta.editDiffs, editDiffsOmitted: ta.editDiffsOmitted }
            : {})
        },
        ...(ctx.taskId ? { taskId: ctx.taskId } : {})
      })
    }
    // If processToolChunk returns null (control tools), silently drop — same
    // behaviour as the regular chat pipeline.
  }
}
