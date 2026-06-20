/**
 * ChunkRouter — dispatches StreamChunk types to focused handler functions.
 * Replaces the 264-line if/else chain in forwardChunkToRenderer.
 */

import type { BrowserWindow } from 'electron'
import type { StreamChunk } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ConversationMode, ConversationPhase, ToolActivity } from '../../shared/types'
import { createTextChunk, createToolActivityChunk, createTurnBoundary } from './chat-protocol'
import { processToolChunk } from './tool-chunk-processor'
import { TextDeltaBatcher } from './text-delta-batcher'
import { chatIpcLogger } from '../logger'

// ── Tool Activity Persistence Accumulator ──────────────────────────────
// Collects completed ToolActivity objects during streaming, keyed by
// conversationId → toolId. Merges tool_use (running) and tool_result
// (completed) by ID so the persisted entry has both startedAt and result.
// Retrieved and cleared by getAndClearToolActivities() during finalize.

const toolActivityStore = new Map<string, Map<string, ToolActivity>>()

function accumulateToolActivity(
  conversationId: string,
  partial: Partial<ToolActivity> & { id: string; toolName: string }
): void {
  let convMap = toolActivityStore.get(conversationId)
  if (!convMap) {
    convMap = new Map<string, ToolActivity>()
    toolActivityStore.set(conversationId, convMap)
  }
  const existing = convMap.get(partial.id)
  if (existing) {
    // Merge: preserve earlier startedAt, overlay new fields
    convMap.set(partial.id, {
      ...existing,
      ...partial,
      startedAt: existing.startedAt || partial.startedAt || 0
    })
  } else {
    convMap.set(partial.id, {
      status: 'running',
      startedAt: Date.now(),
      ...partial
    } as ToolActivity)
  }
}

/**
 * Retrieve and clear accumulated tool activities for a conversation.
 * Called during finalize to persist tool activities to the DB.
 * Returns all activities including 'running' ones (e.g. subagents interrupted mid-execution).
 */
export function getAndClearToolActivities(conversationId: string): ToolActivity[] {
  const convMap = toolActivityStore.get(conversationId)
  toolActivityStore.delete(conversationId)
  if (!convMap) return []
  return [...convMap.values()]
}

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
  /** Active conversation mode — forwarded to processToolChunk to suppress expected plan-mode blocks. */
  mode?: ConversationMode
}

// ── Per-stream metrics ──────────────────────────────────────────────
// Tracks TTFT, chunk count, total chars, and duration per stream.
// Logged as [METRIC:STREAM_COMPLETE] on finalization for observability.
// The StreamMetricsAggregator keeps a sliding window of recent streams
// for completion-rate and TTFT p95 aggregation.

type StreamOutcome = 'complete' | 'stopped' | 'error' | 'timeout'

interface StreamMetrics {
  startedAt: number
  firstTokenAt: number | null
  chunkCount: number
  totalChars: number
}

interface AggregatedStreamRecord {
  outcome: StreamOutcome
  ttft: number | null
  duration: number
}

/**
 * Sliding-window aggregator for stream health metrics.
 * Keeps the last `windowSize` stream outcomes and computes
 * completion rate + TTFT percentiles on demand.
 */
export class StreamMetricsAggregator {
  private records: AggregatedStreamRecord[] = []
  private readonly windowSize: number

  constructor(windowSize: number = 100) {
    this.windowSize = windowSize
  }

  /** Record a completed stream's outcome and timing. */
  record(outcome: StreamOutcome, ttft: number | null, duration: number): void {
    this.records.push({ outcome, ttft, duration })
    if (this.records.length > this.windowSize) this.records.shift()
  }

  /** Fraction of streams that ended with 'complete' outcome (0–1). */
  get completionRate(): number {
    if (this.records.length === 0) return 1
    return this.records.filter((r) => r.outcome === 'complete').length / this.records.length
  }

