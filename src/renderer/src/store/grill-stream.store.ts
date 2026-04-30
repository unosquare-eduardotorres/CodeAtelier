/**
 * Grill stream store — accumulates streaming content from the dedicated
 * GrillAgentService without ever clearing on turn boundaries.
 *
 * This is the key architectural fix: unlike the chat store which clears
 * `streamingContent` on finalizeTurnBubble() and finalizeStream(), the
 * grill stream store only clears via explicit `reset()` (called when
 * the evaluation result is captured or a new evaluation starts).
 *
 * Modeled on AuditStreamingInternals but simplified for a single stream.
 */

import { create } from 'zustand'
import { SentenceBuffer } from '@renderer/utils/sentence-buffer'
import type { ToolActivity } from '../../../shared/types'

// ── Streaming internals (outside reactive store) ────────────────────────────

class GrillStreamingInternals {
  private buffer: SentenceBuffer | null = null
  private storeGet: (() => GrillStreamState) | null = null
  private storeSet: ((partial: Partial<GrillStreamState>) => void) | null = null

  bind(get: () => GrillStreamState, set: (partial: Partial<GrillStreamState>) => void): void {
    this.storeGet = get
    this.storeSet = set
  }

  getOrCreateBuffer(): SentenceBuffer {
    if (!this.buffer) {
      this.buffer = new SentenceBuffer((sentences: string) => {
        const current = this.storeGet?.()
        if (!current) return
        this.storeSet?.({ content: current.content + sentences })
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
  content: string // sentence-buffered markdown
  toolActivities: ToolActivity[] // running/completed tools
  isStreaming: boolean

  handleStreamChunk: (data: {
    type: string
    content?: string
    toolActivity?: Partial<ToolActivity>
  }) => void
  flush: () => void // flush remaining buffered content
  reset: () => void // clear everything for a new evaluation
}

export const useGrillStreamStore = create<GrillStreamState>((set, get) => {
  // Bind internals on store creation
  grillInternals.bind(get, (partial) => set(partial))

  return {
    content: '',
    toolActivities: [],
    isStreaming: false,

    handleStreamChunk: (data) => {
      if (data.type === 'text' && data.content) {
        set({ isStreaming: true })
        grillInternals.getOrCreateBuffer().append(data.content)
      } else if (data.type === 'tool_activity' && data.toolActivity) {
        set((s) => {
          const activity = data.toolActivity!
          const existingIdx = s.toolActivities.findIndex((a) => a.id === activity.id)
          let updatedActivities: ToolActivity[]

          if (existingIdx >= 0) {
            // Update existing (tool_result / tool_progress)
            updatedActivities = [...s.toolActivities]
            updatedActivities[existingIdx] = {
              ...updatedActivities[existingIdx],
              ...activity
            } as ToolActivity
          } else {
            // New tool_use
            updatedActivities = [...s.toolActivities, activity as ToolActivity]
          }

          return {
            toolActivities: updatedActivities,
            isStreaming: true
          }
        })
      }
    },

    flush: () => {
      grillInternals.flush()
    },

    reset: () => {
      grillInternals.reset()
      set({ content: '', toolActivities: [], isStreaming: false })
    }
  }
})
