/**
 * OpenCodeEventNormalizer — maps OpenCode SSE events to StreamChunks.
 * Extracted from the 438-line normalizeEvent switch statement in opencode-executor.ts.
 *
 * Each handler method is focused on a single event type (5-30 lines each).
 */

import type { StreamChunk } from './agent-base.service'
import { summarizeToolInput } from './index'
import { extractResultSummary } from '../ipc/tool-result-summarizer'
import log from 'electron-log/main'

const openCodeLog = log.scope('OpenCode')

/**
 * Matches raw JSON control signals from local LLM backends that leak
 * into text deltas. These should never reach the chunk-router as text.
 */
const LOCAL_CONTROL_SIGNAL_RE = /^\s*\{\s*"type"\s*:\s*"(?:busy|idle|ready|processing)"\s*\}\s*$/

/** GAP-11: Transient error patterns — mirrors TRANSIENT_ERROR_PATTERNS from executor */
const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /overloaded/i,
  /server_is_overloaded/i,
  /too many requests/i,
  /503/,
  /429/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /network/i,
  /timeout/i,
  // SSE-TIMEOUT FIX: spaced/hyphenated/underscored forms ("timed out",
  // "timed-out", "timed_out") — mirrors the executor's TRANSIENT_ERROR_PATTERNS
  // so SSE read stalls show as api_retry in the UI instead of a hard error.
  /timed[\s_-]?out/i
]

/**
 * R7: Route inline <think>...</think> blocks to thinking chunks.
 * Local LLMs (Qwen, DeepSeek) emit chain-of-thought wrapped in <think> tags
 * inside regular text deltas. This function splits text on tag boundaries,
 * routing content inside tags to 'thinking' chunks and content outside to 'text'.
 *
 * Handles: whole-tag-per-delta, tag split across deltas, mixed content.
 */
function routeThinkTags(text: string, state: NormalizerState): StreamChunk[] {
  const chunks: StreamChunk[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (state.inThinkBlock) {
      // Currently inside a <think> block — look for </think>
      const closeIdx = remaining.indexOf('</think>')
      if (closeIdx === -1) {
        // Entire remaining text is thinking content
        chunks.push({ type: 'thinking', content: remaining })
        state.lastPartType = 'thinking'
        remaining = ''
      } else {
        // Emit thinking content before the close tag
        const thinkContent = remaining.slice(0, closeIdx)
        if (thinkContent) {
          chunks.push({ type: 'thinking', content: thinkContent })
          state.lastPartType = 'thinking'
        }
        state.inThinkBlock = false
        remaining = remaining.slice(closeIdx + '</think>'.length)
      }
    } else {
      // Not in a think block — look for <think>
      const openIdx = remaining.indexOf('<think>')
      if (openIdx === -1) {
        // No think tag — emit as regular text with boundary detection
        if (state.lastPartType === 'thinking' && state.hasPriorText) {
          chunks.push({ type: 'turn_boundary', content: `thinking-split-${Date.now()}` })
        }
        chunks.push({ type: 'text', content: remaining })
        state.lastPartType = 'text'
        state.hasPriorText = true
        remaining = ''
      } else {
        // Emit text before the open tag
        const beforeThink = remaining.slice(0, openIdx)
        if (beforeThink) {
          if (state.lastPartType === 'thinking' && state.hasPriorText) {
            chunks.push({ type: 'turn_boundary', content: `thinking-split-${Date.now()}` })
          }
          chunks.push({ type: 'text', content: beforeThink })
          state.lastPartType = 'text'
          state.hasPriorText = true
        }
        state.inThinkBlock = true
        remaining = remaining.slice(openIdx + '<think>'.length)
      }
    }
  }

  return chunks
}

