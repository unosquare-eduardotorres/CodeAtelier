/**
 * StreamSegmentAccumulator — shared utility for splitting streaming content
 * into segments at tool-activity boundaries and heading-based section breaks.
 *
 * Used by both grill-stream.store and audit.store to produce multi-bubble
 * rendering from a continuous stream.
 *
 * Split semantics:
 * - Tools accumulate WITH the text that preceded them (same segment).
 * - A new segment starts when NEW TEXT arrives after tools — the previous
 *   text + tools are finalized together, and the new text starts a fresh segment.
 * - Heading-based splits still fire when a heading arrives after 200+ chars.
 */

import { SentenceBuffer } from './sentence-buffer'
import type { ToolActivity } from '../../../shared/types'

// ── Public types ──────────────────────────────────────────────────────────

export interface StreamSegment {
  content: string
  toolActivities: ToolActivity[]
  timestamp: number
}

export interface SegmentState {
  segments: StreamSegment[]
  currentContent: string
  currentToolActivities: ToolActivity[]
}

// ── Accumulator ───────────────────────────────────────────────────────────

/** Matches markdown headings (## ...) or bold section labels (**Label:**) */
const HEADING_RE = /^(?:#{1,4}\s|\*\*[^*]+(?::\*\*|:\*\* )|\d+\.\s\*\*)/

export class StreamSegmentAccumulator {
  private buffer: SentenceBuffer | null = null
  private segments: StreamSegment[] = []
  private currentContent = ''
  private currentToolActivities: ToolActivity[] = []
  private currentSegmentStartedAt: number = Date.now()
  /** Reentrance guard — prevents nested emitChange when onChange triggers resetAccumulator */
  private isFlushing = false

  constructor(private onChange: (state: SegmentState) => void) {}

  /** Append text from a stream chunk */
  appendText(text: string): void {
    this.getOrCreateBuffer().append(text)
  }

  /** Handle a tool activity — accumulates tools with current text segment */
  handleToolActivity(activity: Partial<ToolActivity> & { id: string; toolName: string }): void {
    // Flush any buffered text before processing the tool
    this.flushBuffer()

    // Add or update tool in current segment — no split here.
    // Splitting happens when new text arrives after tools (in the SentenceBuffer callback).
    const existingIdx = this.currentToolActivities.findIndex((a) => a.id === activity.id)
    if (existingIdx >= 0) {
      this.currentToolActivities = [...this.currentToolActivities]
      this.currentToolActivities[existingIdx] = {
        ...this.currentToolActivities[existingIdx],
        ...activity
      } as ToolActivity
    } else {
      this.currentToolActivities = [...this.currentToolActivities, activity as ToolActivity]
    }

    this.emitChange()
  }

  /** Force flush buffered text */
  flush(): void {
    this.flushBuffer()
  }

  /** Reset all state */
  reset(): void {
    this.buffer?.reset()
    this.buffer = null
    this.segments = []
    this.currentContent = ''
    this.currentToolActivities = []
    this.currentSegmentStartedAt = Date.now()
  }

  /** Get current accumulated state */
  getState(): SegmentState {
    return {
      segments: this.segments,
      currentContent: this.currentContent,
      currentToolActivities: this.currentToolActivities
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private getOrCreateBuffer(): SentenceBuffer {
    if (!this.buffer) {
      this.buffer = new SentenceBuffer((sentences: string) => {
        const isNewSection = HEADING_RE.test(sentences.trimStart())
        const hasSubstantialContent = this.currentContent.trim().length > 200
        // New text arriving after tools → finalize current segment (even if content is empty)
        const hasToolsBeforeNewText = this.currentToolActivities.length > 0

        if ((isNewSection && hasSubstantialContent) || hasToolsBeforeNewText) {
          this.segments.push({
            content: this.currentContent,
            toolActivities: this.currentToolActivities,
            timestamp: this.currentSegmentStartedAt
          })
          this.currentContent = sentences
          this.currentToolActivities = []
          this.currentSegmentStartedAt = Date.now()
        } else {
          this.currentContent += sentences
        }

        this.emitChange()
      })
    }
    return this.buffer
  }

  private flushBuffer(): void {
    this.buffer?.flush()
  }

  private emitChange(): void {
    if (this.isFlushing) return
    try {
      this.isFlushing = true
      this.onChange(this.getState())
    } finally {
      this.isFlushing = false
    }
  }
}