  /** TTFT at the given percentile (0–1). Returns null when no TTFT data exists. */
  ttftPercentile(p: number): number | null {
    const ttfts = this.records
      .map((r) => r.ttft)
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b)
    if (ttfts.length === 0) return null
    return ttfts[Math.min(Math.floor(ttfts.length * p), ttfts.length - 1)]
  }

  /** Convenience: TTFT p95. */
  get ttftP95(): number | null {
    return this.ttftPercentile(0.95)
  }

  /** Number of streams in the current window. */
  get sampleSize(): number {
    return this.records.length
  }

  /** Distribution of outcomes in the current window. */
  get outcomeCounts(): Record<StreamOutcome, number> {
    const counts: Record<StreamOutcome, number> = { complete: 0, stopped: 0, error: 0, timeout: 0 }
    for (const r of this.records) counts[r.outcome]++
    return counts
  }
}

const streamMetricsStore = new Map<string, StreamMetrics>()
const streamAggregator = new StreamMetricsAggregator()

/** Begin tracking metrics for a new stream. */
export function startStreamMetrics(conversationId: string): void {
  streamMetricsStore.set(conversationId, {
    startedAt: Date.now(),
    firstTokenAt: null,
    chunkCount: 0,
    totalChars: 0
  })
}

/**
 * Log final stream metrics, record into the sliding-window aggregator, and clean up.
 * @param outcome - How the stream ended: 'complete' | 'stopped' | 'error' | 'timeout'
 */
export function completeStreamMetrics(
  conversationId: string,
  outcome: StreamOutcome
): void {
  const metrics = streamMetricsStore.get(conversationId)
  streamMetricsStore.delete(conversationId)
  if (!metrics) return

  const duration = Date.now() - metrics.startedAt
  const ttft = metrics.firstTokenAt ? metrics.firstTokenAt - metrics.startedAt : null

  // Record into sliding-window aggregator
  streamAggregator.record(outcome, ttft, duration)

  chatIpcLogger.info(
    `[METRIC:STREAM_COMPLETE] ` +
      `outcome=${outcome} duration=${duration}ms ttft=${ttft}ms ` +
      `chunks=${metrics.chunkCount} chars=${metrics.totalChars} ` +
      `conversationId=${conversationId.slice(0, 8)} ` +
      `completionRate=${(streamAggregator.completionRate * 100).toFixed(1)}% ` +
      `ttftP95=${streamAggregator.ttftP95}ms ` +
      `sampleSize=${streamAggregator.sampleSize}`
  )
}

/** Expose the aggregator for diagnostic IPC or health checks. */
export function getStreamMetricsAggregator(): StreamMetricsAggregator {
  return streamAggregator
}

// ── Text delta batching (~30fps) ────────────────────────────────────
// Reduces IPC calls from ~15/sec to ~3-5/sec during fast streaming.
// Text deltas are buffered and flushed every 33ms (1 frame at 30fps).
// Keyed by conversationId to prevent cross-conversation text mixing when
// concurrent streams are active (e.g. multi-session or parallel agents).
// The shared TextDeltaBatcher owns timing; the flush closure does the IPC send.

const textBatcher = new TextDeltaBatcher()

/** Queue text for batched delivery to the renderer for this conversation. */
function pushText(ctx: ChunkRouterContext, text: string): void {
  textBatcher.push(ctx.conversationId, text, (buffer) => {
    safeSend(
      ctx,
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({ ...basePayload(ctx), text: buffer, phase: ctx.phase })
    )
  })
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
interface BasePayload {
  conversationId: string
  role: 'da-vinci' | 'specialist'
  requestId?: string
  specialist?: string
  taskId?: string
}

function basePayload(ctx: ChunkRouterContext): BasePayload {
  return {
    conversationId: ctx.conversationId,
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    role: ctx.role,
    ...(ctx.specialistMeta?.specialist ? { specialist: ctx.specialistMeta.specialist } : {}),
    ...(ctx.specialistMeta?.taskId ? { taskId: ctx.specialistMeta.taskId } : {})
  }
}

// ── Per-type handler functions ──

function handleText(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.content) return
  chatIpcLogger.debug(
    `[chunk-router:text] ${chunk.content.length} chars → ${ctx.conversationId.slice(0, 8)}`
  )

  // Track stream metrics (TTFT, chunk count, total chars)
  const metrics = streamMetricsStore.get(ctx.conversationId)
  if (metrics) {
    if (metrics.firstTokenAt === null) {
      metrics.firstTokenAt = Date.now()
      const ttft = metrics.firstTokenAt - metrics.startedAt
      chatIpcLogger.info(`[METRIC:TTFT] ${ttft}ms conversationId=${ctx.conversationId.slice(0, 8)}`)
    }
    metrics.chunkCount++
    metrics.totalChars += chunk.content.length
  }

  // Accumulate immediately for backend consumers (prompt caching, etc.)
  ctx.contentAccumulator.value += chunk.content
  // Batch IPC sends at ~30fps to reduce renderer pressure during fast streaming
  pushText(ctx, chunk.content)
}