/** Token usage tracker passed into normalizeEvent */
export interface ExecutorTokenUsage {
  input: number
  output: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/** State references from the OpenCodeExecutor that handlers may need */
export interface NormalizerState {
  childSessions: Map<string, Set<string>>
  sessionMap: Map<string, string>
  serverReadyResolve?: () => void
  /** 6C-2: Last known finish reason from session.updated events */
  lastFinishReason?: string
  /** GAP-12: Last emitted context usage percentage — avoids flooding UI with micro-updates */
  lastContextPercentage?: number
  /** F16: Track last part type for turn boundary detection */
  lastPartType?: 'text' | 'thinking' | 'tool'
  /** F16: Whether we've seen text content before (for thinking→text boundary) */
  hasPriorText?: boolean
  /** R5: Dedupe — callIDs for which we already emitted tool_use */
  emittedToolUse?: Set<string>
  /** R5: Dedupe — callIDs for which we already emitted tool_result */
  emittedToolResult?: Set<string>
  /** R7: Whether we're inside an inline <think>...</think> block (local LLM reasoning) */
  inThinkBlock?: boolean
}

type EventProperties = Record<string, unknown>

type EventHandler = (
  properties: EventProperties,
  sessionId: string,
  tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
) => StreamChunk[]

// ── Per-part-type sub-handlers for message.part.updated ──

/** Handle text part — includes thinking→text turn boundary detection (F16) + inline <think> routing (R7). */
function handleTextPart(part: Record<string, unknown>, state: NormalizerState): StreamChunk[] {
  const text = part.content as string | undefined
  if (!text) return []

  // CONTROL-SIGNAL-FILTER-02: Drop raw JSON control signals from local backends
  if (LOCAL_CONTROL_SIGNAL_RE.test(text)) {
    openCodeLog.debug('[opencode] Filtered control signal in text part: %s', text.slice(0, 60))
    return []
  }

  // R7: Route inline <think> blocks to thinking chunks (local LLMs like Qwen)
  return routeThinkTags(text, state)
}

/** Handle tool-invocation part — call, partial (streaming args), and result sub-states. */
function handleToolInvocationPart(
  part: Record<string, unknown>,
  state: NormalizerState
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  const toolName = part.toolName as string | undefined
  const toolId = part.toolCallId as string | undefined
  // N1: Renamed from `state` to avoid shadowing the NormalizerState parameter
  const invocationState = part.state as string | undefined

  if (invocationState === 'call' && toolName) {
    state.lastPartType = 'tool'
    chunks.push({ type: 'tool_use', toolName, toolId })
  }

  if (invocationState === 'partial' && toolName) {
    const partialArgs = part.args as Record<string, unknown> | undefined
    if (partialArgs) {
      const inputPreview = summarizeToolInput(toolName, partialArgs)
      if (inputPreview) {
        chunks.push({
          type: 'tool_progress',
          toolName,
          toolId,
          toolInput: inputPreview,
          content: `${toolName}: ${inputPreview}`
        })
      }
    }
  }

  if (invocationState === 'result') {
    const result = part.result as string | undefined
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
    chunks.push({
      type: 'tool_result',
      toolName: toolName ?? 'unknown',
      toolId,
      content: resultStr
    })

    // Generate a human-readable tool_use_summary
    const toolNameStr = toolName ?? 'unknown'
    const resultSummaryObj = extractResultSummary(toolNameStr, resultStr)
    let inputSummary: string | undefined
    const toolInput = part.args as Record<string, unknown> | undefined
    if (toolInput) inputSummary = summarizeToolInput(toolNameStr, toolInput)

    if (resultSummaryObj?.result || inputSummary) {
      chunks.push({
        type: 'tool_use_summary',
        toolName: toolNameStr,
        toolId,
        content: [
          inputSummary ? `Input: ${inputSummary}` : '',
          resultSummaryObj?.result ? `Result: ${resultSummaryObj.result}` : ''
        ]
          .filter(Boolean)
          .join(' — ')
      })
    }
  }

  return chunks
}

/**
 * Handle thinking / reasoning part — both map to the 'thinking' chunk type.
 * 6C-1: 'reasoning' / 'reasoning-delta' treated identically to 'thinking'.
 */
function handleThinkingPart(part: Record<string, unknown>, state: NormalizerState): StreamChunk[] {
  const content = part.content as string | undefined
  if (!content) return []
  state.lastPartType = 'thinking'
  return [{ type: 'thinking', content }]
}

/**
 * R5: Handle modern SDK ToolPart shape:
 *   { type: 'tool', tool: string, callID: string, state: { status, input, output, error } }
 *
 * message.part.updated fires a full snapshot on every status transition
 * (pending → running → completed). We dedupe via emittedToolUse / emittedToolResult
 * sets so each callID emits exactly one tool_use and one tool_result.
 */
function handleToolPart(part: Record<string, unknown>, state: NormalizerState): StreamChunk[] {
  const toolName = part.tool as string | undefined
  const callID = part.callID as string | undefined
  const toolState = part.state as Record<string, unknown> | undefined
  if (!toolName || !callID || !toolState) return []

  const status = (toolState.status ?? toolState) as string
  const chunks: StreamChunk[] = []

  // Lazily initialise dedupe sets
  if (!state.emittedToolUse) state.emittedToolUse = new Set()
  if (!state.emittedToolResult) state.emittedToolResult = new Set()

  // ── tool_use (first sighting with input) ──
  // R6-A2: Only emit on 'running', 'completed', or 'error'. 'pending' snapshots have
  // incomplete/empty args that would permanently capture {} as the tool input.
  if (!state.emittedToolUse.has(callID) && status !== 'pending') {
    const input = toolState.input as Record<string, unknown> | string | undefined
    const hasInput = input !== undefined && input !== null
    state.emittedToolUse.add(callID)
    state.lastPartType = 'tool'
    chunks.push({
      type: 'tool_use',
      toolName,
      toolId: callID,
      toolInput: hasInput ? (typeof input === 'string' ? input : JSON.stringify(input)) : undefined
    })
  }

  // ── tool_result (on completed / error) ──
  if ((status === 'completed' || status === 'error') && !state.emittedToolResult.has(callID)) {
    state.emittedToolResult.add(callID)

    const output = (status === 'error' ? toolState.error : toolState.output) as string | undefined
    const resultStr = typeof output === 'string' ? output : JSON.stringify(output ?? '')

    chunks.push({
      type: 'tool_result',
      toolName,
      toolId: callID,
      content: resultStr
    })

    // Generate a human-readable tool_use_summary (mirrors legacy tool-invocation logic)
    const resultSummaryObj = extractResultSummary(toolName, resultStr)
    let inputSummary: string | undefined
    const rawInput = toolState.input as Record<string, unknown> | undefined
    if (rawInput && typeof rawInput === 'object') {
      inputSummary = summarizeToolInput(toolName, rawInput)
    }

    if (resultSummaryObj?.result || inputSummary) {
      chunks.push({
        type: 'tool_use_summary',
        toolName,
        toolId: callID,
        content: [
          inputSummary ? `Input: ${inputSummary}` : '',
          resultSummaryObj?.result ? `Result: ${resultSummaryObj.result}` : ''
        ]
          .filter(Boolean)
          .join(' — ')
      })
    }
  }

  return chunks
}

/** GAP-9: Handle structured_output / structured-output part. */
function handleStructuredOutputPart(part: Record<string, unknown>): StreamChunk[] {
  const data = part.content ?? part.data ?? part.result
  if (!data) return []
  return [
    {
      type: 'structured_output',
      structuredOutput: {
        data,
        schemaName: part.schemaName as string | undefined
      },
      content: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    }
  ]
}

// ── Per-event-type handler functions ──

/**
 * Handle message.part.delta — lightweight text/reasoning streaming deltas.
 * Replaces full message.part.updated snapshots for incremental text in OpenCode ≥1.17.
 */
function handleMessagePartDelta(
  properties: EventProperties,
  _sessionId: string,
  _tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  const field = properties.field as string | undefined
  const delta = properties.delta as string | undefined
  if (!delta) return []

  if (field === 'text') {
    // CONTROL-SIGNAL-FILTER-02: Drop raw JSON control signals from local backends
    if (LOCAL_CONTROL_SIGNAL_RE.test(delta)) {
      openCodeLog.debug('[opencode] Filtered control signal in text delta: %s', delta.slice(0, 60))
      return []
    }
    // R7: Route inline <think> blocks to thinking chunks (local LLMs like Qwen)
    return routeThinkTags(delta, state)
  }

  if (field === 'reasoning' || field === 'thinking') {
    state.lastPartType = 'thinking'
    return [{ type: 'thinking', content: delta }]
  }

  // Unknown field — log but don't drop
  openCodeLog.info(`[opencode] message.part.delta field="${field}" (not text/reasoning)`)
  return []
}

/** Dispatcher for message.part.updated — delegates to per-part-type sub-handlers. */
function handleMessagePartUpdated(
  properties: EventProperties,
  _sessionId: string,
  _tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  const part = properties.part as Record<string, unknown> | undefined
  if (!part?.type) return []

  switch (part.type) {
    case 'text':
      return handleTextPart(part, state)
    case 'tool-invocation':
      return handleToolInvocationPart(part, state)
    case 'tool':
      return handleToolPart(part, state)
    case 'thinking':
    case 'reasoning':
    case 'reasoning-delta':
      return handleThinkingPart(part, state)
    case 'structured_output':
    case 'structured-output':
      return handleStructuredOutputPart(part)
    default:
      return []
  }
}

function handleSessionUpdated(
  properties: EventProperties,
  _sessionId: string,
  tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  const usage = properties.usage as Record<string, number> | undefined
  if (usage) {
    tokenUsage.input = usage.inputTokens ?? tokenUsage.input
    tokenUsage.output = usage.outputTokens ?? tokenUsage.output
    tokenUsage.cacheReadInputTokens = usage.cacheReadInputTokens ?? tokenUsage.cacheReadInputTokens
    tokenUsage.cacheCreationInputTokens =
      usage.cacheCreationInputTokens ?? tokenUsage.cacheCreationInputTokens
  }

  // GAP-12: Emit per-turn context usage updates.
  // Context consumption = fresh input + cache reads + cache writes, matching
  // Claude Code / agent-stream-processor. Using usage.inputTokens alone misses
  // cached tokens (often the bulk of the window) and under-reported usage.
  const contextTokens =
    (usage?.inputTokens ?? 0) +
    (usage?.cacheReadInputTokens ?? 0) +
    (usage?.cacheCreationInputTokens ?? 0)
  if (contextTokens > 0 && usage?.contextWindowSize) {
    const percentage = Math.round((contextTokens / usage.contextWindowSize) * 100)
    state.lastContextPercentage = percentage
    chunks.push({
      type: 'context_usage_update',
      contextUsageUpdate: {
        inputTokens: contextTokens,
        contextWindowSize: usage.contextWindowSize,
        percentage
      }
    })
  }

  // 6C-2: Track finishReason for terminal status mapping
  const finishReason = properties.finishReason as string | undefined
  if (finishReason) {
    state.lastFinishReason = finishReason
    openCodeLog.info(`[opencode] Session finishReason: ${finishReason}`)

    // Emit context_exhausted signal when context window is full
    if (finishReason === 'length') {
      chunks.push({
        type: 'compact_boundary',
        content: 'Context window exhausted — compaction needed'
      })
    }
  }

  return chunks
}

function handleSessionError(properties: EventProperties): StreamChunk[] {
  const rawError = properties.error
  if (!rawError) return []

  // The SDK sends error as an object: { name: string, data: { message: string, ... } }.
  // Coerce to a string for downstream consumers that pattern-match on error messages.
  // R8: If the coerced string is empty/whitespace, fall back to JSON.stringify(rawError)
  // then a descriptive placeholder. This surfaces real provider errors (e.g. OpenCode
  // omlx vision rejection) that previously produced '' ?? fallback → empty error text.
  let error: string =
    typeof rawError === 'string'
      ? rawError
      : ((rawError as any)?.data?.message ?? (rawError as any)?.message ?? '')
  if (!error || !error.trim()) {
    error = JSON.stringify(rawError)
    if (!error || error === '{}' || error === '""') {
      error = 'OpenCode session error (no message)'
    }
  }

  // GAP-11: Classify transient vs permanent errors. Transient errors emit
  // api_retry instead of error, giving the UI a more accurate status indicator.
  const isTransient = TRANSIENT_PATTERNS.some((p) => p.test(error))
  if (isTransient) {
    openCodeLog.info(`[opencode] Transient error detected — UI will show retry status: ${error}`)
    const chunks: StreamChunk[] = [
      {
        type: 'api_retry',
        content: `Transient error: ${error}`,
        retryInfo: {
          attempt: 1,
          maxRetries: 3,
          retryDelayMs: 2000,
          errorStatus: null
        }
      }
    ]
    // F17: Additionally emit rate_limit for rate-limit-specific errors so the
    // UI rate limit indicator works for OpenCode sessions (parity with CLI).
    const isRateLimit = /rate.?limit|429|too many requests/i.test(error)
    if (isRateLimit) {
      chunks.push({
        type: 'rate_limit',
        rateLimit: { status: 'rejected', utilization: 100, rateLimitType: 'api' }
      })
    }
    return chunks
  }

  return [{ type: 'error', error }]
}

function handleSessionCompacted(properties: EventProperties): StreamChunk[] {
  const chunks: StreamChunk[] = [{ type: 'compact_boundary', content: 'OpenCode compaction' }]

  // 6C-4: Emit context usage reset so the UI badge refreshes post-compaction
  const usage = properties.usage as Record<string, number> | undefined
  const contextTokens =
    (usage?.inputTokens ?? 0) +
    (usage?.cacheReadInputTokens ?? 0) +
    (usage?.cacheCreationInputTokens ?? 0)
  if (contextTokens > 0 && usage?.contextWindowSize) {
    chunks.push({
      type: 'context_usage_update',
      contextUsageUpdate: {
        inputTokens: contextTokens,
        contextWindowSize: usage.contextWindowSize,
        percentage: Math.round((contextTokens / usage.contextWindowSize) * 100)
      }
    })
  } else {
    // N12: Estimate compaction reduces to ~30% usage. Use a sane default
    // context window to avoid 0/0 = NaN in the renderer's qualityPct calculation.
    const estimatedWindow = 200_000
    const estimatedTokens = Math.round(estimatedWindow * 0.3)
    chunks.push({
      type: 'context_usage_update',
      contextUsageUpdate: {
        inputTokens: estimatedTokens,
        contextWindowSize: estimatedWindow,
        percentage: 30
      }
    })
  }

  return chunks
}

function handleSessionIdle(
  _properties: EventProperties,
  _sessionId: string,
  _tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  // R6-A1: Clear dedupe sets on idle for bounded memory. A new agent turn will
  // produce fresh callIDs, so stale entries never match and just waste memory.
  if (state.emittedToolUse) state.emittedToolUse.clear()
  if (state.emittedToolResult) state.emittedToolResult.clear()

  const chunks: StreamChunk[] = [{ type: 'status', content: 'idle' }]

  // Note: 'idle' status is suppressed by SUPPRESSED_STATUS_VALUES in chunk-router.ts.
  // The 'finishReason:' prefix is suppressed by SUPPRESSED_STATUS_PREFIXES.
  if (state.lastFinishReason) {
    const reasonMap: Record<string, string> = {
      stop: 'completed',
      length: 'context_exhausted',
      'tool-calls': 'tool_pending',
      error: 'failed'
    }
    const terminalReason = reasonMap[state.lastFinishReason] ?? state.lastFinishReason
    chunks.push({ type: 'status', content: `finishReason:${terminalReason}` })
    state.lastFinishReason = undefined
  }

  return chunks
}

function handleFileEdited(properties: EventProperties): StreamChunk[] {
  const filePath = properties.path as string | undefined
  return [
    {
      type: 'hook_lifecycle',
      hookInfo: {
        hookId: 'file-edited',
        hookName: 'OpenCode file.edited',
        hookEvent: 'file.edited',
        phase: 'response',
        output: filePath ?? 'unknown file',
        outcome: 'success'
      }
    }
  ]
}

// Cap diff content before allocating a chunk string. The chunk-router has a
// separate 1MB guard, but capping here avoids a transient multi-MB allocation
// in the main process when OpenCode emits very large diffs.
const MAX_SESSION_DIFF_CHARS = 2_000_000 // 2MB — generous for recovery metadata

function handleSessionDiff(properties: EventProperties): StreamChunk[] {
  const diff = properties.diff as string | undefined
  if (!diff) return []
  // Session diffs are internal recovery metadata — route to session_state,
  // not text, to prevent rendering in the chat bubble.
  const safeDiff =
    diff.length > MAX_SESSION_DIFF_CHARS ? diff.slice(0, MAX_SESSION_DIFF_CHARS) : diff
  return [{ type: 'session_state', content: `session_diff:${safeDiff}` }]
}

/**
 * session.status — maps OpenCode session statuses to internal status labels.
 * These labels are suppressed from chat rendering by SUPPRESSED_STATUS_VALUES
 * in src/main/ipc/chunk-router.ts. If you add a new mapping here, update
 * the suppression list there.
 */
function handleSessionStatus(properties: EventProperties): StreamChunk[] {
  const rawStatus = properties.status
  if (!rawStatus) return []
  let status: string
  if (typeof rawStatus === 'string') {
    status = rawStatus
  } else if (
    typeof rawStatus === 'object' &&
    typeof (rawStatus as Record<string, unknown>).type === 'string'
  ) {
    // OpenCode local backends emit object statuses like {type:'busy'}
    status = (rawStatus as { type: string }).type
  } else {
    status = JSON.stringify(rawStatus)
  }
  const statusMap: Record<string, string> = {
    thinking: 'thinking',
    tool_use: 'reviewing',
    idle: 'idle',
    busy: 'thinking', // local LLM backend status → map to 'thinking' (already suppressed)
    error: 'failed',
    compacting: 'thinking',
    generating: 'writing'
  }
  return [{ type: 'status', content: statusMap[status] ?? status }]
}

function handleSessionCreated(
  properties: EventProperties,
  sessionId: string,
  _tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  const childId = properties.id as string | undefined
  const parentId = properties.parentID as string | undefined
  if (!childId) return []

  const trackParent = parentId ?? sessionId
  if (!state.childSessions.has(trackParent)) {
    state.childSessions.set(trackParent, new Set())
  }
  state.childSessions.get(trackParent)!.add(childId)
  openCodeLog.info(
    `[opencode] Child session ${childId} created (parent: ${trackParent}, ` +
      `total children: ${state.childSessions.get(trackParent)!.size})`
  )
  return [{ type: 'subagent_start', content: `Subagent session started: ${childId}` }]
}

function handleMessageRemoved(properties: EventProperties): StreamChunk[] {
  const removedId = properties.messageID as string | undefined
  return removedId ? [{ type: 'session_state', content: `message_removed:${removedId}` }] : []
}

function handleMessageUpdated(properties: EventProperties): StreamChunk[] {
  const msgPart = properties.part as Record<string, unknown> | undefined
  if (msgPart?.type === 'text') {
    const text = msgPart.content as string | undefined
    if (text) return [{ type: 'text', content: text }]
  }
  return []
}

function handlePermissionAsked(properties: EventProperties): StreamChunk[] {
  const tool = properties.tool as string | undefined
  const permissionId = properties.permissionId as string | undefined
  const args = properties.args as Record<string, unknown> | undefined
  if (!tool || !permissionId) return []

  openCodeLog.info(`[opencode] Permission requested for tool: ${tool} (id: ${permissionId})`)
  return [
    {
      type: 'permission_request',
      toolName: tool,
      permissionRequest: { permissionId, tool, args, message: `Agent wants to use ${tool}` }
    }
  ]
}

function handlePermissionReplied(properties: EventProperties): StreamChunk[] {
  const tool = properties.tool as string | undefined
  const allowed = properties.allowed as boolean | undefined
  if (tool) openCodeLog.info(`[opencode] Permission ${allowed ? 'granted' : 'denied'} for: ${tool}`)
  return []
}

function handleInstallationUpdated(): StreamChunk[] {
  openCodeLog.info('[opencode] Installation updated — dependency change detected')
  return []
}

function handleLspDiagnostics(properties: EventProperties): StreamChunk[] {
  const diagnostics = properties.diagnostics as Array<Record<string, unknown>> | undefined
  if (!diagnostics || diagnostics.length === 0) return []

  openCodeLog.info(`[opencode] LSP diagnostics: ${diagnostics.length} issues`)

  // GAP-14: Surface LSP diagnostics to the UI as a structured chunk
  const severityMap: Record<string, 'error' | 'warning' | 'info' | 'hint'> = {
    error: 'error',
    warning: 'warning',
    information: 'info',
    hint: 'hint',
    '1': 'error',
    '2': 'warning',
    '3': 'info',
    '4': 'hint'
  }

  const parsed = diagnostics.slice(0, 20).map((d) => ({
    file: (d.file ?? d.path ?? d.uri ?? 'unknown') as string,
    line: (d.line ?? (d.range as Record<string, unknown>)?.start ?? 0) as number,
    severity: severityMap[String(d.severity ?? 'warning')] ?? 'warning',
    message: (d.message ?? String(d)) as string,
    source: d.source as string | undefined
  }))

  // Build a human-readable summary for content
  const errorCount = parsed.filter((d) => d.severity === 'error').length
  const warnCount = parsed.filter((d) => d.severity === 'warning').length
  const summary =
    [errorCount > 0 ? `${errorCount} error(s)` : '', warnCount > 0 ? `${warnCount} warning(s)` : '']
      .filter(Boolean)
      .join(', ') || `${parsed.length} diagnostic(s)`

  return [
    {
      type: 'lsp_diagnostics',
      lspDiagnostics: parsed,
      content: `LSP: ${summary}`
    }
  ]
}

function handleTodoUpdated(properties: EventProperties): StreamChunk[] {
  const todoAction = properties.action as string | undefined
  const todoText = properties.text as string | undefined
  const todoIndex = properties.index as number | undefined
  openCodeLog.info(`[opencode] Todo ${todoAction ?? 'updated'}: ${todoText ?? '(no text)'}`)
  if (!todoText) return []

  // GAP-15: Bridge todo updates to the UI as a dedicated chunk type
  const actionMap: Record<string, 'add' | 'complete' | 'remove' | 'update'> = {
    add: 'add',
    create: 'add',
    complete: 'complete',
    done: 'complete',
    remove: 'remove',
    delete: 'remove',
    update: 'update',
    edit: 'update'
  }
  const normalizedAction = actionMap[todoAction ?? 'update'] ?? 'update'

  return [
    {
      type: 'todo_update',
      todoUpdate: {
        action: normalizedAction,
        text: todoText,
        index: todoIndex
      },
      content: `Todo ${normalizedAction}: ${todoText}`
    }
  ]
}

function handleCommandExecuted(properties: EventProperties): StreamChunk[] {
  const command = properties.command as string | undefined
  if (command) openCodeLog.info(`[opencode] Command executed: ${command}`)
  return []
}

function handleMessagePartRemoved(properties: EventProperties): StreamChunk[] {
  const removedMsgId = properties.messageID as string | undefined
  const removedPartId = properties.partID as string | undefined
  if (!removedMsgId || !removedPartId) return []
  return [{ type: 'session_state', content: `part_removed:${removedMsgId}:${removedPartId}` }]
}

function handleSessionDeleted(
  properties: EventProperties,
  _sessionId: string,
  _tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  const deletedId = properties.id as string | undefined
  if (!deletedId) return []

  openCodeLog.info(`[opencode] Session ${deletedId} deleted — cleaning up references`)
  for (const [convId, sessId] of state.sessionMap.entries()) {
    if (sessId === deletedId) {
      state.sessionMap.delete(convId)
      break
    }
  }
  state.childSessions.delete(deletedId)
  for (const children of state.childSessions.values()) {
    children.delete(deletedId)
  }
  return [{ type: 'session_state', content: `session_deleted:${deletedId}` }]
}

function handleFileWatcherUpdated(properties: EventProperties): StreamChunk[] {
  const watchedPath = properties.path as string | undefined
  const watchedEvent = properties.event as string | undefined
  if (!watchedPath) return []
  openCodeLog.info(`[opencode] File watcher: ${watchedEvent ?? 'changed'} ${watchedPath}`)
  return [
    {
      type: 'hook_lifecycle',
      hookInfo: {
        hookId: 'file-watcher',
        hookName: 'OpenCode file.watcher.updated',
        hookEvent: 'file.watcher.updated',
        phase: 'response',
        output: `${watchedEvent ?? 'changed'}: ${watchedPath}`,
        outcome: 'success'
      }
    }
  ]
}

function handleLspUpdated(properties: EventProperties): StreamChunk[] {
  const lspStatus = properties.status as string | undefined
  const lspLanguage = properties.language as string | undefined
  openCodeLog.info(`[opencode] LSP ${lspLanguage ?? 'unknown'}: ${lspStatus ?? 'updated'}`)
  if (lspStatus === 'error' || lspStatus === 'disconnected') {
    return [{ type: 'status', content: `lsp_${lspStatus}:${lspLanguage ?? 'unknown'}` }]
  }
  return []
}

function handleServerConnected(
  _properties: EventProperties,
  _sessionId: string,
  _tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  openCodeLog.info('[opencode] Server fully initialized — all subsystems ready')
  if (state.serverReadyResolve) {
    state.serverReadyResolve()
    state.serverReadyResolve = undefined
  }
  return []
}

// ── session.next.* V2 event bus handlers ──

/** No-op handler — suppresses "Unhandled event type" log for known V2 events. */
function noopHandler(): StreamChunk[] {
  return []
}

/** Track whether we've logged the first-sighting raw shape for each V2 tool event type. */
const v2ToolFirstSighting = { called: false, success: false, failed: false }

/**
 * session.next.tool.called — V2 event bus.
 * Emits `tool_use`, deduped via `state.emittedToolUse` (shared with handleToolPart
 * so V1+V2 double-fire never duplicates).
 *
 * Property names are parsed defensively — exact V2 payload shape may vary.
 */
function handleV2ToolCalled(
  properties: EventProperties,
  _sessionId: string,
  _tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  if (!v2ToolFirstSighting.called) {
    v2ToolFirstSighting.called = true
    openCodeLog.info(
      '[opencode] V2 tool.called first sighting — raw properties:',
      JSON.stringify(properties).slice(0, 500)
    )
  }

  const toolName = (properties.tool ??
    properties.name ??
    properties.toolName ??
    'unknown') as string
  const callID = (properties.callID ?? properties.id ?? properties.toolCallId) as string | undefined
  if (!callID) return []

  // Lazily initialise dedupe sets
  if (!state.emittedToolUse) state.emittedToolUse = new Set()
  if (state.emittedToolUse.has(callID)) return []
  state.emittedToolUse.add(callID)
  state.lastPartType = 'tool'

  const rawInput = (properties.input ?? properties.args) as
    Record<string, unknown> | string | undefined
  let toolInput: string | undefined
  if (rawInput != null) {
    toolInput = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
  }

  return [{ type: 'tool_use', toolName, toolId: callID, toolInput }]
}

/**
 * session.next.tool.success — V2 event bus.
 * Emits `tool_result` + `tool_use_summary`, deduped via `state.emittedToolResult`.
 */
function handleV2ToolSuccess(
  properties: EventProperties,
  _sessionId: string,
  _tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  if (!v2ToolFirstSighting.success) {
    v2ToolFirstSighting.success = true
    openCodeLog.info(
      '[opencode] V2 tool.success first sighting — raw properties:',
      JSON.stringify(properties).slice(0, 500)
    )
  }

  const toolName = (properties.tool ??
    properties.name ??
    properties.toolName ??
    'unknown') as string
  const callID = (properties.callID ?? properties.id ?? properties.toolCallId) as string | undefined
  if (!callID) return []

  if (!state.emittedToolResult) state.emittedToolResult = new Set()
  if (state.emittedToolResult.has(callID)) return []
  state.emittedToolResult.add(callID)

  // Also ensure tool_use was emitted (V2-only path — V1 may not have fired)
  if (!state.emittedToolUse) state.emittedToolUse = new Set()
  const chunks: StreamChunk[] = []
  if (!state.emittedToolUse.has(callID)) {
    state.emittedToolUse.add(callID)
    state.lastPartType = 'tool'
    const rawInput = (properties.input ?? properties.args) as
      Record<string, unknown> | string | undefined
    let toolInput: string | undefined
    if (rawInput != null) {
      toolInput = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
    }
    chunks.push({ type: 'tool_use', toolName, toolId: callID, toolInput })
  }

  const output = (properties.output ?? properties.result) as string | unknown | undefined
  const resultStr = typeof output === 'string' ? output : JSON.stringify(output ?? '')

  chunks.push({ type: 'tool_result', toolName, toolId: callID, content: resultStr })

  // Generate a human-readable summary
  const resultSummaryObj = extractResultSummary(toolName, resultStr)
  let inputSummary: string | undefined
  const rawInput = (properties.input ?? properties.args) as Record<string, unknown> | undefined
  if (rawInput && typeof rawInput === 'object') {
    inputSummary = summarizeToolInput(toolName, rawInput)
  }
  if (resultSummaryObj?.result || inputSummary) {
    chunks.push({
      type: 'tool_use_summary',
      toolName,
      toolId: callID,
      content: [
        inputSummary ? `Input: ${inputSummary}` : '',
        resultSummaryObj?.result ? `Result: ${resultSummaryObj.result}` : ''
      ]
        .filter(Boolean)
        .join(' — ')
    })
  }

  return chunks
}

/**
 * session.next.tool.failed — V2 event bus.
 * Emits `tool_result` with error payload, deduped via `state.emittedToolResult`.
 */
function handleV2ToolFailed(
  properties: EventProperties,
  _sessionId: string,
  _tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  if (!v2ToolFirstSighting.failed) {
    v2ToolFirstSighting.failed = true
    openCodeLog.info(
      '[opencode] V2 tool.failed first sighting — raw properties:',
      JSON.stringify(properties).slice(0, 500)
    )
  }

  const toolName = (properties.tool ??
    properties.name ??
    properties.toolName ??
    'unknown') as string
  const callID = (properties.callID ?? properties.id ?? properties.toolCallId) as string | undefined
  if (!callID) return []

  if (!state.emittedToolResult) state.emittedToolResult = new Set()
  if (state.emittedToolResult.has(callID)) return []
  state.emittedToolResult.add(callID)

  // Also ensure tool_use was emitted
  if (!state.emittedToolUse) state.emittedToolUse = new Set()
  const chunks: StreamChunk[] = []
  if (!state.emittedToolUse.has(callID)) {
    state.emittedToolUse.add(callID)
    state.lastPartType = 'tool'
    chunks.push({ type: 'tool_use', toolName, toolId: callID })
  }

  const errorMsg = (properties.error ?? properties.message ?? 'Tool execution failed') as string
  const resultStr = typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg)

