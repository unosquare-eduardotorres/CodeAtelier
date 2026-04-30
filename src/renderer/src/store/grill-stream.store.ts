/**
 * Grill stream store — accumulates streaming content from the dedicated
 * GrillAgentService, splitting text into segments at tool-activity boundaries.
 *
 * Each segment contains the text that preceded a tool call and the tool
 * activities that followed. This prevents all narration from accumulating
 * into one giant bubble — each narration+tools block renders independently.
 *
 * Only clears via explicit `reset()` (called when the evaluation result is
 * captured or a new evaluation starts).
 */

import { create } from 'zustand'
import { SentenceBuffer } from '@renderer/utils/sentence-buffer'
import type { ToolActivity } from '../../../shared/types'

// ── Segment type ───────────────────────────────────────────────────────────

export interface GrillStreamSegment {
  content: string
  toolActivities: ToolActivity[]
}

// ── Streaming internals (outside reactive store) ──────────────────────────

class GrillStreamingInternals {
  private buffer: SentenceBuffer | null = null
  private storeGet: (() => GrillStreamState) | null = null
  private storeSet: ((partial: Partial<GrillStreamState>) => void) | null = null

  /** Matches markdown headings (## ...) or bold section labels (**Label:**) */
  private static HEADING_RE = /^(?:#{1,4}\s|\*\*[^*]+(?::\*\*|:\*\* )|\d+\.\s\*\*)/

  bind(get: () => GrillStreamState, set: (partial: Partial<GrillStreamState>) => void): void {
    this.storeGet = get
    this.storeSet = set
  }

  getOrCreateBuffer(): SentenceBuffer {
    if (!this.buffer) {
      this.buffer = new SentenceBuffer((sentences: string) => {
        const current = this.storeGet?.()
        if (!current) return

        // Detect section headings at the start of flushed text
        const isNewSection = GrillStreamingInternals.HEADING_RE.test(sentences.trimStart())
        const hasSubstantialContent = current.currentContent.trim().length > 200

        if (isNewSection && hasSubstantialContent) {
          // Auto-split: finalize current content as a segment, start fresh
          const finalized: GrillStreamSegment = {
            content: current.currentContent,
            toolActivities: current.currentToolActivities
          }
          this.storeSet?.({
            segments: [...current.segments, finalized],
            currentContent: sentences,
            currentToolActivities: []
          })
        } else {
          this.storeSet?.({ currentContent: current.currentContent + sentences })
        }
      })
    }
    return this.buffer
  }

  flush(): void {
    this.buffer?.flush()
  }

  reset(): void {
    this.buffer?.reset()
    this.buffer = null
  }
}

const grillInternals = new GrillStreamingInternals()

// ── Store interface ─────────────────────────────────────────────────────────

interface GrillStreamState {
  /** Finalized segments — each has text + associated tool activities */
  segments: GrillStreamSegment[]
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

export const useGrillStreamStore = create<GrillStreamState>((set, get) => {
  // Bind internals on store creation
  grillInternals.bind(get, (partial) => set(partial))

  return {
    segments: [],
    currentContent: '',
    currentToolActivities: [],
    isStreaming: false,

    handleStreamChunk: (data) => {
      if (data.type === 'text' && data.content) {
        set({ isStreaming: true })
        grillInternals.getOrCreateBuffer().append(data.content)
      } else if (data.type === 'tool_activity' && data.toolActivity) {
        // When a new tool_use arrives and there's pending text, finalize
        // the current segment so the text renders as its own bubble.
        const state = get()
        const activity = data.toolActivity!

        // Flush any buffered text before splitting
        grillInternals.flush()

        const freshState = get()
        const isNewTool = !freshState.currentToolActivities.some((a) => a.id === activity.id)

        if (isNewTool && freshState.currentContent.trim()) {
          // Finalize current segment (text only — tools will go into the new segment)
          const finalized: GrillStreamSegment = {
            content: freshState.currentContent,
            toolActivities: freshState.currentToolActivities
          }
          set({
            segments: [...freshState.segments, finalized],
            currentContent: '',
            currentToolActivities: [activity as ToolActivity],
            isStreaming: true
          })
        } else {
          // Update or add tool in current segment
          const existingIdx = state.currentToolActivities.findIndex((a) => a.id === activity.id)
          let updatedActivities: ToolActivity[]

          if (existingIdx >= 0) {
            updatedActivities = [...state.currentToolActivities]
            updatedActivities[existingIdx] = {
              ...updatedActivities[existingIdx],
              ...activity
            } as ToolActivity
          } else {
            updatedActivities = [...state.currentToolActivities, activity as ToolActivity]
          }

          set({
            currentToolActivities: updatedActivities,
            isStreaming: true
          })
        }
      }
    },

    flush: () => {
      grillInternals.flush()
    },

    reset: () => {
      grillInternals.reset()
      set({
        segments: [],
        currentContent: '',
        currentToolActivities: [],
        isStreaming: false
      })
    }
  }
})
