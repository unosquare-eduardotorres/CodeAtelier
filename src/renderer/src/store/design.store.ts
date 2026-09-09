import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import {
  StreamSegmentAccumulator,
  type SegmentState
} from '@renderer/utils/stream-segment-accumulator'
import type {
  AuditFinding,
  AuditRun,
  AuditTrackId,
  DesignCommandId,
  DesignCompleteEvent,
  DesignIntermediateEvent,
  DesignProgressEvent,
  DesignResultEvent,
  DesignScope,
  DesignStreamChunkEvent,
  LLMProvider
} from '../../../shared/types'
import {
  applyDesignIntermediate,
  applyDesignProgress,
  applyDesignResult,
  isEventForWorkspace
} from './design-store-utils'

// ── Per-track streaming internals ───────────────────────────────────────────

/**
 * Manages StreamSegmentAccumulator instances per design command — keeps timers
 * and mutable state outside the reactive Zustand store.
 *
 * Deliberately a copy of `AuditStreamingInternals` rather than a shared base:
 * extracting one would mean editing a working feature for no functional gain.
 * The accumulator itself is already shared.
 */
class DesignStreamingInternals {
  private accumulators = new Map<string, StreamSegmentAccumulator>()
  private storeGet: (() => DesignState) | null = null
  private storeSet: ((partial: Partial<DesignState>) => void) | null = null

  bind(get: () => DesignState, set: (partial: Partial<DesignState>) => void): void {
    this.storeGet = get
    this.storeSet = set
  }

  getOrCreateAccumulator(trackId: string): StreamSegmentAccumulator {
    if (!this.accumulators.has(trackId)) {
      this.accumulators.set(
        trackId,
        new StreamSegmentAccumulator((state: SegmentState) => {
          const current = this.storeGet?.()
          if (!current) return
          this.storeSet?.({
            perTrackStreaming: {
              ...current.perTrackStreaming,
              [trackId]: state
            }
          })
        })
      )
    }
    return this.accumulators.get(trackId)!
  }

  flushTrack(trackId: string): void {
    this.accumulators.get(trackId)?.flush()
  }

  resetAll(): void {
    this.accumulators.forEach((a) => a.reset())
    this.accumulators.clear()
  }
}

const designInternals = new DesignStreamingInternals()

// ── Store interface ──────────────────────────────────────────────────────────

export interface DesignStartArgs {
  workspaceId: string
  commandIds: DesignCommandId[]
  scope: DesignScope
  brief: string
  llmProvider?: LLMProvider
}

interface DesignState {
  currentRun: AuditRun | null
  isRunning: boolean
  /**
   * The workspace this store is bound to.
   *
   * Design runs are per-workspace concurrent by design (P3.7.3), and
   * `sendWorkspaceEvent` broadcasts to the renderer without filtering — it only
   * tags the payload. Every handler below therefore drops events belonging to
   * another workspace, or a background run would overwrite this one's state.
   */
  workspaceId: string | null
  /** Last refusal reason from the `DesignIpcResult` envelope, for the UI to show. */
  lastError: string | null
  liveStreamText: Record<string, string>
  selectedFindings: AuditFinding[]
  perTrackStreaming: Record<string, SegmentState>

  // Actions
  loadLatest: (workspaceId: string) => Promise<void>
  openRun: (workspaceId: string, run: AuditRun) => void
  /** Resolves to a refusal reason, or null on success. Never throws. */
  startDesign: (args: DesignStartArgs) => Promise<string | null>
  cancelDesign: () => Promise<void>
  toggleFinding: (finding: AuditFinding) => void
  selectAllInTrack: (trackId: AuditTrackId) => void
  clearSelectedFindings: () => void
  clearError: () => void
  handleProgress: (data: DesignProgressEvent) => void
  handleResult: (data: DesignResultEvent) => void
  handleComplete: (data: DesignCompleteEvent) => void
  handleStreamChunk: (data: DesignStreamChunkEvent) => void
  handleIntermediate: (data: DesignIntermediateEvent) => void
  reset: () => void
}

const TERMINAL_STATUSES = ['completed', 'partial', 'cancelled', 'failed']