  chunks.push({ type: 'tool_result', toolName, toolId: callID, content: resultStr })

  return chunks
}

/**
 * session.next.agent.switched — emits status chunk with agent name.
 * The 'agent_switched:' prefix is suppressed from chat rendering by
 * SUPPRESSED_STATUS_PREFIXES in src/main/ipc/chunk-router.ts.
 */
function handleAgentSwitched(properties: EventProperties): StreamChunk[] {
  const raw = properties.agent ?? properties.name ?? 'unknown'
  const name =
    typeof raw === 'string'
      ? raw
      : ((raw as Record<string, unknown>)?.name ??
        (raw as Record<string, unknown>)?.id ??
        JSON.stringify(raw))
  return [{ type: 'status', content: `agent_switched:${name}` }]
}

/**
 * session.next.model.switched — emits status chunk with model id.
 * The 'model_switched:' prefix is suppressed from chat rendering by
 * SUPPRESSED_STATUS_PREFIXES in src/main/ipc/chunk-router.ts.
 */
function handleModelSwitched(properties: EventProperties): StreamChunk[] {
  const raw = properties.model ?? properties.modelID ?? properties.id ?? 'unknown'
  const modelId =
    typeof raw === 'string'
      ? raw
      : ((raw as Record<string, unknown>)?.id ??
        (raw as Record<string, unknown>)?.modelID ??
        JSON.stringify(raw))
  return [{ type: 'status', content: `model_switched:${modelId}` }]
}