function handleThinking(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.content) return
  const thinkingText = `\n\n<details>\n<summary>💭 Reasoning</summary>\n\n${chunk.content}\n\n</details>\n\n`
  ctx.contentAccumulator.value += thinkingText
  safeSend(
    ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTextChunk({ ...basePayload(ctx), text: thinkingText, phase: ctx.phase })
  )
}

function handleToolChunk(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Flush pending text before tool activity (tool_use starts a new visual block)
  if (chunk.type === 'tool_use') textBatcher.flush(ctx.conversationId)

  const result = processToolChunk(chunk, {
    workspacePath: ctx.workspacePath,
    agentType: ctx.specialistMeta?.specialist ?? ctx.role,
    workspaceId: ctx.conversationId,
    agentId: ctx.specialistMeta?.taskId,
    mode: ctx.mode
  })
  if (!result) return

  // Accumulate for DB persistence (merge tool_use → tool_result by id)
  accumulateToolActivity(ctx.conversationId, result.toolActivity)

  safeSend(
    ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createToolActivityChunk({ ...basePayload(ctx), toolActivity: result.toolActivity })
  )
}

function handleTurnBoundary(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Flush any pending text before emitting boundary
  textBatcher.flush(ctx.conversationId)
  safeSend(
    ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTurnBoundary({
      ...basePayload(ctx),
      turnId: chunk.content ?? `turn-${Date.now()}`
    })
  )
}

/** Patterns indicating server-side overload/outage */
const OVERLOAD_PATTERNS = [/529/i, /overloaded/i, /server_is_overloaded/i, /503 Service/i]

function handleError(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Flush pending text before error
  textBatcher.flush(ctx.conversationId)

  // Detect server overload errors and format with friendly message
  const isOverload = chunk.error && OVERLOAD_PATTERNS.some((p) => p.test(chunk.error!))
  const errorText = isOverload
    ? '\n\n**API Error: 529 Overloaded.** This is a server-side issue, usually temporary — try again in a moment. If it persists, check [status.claude.com](https://status.claude.com).'
    : `\n\n**Error:** ${chunk.error}`

  ctx.contentAccumulator.value += errorText
  safeSend(
    ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTextChunk({ ...basePayload(ctx), text: errorText })
  )
}