export const useDesignStore = create<DesignState>((set, get) => {
  designInternals.bind(get, (partial) => set(partial))

  /** True when an event belongs to the workspace this store is showing. */
  const isForActiveWorkspace = (eventWorkspaceId: string): boolean =>
    isEventForWorkspace(get(), eventWorkspaceId)

  return {
    currentRun: null,
    isRunning: false,
    workspaceId: null,
    lastError: null,
    liveStreamText: {},
    selectedFindings: [],
    perTrackStreaming: {},

    openRun: (workspaceId, run) => {
      designInternals.resetAll()
      set({
        workspaceId,
        currentRun: run,
        isRunning: false,
        lastError: null,
        liveStreamText: {},
        perTrackStreaming: {},
        selectedFindings: []
      })
    },

    loadLatest: async (workspaceId) => {
      try {
        const res = await window.api.designGetLatest({ workspaceId })
        if (!res.ok) {
          set({ workspaceId, lastError: res.reason })
          return
        }
        const run = res.data
        // Sync isRunning with the persisted state, so a restart mid-run does not
        // leave the page showing an idle design review that is still going.
        const isTerminal = !run || TERMINAL_STATUSES.includes(run.status)
        set({ workspaceId, currentRun: run, isRunning: !isTerminal, lastError: null })
      } catch (error) {
        rendererLog.error('Failed to load latest design run:', error)
      }
    },

    startDesign: async ({ workspaceId, commandIds, scope, brief, llmProvider }) => {
      designInternals.resetAll()
      set({
        workspaceId,
        isRunning: true,
        lastError: null,
        liveStreamText: {},
        perTrackStreaming: {},
        selectedFindings: []
      })
      try {
        const res = await window.api.designStart({
          workspaceId,
          commandIds,
          scope,
          brief,
          llmProvider
        })
        if (!res.ok) {
          // A refusal is an expected outcome the UI renders as a message —
          // "a design run is already in progress for this workspace" is not an
          // exception, and throwing it would discard the reason.
          set({ isRunning: false, lastError: res.reason })
          return res.reason
        }
        set({ currentRun: res.data })
        return null
      } catch (error) {
        rendererLog.error('Failed to start design run:', error)
        const reason = error instanceof Error ? error.message : String(error)
        set({ isRunning: false, lastError: reason })
        return reason
      }
    },

    cancelDesign: async () => {
      const workspaceId = get().workspaceId
      if (!workspaceId) return
      try {
        await window.api.designCancel({ workspaceId })
      } catch (error) {
        rendererLog.error('Failed to cancel design run:', error)
      }
    },

    toggleFinding: (finding) => {
      set((s) => {
        const exists = s.selectedFindings.some((f) => f.id === finding.id)
        return {
          selectedFindings: exists
            ? s.selectedFindings.filter((f) => f.id !== finding.id)
            : [...s.selectedFindings, finding]
        }
      })
    },

    selectAllInTrack: (trackId) => {
      set((s) => {
        const result = s.currentRun?.results.find((r) => r.trackId === trackId)
        if (!result) return s
        const byId = new Map(s.selectedFindings.map((f) => [f.id, f]))
        for (const f of result.findings) {
          if (f.severity !== 'info') byId.set(f.id, f)
        }
        return { selectedFindings: [...byId.values()] }
      })
    },

    clearSelectedFindings: () => set({ selectedFindings: [] }),

    clearError: () => set({ lastError: null }),

    handleProgress: (data) => {
      const patch = applyDesignProgress(get(), data)
      if (patch) set(patch)
    },

    handleResult: (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      designInternals.flushTrack(data.trackId)
      const patch = applyDesignResult(get(), data)
      if (patch) set(patch)
    },

    handleComplete: (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      designInternals.resetAll()
      set({
        currentRun: data,
        isRunning: false,
        liveStreamText: {},
        perTrackStreaming: {}
      })
    },

    handleStreamChunk: (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      const { chunk } = data

      if (chunk.type === 'text' && chunk.content) {
        designInternals.getOrCreateAccumulator(data.trackId).appendText(chunk.content)
        return
      }

      // `design.ipc.ts` forwards the agent's raw chunks rather than the
      // pre-flattened `{ type: 'tool_activity' }` frames the audit path builds,
      // so the tool shape is assembled here instead.
      if (chunk.type !== 'tool_use' && chunk.type !== 'tool_result') return
      if (!chunk.toolId || !chunk.toolName) return

      designInternals.getOrCreateAccumulator(data.trackId).handleToolActivity({
        id: chunk.toolId,
        toolName: chunk.toolName,
        ...(chunk.toolInput !== undefined ? { input: chunk.toolInput } : {}),
        ...(chunk.type === 'tool_use'
          ? { status: 'running' as const, startedAt: Date.now() }
          : {
              status: chunk.isError ? ('error' as const) : ('completed' as const),
              completedAt: Date.now()
            })
      })
    },

    handleIntermediate: (data) => {
      const patch = applyDesignIntermediate(get(), data)
      if (patch) set(patch)
    },

    reset: () => {
      designInternals.resetAll()
      set({
        currentRun: null,
        isRunning: false,
        workspaceId: null,
        lastError: null,
        liveStreamText: {},
        perTrackStreaming: {},
        selectedFindings: []
      })
    }
  }
})
