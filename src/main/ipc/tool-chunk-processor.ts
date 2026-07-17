/**
 * Tool Chunk Processor — single source of truth for tool_use / tool_result / tool_progress handling.
 *
 * All consumers (chunk-router, grill, audit, council) call processToolChunk() from here.
 * To add a new field to ToolActivity, change error detection, or handle a new composable tool,
 * edit this file only — no consumer changes needed.
 */

import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import type { ConversationMode, ToolActivity, ToolOperationType } from '../../shared/types'
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
  /** Active conversation mode — used to suppress expected plan-mode permission blocks. */
  mode?: ConversationMode
}

// ── Expected plan-mode permission blocks ──
// In Plan mode, Write/Edit are intentionally not on the allow-list, so the SDK
// returns "No such tool available: Write/Edit". This is expected behavior, not a
// bug — we must not auto-report it to the bug tracker (it pollutes the tracker
// with false positives every time a model reaches for Write to author a plan).
const PLAN_BLOCKED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

// ── Conditionally-loaded MCP tools ──
// These tools belong to MCP servers that may not be running (e.g., memory server
// when no workspace is configured). "No such tool available" for these is expected,
// not a bug — suppress from the bug tracker.
const CONDITIONAL_MCP_TOOLS = new Set([
  'mcp__memory__memory_search',
  'mcp__memory__memory_record',
  'mcp__memory__memory_flag'
])

/**
 * True when a tool_use_error is the expected outcome of calling a conditionally-loaded
 * MCP tool that isn't currently available — not a real failure to report.
 */
function isExpectedToolUnavailable(
  toolName: string | undefined,
  content: string | undefined
): boolean {
  if (!toolName || !content) return false
  if (!content.includes('No such tool available')) return false
  return CONDITIONAL_MCP_TOOLS.has(toolName)
}

/**
 * True when a tool_use_error is the expected "blocked in Plan mode" outcome of a
 * Write/Edit attempt — i.e. a permission gate, not a real failure to report.
 */
export function isExpectedPlanModeBlock(
  toolName: string | undefined,
  content: string | undefined,
  mode: ConversationMode | undefined
): boolean {
  if (mode !== 'plan') return false
  if (!toolName || !PLAN_BLOCKED_TOOLS.has(toolName)) return false
  if (!content) return false
  return content.includes('No such tool available')
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

    // Auto-capture tool errors to the bug tracker (skip known format tags and
    // expected plan-mode Write/Edit permission blocks).
    const skipTags = new Set(options.formatTagsToSkip ?? [])
    const isPlanModeBlock = isExpectedPlanModeBlock(chunk.toolName, chunk.content, options.mode)
    const isConditionalToolMissing = isExpectedToolUnavailable(chunk.toolName, chunk.content)
    if (isToolError && chunk.content && !skipTags.has(chunk.toolName ?? '') && !isPlanModeBlock && !isConditionalToolMissing) {
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
