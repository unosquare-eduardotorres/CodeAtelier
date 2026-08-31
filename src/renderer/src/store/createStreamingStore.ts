/**
 * createStreamingStore — factory that builds a Zustand store wrapping a single
 * StreamSegmentAccumulator. This is the one accumulator-wrapper shared by every
 * streaming surface (Grill today; Chat/Council can adopt it incrementally).
 *
 * Each store instance owns its own accumulator (kept outside reactive state) and
 * exposes the reactive slice {segments, currentContent, currentToolActivities,
 * isStreaming} plus the handleStreamChunk / flush / reset actions.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand'
import {
  StreamSegmentAccumulator,
  type StreamSegment,
  type SegmentState
} from '@renderer/utils/stream-segment-accumulator'
import type { ToolActivity } from '../../../shared/types'

// ── Store interface ─────────────────────────────────────────────────────────

export interface StreamingStoreState {
  /** Finalized segments — each has text + associated tool activities */
  segments: StreamSegment[]
  /** Text accumulating for the current (not-yet-finalized) segment */
  currentContent: string
  /** Tool activities for the current segment */
  currentToolActivities: ToolActivity[]
  isStreaming: boolean
  /**
   * Flat snapshot taken by finalize() — the lane's full content/tools with the
   * accumulator internals released. Non-null only between finalize() and reset().
   */
  finalSnapshot: StreamingFinalSnapshot | null

  handleStreamChunk: (data: {
    type: string
    content?: string
    toolActivity?: Partial<ToolActivity>
  }) => void
  flush: () => void
  reset: () => void
  /**
   * Clear committed segments from store state without resetting the
   * accumulator's internal tracking (heading/tool-boundary detection intact).
   */
  clearCommittedSegments: () => void
  /**
   * Terminal: flush the accumulator, snapshot its flat content/tools, then
   * release the accumulator internals (segments array, current buffers).
   * Idempotent — a second call is a no-op. reset() clears the snapshot.
   *
   * F9: completed build lanes stay alive across waves (FIX-B), so without this
   * each lane's segment array (each segment up to SEGMENT_HARD_CAP_CHARS) plus
   * tool activities grow renderer memory for the whole multi-wave build.
   */
  finalize: () => void
  /**
   * Register/unregister a callback that fires when a new segment is finalized.
   * Pass `null` to unregister (e.g. on component unmount).
   */
  setOnSegmentCommit: (cb: ((segment: StreamSegment) => void) | null) => void
}

/** Flat end-state captured by finalize() — see StreamingStoreState.finalSnapshot. */
export interface StreamingFinalSnapshot {
  content: string
  toolActivities: ToolActivity[]
  /** When finalize() ran — stable timestamp for completed-message rendering. */
  finalizedAt: number
}

/** Minimal shape the flat-content helpers need (lets callers pass any superset). */
export interface StreamingSlice {
  segments: StreamSegment[]
  currentContent: string
  currentToolActivities: ToolActivity[]
}

/** Compute flat content from segments + current (for capture/finalization). */
export function getFlatContent(state: StreamingSlice): string {
  return state.segments.map((s) => s.content).join('') + state.currentContent
}

/** Compute flat tool activities from segments + current (for capture/finalization). */
export function getFlatToolActivities(state: StreamingSlice): ToolActivity[] {
  return [...state.segments.flatMap((s) => s.toolActivities), ...state.currentToolActivities]
}

// ── Factory ───────────────────────────────────────────────────────────────

/**
 * Build a streaming store backed by a dedicated StreamSegmentAccumulator.
 * Only clears via explicit `reset()` — callers decide when a stream ends.
 */
export function createStreamingStore(): UseBoundStore<StoreApi<StreamingStoreState>> {
  return create<StreamingStoreState>((set, get) => {
    // Mutable closure state for progressive segment commitment.
    let onSegmentCommit: ((segment: StreamSegment) => void) | null = null
    let committedCount = 0
    let lastKnownSegmentTotal = 0

    // Accumulator lives outside reactive state; syncs into the store on change.
    const accumulator = new StreamSegmentAccumulator((state: SegmentState) => {
      // Only expose un-committed segments to the store (committed ones are
      // already rendered as chat messages by the consumer).
      const uncommitted = state.segments.slice(committedCount)

      set({
        segments: uncommitted,
        currentContent: state.currentContent,
        currentToolActivities: state.currentToolActivities
      })

      // Fire callback for newly finalized segments.
      if (onSegmentCommit && state.segments.length > lastKnownSegmentTotal) {
        const newSegments = state.segments.slice(lastKnownSegmentTotal)
        lastKnownSegmentTotal = state.segments.length
        for (const seg of newSegments) {
          onSegmentCommit(seg)
        }
      } else {
        lastKnownSegmentTotal = state.segments.length
      }
    })

    return {
      segments: [],
      currentContent: '',
      currentToolActivities: [],
      isStreaming: false,
      finalSnapshot: null,

      handleStreamChunk: (data) => {
        if (data.type === 'text' && data.content) {
          set({ isStreaming: true })
          accumulator.appendText(data.content)
        } else if (data.type === 'tool_activity' && data.toolActivity) {
          const activity = data.toolActivity as ToolActivity & { id: string; toolName: string }
          accumulator.handleToolActivity(activity)
          set({ isStreaming: true })
        }
      },

      flush: () => {
        accumulator.flush()
      },

      reset: () => {
        accumulator.reset()
        committedCount = 0
        lastKnownSegmentTotal = 0
        set({
          segments: [],
          currentContent: '',
          currentToolActivities: [],
          isStreaming: false,
          finalSnapshot: null
        })
      },

      finalize: () => {
        // Idempotent: once a snapshot exists, later calls (duplicate terminal
        // events, late chunks) must not overwrite it with empty content.
        if (get().finalSnapshot) return
        accumulator.flush()
        const slice = get()
        const snapshot: StreamingFinalSnapshot = {
          content: getFlatContent(slice),
          toolActivities: getFlatToolActivities(slice),
          finalizedAt: Date.now()
        }
        // Release the accumulator internals — reset() does not emit, so no
        // intermediate store notification races the snapshot set below.
        accumulator.reset()
        committedCount = 0
        lastKnownSegmentTotal = 0
        set({
          segments: [],
          currentContent: '',
          currentToolActivities: [],
          isStreaming: false,
          finalSnapshot: snapshot
        })
      },

      clearCommittedSegments: () => {
        committedCount = lastKnownSegmentTotal
        set({ segments: [] })
      },

      setOnSegmentCommit: (cb) => {
        onSegmentCommit = cb
      }
    }
  })
}
