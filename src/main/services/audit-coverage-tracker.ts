/**
 * AuditCoverageTracker — tracks file-level coverage during an audit session.
 *
 * Listens to StreamChunk events during audit execution and extracts file
 * paths from tool_use / tool_result chunks (Read, Glob, Grep, file_outline,
 * find_references, etc.) to determine which files were actually inspected.
 *
 * The resulting stats feed the coverage gate that prevents hallucinated
 * scores when insufficient evidence was gathered.
 */

import type { StreamChunk } from './agent-base.service'
import { MCP_TOOLS } from '../../shared/constants'

export interface AuditCoverageStats {
  filesInspected: string[]
  fileCount: number
  toolCallCount: number
  readToolCount: number
}

/** Tools whose invocation implies a file was inspected. */
const READ_TOOLS = new Set([
  // Built-in SDK tools
  'Read',
  // Legacy short-name tools (pre-MCP prefix)
  'file_outline',
  'find_callers',
  'find_callees',
  'find_references',
  'find_definition',
  'find_all_callers',
  'find_all_callees',
  'class_hierarchy',
  'module_dependencies',
  // MCP tools — derived from canonical registry
  ...MCP_TOOLS.CODE_GRAPH._ALL_NAMES,
  ...MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES,
  ...MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES
])

export class AuditCoverageTracker {
  private inspectedFiles = new Set<string>()
  private toolCallCount = 0
  private readToolCount = 0

  /** Call on every StreamChunk during audit execution. */
  onChunk(chunk: StreamChunk): void {
    if (chunk.type === 'tool_use') {
      this.toolCallCount++
      this.extractFilesFromToolUse(chunk)
    }
    if (chunk.type === 'tool_result') {
      this.extractFilesFromToolResult(chunk)
    }
  }

  private extractFilesFromToolUse(chunk: StreamChunk): void {
    const toolName = chunk.toolName ?? ''

    if (READ_TOOLS.has(toolName)) {
      this.readToolCount++
    }

    if (!chunk.toolInput) return

    // Strategy 1: Try JSON parse (SDK format — backward compat)
    try {
      const input = JSON.parse(chunk.toolInput) as Record<string, unknown>
      if (typeof input.file_path === 'string' && input.file_path) {
        this.inspectedFiles.add(this.normalizePath(input.file_path))
        return
      }
      if (typeof input.path === 'string' && input.path) {
        this.inspectedFiles.add(this.normalizePath(input.path))
        return
      }
    } catch {
      /* Not JSON — fall through to display string extraction */
    }

    // Strategy 2: Display string (CLI format)
    // summarizeToolInput() produces strings like:
    //   Read  → "src/main/index.ts"
    //   Grep  → "/pattern/ in src/main"
    //   Glob  → "**/*.ts"
    //   file_outline  → "outline: src/main/index.ts"
    //   find_callers  → "callers of: myFunction"
    //   deps  → "deps: src/main/index.ts"
    const input = chunk.toolInput.trim()

    // Read/Write/Edit tools: toolInput IS the file path (relative, no spaces)
    if (
      (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') &&
      input &&
      !input.includes(' ')
    ) {
      this.inspectedFiles.add(this.normalizePath(input))
      return
    }

    // Code-graph tools with "prefix: path" pattern
    const prefixMatch = input.match(/^(?:outline|deps|dependents):\s*(.+)$/)
    if (prefixMatch?.[1]) {
      this.inspectedFiles.add(this.normalizePath(prefixMatch[1]))
      return
    }

    // Grep: extract path from "/pattern/ in path"
    const grepMatch = input.match(/in\s+(\S+)\s*$/)
    if (toolName === 'Grep' && grepMatch?.[1]) {
      this.inspectedFiles.add(this.normalizePath(grepMatch[1]))
      return
    }
  }

  private extractFilesFromToolResult(chunk: StreamChunk): void {
    // Extract file paths mentioned in Glob / Grep results
    if (!chunk.content) return

    const toolName = chunk.toolName ?? ''
    if (toolName === 'Glob' || toolName === 'Grep') {
      // These tools return file paths (one per line or in structured output)
      const lines = chunk.content.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        // Basic heuristic: looks like a file path (contains a dot extension, no spaces at start)
        if (trimmed && /\.[a-zA-Z]{1,10}$/.test(trimmed) && !trimmed.includes(' ')) {
          this.inspectedFiles.add(this.normalizePath(trimmed))
        }
      }
    }
  }

  /** Normalize a file path for consistent deduplication. */
  private normalizePath(filePath: string): string {
    // Strip leading ./ and trailing whitespace
    return filePath.replace(/^\.\//, '').trim()
  }

  /** Get current coverage statistics. */
  getStats(): AuditCoverageStats {
    return {
      filesInspected: [...this.inspectedFiles],
      fileCount: this.inspectedFiles.size,
      toolCallCount: this.toolCallCount,
      readToolCount: this.readToolCount
    }
  }

  /** Reset all tracking state. */
  reset(): void {
    this.inspectedFiles.clear()
    this.toolCallCount = 0
    this.readToolCount = 0
  }
}
