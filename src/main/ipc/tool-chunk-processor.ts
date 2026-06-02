/**
 * Tool Chunk Processor — single source of truth for tool_use / tool_result / tool_progress handling.
 *
 * All consumers (chunk-router, grill, audit, council) call processToolChunk() from here.
 * To add a new field to ToolActivity, change error detection, or handle a new composable tool,
 * edit this file only — no consumer changes needed.
 */

import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import type { ToolActivity, ToolOperationType } from '../../shared/types'
import { MCP_TOOLS } from '../../shared/constants'
import { extractResultSummary } from './tool-result-summarizer'
import { reportToolError } from './tool-error-reporter'

// ── Public types ──

export interface ProcessedToolChunk {
  type: 'tool_activity'
  toolActivity: ToolActivity
}

export interface ToolChunkOptions {
  workspacePath?: string
  agentType: string
  workspaceId?: string
  agentId?: string
  /** Format tags to skip for error reporting. e.g. ['grill-evaluation'], ['audit-finding', 'audit-score'] */
  formatTagsToSkip?: string[]
}

// ── Composable tools: input is composed into result so file/pattern is visible without expanding ──

const COMPOSABLE_TOOLS = new Set(['Read', 'Grep', 'Glob'])

// ── Structured metadata extraction ──

function extractStructuredMeta(
  toolName: string | undefined,
  toolInput: string | undefined
): { filePath?: string; lineRange?: string; operationType: ToolOperationType } {
  const name = (toolName ?? '').toLowerCase()

  // Determine operation type from tool name
  const operationType: ToolOperationType =
    name === 'read'
      ? 'read'
      : name === 'write'
        ? 'write'
        : name === 'edit' || name === 'multiedit'
          ? 'edit'
          : name === 'grep' || name === 'glob'
            ? 'search'
            : name === 'bash'
              ? 'shell'
              : name.startsWith('mcp__code') || name.startsWith('mcp__semantic')
                ? 'codegraph'
                : 'other'

  if (!toolInput) return { operationType }

  let input: Record<string, unknown> = {}
  try {
    input = JSON.parse(toolInput) as Record<string, unknown>
  } catch {
    return { operationType }
  }

  // Extract file path
  const filePath = (input.file_path ?? input.filePath ?? input.path) as string | undefined

  // Extract line range from offset + limit
  const offset = input.offset as number | undefined
  const limit = input.limit as number | undefined
  const lineRange = offset ? `${offset}${limit ? `-${offset + limit - 1}` : '+'}` : undefined

  return { filePath: filePath || undefined, lineRange, operationType }
}

// ── Core processor ──

/**
 * Process a single tool-related StreamChunk and return a normalized ToolActivity.
 * Returns null for non-tool chunks or internal control tools.
 */
export function processToolChunk(
  chunk: StreamChunk,
  options: ToolChunkOptions
): ProcessedToolChunk | null {
  if (chunk.type !== 'tool_use' && chunk.type !== 'tool_result' && chunk.type !== 'tool_progress') {
    return null
  }

  // Control tools are internal — never surface in UI
  if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return null

  if (chunk.type === 'tool_use') {
    const meta = extractStructuredMeta(chunk.toolName, chunk.toolInput)
    return {
      type: 'tool_activity',
      toolActivity: {
        id: generateToolId(chunk.toolId),
        toolName: chunk.toolName ?? 'Unknown',
        status: 'running',
        input: safelySummarizeInput(chunk.toolInput, chunk.toolName, options.workspacePath),
        startedAt: Date.now(),
        filePath: meta.filePath,
        lineRange: meta.lineRange,
        operationType: meta.operationType
      }
    }
  }

  if (chunk.type === 'tool_result') {
    // Use the pre-computed input summary from the normalizer (stored during tool_use processing).
    // Falls back to parsing result content for backward compatibility.
    let toolInputSummary: string | undefined = chunk.toolInput
    if (!toolInputSummary && chunk.content) {
      try {
        const parsed = JSON.parse(chunk.content) as Record<string, unknown>
        toolInputSummary = summarizeToolInput(chunk.toolName ?? '', parsed, options.workspacePath)
      } catch {
        // Result content isn't JSON — no input summary available
      }
    }

    const resultObj = extractResultSummary(chunk.toolName ?? '', chunk.content)
    let resultSummary = resultObj?.result
    const resultDetail = resultObj?.resultDetail

    // Compose file path / pattern into result so it's always visible without expanding
    if (toolInputSummary && resultSummary && COMPOSABLE_TOOLS.has(chunk.toolName ?? '')) {
      resultSummary = `${resultSummary} — ${toolInputSummary}`
    }

    // Tag the activity as 'error' when the SDK returned a tool_use_error
    const isToolError =
      typeof chunk.content === 'string' && chunk.content.includes('<tool_use_error>')

    // Auto-capture tool errors to the bug tracker (skip known format tags)
    const skipTags = new Set(options.formatTagsToSkip ?? [])
    if (isToolError && chunk.content && !skipTags.has(chunk.toolName ?? '')) {
      reportToolError(chunk.toolName ?? 'Unknown', chunk.content, {
        agentType: options.agentType,
        workspaceId: options.workspaceId,
        agentId: options.agentId
      })
    }

    // Extract structured metadata from the original tool input
    const meta = extractStructuredMeta(chunk.toolName, chunk.toolInput)

    const toolActivity: ToolActivity = {
      id: generateToolId(chunk.toolId),
      toolName: chunk.toolName ?? 'Unknown',
      status: isToolError ? 'error' : 'completed',
      startedAt: 0,
      completedAt: Date.now(),
      filePath: meta.filePath,
      lineRange: meta.lineRange,
      operationType: meta.operationType
    }
    if (toolInputSummary) toolActivity.input = toolInputSummary
    if (resultSummary) toolActivity.result = resultSummary
    if (resultDetail) toolActivity.resultDetail = resultDetail

    return { type: 'tool_activity', toolActivity }
  }

  // tool_progress
  return {
    type: 'tool_activity',
    toolActivity: {
      id: generateToolId(chunk.toolId),
      toolName: chunk.toolName ?? 'Unknown',
      status: 'running',
      startedAt: 0,
      elapsedSeconds: chunk.elapsedSeconds
    }
  }
}

// ── Helpers ──

function generateToolId(toolId?: string): string {
  return toolId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function safelySummarizeInput(
  toolInput: string | undefined,
  toolName: string | undefined,
  workspacePath?: string
): string | undefined {
  if (!toolInput) return undefined
  try {
    const parsed = JSON.parse(toolInput) as Record<string, unknown>
    return summarizeToolInput(toolName ?? '', parsed, workspacePath)
  } catch {
    return toolInput.slice(0, 120)
  }
}
