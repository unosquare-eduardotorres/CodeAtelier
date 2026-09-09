/**
 * Pure reducers behind design.store's IPC event handlers.
 *
 * Extracted from the store so they can be tested without a renderer — the same
 * split `update-store-utils` and `chat-action-utils` use.
 *
 * ── The rule these exist to pin ──────────────────────────────────────────────
 * `sendWorkspaceEvent` broadcasts to the renderer and merely *tags* the payload
 * with a workspaceId; it does not filter. Design runs are permitted to run
 * concurrently across workspaces (DESIGN_START guards per workspace, not
 * globally), so a design page bound to workspace A receives workspace B's
 * progress, results and completions too. Every reducer below therefore refuses
 * an event that is not for the bound workspace, rather than merging it.
 *
 * Workspace Health gets away without this only because AuditAgentService has a
 * single global running guard.
 */
import type {
  AuditRun,
  DesignIntermediateEvent,
  DesignProgressEvent,
  DesignResultEvent
} from '../../../shared/types'

/** The slice of design.store state the reducers read. */
export interface DesignReducerState {
  workspaceId: string | null
  currentRun: AuditRun | null
  liveStreamText: Record<string, string>
}

/** What a reducer writes back. `null` means "this event is not ours — ignore it". */
export type DesignPatch = Partial<Pick<DesignReducerState, 'currentRun' | 'liveStreamText'>>

/**
 * True when an event belongs to the workspace the store is bound to.
 *
 * An unbound store (`workspaceId === null`) accepts nothing: before `loadLatest`
 * has run there is no run to merge into and no way to tell whose event it is.
 */
export function isEventForWorkspace(
  state: Pick<DesignReducerState, 'workspaceId'>,
  eventWorkspaceId: string
): boolean {
  return state.workspaceId !== null && state.workspaceId === eventWorkspaceId
}

export function applyDesignProgress(
  state: DesignReducerState,
  data: DesignProgressEvent
): DesignPatch | null {
  if (!isEventForWorkspace(state, data.workspaceId)) return null

  const liveStreamText = { ...state.liveStreamText }
  if (data.streamChunk) {
    liveStreamText[data.trackId] = (liveStreamText[data.trackId] ?? '') + data.streamChunk
  }

  if (!state.currentRun) return { liveStreamText }

  return {
    liveStreamText,
    currentRun: {
      ...state.currentRun,
      results: state.currentRun.results.map((r) =>
        r.trackId === data.trackId ? { ...r, status: data.status } : r
      )
    }
  }
}

export function applyDesignResult(
  state: DesignReducerState,
  data: DesignResultEvent
): DesignPatch | null {
  if (!isEventForWorkspace(state, data.workspaceId)) return null
  if (!state.currentRun) return null

  // `data` is the persisted row plus the workspaceId tag. Strip the tag so the
  // stored result keeps the exact `AuditResult` shape.
  const { workspaceId: _tag, ...result } = data

  const liveStreamText = { ...state.liveStreamText }
  delete liveStreamText[data.trackId]

  return {
    liveStreamText,
    currentRun: {
      ...state.currentRun,
      results: state.currentRun.results.map((r) => (r.trackId === data.trackId ? result : r))
    }
  }
}

export function applyDesignIntermediate(
  state: DesignReducerState,
  data: DesignIntermediateEvent
): DesignPatch | null {
  if (!isEventForWorkspace(state, data.workspaceId)) return null
  if (!state.currentRun) return null

  return {
    currentRun: {
      ...state.currentRun,
      results: state.currentRun.results.map((r) => {
        if (r.trackId !== data.trackId) return r
        return {
          ...r,
          findings: data.findings,
          coverageStats: data.coverageStats,
          summary: `Round ${data.roundNumber}/${data.totalRounds}: ${data.findings.length} finding(s), ${data.coverageStats.fileCount} files inspected`,
          roundProgress: {
            roundNumber: data.roundNumber,
            totalRounds: data.totalRounds,
            totalFiles: data.totalFiles,
            batchSize: data.batchSize
          }
        }
      })
    }
  }
}
