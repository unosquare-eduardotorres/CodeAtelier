/**
 * Sentence buffer — accumulates streaming tokens and flushes complete sentences.
 *
 * Detects sentence boundaries: . ! ? followed by space/newline, or double newline (paragraph).
 * Respects markdown: won't split inside code blocks, inline code, or URLs.
 */

export class SentenceBuffer {
  private buffer = ''
  private flushedLength = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private onFlush: (sentences: string) => void
  private inCodeBlock = false

  /** Max ms to wait before force-flushing partial content (handles trailing text) */
  private static FLUSH_TIMEOUT = 250

  /**
   * Force-flush threshold (chars). When unflushed buffered content exceeds
   * this size, we flush even without a sentence boundary. Prevents long code
   * blocks from stalling the visible stream behind the timeout.
   */
  private static FLUSH_CHAR_LIMIT = 200

  constructor(onFlush: (completeSentences: string) => void) {
    this.onFlush = onFlush
  }

  append(chunk: string): void {
    this.buffer += chunk
    this.tryFlush()
    this.resetTimer()
  }

  private tryFlush(): void {
    const unflushed = this.buffer.slice(this.flushedLength)
    const boundary = this.findSentenceBoundary(unflushed)
    if (boundary > 0) {
      const toFlush = unflushed.slice(0, boundary)
      this.flushedLength += boundary
      this.onFlush(toFlush)
      return
    }
    // Char-based force-flush — covers long code-only responses that never
    // hit a sentence boundary or paragraph break before the timeout.
    if (unflushed.length > SentenceBuffer.FLUSH_CHAR_LIMIT) {
      this.flushedLength = this.buffer.length
      this.onFlush(unflushed)
    }
  }

  /** Force flush any remaining buffered content (called on stream complete) */
  flush(): void {
    this.clearTimer()
    const remaining = this.buffer.slice(this.flushedLength)
    if (remaining) {
      this.flushedLength = this.buffer.length
      this.onFlush(remaining)
    }
  }

  reset(): void {
    this.buffer = ''
    this.flushedLength = 0
    this.inCodeBlock = false
    this.clearTimer()
  }

  private resetTimer(): void {
    this.clearTimer()
    this.flushTimer = setTimeout(() => {
      // Force-flush partial content after timeout (e.g., agent pauses mid-sentence)
      const remaining = this.buffer.slice(this.flushedLength)
      if (remaining) {
        this.flushedLength = this.buffer.length
        this.onFlush(remaining)
      }
    }, SentenceBuffer.FLUSH_TIMEOUT)
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  private findSentenceBoundary(text: string): number {
    // Track code block state
    const lines = text.split('\n')
    let lastBoundary = 0
    let pos = 0

    for (const line of lines) {
      // Toggle code block state on ``` lines
      if (line.trimStart().startsWith('```')) {
        this.inCodeBlock = !this.inCodeBlock
      }

      pos += line.length + 1 // +1 for \n

      // Double newline = paragraph boundary (always flush)
      if (line === '' && pos > 1 && !this.inCodeBlock) {
        lastBoundary = pos
        continue
      }

      // Inside code blocks, only flush on blank lines
      if (this.inCodeBlock) continue

      // Sentence-ending punctuation followed by space or end-of-chunk
      // Look for `. `, `? `, `! `, `.\n`, `?\n`, `!\n`
      const sentenceEnd = /[.!?](?:\s|$)/g
      let match: RegExpExecArray | null
      while ((match = sentenceEnd.exec(line)) !== null) {
        // Skip common abbreviations and decimals
        const charBefore = line[match.index - 1]
        if (charBefore && /\d/.test(charBefore) && line[match.index] === '.') continue
        // Skip URLs
        if (line.slice(Math.max(0, match.index - 10), match.index).includes('://')) continue

        lastBoundary = pos - line.length - 1 + match.index + match[0].length
      }
    }

    return lastBoundary
  }
}
