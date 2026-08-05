/**
 * Tool Chunk Processor — single source of truth for tool_use / tool_result / tool_progress handling.
 *
 * All consumers (chunk-router, grill, audit, council) call processToolChunk() from here.
 * To add a new field to ToolActivity, change error detection, or handle a new composable tool,
 * edit this file only — no consumer changes needed.
 */

import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import type {
  ConversationMode,
  ToolActivity,
  ToolEditDiff,
  ToolOperationType
} from '../../shared/types'
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
const CONDITIONAL_MCP_TOOLS = new Set(MCP_TOOLS.MEMORY._ALL_NAMES)

/**
 * True when a tool_use_error is a transient LLM JSON generation error —
 * Claude occasionally drops key names or generates invalid JSON for tool
 * parameters. The CLI rejects these with InputValidationError. These are
 * self-correcting (the error goes back to Claude, which retries) and
 * should not pollute the bug tracker.
 */
export function isTransientLlmJsonError(content: string | undefined): boolean {
  if (!content) return false
  return content.includes('could not be parsed as JSON') || content.includes('InputValidationError')
}

/**
 * True when a tool_use_error is a self-correcting agent mistake —
 * the error goes back to Claude which retries with corrected parameters.
 * These should not pollute the bug tracker.
 */
export function isAgentToolMistake(content: string | undefined): boolean {
  if (!content) return false
  return (
    /replace_all is false/i.test(content) ||
    /has not been read yet/i.test(content) ||
    /old_string and new_string are exactly the same/i.test(content) ||
    /Path does not exist/i.test(content)
  )
}

/**
 * True when a tool error is an expected CLI permission/interaction outcome —
 * permission denied, user timeout, user rejection, multi-operation approval,
 * file race condition, or tool disabled in context. These are operational
 * events, not application bugs.
 */
export function isCliInteractionError(content: string | undefined): boolean {
  if (!content) return false
  return (
    /has been denied/i.test(content) ||               // "Permission to use Bash...has been denied"
    /denied by timeout/i.test(content) ||             // "No user response — denied by timeout"
    /doesn.t want to proceed/i.test(content) ||       // "The user doesn't want to proceed"
    /does not want to proceed/i.test(content) ||      // alternate phrasing
    /requires approval/i.test(content) ||             // "The following part requires approval"
    /has been modified since read/i.test(content) ||  // "File has been modified since read"
    /exists but is not enabled/i.test(content)        // "Bash exists but is not enabled in this context"
  )
}

/**
 * True when a tool_use_error is the expected outcome of calling a conditionally-loaded
 * MCP tool that isn't currently available — not a real failure to report.
 */
