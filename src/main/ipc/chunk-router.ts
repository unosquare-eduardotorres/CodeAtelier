/**
 * ChunkRouter — dispatches StreamChunk types to focused handler functions.
 * Replaces the 264-line if/else chain in forwardChunkToRenderer.
 */

import type { BrowserWindow } from 'electron'
import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import { IPC_CHANNELS, MCP_TOOLS } from '../../shared/constants'
import type { ConversationPhase } from '../../shared/types'
import { createTextChunk, createToolActivityChunk, createTurnBoundary } from './chat-protocol'
import { extractResultSummary } from './tool-result-summarizer'
import { reportToolError } from './tool-error-reporter'
import { chatIpcLogger } from '../logger'

// ── Shared context passed to all handlers ──

export interface ChunkRouterContext {
  mainWindow: BrowserWindow
  conversationId: string
  role: 'da-vinci' | 'specialist'
  contentAccumulator: { value: string }
  workspacePath?: string
  specialistMeta?: { specialist: string; taskId?: string }
  phase?: ConversationPhase
  requestId?: string
}

/**
 * Send an IPC message to the renderer, guarding against destroyed windows.
 * During streaming the user may close the window — without this guard every
 * webContents.send() would throw an unhandled exception.
 */
function safeSend(ctx: ChunkRouterContext, channel: string, ...args: unknown[]): void {
  try {
    if (!ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send(channel, ...args)
    }
  } catch (err) {
    chatIpcLogger.warn('Failed to send IPC chunk:', err)
  }
}

/** Base payload fields shared by all IPC messages */
function basePayload(ctx: ChunkRouterContext) {
  return {
    conversationId: ctx.conversationId,
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    role: ctx.role,
    ...(ctx.specialistMeta?.specialist ? { specialist: ctx.specialistMeta.specialist } : {}),
    ...(ctx.specialistMeta?.taskId ? { taskId: ctx.specialistMeta.taskId } : {})
  }
}

/** Generate a unique tool ID with better collision resistance */
function generateToolId(prefix: string, existingId?: string | null): string {
  if (existingId) return existingId
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ── Per-type handler functions ──

function handleText(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.content) return
  chatIpcLogger.debug(
    `[chunk-router:text] ${chunk.content.length} chars → ${ctx.conversationId.slice(0, 8)}`
  )
  ctx.contentAccumulator.value += chunk.content
  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTextChunk({ ...basePayload(ctx), text: chunk.content, phase: ctx.phase })
  )
}

function handleThinking(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.content) return
  const thinkingText = `\n\n<details>\n<summary>💭 Reasoning</summary>\n\n${chunk.content}\n\n</details>\n\n`
  ctx.contentAccumulator.value += thinkingText
  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTextChunk({ ...basePayload(ctx), text: thinkingText, phase: ctx.phase })
  )
}

function handleToolUse(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Control tools are internal — don't show as tool activity in the UI
  if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return

  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createToolActivityChunk({
      ...basePayload(ctx),
      toolActivity: {
        id: generateToolId('tool', chunk.toolId),
        toolName: chunk.toolName ?? 'Unknown',
        status: 'running' as const,
        input: chunk.toolInput,
        startedAt: Date.now()
      }
    })
  )
}

