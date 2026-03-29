/**
 * Buffer-aware NDJSON parser for handling partial lines across data events.
 * Used by the generalist (which stays on CLI) and as CLI fallback for specialists.
 */
export class NDJSONParser {
  private buffer = ''

  /**
   * Feed raw data and return complete JSON objects parsed from complete lines.
   */
  feed(data: Buffer | string): Record<string, unknown>[] {
    this.buffer += data.toString()
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    const events: Record<string, unknown>[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        // Not JSON — skip (non-JSON lines are handled by callers)
      }
    }
    return events
  }

  /**
   * Flush any remaining buffer content (call on process exit).
   */
  flush(): Record<string, unknown>[] {
    const remaining = this.buffer.trim()
    this.buffer = ''
    if (!remaining) return []
    try {
      return [JSON.parse(remaining)]
    } catch {
      return []
    }
  }

  /** Check if there's buffered content */
  hasBuffered(): boolean {
    return this.buffer.trim().length > 0
  }

  /** Get raw buffer for non-JSON fallback */
  getRawBuffer(): string {
    const raw = this.buffer
    this.buffer = ''
    return raw
  }
}
