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
   * Register/unregister a callback that fires when a new segment is finalized.
   * Pass `null` to unregister (e.g. on component unmount).
   */
  setOnSegmentCommit: (cb: ((segment: StreamSegment) => void) | null) => void
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
  return create<StreamingStoreState>((set) => {
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
          isStreaming: false
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