function handleToolResult(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Control tool results are internal
  if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return

  let toolInputSummary: string | undefined
  if (chunk.content) {
    try {
      const parsed = JSON.parse(chunk.content) as Record<string, unknown>
      toolInputSummary = summarizeToolInput(chunk.toolName ?? '', parsed, ctx.workspacePath)
    } catch {
      toolInputSummary = chunk.content.slice(0, 120)
    }
  }

  const resultSummaryObj = extractResultSummary(chunk.toolName ?? '', chunk.content)
  let resultSummary = resultSummaryObj?.result
  const resultDetail = resultSummaryObj?.resultDetail

  // For Read, compose file path into result so it's always visible
  if (chunk.toolName === 'Read' && toolInputSummary && resultSummary) {
    resultSummary = `${resultSummary} — ${toolInputSummary}`
  }

  // Tag the activity as 'error' when the SDK returned a tool_use_error
  const isToolError =
    typeof chunk.content === 'string' && chunk.content.includes('<tool_use_error>')

  // Auto-capture tool errors to the bug tracker
  if (isToolError && chunk.content) {
    reportToolError(chunk.toolName ?? 'Unknown', chunk.content, {
      agentType: ctx.specialistMeta?.specialist ?? ctx.role,
      workspaceId: ctx.conversationId,
      agentId: ctx.specialistMeta?.taskId
    })
  }

  const toolActivity: Record<string, unknown> = {
    id: generateToolId('tool', chunk.toolId),
    toolName: chunk.toolName ?? 'Unknown',
    status: isToolError ? 'error' : 'completed',
    completedAt: Date.now()
  }
  if (toolInputSummary) toolActivity.input = toolInputSummary
  if (resultSummary) toolActivity.result = resultSummary
  if (resultDetail) toolActivity.resultDetail = resultDetail

  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createToolActivityChunk({
      ...basePayload(ctx),
      toolActivity: toolActivity as { id: string; toolName: string }
    })
  )
}

function handleTurnBoundary(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTurnBoundary({
      ...basePayload(ctx),
      turnId: chunk.content ?? `turn-${Date.now()}`
    })
  )
}

function handleError(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  const errorText = `\n\n**Error:** ${chunk.error}`
  ctx.contentAccumulator.value += errorText
  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTextChunk({ ...basePayload(ctx), text: errorText })
  )
}

function handleStatus(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.content || chunk.content === 'heartbeat') return
  const statusText = `\n\n_${chunk.content}_\n\n`
  ctx.contentAccumulator.value += statusText
  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTextChunk({ ...basePayload(ctx), text: statusText })
  )
}

function handleToolProgress(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createToolActivityChunk({
      ...basePayload(ctx),
      toolActivity: {
        id: generateToolId('tool', chunk.toolId),
        toolName: chunk.toolName ?? 'Unknown',
        status: 'running' as const,
        elapsedSeconds: chunk.elapsedSeconds
      }
    })
  )
}

function handleRateLimit(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx, IPC_CHANNELS.SDK_RATE_LIMIT, {
    ...(chunk.rateLimit ?? {}),
    ...basePayload(ctx)
  })
}

function handleApiRetry(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx, IPC_CHANNELS.SDK_API_RETRY, {
    ...(chunk.retryInfo ?? {}),
    ...basePayload(ctx)
  })
}

function handleCompactBoundary(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  const compactText = `\n\n_⚡ ${chunk.content}_\n\n`
  ctx.contentAccumulator.value += compactText
  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTextChunk({ ...basePayload(ctx), text: compactText })
  )
}

function handlePromptSuggestion(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx, IPC_CHANNELS.SDK_PROMPT_SUGGESTION, {
    ...basePayload(ctx),
    suggestion: chunk.content
  })
}

function handleFilesPersisted(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx, IPC_CHANNELS.SDK_FILES_PERSISTED, {
    ...basePayload(ctx),
    files: chunk.persistedFiles
  })
}

function handleHookLifecycle(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx, IPC_CHANNELS.SDK_HOOK_LIFECYCLE, {
    ...(chunk.hookInfo ?? {}),
    ...basePayload(ctx)
  })
}

function handleSessionState(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx, IPC_CHANNELS.SDK_SESSION_STATE, {
    ...basePayload(ctx),
    state: chunk.content
  })
}

function handleAuthStatus(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx, IPC_CHANNELS.SDK_AUTH_STATUS, {
    ...basePayload(ctx),
    message: chunk.content
  })
}

function handleSessionRecovery(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx, IPC_CHANNELS.CHAT_SESSION_RECOVERY, {
    ...basePayload(ctx),
    phase: chunk.recoveryPhase,
    message: chunk.content
  })
}

function handleContextUsageUpdate(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  safeSend(ctx, IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
    ...basePayload(ctx),
    chunk: '',
    contextUsageUpdate: (chunk as unknown as { contextUsageUpdate: unknown }).contextUsageUpdate
  })
}

function handleTodoUpdate(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.todoUpdate) return
  safeSend(ctx, IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
    ...basePayload(ctx),
    chunk: '',
    todoUpdate: chunk.todoUpdate
  })
}

