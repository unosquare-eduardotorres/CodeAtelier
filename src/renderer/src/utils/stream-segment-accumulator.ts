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
 * - Splits never fire inside a fenced code block (all three triggers: size,
 *   heading, and tool). A mid-fence split would render as two broken fences,
 *   so every trigger defers until the fence closes.
 */

import { SentenceBuffer } from './sentence-buffer'
import { shouldCommitForSize, fenceParityAfter } from '../../../shared/stream-segmentation'
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
  /** A2 FIX: fence parity across the current segment — a split must never land inside a fenced code block. */
  private inCodeFence = false

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
      // Defence in depth: an elapsed-only heartbeat update must never create a
      // row. Progress frames carry no startedAt/completedAt, so a row minted
      // here could only ever sit at 'running' forever if its id doesn't match a
      // real tool. tool_use / tool_result still create normally.
      const isProgressOnly =
        activity.elapsedSeconds !== undefined && !activity.startedAt && !activity.completedAt
      if (isProgressOnly) return
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
    this.inCodeFence = false
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
        // A2 FIX: over the size cap → finalize at the next paragraph boundary
        // (predicate shared + tested in src/shared/stream-segmentation.ts).
        const isOverSizeLimit = shouldCommitForSize(
          this.currentContent.length,
          sentences,
          this.inCodeFence
        )
        // F5 FIX: no split trigger may fire inside a fenced code block — a
        // `## ` inside a fenced markdown sample is content, not a section
        // break, and tools must stay attached to the in-fence text. Deferred
        // splits fire on the next eligible flush after the fence closes.
        const canSplit = !this.inCodeFence

        if (
          (canSplit && isOverSizeLimit) ||
          (canSplit && isNewSection && hasSubstantialContent) ||
          (canSplit && hasToolsBeforeNewText)
        ) {
          this.segments.push({
            content: this.currentContent,
            toolActivities: this.currentToolActivities,
            timestamp: this.currentSegmentStartedAt
          })
          this.currentContent = sentences
          this.currentToolActivities = []
          this.currentSegmentStartedAt = Date.now()
          this.inCodeFence = false
        } else {
          this.currentContent += sentences
        }

        // Track fence parity across everything appended to the current segment
        // (SentenceBuffer's force-flush paths can emit mid-fence text, so the
        // boundary heuristic alone is not fence-safe).
        this.inCodeFence = fenceParityAfter(this.inCodeFence, sentences)

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
