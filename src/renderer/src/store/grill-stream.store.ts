/**
 * Grill stream store — accumulates streaming content from the dedicated
 * GrillAgentService, splitting text into segments at tool-activity boundaries.
 *
 * Each segment contains the text that preceded a tool call and the tool
 * activities that followed. This prevents all narration from accumulating
 * into one giant bubble — each narration+tools block renders independently.
 *
 * Uses the shared StreamSegmentAccumulator for segment logic.
 * Only clears via explicit `reset()` (called when the evaluation result is
 * captured or a new evaluation starts).
 */

import { create } from 'zustand'
import {
  StreamSegmentAccumulator,
  type StreamSegment,
  type SegmentState
} from '@renderer/utils/stream-segment-accumulator'
import type { ToolActivity } from '../../../shared/types'

// Re-export segment type for consumers
export type GrillStreamSegment = StreamSegment

// ── Streaming internals (outside reactive store) ──────────────────────────

let grillAccumulator: StreamSegmentAccumulator | null = null

// ── Store interface ─────────────────────────────────────────────────────────

interface GrillStreamState {
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
}

/** Compute flat content from segments + current (for capture/finalization) */
export function getFlatContent(state: GrillStreamState): string {
  return state.segments.map((s) => s.content).join('') + state.currentContent
}

/** Compute flat tool activities from segments + current (for capture/finalization) */
export function getFlatToolActivities(state: GrillStreamState): ToolActivity[] {
  return [...state.segments.flatMap((s) => s.toolActivities), ...state.currentToolActivities]
}

export const useGrillStreamStore = create<GrillStreamState>((set) => {
  // Create the accumulator that syncs state to Zustand
  grillAccumulator = new StreamSegmentAccumulator((state: SegmentState) => {
    set({
      segments: state.segments,
      currentContent: state.currentContent,
      currentToolActivities: state.currentToolActivities
    })
  })

  return {
    segments: [],
    currentContent: '',
    currentToolActivities: [],
    isStreaming: false,

    handleStreamChunk: (data) => {
      if (data.type === 'text' && data.content) {
        set({ isStreaming: true })
        grillAccumulator!.appendText(data.content)
      } else if (data.type === 'tool_activity' && data.toolActivity) {
        const activity = data.toolActivity as ToolActivity & { id: string; toolName: string }
        grillAccumulator!.handleToolActivity(activity)
        set({ isStreaming: true })
      }
    },

    flush: () => {
      grillAccumulator?.flush()
    },

    reset: () => {
      grillAccumulator?.reset()
      set({
        segments: [],
        currentContent: '',
        currentToolActivities: [],
        isStreaming: false
      })
    }
  }
})