/** session.next.step.ended — extracts per-step token usage when available. */
function handleStepEnded(
  properties: EventProperties,
  _sessionId: string,
  tokenUsage: ExecutorTokenUsage
): StreamChunk[] {
  const usage = properties.usage as Record<string, number> | undefined
  if (usage) {
    tokenUsage.input = usage.inputTokens ?? usage.input ?? tokenUsage.input
    tokenUsage.output = usage.outputTokens ?? usage.output ?? tokenUsage.output
    tokenUsage.cacheReadInputTokens = usage.cacheReadInputTokens ?? tokenUsage.cacheReadInputTokens
    tokenUsage.cacheCreationInputTokens =
      usage.cacheCreationInputTokens ?? tokenUsage.cacheCreationInputTokens
  }
  return []
}

// ── Dispatch table ──

const EVENT_HANDLERS: Record<string, EventHandler> = {
  'message.part.updated': handleMessagePartUpdated,
  'message.part.delta': handleMessagePartDelta,
  'session.updated': handleSessionUpdated,
  'session.error': handleSessionError as EventHandler,
  'session.compacted': handleSessionCompacted as EventHandler, // 6C-4: now emits context_usage_update
  'session.idle': handleSessionIdle,
  'file.edited': handleFileEdited as EventHandler,
  'session.diff': handleSessionDiff as EventHandler,
  'session.status': handleSessionStatus as EventHandler,
  'session.created': handleSessionCreated,
  'message.removed': handleMessageRemoved as EventHandler,
  'message.updated': handleMessageUpdated as EventHandler,
  'permission.asked': handlePermissionAsked as EventHandler,
  'permission.replied': handlePermissionReplied as EventHandler,
  'installation.updated': handleInstallationUpdated as EventHandler,
  'lsp.client.diagnostics': handleLspDiagnostics as EventHandler,
  'todo.updated': handleTodoUpdated as EventHandler,
  'command.executed': handleCommandExecuted as EventHandler,
  'message.part.removed': handleMessagePartRemoved as EventHandler,
  'session.deleted': handleSessionDeleted,
  'file.watcher.updated': handleFileWatcherUpdated as EventHandler,
  'lsp.updated': handleLspUpdated as EventHandler,
  'server.connected': handleServerConnected,

  // session.next.* — V2 event bus. Currently fires alongside V1 events.
  // Registered to suppress "Unhandled event type" log spam.
  'session.next.agent.switched': handleAgentSwitched as EventHandler,
  'session.next.model.switched': handleModelSwitched as EventHandler,
  'session.next.text.started': noopHandler as EventHandler,
  'session.next.text.delta': noopHandler as EventHandler,
  'session.next.text.ended': noopHandler as EventHandler,
  'session.next.reasoning.started': noopHandler as EventHandler,
  'session.next.reasoning.delta': noopHandler as EventHandler,
  'session.next.reasoning.ended': noopHandler as EventHandler,
  'session.next.tool.input.started': noopHandler as EventHandler,
  'session.next.tool.input.delta': noopHandler as EventHandler,
  'session.next.tool.input.ended': noopHandler as EventHandler,
  'session.next.tool.called': handleV2ToolCalled,
  'session.next.tool.progress': noopHandler as EventHandler,
  'session.next.tool.success': handleV2ToolSuccess,
  'session.next.tool.failed': handleV2ToolFailed,
  'session.next.step.started': noopHandler as EventHandler,
  'session.next.step.ended': handleStepEnded as EventHandler,
  'session.next.step.failed': noopHandler as EventHandler,
  'session.next.compaction.started': noopHandler as EventHandler,
  'session.next.compaction.delta': noopHandler as EventHandler,
  'session.next.compaction.ended': noopHandler as EventHandler,
  'session.next.retried': noopHandler as EventHandler,
  'session.next.prompted': noopHandler as EventHandler,
  'session.next.prompt.admitted': noopHandler as EventHandler,
  'session.next.context.updated': noopHandler as EventHandler,
  'session.next.synthetic': noopHandler as EventHandler,
  'session.next.shell.started': noopHandler as EventHandler,
  'session.next.shell.ended': noopHandler as EventHandler,
  'session.next.moved': noopHandler as EventHandler,

  // Server lifecycle — suppress heartbeat noise (~6x/minute).
  'server.heartbeat': noopHandler as EventHandler,

  // Plugin/catalog/integration lifecycle — informational, no UI action needed.
  'plugin.added': noopHandler as EventHandler,
  'plugin.removed': noopHandler as EventHandler,
  'catalog.updated': noopHandler as EventHandler,
  'integration.updated': noopHandler as EventHandler,
  'reference.updated': noopHandler as EventHandler
}

