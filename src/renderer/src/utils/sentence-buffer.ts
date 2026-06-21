/**
 * Sentence buffer — accumulates streaming tokens and flushes complete sentences.
 *
 * Detects sentence boundaries: . ! ? followed by space/newline, or double newline (paragraph).
 * Respects markdown: won't split inside code blocks, inline code, or URLs.
 */

/** Common TLDs to detect bare domain names (e.g. example.com) and avoid false sentence splits. */
const COMMON_TLDS = /\.(com|org|net|io|dev|ai|app|co|edu|gov)\b/i

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
    // Use local copy to avoid corrupting state when no boundary is found
    // (the same unflushed text is re-scanned on the next append() call)
    let localInCodeBlock = this.inCodeBlock
    let stateAtBoundary = this.inCodeBlock
    const lines = text.split('\n')
    let lastBoundary = 0
    let pos = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Toggle code block state on ``` lines
      if (line.trimStart().startsWith('```')) {
        localInCodeBlock = !localInCodeBlock
      }

      const lineStart = pos
      pos += line.length
      // Only add \n separator if this isn't the last line
      if (i < lines.length - 1) pos += 1

      // Double newline = paragraph boundary (always flush)
      if (line === '' && lineStart > 0 && !localInCodeBlock) {
        lastBoundary = pos
        stateAtBoundary = localInCodeBlock
        continue
      }

      // Inside code blocks, only flush on blank lines
      if (localInCodeBlock) continue

      // Sentence-ending punctuation followed by space or end-of-chunk
      // Look for `. `, `? `, `! `, `.\n`, `?\n`, `!\n`
      const sentenceEnd = /[.!?](?:\s|$)/g
      let match: RegExpExecArray | null
      while ((match = sentenceEnd.exec(line)) !== null) {
        // Skip common abbreviations and decimals
        const charBefore = line[match.index - 1]
        if (charBefore && /\d/.test(charBefore) && line[match.index] === '.') continue
        // Skip URLs (protocol-prefixed)
        if (line.slice(Math.max(0, match.index - 10), match.index).includes('://')) continue
        // Skip bare domains (e.g. example.com, docs.dev)
        if (
          line[match.index] === '.' &&
          COMMON_TLDS.test(line.slice(match.index, match.index + 6))
        ) continue

        lastBoundary = lineStart + match.index + match[0].length
        stateAtBoundary = localInCodeBlock
      }
    }

    // Only commit state change when text is actually being flushed
    if (lastBoundary > 0) {
      this.inCodeBlock = stateAtBoundary
    }
    // If no boundary found → don't update state; the same text will be re-scanned

    return lastBoundary
  }
}
