/**
 * ChunkRouter — dispatches StreamChunk types to focused handler functions.
 * Replaces the 264-line if/else chain in forwardChunkToRenderer.
 */

import { ipcMain, type BrowserWindow } from 'electron'
import type { StreamChunk } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ConversationMode,
  ConversationPhase,
  ToolActivity,
  PlanRecord
} from '../../shared/types'
import { createTextChunk, createToolActivityChunk, createTurnBoundary } from './chat-protocol'
import { processToolChunk } from './tool-chunk-processor'
import { TextDeltaBatcher } from './text-delta-batcher'
import { chatIpcLogger } from '../logger'
import { chunkAckTracker } from './chunk-ack-tracker'
import { todoRepository } from '../db/repositories/todo.repository'
import { planRepository } from '../db/repositories/plan.repository'
import { matchPlanTaskForFile, isPhaseTaskSetComplete } from '../../shared/plan-tasks'

// ── Tool Activity Persistence Accumulator ──────────────────────────────
// Collects completed ToolActivity objects during streaming, keyed by
// conversationId → toolId. Merges tool_use (running) and tool_result
// (completed) by ID so the persisted entry has both startedAt and result.
// Retrieved and cleared by getAndClearToolActivities() during finalize.

const toolActivityStore = new Map<string, Map<string, ToolActivity>>()

// TOOLACTIVITY-STORE-RECREATED-01: Track recently cleared conversations so
// late-arriving chunks don't re-create orphaned Map entries after clear.
const clearedConversations = new Set<string>()