export function isExpectedToolUnavailable(
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

// ── Edit diff extraction ──

/** Storage budget — editDiffs live in the messages JSON column, so they must stay small. */
const MAX_EDIT_STRING_CHARS = 2_000
const MAX_EDITS = 10
const MAX_EDIT_DIFFS_TOTAL_CHARS = 16_000

function clip(s: string): { value: string; truncated: boolean } {
  return s.length > MAX_EDIT_STRING_CHARS
    ? { value: s.slice(0, MAX_EDIT_STRING_CHARS), truncated: true }
    : { value: s, truncated: false }
}

/** Read an `{ old_string, new_string }` pair from either snake_case or camelCase. */
function readEditPair(raw: unknown): { oldString: string; newString: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const oldString = (o.old_string ?? o.oldString) as unknown
  const newString = (o.new_string ?? o.newString) as unknown
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null
  if (oldString === '' && newString === '') return null
  return { oldString, newString }
}

/**
 * Pull before/after segments out of an already-parsed Edit/MultiEdit tool input.
 * Tolerates both shapes: `{ edits: [{ old_string, new_string }] }` (MultiEdit)
 * and a top-level `{ old_string, new_string }` (Edit). Returns undefined when
 * the input carries no usable pair — the feature degrades silently rather than
 * throwing on an unfamiliar backend shape.
 */
export function extractEditDiffs(
  input: Record<string, unknown>
): { editDiffs: ToolEditDiff[]; editDiffsOmitted: number } | undefined {
  const candidates: unknown[] = Array.isArray(input.edits) ? input.edits : [input]

  const pairs = candidates
    .map(readEditPair)
    .filter((p): p is { oldString: string; newString: string } => p !== null)
  if (pairs.length === 0) return undefined

  const editDiffs: ToolEditDiff[] = []
  let totalChars = 0

  for (const pair of pairs) {
    if (editDiffs.length >= MAX_EDITS) break
    const oldClip = clip(pair.oldString)
    const newClip = clip(pair.newString)
    const size = oldClip.value.length + newClip.value.length
    if (totalChars + size > MAX_EDIT_DIFFS_TOTAL_CHARS && editDiffs.length > 0) break
    totalChars += size
    const diff: ToolEditDiff = { oldString: oldClip.value, newString: newClip.value }
    if (oldClip.truncated || newClip.truncated) diff.truncated = true
    editDiffs.push(diff)
  }

  return { editDiffs, editDiffsOmitted: pairs.length - editDiffs.length }
}

// ── Structured metadata extraction ──

function extractStructuredMeta(
  toolName: string | undefined,
  toolInput: string | undefined,
  toolInputRaw?: string
): {
  filePath?: string
  lineRange?: string
  operationType: ToolOperationType
  editDiffs?: ToolEditDiff[]
  editDiffsOmitted?: number
} {
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

  // Prefer toolInputRaw — actual JSON tool input. `toolInput` on the CLI
  // backend is a human-readable display string ("src/a.ts (1 lines)"), not
  // parseable JSON; JSON.parse on it always throws. toolInputRaw carries the
  // real object (see StreamChunk.toolInputRaw). OpenCode's toolInput has
  // historically already been raw JSON, so this falls back correctly there.
  const rawSource = toolInputRaw ?? toolInput
  if (!rawSource) return { operationType }

  let input: Record<string, unknown> = {}
  try {
    input = JSON.parse(rawSource) as Record<string, unknown>
  } catch {
    return { operationType }
  }

  // Extract file path
  const filePath = (input.file_path ?? input.filePath ?? input.path) as string | undefined

  // Extract line range from offset + limit
  const offset = input.offset as number | undefined
  const limit = input.limit as number | undefined
  const lineRange = offset ? `${offset}${limit ? `-${offset + limit - 1}` : '+'}` : undefined

  // Before/after segments — Edit/MultiEdit only. The tool *input* already
  // carries the exact changed text, so there's nothing to parse from output.
  const edits = operationType === 'edit' ? extractEditDiffs(input) : undefined

  return {
    filePath: filePath || undefined,
    lineRange,
    operationType,
    editDiffs: edits?.editDiffs,
    editDiffsOmitted: edits && edits.editDiffsOmitted > 0 ? edits.editDiffsOmitted : undefined
  }
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
    const meta = extractStructuredMeta(chunk.toolName, chunk.toolInput, chunk.toolInputRaw)
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
        operationType: meta.operationType,
        editDiffs: meta.editDiffs,
        editDiffsOmitted: meta.editDiffsOmitted
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

    // Tag the activity as 'error' when the SDK returned a tool_use_error,
    // the stream-normalizer propagated is_error, or the content indicates a
    // permission denial from the CLI.
    const contentStr = typeof chunk.content === 'string' ? chunk.content : ''
    const isPermissionDenial = /Claude requested permissions/.test(contentStr)
    const isToolError =
      contentStr.includes('<tool_use_error>') || chunk.isError === true || isPermissionDenial

    // Auto-capture tool errors to the bug tracker (skip known format tags,
    // expected plan-mode Write/Edit permission blocks, and permission denials
    // which are user-initiated and not bugs).
    const skipTags = new Set(options.formatTagsToSkip ?? [])
    const isPlanModeBlock = isExpectedPlanModeBlock(chunk.toolName, chunk.content, options.mode)
    const isConditionalToolMissing = isExpectedToolUnavailable(chunk.toolName, chunk.content)
    const isTransientJson = isTransientLlmJsonError(chunk.content)
    const isAgentMistake = isAgentToolMistake(chunk.content)
    const isInteractionError = isCliInteractionError(chunk.content)
    if (
      isToolError &&
      chunk.content &&
      !skipTags.has(chunk.toolName ?? '') &&
      !isPlanModeBlock &&
      !isConditionalToolMissing &&
      !isTransientJson &&
      !isAgentMistake &&
      !isPermissionDenial &&
      !isInteractionError
    ) {
      reportToolError(chunk.toolName ?? 'Unknown', chunk.content, {
        agentType: options.agentType,
        workspaceId: options.workspaceId,
        agentId: options.agentId
      })
    }

    // Extract structured metadata from the original tool input
    const meta = extractStructuredMeta(chunk.toolName, chunk.toolInput, chunk.toolInputRaw)

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
    // Only set when present — consumers merge tool_use → tool_result by id, so an
    // explicit `undefined` here would clobber diffs captured at tool_use time.
    if (meta.editDiffs) {
      toolActivity.editDiffs = meta.editDiffs
      toolActivity.editDiffsOmitted = meta.editDiffsOmitted
    }
    if (toolInputSummary) toolActivity.input = toolInputSummary
    // Override result summary for permission denials with a clear label
    if (isPermissionDenial) {
      toolActivity.result = 'Permission denied'
    } else if (resultSummary) {
      toolActivity.result = resultSummary
    }
    if (resultDetail) toolActivity.resultDetail = resultDetail

    return { type: 'tool_activity', toolActivity }
  }

  // tool_progress — update-only. A heartbeat must never mint a new activity row:
  // an id synthesised here can never be closed by the tool_result (which carries
  // the real id), leaving a phantom 'running' tool in the UI forever.
  if (!chunk.toolId) return null
  return {
    type: 'tool_activity',
    toolActivity: {
      id: chunk.toolId,
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