function handleStatus(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Flush pending text before status messages
  textBatcher.flush(ctx.conversationId)
  if (!chunk.content || chunk.content === 'heartbeat') return
  const statusText = `\n\n_${chunk.content}_\n\n`
  ctx.contentAccumulator.value += statusText
  safeSend(
    ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTextChunk({ ...basePayload(ctx), text: statusText })
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
  safeSend(
    ctx,
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

// F4: LSP diagnostics handler — forwards compiler/linter errors from OpenCode to renderer
function handleLspDiagnostics(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.lspDiagnostics) return
  safeSend(ctx, IPC_CHANNELS.SDK_LSP_DIAGNOSTICS, {
    ...basePayload(ctx),
    diagnostics: chunk.lspDiagnostics
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

/** Generate a unique ID for sub-agent tool activities (not part of processToolChunk pipeline) */
function generateSubagentId(prefix: string, existingId?: string | null): string {
  if (existingId) return existingId
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ── SubAgent lifecycle handlers ──
// These map the subagent_* chunks from stream-normalizer into tool activity
// events so sub-agent work appears in the tool activity panel.
// Text content is dual-emitted: as a chat bubble text chunk AND a truncated
// tool activity entry, so prose is readable while the accordion shows a summary.

function handleSubagentStart(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  const activity = {
    id: generateSubagentId('subagent', chunk.toolId),
    toolName: chunk.toolName ?? 'Agent',
    status: 'running' as const,
    input: chunk.content ? truncate(chunk.content, 80) : undefined,
    startedAt: Date.now()
  }
  accumulateToolActivity(ctx.conversationId, activity)

  // Emit tool activity for the accordion (short summary only)
  safeSend(
    ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createToolActivityChunk({ ...basePayload(ctx), toolActivity: activity })
  )
}

function handleSubagentProgress(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  const content = chunk.content ?? ''

  // If the progress content looks like actual text output (not just a status label),
  // emit it as chat text so it renders in the message bubble, not just the tool accordion.
  if (content.length > 20 && !isStatusLabel(content)) {
    ctx.contentAccumulator.value += content
    safeSend(
      ctx,
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({
        ...basePayload(ctx),
        text: content,
        phase: ctx.phase
      })
    )
  }

  // Accumulate for DB persistence (captures intermediate result text)
  const activity = {
    id: generateSubagentId('subagent', chunk.toolId),
    toolName: chunk.toolName ?? 'Agent',
    status: 'running' as const,
    result: truncate(content, 80)
  }
  accumulateToolActivity(ctx.conversationId, activity)

  safeSend(
    ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createToolActivityChunk({ ...basePayload(ctx), toolActivity: activity })
  )
}

function handleSubagentComplete(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  const content = chunk.content ?? ''

  // Emit long completion text as bubble content
  if (content.length > 20 && !isStatusLabel(content)) {
    ctx.contentAccumulator.value += content
    safeSend(
      ctx,
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({
        ...basePayload(ctx),
        text: content,
        phase: ctx.phase
      })
    )
  }

  // Tool activity: mark as complete with short summary
  const activity = {
    id: generateSubagentId('subagent', chunk.toolId),
    toolName: 'Agent',
    status: (chunk.toolInput === 'completed' ? 'completed' : 'error') as 'completed' | 'error',
    result: truncate(content, 80),
    completedAt: Date.now()
  }
  accumulateToolActivity(ctx.conversationId, activity)

  safeSend(
    ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createToolActivityChunk({ ...basePayload(ctx), toolActivity: activity })
  )
}

// ── Permission request handler ──

// N4: handleToolUseSummary removed — tool summaries already flow through tool_result
// in the tool activity accordion. The dedicated SDK_TOOL_USE_SUMMARY IPC channel was vestigial.

function handlePermissionRequest(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.permissionRequest) return
  safeSend(ctx, IPC_CHANNELS.PERMISSION_REQUEST, {
    ...basePayload(ctx),
    ...chunk.permissionRequest
  })
}

// ── Dispatch table ──

function handleStructuredOutput(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.content) return
  // Accumulate as text for backend consumers
  ctx.contentAccumulator.value += chunk.content
  // Forward as text (batched) — the structured_output data rides along
  // in the chunk for renderers that support progressive schema rendering.
  pushText(ctx, chunk.content)
}

type ChunkHandler = (ctx: ChunkRouterContext, chunk: StreamChunk) => void

const CHUNK_HANDLERS: Record<string, ChunkHandler> = {
  text: handleText,
  thinking: handleThinking,
  tool_use: handleToolChunk,
  tool_result: handleToolChunk,
  turn_boundary: handleTurnBoundary,
  error: handleError,
  status: handleStatus,
  tool_progress: handleToolChunk,
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
  subagent_complete: handleSubagentComplete,
  structured_output: handleStructuredOutput,
  // N4: tool_use_summary handler removed — summaries flow via tool_result
  permission_request: handlePermissionRequest,
  lsp_diagnostics: handleLspDiagnostics
}

/**
 * Route a StreamChunk to the appropriate handler.
 * Drop-in replacement for forwardChunkToRenderer.
 */
export function routeChunk(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  const handler = CHUNK_HANDLERS[chunk.type]
  if (handler) {
    handler(ctx, chunk)
  } else {
    chatIpcLogger.warn(
      `[chunk-router] Unhandled chunk type: ${chunk.type} ` +
        `(contentLen=${chunk.content?.length ?? 0})`
    )
  }
}

/**
 * Flush any pending batched text deltas immediately.
 * When `conversationId` is provided, only that conversation's buffer is flushed
 * and its flusher callback is cleared. Without it, ALL keys are flushed — which
 * is safe today (single-stream lock) but would leak across conversations if
 * concurrent streams were ever allowed.
 */
export function flushTextBatcher(conversationId?: string): void {
  textBatcher.reset(conversationId)
}