function accumulateToolActivity(
  conversationId: string,
  partial: Partial<ToolActivity> & { id: string; toolName: string }
): void {
  // TOOLACTIVITY-STORE-RECREATED-01: Don't re-create after clear
  if (clearedConversations.has(conversationId)) return

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
 * Record an externally-created tool activity (e.g. Prompt Optimizer) into the
 * accumulator so it persists with the assistant message via the existing
 * getAndClearToolActivities → DB finalize path.
 *
 * Clears the conversation from `clearedConversations` first so the synthetic
 * activity is not silently dropped by the 10s tombstone guard.
 */
export function recordExternalToolActivity(
  conversationId: string,
  activity: Partial<ToolActivity> & { id: string; toolName: string }
): void {
  clearedConversations.delete(conversationId)
  accumulateToolActivity(conversationId, activity)
}

/**
 * Whole-message budget for inline edit diffs. tool-chunk-processor caps each
 * ACTIVITY at 16KB, but a build turn with 40 Edit calls would still put ~640KB
 * of JSON into a single `messages` row, re-parsed on every conversation open.
 */
export const MAX_MESSAGE_EDIT_DIFF_CHARS = 128_000

/**
 * Enforce the per-message editDiffs budget. Walks newest-first so the most
 * recent edits (the ones the user is actually looking at) are kept, and strips
 * diffs off older activities once the budget is spent — the activity itself and
 * its `editDiffsOmitted` count survive, so the UI still shows what was dropped.
 */
export function capEditDiffBudget(
  activities: ToolActivity[],
  budget: number = MAX_MESSAGE_EDIT_DIFF_CHARS
): ToolActivity[] {
  const out = [...activities]
  let used = 0

  for (let i = out.length - 1; i >= 0; i--) {
    const activity = out[i]
    const diffs = activity.editDiffs
    if (!diffs || diffs.length === 0) continue

    const size = diffs.reduce((n, d) => n + d.oldString.length + d.newString.length, 0)
    if (used + size <= budget) {
      used += size
      continue
    }

    const { editDiffs: _dropped, ...rest } = activity
    out[i] = { ...rest, editDiffsOmitted: (activity.editDiffsOmitted ?? 0) + diffs.length }
  }

  return out
}

/**
 * Retrieve and clear accumulated tool activities for a conversation.
 * Called during finalize to persist tool activities to the DB.
 * Returns all activities including 'running' ones (e.g. subagents interrupted mid-execution).
 */
export function getAndClearToolActivities(conversationId: string): ToolActivity[] {
  // TOOLACTIVITY-STORE-RECREATED-01: Block re-creation for 10s after clear
  clearedConversations.add(conversationId)
  setTimeout(() => clearedConversations.delete(conversationId), 10_000)

  const convMap = toolActivityStore.get(conversationId)
  toolActivityStore.delete(conversationId)
  if (!convMap) return []
  return capEditDiffBudget([...convMap.values()])
}

// ── Shared context passed to all handlers ──

export interface ChunkRouterContext {
  mainWindow: BrowserWindow
  conversationId: string
  role: 'specialist'
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

/**
 * How a stream ended. Used for metrics aggregation.
 *
 *   complete   — LLM finished naturally (message_stop received)
 *   completed  — User/system marked the conversation as done
 *   stopped    — User manually stopped the response mid-stream
 *   swapped    — Specialist swap interrupted the stream
 *   aborted    — System abort (workspace switch, conversation deleted, safety timeout cleanup)
 *   error      — Unrecoverable stream error
 *   timeout       — Safety timeout fired before LLM responded
 *   max-lifetime  — Stream exceeded absolute hard cap (MAX_STREAM_LIFETIME_MS)
 */
type StreamOutcome =
  | 'complete'
  | 'stopped'
  | 'error'
  | 'timeout'
  | 'aborted'
  | 'completed'
  | 'swapped'
  | 'max-lifetime'

interface StreamMetrics {
  startedAt: number
  firstTokenAt: number | null
  lastChunkAt: number | null
  chunkCount: number
  totalChars: number
  maxITL: number // max inter-token latency (ms)
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

  /**
   * Fraction of streams that ended successfully (0–1).
   * Counts 'complete' (natural finish) and 'completed' (user-finished) as success.
   * User-initiated interruptions (stopped, swapped, aborted) are neutral — not failures.
   */
  get completionRate(): number {
    if (this.records.length === 0) return 1
    return (
      this.records.filter((r) => r.outcome === 'complete' || r.outcome === 'completed').length /
      this.records.length
    )
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
    const counts: Record<StreamOutcome, number> = {
      complete: 0,
      stopped: 0,
      error: 0,
      timeout: 0,
      completed: 0,
      aborted: 0,
      swapped: 0,
      'max-lifetime': 0
    }
    for (const r of this.records) counts[r.outcome]++
    return counts
  }

  /**
   * Fraction of streams that ended with 'error' or 'timeout' outcome (0–1).
   * Per Zylos Research recommendation: track connection reset rate with < 0.5% target.
   * Streams interrupted without a message_stop event are classified as resets.
   */
  get connectionResetRate(): number {
    if (this.records.length === 0) return 0
    const resets = this.records.filter(
      (r) => r.outcome === 'error' || r.outcome === 'timeout'
    ).length
    return resets / this.records.length
  }
}

const streamMetricsStore = new Map<string, StreamMetrics>()
const streamAggregator = new StreamMetricsAggregator()

/** Begin tracking metrics for a new stream. */
export function startStreamMetrics(conversationId: string): void {
  streamMetricsStore.set(conversationId, {
    startedAt: Date.now(),
    firstTokenAt: null,
    lastChunkAt: null,
    chunkCount: 0,
    totalChars: 0,
    maxITL: 0
  })
}

/**
 * Log final stream metrics, record into the sliding-window aggregator, and clean up.
 * @param outcome - How the stream ended: 'complete' | 'stopped' | 'error' | 'timeout'
 */
export function completeStreamMetrics(conversationId: string, outcome: StreamOutcome): void {
  const metrics = streamMetricsStore.get(conversationId)
  streamMetricsStore.delete(conversationId)
  if (!metrics) return

  const duration = Date.now() - metrics.startedAt
  const ttft = metrics.firstTokenAt ? metrics.firstTokenAt - metrics.startedAt : null

  // Record into sliding-window aggregator
  streamAggregator.record(outcome, ttft, duration)

  // IPC-BACKPRESSURE: Collect backpressure metrics for this stream
  const bp = chunkAckTracker.getMetrics(conversationId)

  chatIpcLogger.info(
    `[METRIC:STREAM_COMPLETE] ` +
      `outcome=${outcome} duration=${duration}ms ttft=${ttft}ms ` +
      `maxITL=${metrics.maxITL}ms chunks=${metrics.chunkCount} chars=${metrics.totalChars} ` +
      `conversationId=${conversationId.slice(0, 8)} ` +
      `completionRate=${(streamAggregator.completionRate * 100).toFixed(1)}% ` +
      `ttftP95=${streamAggregator.ttftP95}ms ` +
      `sampleSize=${streamAggregator.sampleSize} ` +
      `backpressureActivations=${bp.backpressureActivations} ` +
      `avgAckLatency=${bp.avgAckLatency}ms ` +
      `maxPending=${bp.maxPendingChunks}`
  )

  // Clean up backpressure tracking for this stream
  chunkAckTracker.cleanup(conversationId)
  chunkAckTracker.clearMetrics(conversationId)
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
  // IPC-BACKPRESSURE: Pass the adaptive interval to the batcher. When the
  // renderer is under pressure (pending > HWM), the interval widens from
  // 33ms (~30fps) to 100ms (~10fps), giving React more breathing room.
  const interval = chunkAckTracker.getRecommendedInterval(ctx.conversationId)
  textBatcher.push(
    ctx.conversationId,
    text,
    (buffer) => {
      safeSend(
        ctx,
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createTextChunk({ ...basePayload(ctx), text: buffer, phase: ctx.phase })
      )
      // Record send for backpressure tracking
      chunkAckTracker.recordSend(ctx.conversationId)
    },
    interval
  )
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
  role: 'specialist'
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

/**
 * Regex matching raw JSON control signals that local LLM backends
 * (Ollama/oMLX) emit as text deltas instead of structured events.
 * Only matches when the ENTIRE chunk content is the JSON object.
 */
const LOCAL_CONTROL_SIGNAL_RE = /^\s*\{\s*"type"\s*:\s*"(?:busy|idle|ready|processing)"\s*\}\s*$/

function handleText(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.content) return

  // CONTROL-SIGNAL-FILTER-01: Local LLM backends may leak raw JSON control
  // signals (e.g. {"type":"busy"}) as text deltas. Drop them silently.
  if (LOCAL_CONTROL_SIGNAL_RE.test(chunk.content)) {
    chatIpcLogger.debug('[chunk-router] Filtered control signal in text: %s', chunk.content)
    return
  }
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
    if (metrics.lastChunkAt !== null) {
      const itl = Date.now() - metrics.lastChunkAt
      metrics.maxITL = Math.max(metrics.maxITL, itl)
    }
    metrics.lastChunkAt = Date.now()
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
  // F-20: Flush pending batched text before thinking IPC send.
  // Prevents minor reorder if thinking and text chunks interleave.
  // Consistent with handleToolChunk, handleError, and handleStatus.
  textBatcher.flush(ctx.conversationId)
  const thinkingText = `\n\n<details>\n<summary>💭 Reasoning</summary>\n\n${chunk.content}\n\n</details>\n\n`
  ctx.contentAccumulator.value += thinkingText
  safeSend(
    ctx,
    IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
    createTextChunk({ ...basePayload(ctx), text: thinkingText, phase: ctx.phase })
  )
}

function handleToolChunk(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Flush pending text before tool activity (tool_use and tool_result start/end a visual block)
  if (chunk.type === 'tool_use' || chunk.type === 'tool_result')
    textBatcher.flush(ctx.conversationId)

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

  // TASK-DERIVE-01: Derive task completion from OBSERVED write/edit activity
  // (main-owned, DB-backed) instead of relying solely on the model
  // self-reporting via emit_phase_progress. Fires only on tool_result (the
  // operation actually completed, not just started) for successful write/edit
  // ops — this is what lets a phase the model never reported on still show
  // accurate progress, mirroring how BlueprintBuildService derives task
  // status from its own wave loop rather than trusting the model.
  if (
    chunk.type === 'tool_result' &&
    result.toolActivity.status !== 'error' &&
    result.toolActivity.filePath &&
    (result.toolActivity.operationType === 'write' || result.toolActivity.operationType === 'edit')
  ) {
    try {
      derivePlanTaskFromFileActivity(ctx, result.toolActivity.filePath)
    } catch (err) {
      chatIpcLogger.warn(`[chunk-router] Task derivation failed: ${(err as Error).message}`)
    }
  }
}

// ── Active-plan lookup cache (per conversation) ──────────────────────
// A file-heavy build fires derivePlanTaskFromFileActivity once per
// write/edit tool_result — findActiveByConversationId on every single one
// is wasted work, since the plan's structuredPlan (title/phases/files) is
// immutable for the life of a build; only its phase_progress_json changes,
// which is still always read fresh (never cached) for correctness. Short
// TTL bounds staleness if the user starts a brand-new plan mid-conversation
// without needing cross-module cache invalidation wiring.
const ACTIVE_PLAN_CACHE_TTL_MS = 5000
const activePlanCache = new Map<string, { plan: PlanRecord; cachedAt: number }>()

function getCachedActivePlan(conversationId: string): PlanRecord | null {
  const cached = activePlanCache.get(conversationId)
  if (cached && Date.now() - cached.cachedAt < ACTIVE_PLAN_CACHE_TTL_MS) {
    return cached.plan
  }
  const plan = planRepository.findActiveByConversationId(conversationId)
  if (plan) {
    activePlanCache.set(conversationId, { plan, cachedAt: Date.now() })
  } else {
    activePlanCache.delete(conversationId)
  }
  return plan
}

/**
 * Match a touched file against the conversation's persisted plan and, on a
 * unique match, promote that task to 'complete' and its phase to
 * 'in_progress' (never regressing a phase past 'pending'). Emits a synthetic
 * phaseProgress chunk so the renderer converges on the same state the DB now
 * holds, whether or not the model itself called emit_phase_progress.
 */
function derivePlanTaskFromFileActivity(ctx: ChunkRouterContext, filePath: string): void {
  const plan = getCachedActivePlan(ctx.conversationId)
  if (!plan) return

  const match = matchPlanTaskForFile(plan.structuredPlan, filePath)
  if (!match) return

  const existingProgress = planRepository.getPhaseProgress(plan.id)
  const currentPhase = existingProgress.find((p) => p.phaseId === match.phaseId)
  let nextPhaseStatus: 'started' | 'in_progress' | 'completed' | 'failed' | 'skipped' =
    !currentPhase || currentPhase.status === 'pending'
      ? 'in_progress'
      : (currentPhase.status as 'started' | 'in_progress' | 'completed' | 'failed' | 'skipped')

  planRepository.updatePhaseProgress(
    plan.id,
    match.phaseId,
    nextPhaseStatus,
    undefined,
    [match.touchedFile],
    { taskId: match.taskId, title: match.taskTitle, status: 'complete' }
  )

  // Auto-finalize the phase once every DECLARED task in it (the full
  // manifest, not just whatever's been recorded so far) has reached a
  // terminal status. Without this, an execution the model never explicitly
  // completed stays "in progress" forever — handleMessageComplete's allDone
  // check requires every phase to reach completed/skipped/failed before the
  // panel goes read-only and memory extraction fires. 'failed' phases are
  // never auto-promoted — a task landing after a failure doesn't undo it.
  if (nextPhaseStatus !== 'completed' && nextPhaseStatus !== 'failed') {
    const refreshedPhase = planRepository
      .getPhaseProgress(plan.id)
      .find((p) => p.phaseId === match.phaseId)
    if (isPhaseTaskSetComplete(plan.structuredPlan, match.phaseId, refreshedPhase?.tasks ?? [])) {
      nextPhaseStatus = 'completed'
      planRepository.updatePhaseProgress(plan.id, match.phaseId, 'completed')
    }
  }

  safeSend(ctx, IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
    ...basePayload(ctx),
    chunk: '',
    phaseProgress: {
      planId: plan.id,
      phaseId: match.phaseId,
      phaseTitle: match.phaseTitle,
      status: nextPhaseStatus,
      totalPhases: plan.structuredPlan.phases?.length ?? 0,
      taskId: match.taskId,
      taskTitle: match.taskTitle,
      taskStatus: 'complete',
      totalTasks: match.totalTasksInPhase
    }
  })
}

function handleTurnBoundary(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Flush any pending text before emitting boundary
  textBatcher.flush(ctx.conversationId)
  // The renderer splits bubbles on this boundary, but the accumulator is what
  // gets persisted — without a separator the fragments either side of a tool
  // call fuse into one run-on sentence when the conversation is reloaded.
  if (ctx.contentAccumulator.value && !ctx.contentAccumulator.value.endsWith('\n\n')) {
    ctx.contentAccumulator.value += '\n\n'
  }
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

/**
 * Status content patterns that are internal metadata — never rendered in chat.
 * These are operational lifecycle events emitted by the OpenCode event normalizer.
 *
 * MAINTENANCE: Keep in sync with status-emitting handlers in
 * src/main/services/opencode-event-normalizer.ts:
 *
 *   Prefix               Emitter
 *   ───────────────────   ──────────────────────────────
 *   agent_switched:       handleAgentSwitched()
 *   model_switched:       handleModelSwitched()
 *   finishReason:         handleSessionIdle()
 *
 *   Value                 Emitter
 *   ───────────────────   ──────────────────────────────
 *   idle                  handleSessionStatus() → statusMap
 *   thinking              handleSessionStatus() → statusMap
 *   reviewing             handleSessionStatus() → statusMap
 *   writing               handleSessionStatus() → statusMap
 *   failed                handleSessionStatus() → statusMap
 */
const SUPPRESSED_STATUS_PREFIXES = ['agent_switched:', 'model_switched:', 'finishReason:'] as const

const SUPPRESSED_STATUS_VALUES: ReadonlySet<string> = new Set([
  'idle',
  'busy', // local LLM backend status signal
  'thinking',
  'reviewing',
  'writing',
  'failed'
])

function handleStatus(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Flush pending text before status messages
  textBatcher.flush(ctx.conversationId)
  if (!chunk.content) return

  // HEARTBEAT-KEEPALIVE: the executor emits this between NDJSON messages purely
  // to prove the CLI is alive (cli-executor.ts, HeartbeatMonitor). It must not
  // render as text, but dropping it discarded the one liveness signal that
  // tracks real CLI output — leaving the renderer's watchdog dependent on a 30s
  // setInterval that main-thread indexing can starve. Forward it as a keepalive
  // instead: handleMessageChunk's `data.keepalive` branch consumes it and
  // returns before any rendering.
  if (chunk.content === 'heartbeat') {
    safeSend(ctx, IPC_CHANNELS.CHAT_MESSAGE_CHUNK, { ...basePayload(ctx), keepalive: true })
    return
  }

  // Guard: non-string content (e.g., object coerced via template literal)
  if (typeof chunk.content !== 'string') return

  // Suppress internal metadata status — these are operational signals,
  // not conversational content. They come from the OpenCode event normalizer.
  if (
    SUPPRESSED_STATUS_VALUES.has(chunk.content) ||
    SUPPRESSED_STATUS_PREFIXES.some((p) => chunk.content!.startsWith(p)) ||
    LOCAL_CONTROL_SIGNAL_RE.test(chunk.content)
  ) {
    chatIpcLogger.debug('[chunk-router] Suppressed metadata status: %s', chunk.content)
    return
  }

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

const MAX_SESSION_STATE_CHARS = 1_000_000 // 1MB safety net

function handleSessionState(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  let state = chunk.content ?? ''

  if (state.length > MAX_SESSION_STATE_CHARS) {
    chatIpcLogger.warn(
      '[chunk-router] Session state exceeds %d chars (%d); truncating',
      MAX_SESSION_STATE_CHARS,
      state.length
    )
    state = state.slice(0, MAX_SESSION_STATE_CHARS)
  }

  safeSend(ctx, IPC_CHANNELS.SDK_SESSION_STATE, {
    ...basePayload(ctx),
    state
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
  // Full-snapshot sync from Claude CLI's TodoWrite tool — replaces the whole
  // list rather than applying an incremental patch. See StreamChunk.todoSync.
  if (chunk.todoSync) {
    safeSend(ctx, IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      ...basePayload(ctx),
      chunk: '',
      todoSync: chunk.todoSync
    })
    try {
      todoRepository.syncTodos(ctx.conversationId, chunk.todoSync)
    } catch (err) {
      chatIpcLogger.warn(`[chunk-router] Failed to persist todo sync: ${(err as Error).message}`)
    }
    return
  }

  if (!chunk.todoUpdate) return
  safeSend(ctx, IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
    ...basePayload(ctx),
    chunk: '',
    todoUpdate: chunk.todoUpdate
  })

  // Persist to DB so todos survive app restart
  const { action, text, index } = chunk.todoUpdate
  try {
    switch (action) {
      case 'add':
        todoRepository.saveTodo(ctx.conversationId, text, index)
        break
      case 'complete':
        todoRepository.completeTodo(ctx.conversationId, text, index)
        break
      case 'remove':
        todoRepository.removeTodo(ctx.conversationId, text, index)
        break
    }
  } catch (err) {
    chatIpcLogger.warn(`[chunk-router] Failed to persist todo: ${(err as Error).message}`)
  }
}

function handlePhaseProgress(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  if (!chunk.phaseProgress) return
  safeSend(ctx, IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
    ...basePayload(ctx),
    chunk: '',
    phaseProgress: chunk.phaseProgress
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

function handleTurnLimit(ctx: ChunkRouterContext, chunk: StreamChunk): void {
  // Flush pending text before the turn-limit card
  textBatcher.flush(ctx.conversationId)

  // Emit text fallback (the markdown message) for content accumulation
  const text = chunk.content ?? ''
  if (text) {
    ctx.contentAccumulator.value += text
    safeSend(
      ctx,
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({ ...basePayload(ctx), text, phase: ctx.phase })
    )
  }

  // Emit the structured turnLimit payload so the renderer can show a Continue button
  if (chunk.turnLimit) {
    safeSend(ctx, IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      ...basePayload(ctx),
      chunk: '',
      turnLimit: chunk.turnLimit
    })
  }
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
  phase_progress: handlePhaseProgress,
  subagent_start: handleSubagentStart,
  subagent_progress: handleSubagentProgress,
  subagent_complete: handleSubagentComplete,
  structured_output: handleStructuredOutput,
  // N4: tool_use_summary handler removed — summaries flow via tool_result
  permission_request: handlePermissionRequest,
  lsp_diagnostics: handleLspDiagnostics,
  turn_limit: handleTurnLimit
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

// ── Stream Diagnostics IPC ────────────────────────────────────────────
// Exposes the StreamMetricsAggregator data via IPC so the renderer
// (future Performance tab, dev tools) can read streaming SLO metrics.

import { validateSender } from './validate-sender'

export function registerStreamDiagnosticsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.STREAM_METRICS_GET, (event) => {
    validateSender(event)
    return {
      completionRate: streamAggregator.completionRate,
      connectionResetRate: streamAggregator.connectionResetRate,
      ttftP50: streamAggregator.ttftPercentile(0.5),
      ttftP95: streamAggregator.ttftP95,
      ttftP99: streamAggregator.ttftPercentile(0.99),
      sampleSize: streamAggregator.sampleSize,
      outcomeCounts: streamAggregator.outcomeCounts
    }
  })

  // IPC-BACKPRESSURE: Renderer sends ACK after processing a batch of chunks.
  // This feeds the adaptive batcher interval adjustment.
  ipcMain.on(
    IPC_CHANNELS.CHAT_CHUNK_ACK,
    (
      _event,
      data: { processed: number; timestamp: number; perConversation?: Record<string, number> }
    ) => {
      if (data.perConversation) {
        // Phase-2: Per-conversation ACK routing — backpressure tracked independently
        for (const [convId, count] of Object.entries(data.perConversation)) {
          chunkAckTracker.recordAck(convId, count)
        }
      } else {
        // Backward compat fallback for old renderers
        chunkAckTracker.recordAck('__global__', data.processed)
      }
    }
  )
}
