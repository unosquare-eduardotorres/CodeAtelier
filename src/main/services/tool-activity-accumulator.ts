/**
 * S8: Tool Activity Accumulator — tracks what the local LLM discovers during a session.
 *
 * Runs at the AgentSessionService level (not inside the SDK executor) where we
 * have access to full chunk data. Records tool calls with their targets and
 * output sizes so other strategies can build structured summaries (S6),
 * plan state (S3), auto-continue context (S4), and compaction decisions (S7).
 *
 * The existing ToolTracker (sdk-executor/tool-tracker.ts) only maps IDs→names.
 * This accumulator provides richer tracking at the application level.
 */

export interface ToolActivityEntry {
  toolName: string
  filePath?: string
  /** Approximate output length in characters */
  outputLen: number
  timestamp: number
}

/**
 * Accumulates tool activity for a single message exchange.
 * Reset between messages via `reset()`.
 */
export class ToolActivityAccumulator {
  private entries: ToolActivityEntry[] = []

  /**
   * Record a tool use event with its output metadata.
   * Called from processContentChunk() for tool_use and tool_result events.
   */
  record(entry: { toolName: string; input?: unknown; outputLength: number }): void {
    const filePath = this.extractFilePath(entry.toolName, entry.input)
    this.entries.push({
      toolName: entry.toolName,
      filePath,
      outputLen: entry.outputLength,
      timestamp: Date.now()
    })
  }

  /**
   * Get deduplicated list of file paths explored during this session.
   * Useful for S6 (summary) and S4 (auto-continue context).
   */
  getExploredFiles(): string[] {
    const paths = new Set<string>()
    for (const entry of this.entries) {
      if (entry.filePath) paths.add(entry.filePath)
    }
    return [...paths]
  }

  /**
   * Build a condensed discovery summary for context injection.
   * Used by S4 (auto-continue) and S6 (conversation summary).
   *
   * @param maxChars Maximum output size in characters
   */
  buildDiscoverySummary(maxChars: number): string {
    if (this.entries.length === 0) return ''

    const parts: string[] = []
    let charCount = 0

    // Tool call count
    const toolLine = `Tool calls: ${this.entries.length}`
    parts.push(toolLine)
    charCount += toolLine.length

    // Files explored (deduplicated)
    const files = this.getExploredFiles()
    if (files.length > 0) {
      const filesLine = `Files explored: ${files.join(', ')}`
      if (charCount + filesLine.length + 1 <= maxChars) {
        parts.push(filesLine)
        charCount += filesLine.length + 1
      } else {
        // Truncate file list
        const truncated = `Files explored: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}`
        parts.push(truncated)
        charCount += truncated.length + 1
      }
    }

    // Tool breakdown (most-used tools)
    const toolCounts = new Map<string, number>()
    for (const entry of this.entries) {
      toolCounts.set(entry.toolName, (toolCounts.get(entry.toolName) ?? 0) + 1)
    }
    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}(${count})`)
      .join(', ')
    if (topTools) {
      const toolsLine = `Tools used: ${topTools}`
      if (charCount + toolsLine.length + 1 <= maxChars) {
        parts.push(toolsLine)
      }
    }

    return parts.join('\n')
  }

  /**
   * Estimate total tokens consumed by tool results so far.
   * Uses chars / 3.5 approximation.
   */
  getEstimatedTokensConsumed(): number {
    let totalChars = 0
    for (const entry of this.entries) {
      totalChars += entry.outputLen
    }
    return Math.ceil(totalChars / 3.5)
  }

  /** Get the raw entry count */
  get count(): number {
    return this.entries.length
  }

  /** Get all entries (for plan state persistence) */
  getEntries(): readonly ToolActivityEntry[] {
    return this.entries
  }

  /** Reset state for a new message exchange */
  reset(): void {
    this.entries = []
  }

  /**
   * Extract a file path from tool input, if present.
   * Handles both raw object inputs (from SDK) and summarized string inputs
   * produced by `summarizeToolInput()` in agent-base.service.ts.
   */
  private extractFilePath(toolName: string, input: unknown): string | undefined {
    // F1: Handle string input from summarizeToolInput().
    // Read/Write/Edit summaries are just the file path (e.g. "src/main/foo.ts").
    // Grep summaries look like "/pattern/ in src/..." — extract path after " in ".
    if (typeof input === 'string') {
      if (input.includes('/') && !input.includes(' ')) return input
      const inMatch = input.match(/ in (.+)$/)
      if (inMatch) return inMatch[1]
      return undefined
    }

    if (!input || typeof input !== 'object') return undefined
    const inp = input as Record<string, unknown>

    // Direct file_path parameter (Read, Edit, Write, FileOutline, etc.)
    if (typeof inp.file_path === 'string') return inp.file_path
    if (typeof inp.filePath === 'string') return inp.filePath

    // Glob pattern can hint at directory
    if (toolName === 'Glob' && typeof inp.path === 'string') return inp.path

    // Grep path parameter
    if (toolName === 'Grep' && typeof inp.path === 'string') return inp.path

    return undefined
  }
}