// ── SubAgent helpers ──

/** Truncate a string to `maxLen` with an ellipsis */
function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str
}

/** Returns true if the content is a short status label, not prose text */
function isStatusLabel(content: string): boolean {
  const lower = content.trim().toLowerCase()
  return (
    lower.length < 30 &&
    (lower.startsWith('running') ||
      lower.startsWith('starting') ||
      lower.startsWith('completed') ||
      lower.startsWith('failed') ||
      lower.startsWith('waiting'))
  )
}

// ── SubAgent lifecycle handlers ──
// These map the subagent_* chunks from stream-normalizer into tool activity
// events so sub-agent work appears in the tool activity panel.
// Text content is dual-emitted: as a chat bubble text chunk AND a truncated
// tool activity entry, so prose is readable while the accordion shows a summary.

function handleSubagentStart(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Emit tool activity for the accordion (short summary only)
  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createToolActivityChunk({
      ...basePayload(ctx),
      toolActivity: {
        id: generateToolId('subagent', chunk.toolId),
        toolName: chunk.toolName ?? 'Agent',
        status: 'running' as const,
        input: chunk.content ? truncate(chunk.content, 80) : undefined,
        startedAt: Date.now()
      }
    })
  )
}

function handleSubagentProgress(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  const content = chunk.content ?? ''

  // If the progress content looks like actual text output (not just a status label),
  // emit it as chat text so it renders in the message bubble, not just the tool accordion.
  if (content.length > 20 && !isStatusLabel(content)) {
    ctx.contentAccumulator.value += content
    safeSend(ctx, 
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({
        ...basePayload(ctx),
        text: content,
        phase: ctx.phase
      })
    )
  }

  // Also emit tool activity update (short summary only)
  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createToolActivityChunk({
      ...basePayload(ctx),
      toolActivity: {
        id: generateToolId('subagent', chunk.toolId),
        toolName: chunk.toolName ?? 'Agent',
        status: 'running' as const,
        result: truncate(content, 80)
      }
    })
  )
}

function handleSubagentComplete(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  const content = chunk.content ?? ''

  // Emit long completion text as bubble content
  if (content.length > 20 && !isStatusLabel(content)) {
    ctx.contentAccumulator.value += content
    safeSend(ctx, 
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({
        ...basePayload(ctx),
        text: content,
        phase: ctx.phase
      })
    )
  }

  // Tool activity: mark as complete with short summary
  safeSend(ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createToolActivityChunk({
      ...basePayload(ctx),
      toolActivity: {
        id: generateToolId('subagent', chunk.toolId),
        toolName: 'Agent',
        status: (chunk.toolInput === 'completed' ? 'completed' : 'error') as 'completed' | 'error',
        result: truncate(content, 80),
        completedAt: Date.now()
      }
    })
  )
}

// ── Dispatch table ──

type ChunkHandler = (ctx: ChunkRouterContext, chunk: StreamChunk) => void

const CHUNK_HANDLERS: Record<string, ChunkHandler> = {
  text: handleText,
  thinking: handleThinking,
  tool_use: handleToolUse,
  tool_result: handleToolResult,
  turn_boundary: handleTurnBoundary,
  error: handleError,
  status: handleStatus,
  tool_progress: handleToolProgress,
  rate_limit: handleRateLimit,
  api_retry: handleApiRetry,
  compact_boundary: handleCompactBoundary,
  prompt_suggestion: handlePromptSuggestion,
  files_persisted: handleFilesPersisted,
  hook_lifecycle: handleHookLifecycle,
  session_state: handleSessionState,
  auth_status: handleAuthStatus,
  session_recovery: handleSessionRecovery,
  context_usage_update: handleContextUsageUpdate,
  todo_update: handleTodoUpdate,
  subagent_start: handleSubagentStart,
  subagent_progress: handleSubagentProgress,
  subagent_complete: handleSubagentComplete
}

/**
 * Route a StreamChunk to the appropriate handler.
 * Drop-in replacement for forwardChunkToRenderer.
 */
export function routeChunk(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  const handler = CHUNK_HANDLERS[chunk.type]
  if (handler) handler(ctx, chunk)
}
