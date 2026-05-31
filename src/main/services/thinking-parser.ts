/**
 * Thinking Block Parser — extracts <think>...</think> blocks from local LLM output.
 *
 * Qwen3, Qwen3-Coder, and DeepSeek-Coder-V3 emit reasoning inside <think>...</think>
 * XML-style tags. This parser extracts those blocks so they can be:
 *   1. Emitted as 'thinking' StreamChunks for the UI reasoning display
 *   2. Separated from the actual response content
 *
 * Handles:
 *   - Complete blocks: <think>reasoning here</think>
 *   - Streaming partial blocks (buffered until close tag)
 *   - Multiple think blocks in a single response
 *   - Nested content that isn't actual think tags
 *
 * Phase 4A — Local-First: Parse thinking blocks for local LLM reasoning display.
 */

/** Result of parsing a text chunk for thinking blocks */
export interface ThinkingParseResult {
  /** Extracted thinking content (empty string if none) */
  thinking: string
  /** Remaining response content with thinking blocks removed */
  response: string
}

/**
 * Extract all complete <think>...</think> blocks from text.
 *
 * Returns the thinking content (concatenated if multiple blocks)
 * and the remaining response with think blocks removed.
 */
export function extractThinkingBlocks(text: string): ThinkingParseResult {
  if (!text.includes('<think>')) {
    return { thinking: '', response: text }
  }

  const thinkingParts: string[] = []
  let response = text

  // Match all <think>...</think> blocks (non-greedy, dotAll for multiline)
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g
  let match: RegExpExecArray | null

  while ((match = thinkRegex.exec(text)) !== null) {
    thinkingParts.push(match[1].trim())
    response = response.replace(match[0], '')
  }

  return {
    thinking: thinkingParts.join('\n\n'),
    response: response.trim()
  }
}

/**
 * Streaming thinking block parser — accumulates partial blocks across chunks.
 *
 * Usage:
 *   const parser = new StreamingThinkingParser()
 *   for (const chunk of stream) {
 *     const { thinking, response, isInsideThinkBlock } = parser.push(chunk)
 *     if (thinking) yield { type: 'thinking', content: thinking }
 *     if (response) yield { type: 'text', content: response }
 *   }
 *   // Flush any remaining content
 *   const remaining = parser.flush()
 */
export class StreamingThinkingParser {
  private buffer = ''
  private insideThinkBlock = false
  private thinkBuffer = ''

  /**
   * Push a new text chunk through the parser.
   *
   * Returns any complete thinking blocks and response text that can be emitted.
   * Partial think blocks are buffered internally.
   */
  push(chunk: string): {
    thinking: string
    response: string
    isInsideThinkBlock: boolean
  } {
    this.buffer += chunk
    let thinking = ''
    let response = ''

    while (this.buffer.length > 0) {
      if (this.insideThinkBlock) {
        // Look for the closing </think> tag
        const closeIdx = this.buffer.indexOf('</think>')
        if (closeIdx !== -1) {
          // Complete the think block
          this.thinkBuffer += this.buffer.slice(0, closeIdx)
          thinking += (thinking ? '\n\n' : '') + this.thinkBuffer.trim()
          this.thinkBuffer = ''
          this.insideThinkBlock = false
          this.buffer = this.buffer.slice(closeIdx + '</think>'.length)
        } else {
          // Still inside think block — buffer everything
          // But check for a partial </think> tag at the end
          const partialClose = findPartialTag(this.buffer, '</think>')
          if (partialClose !== -1) {
            // Buffer up to the partial tag
            this.thinkBuffer += this.buffer.slice(0, partialClose)
            this.buffer = this.buffer.slice(partialClose)
          } else {
            this.thinkBuffer += this.buffer
            this.buffer = ''
          }
          break
        }
      } else {
        // Look for the opening <think> tag
        const openIdx = this.buffer.indexOf('<think>')
        if (openIdx !== -1) {
          // Emit any response text before the think tag
          const before = this.buffer.slice(0, openIdx)
          if (before) response += before
          this.insideThinkBlock = true
          this.buffer = this.buffer.slice(openIdx + '<think>'.length)
        } else {
          // Check for partial <think> tag at the end
          const partialOpen = findPartialTag(this.buffer, '<think>')
          if (partialOpen !== -1) {
            // Emit text before the potential tag start
            response += this.buffer.slice(0, partialOpen)
            this.buffer = this.buffer.slice(partialOpen)
            break
          } else {
            // No think tags — all response text
            response += this.buffer
            this.buffer = ''
          }
        }
      }
    }

    return {
      thinking,
      response,
      isInsideThinkBlock: this.insideThinkBlock
    }
  }

  /**
   * Flush any remaining buffered content.
   * Call this when the stream ends to recover partial think blocks.
   */
  flush(): { thinking: string; response: string } {
    let thinking = ''
    let response = ''

    if (this.insideThinkBlock && this.thinkBuffer) {
      // Unclosed think block — emit as thinking (model probably got cut off)
      thinking = this.thinkBuffer.trim()
      this.thinkBuffer = ''
    }

    if (this.buffer) {
      response = this.buffer
      this.buffer = ''
    }

    this.insideThinkBlock = false
    return { thinking, response }
  }

  /** Reset parser state for a new turn */
  reset(): void {
    this.buffer = ''
    this.insideThinkBlock = false
    this.thinkBuffer = ''
  }
}

/**
 * Find the start index of a partial tag match at the end of text.
 * Returns -1 if no partial match found.
 *
 * Example: findPartialTag('hello <thi', '<think>') → 6
 *          findPartialTag('hello world', '<think>') → -1
 */
function findPartialTag(text: string, tag: string): number {
  // Check if the end of text could be the start of the tag
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
    const endOfText = text.slice(-len)
    const startOfTag = tag.slice(0, len)
    if (endOfText === startOfTag) {
      return text.length - len
    }
  }
  return -1
}