/**
 * Normalize an OpenCode SSE event into StreamChunks.
 * Drop-in replacement for the old switch statement in OpenCodeExecutor.normalizeEvent().
 */
export function normalizeOpenCodeEvent(
  event: unknown,
  sessionId: string,
  tokenUsage: ExecutorTokenUsage,
  state: NormalizerState
): StreamChunk[] {
  const evt = event as Record<string, unknown>
  const type = evt.type as string | undefined
  const properties = evt.properties as EventProperties | undefined

  if (!type || !properties) return []

  // Filter events for this session — but allow child session events through
  const eventSessionId = properties.sessionID as string | undefined
  if (eventSessionId && eventSessionId !== sessionId) {
    // GAP-13: Check if this event belongs to a known child/subagent session
    const isChildSession =
      state.childSessions.has(sessionId) && state.childSessions.get(sessionId)!.has(eventSessionId)

    if (isChildSession) {
      // Process child session events but tag them as subagent progress
      if (type === 'session.idle' || type === 'session.deleted') {
        return [
          { type: 'subagent_complete', content: `Subagent session completed: ${eventSessionId}` }
        ]
      }

      // For text and tool events from child sessions, emit as subagent_progress
      const handler = EVENT_HANDLERS[type]
      if (handler) {
        const childChunks = handler(properties, sessionId, tokenUsage, state)
        // Wrap text chunks as subagent_progress
        return childChunks.map((chunk) => {
          if (chunk.type === 'text' || chunk.type === 'tool_use' || chunk.type === 'tool_result') {
            return {
              ...chunk,
              type: 'subagent_progress' as const,
              content: chunk.content
                ? `[subagent:${eventSessionId.slice(0, 8)}] ${chunk.content}`
                : chunk.content
            }
          }
          return chunk
        })
      }
    }

    return []
  }

  const handler = EVENT_HANDLERS[type]
  if (handler) return handler(properties, sessionId, tokenUsage, state)

  // 6C-5: Log unknown event types for forward-compatibility awareness
  openCodeLog.info(`[opencode] Unhandled event type: ${type}`)
  return []
}
