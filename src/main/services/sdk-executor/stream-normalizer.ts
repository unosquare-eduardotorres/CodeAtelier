/**
 * Stream normalizer — converts raw SDK messages into StreamChunk events.
 *
 * Handles the mapping of SDK message types (system, assistant, stream_event,
 * user, result, tool_progress, rate_limit_event, etc.) to the unified
 * StreamChunk interface that the rest of the application consumes.
 *
 * Extracted from SDKExecutor.execute() to reduce cyclomatic complexity.
 */

import type { StreamChunk } from '../agent-base.service'
import { summarizeToolInput } from '../agent-base.service'
import type { SDKExecuteResult, TerminalReason } from '../sdk-executor'
import type { ToolTracker } from './tool-tracker'
import type { TokenAccountant } from './token-accountant'
import { sdkLog } from './index'

/** Mutable state that accumulates across the stream */
export interface StreamState {
  sessionId?: string
  resultText?: string
  terminalReason?: TerminalReason
  sessionTitle?: string
}

/**
 * Normalize a single SDK message into zero or more StreamChunks.
 *
 * This is a pure-ish function: it reads from tools/tokens state and may mutate
 * the ToolTracker's hasPriorContent/lastBlockType, but produces no side effects
 * beyond yielded chunks.
 */
export function* normalizeMessage(
  msg: Record<string, unknown>,
  tools: ToolTracker,
  tokens: TokenAccountant,
  state: StreamState,
  cwd: string
): Generator<StreamChunk & { _meta?: SDKExecuteResult }> {
  // ── system.init — capture session ID ──
  if (msg.type === 'system' && msg.subtype === 'init') {
    state.sessionId = msg.session_id as string | undefined
    return
  }

  // ── SubAgent lifecycle events ──
  if (msg.type === 'system' && msg.subtype === 'task_started') {
    yield {
      type: 'subagent_start',
      content: msg.description as string,
      toolId: msg.task_id as string,
      toolName: (msg.task_type as string) || 'Agent'
    }
    return
  }

  if (msg.type === 'system' && msg.subtype === 'task_progress') {
    yield {
      type: 'subagent_progress',
      content: (msg.summary as string) || (msg.description as string),
      toolId: msg.task_id as string,
      toolName: msg.last_tool_name as string | undefined
    }
    return
  }

  if (msg.type === 'system' && msg.subtype === 'task_notification') {
    yield {
      type: 'subagent_complete',
      content: msg.summary as string,
      toolId: msg.task_id as string,
      toolInput: msg.status as string
    }
    return
  }

  // ── assistant — complete replay, only used for tool ID mapping ──
  if (msg.type === 'assistant') {
    const assistantMsg = msg.message as Record<string, unknown> | undefined
    if (assistantMsg?.content && Array.isArray(assistantMsg.content)) {
      tools.registerFromAssistantMessage(assistantMsg.content as Record<string, unknown>[])
    }
    return
  }

  // ── stream_event — real-time streaming content ──
  if (msg.type === 'stream_event') {
    const streamEvent = (msg as Record<string, unknown>).event as Record<string, unknown>
    if (!streamEvent) return

    // Real-time text streaming
    if (streamEvent.type === 'content_block_delta') {
      const delta = streamEvent.delta as Record<string, unknown> | undefined
      if (delta?.type === 'text_delta' && delta.text) {
        tools.hasPriorContent = true
        yield { type: 'text', content: delta.text as string }
      }
      if (delta?.type === 'json_delta' && delta.json) {
        tools.hasPriorContent = true
        yield { type: 'text', content: delta.json as string }
      }
    }

    // Tool use start + thinking→text boundary detection
    if (streamEvent.type === 'content_block_start') {
      const cb = streamEvent.content_block as Record<string, unknown> | undefined

      // Detect thinking→text transition within the same turn
      if (cb?.type === 'text' && tools.lastBlockType === 'thinking' && tools.hasPriorContent) {
        yield { type: 'turn_boundary' as const, content: `thinking-split-${Date.now()}` }
      }

      // Track block type transitions
      if (cb?.type === 'thinking') tools.lastBlockType = 'thinking'
      else if (cb?.type === 'tool_use') tools.lastBlockType = 'tool_use'
      else if (cb?.type === 'text') tools.lastBlockType = 'text'

      if (cb?.type === 'tool_use') {
        const toolId = cb.id as string | undefined
        const toolName = cb.name as string
        const toolInput = cb.input as Record<string, unknown> | undefined
        const hasInput = toolInput && Object.keys(toolInput).length > 0

        if (toolId) {
          tools.register(toolId, toolName)
        }

        tools.hasPriorContent = true
        yield {
          type: 'tool_use',
          toolName,
          toolId,
          toolInput: hasInput ? summarizeToolInput(toolName, toolInput, cwd) : undefined
        }
      }
    }

    // Token usage from message_start + turn boundary detection
    if (streamEvent.type === 'message_start') {
      if (tools.hasPriorContent) {
        yield { type: 'turn_boundary' as const, content: `turn-${Date.now()}` }
      }
      const startMsg = streamEvent.message as Record<string, unknown> | undefined
      tokens.accumulateFromMessageStart(startMsg?.usage as Record<string, number> | undefined)
    }

    // Token usage from message_delta
    if (streamEvent.type === 'message_delta') {
      tokens.accumulateFromMessageDelta(streamEvent.usage as Record<string, number> | undefined)
    }
    return
  }

  // ── user — tool results ──
  if (msg.type === 'user') {
    const userMsg = msg.message as Record<string, unknown> | undefined
    if (userMsg?.content && Array.isArray(userMsg.content)) {
      for (const block of userMsg.content as Record<string, unknown>[]) {
        if (block.type === 'tool_result') {
          const toolUseId = block.tool_use_id as string | undefined
          const toolName = tools.resolve(toolUseId)
          tools.consume(toolUseId)

          let resultContent: string | undefined
          if (typeof block.content === 'string') {
            resultContent = block.content
          } else if (Array.isArray(block.content)) {
            resultContent = (block.content as Record<string, unknown>[])
              .filter((c) => c.type === 'text')
              .map((c) => c.text as string)
              .join('\n')
          }

          yield {
            type: 'tool_result',
            toolName,
            toolId: toolUseId,
            content: resultContent
          }
        }
      }
    }
    return
  }

  // ── result — final query result ──
  if (msg.type === 'result') {
    const subtype = msg.subtype as string | undefined
    const isError = msg.is_error as boolean | undefined

    if (isError && subtype && subtype !== 'success') {
      const errorDetail =
        subtype === 'error_max_budget_usd'
          ? 'budget cap exceeded'
          : subtype === 'error_max_turns'
            ? 'max turns reached'
            : subtype === 'error_max_structured_output_retries'
              ? 'structured output schema validation failed after retries'
              : subtype
      sdkLog.warn(`[TELEMETRY:sdk-result-error] subtype=${subtype} detail=${errorDetail}`)
      yield { type: 'error', error: `SDK execution stopped: ${errorDetail}` }
    }

    state.resultText = msg.result as string | undefined

    // Extract terminal reason (SDK 0.2.96+)
    const rawTerminalReason = msg.terminal_reason as string | undefined
    if (rawTerminalReason) {
      state.terminalReason = rawTerminalReason as TerminalReason
      sdkLog.info(`[TELEMETRY:terminal-reason] ${state.terminalReason}`)
    }

    // Extract session title
    const rawSessionTitle = msg.session_title ?? msg.sessionTitle
    if (rawSessionTitle && typeof rawSessionTitle === 'string') {
      state.sessionTitle = rawSessionTitle
      sdkLog.info(`[TELEMETRY:session-title] "${state.sessionTitle}"`)
    }

    // For structured output, the JSON is in structured_output
    if (!state.resultText) {
      const structuredOutput = msg.structured_output
      if (structuredOutput) {
        state.resultText =
          typeof structuredOutput === 'string' ? structuredOutput : JSON.stringify(structuredOutput)
      }
    }

    if (state.resultText && !tools.hasPriorContent) {
      yield { type: 'text', content: state.resultText }
    }

    // SDK result has authoritative usage
    tokens.setFromResult(msg.usage as Record<string, number> | undefined)
    return
  }

  // ── tool_progress — elapsed time updates ──
  if (msg.type === 'tool_progress') {
    yield {
      type: 'tool_progress',
      toolId: msg.tool_use_id as string,
      toolName: msg.tool_name as string,
      elapsedSeconds: msg.elapsed_time_seconds as number,
      content: `${msg.elapsed_time_seconds}s`
    }
    return
  }

  // ── rate_limit_event ──
  if (msg.type === 'rate_limit_event') {
    const info = msg.rate_limit_info as Record<string, unknown>
    if (info) {
      yield {
        type: 'rate_limit',
        rateLimit: {
          status: info.status as 'allowed' | 'allowed_warning' | 'rejected',
          utilization: info.utilization as number | undefined,
          resetsAt: info.resetsAt as number | undefined,
          rateLimitType: info.rateLimitType as string | undefined
        }
      }
    }
    return
  }

  // ── system/api_retry ──
  if (msg.type === 'system' && msg.subtype === 'api_retry') {
    yield {
      type: 'api_retry',
      retryInfo: {
        attempt: msg.attempt as number,
        maxRetries: msg.max_retries as number,
        retryDelayMs: msg.retry_delay_ms as number,
        errorStatus: msg.error_status as number | null
      }
    }
    return
  }

  // ── system/compact_boundary ──
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    const meta = msg.compact_metadata as Record<string, unknown> | undefined
    yield {
      type: 'compact_boundary',
      content: `Context compacted (trigger: ${meta?.trigger ?? 'auto'}, pre-tokens: ${meta?.pre_tokens ?? '?'})`
    }
    return
  }

  // ── system/status ──
  if (msg.type === 'system' && msg.subtype === 'status') {
    yield { type: 'session_state', content: (msg.status as string | null) ?? 'idle' }
    return
  }

  // ── prompt_suggestion ──
  if (msg.type === 'prompt_suggestion') {
    yield { type: 'prompt_suggestion', content: msg.suggestion as string }
    return
  }

  // ── system/files_persisted ──
  if (msg.type === 'system' && msg.subtype === 'files_persisted') {
    yield {
      type: 'files_persisted',
      persistedFiles: (msg.files as Array<{ filename: string; file_id: string }> | undefined)?.map(
        (f) => ({
          filename: f.filename,
          fileId: f.file_id
        })
      )
    }
    return
  }

  // ── tool_use_summary ──
  if (msg.type === 'tool_use_summary') {
    yield { type: 'tool_use_summary', content: msg.summary as string }
    return
  }

  // ── system/hook lifecycle ──
  if (
    msg.type === 'system' &&
    ['hook_started', 'hook_progress', 'hook_response'].includes(msg.subtype as string)
  ) {
    yield {
      type: 'hook_lifecycle',
      hookInfo: {
        hookId: msg.hook_id as string,
        hookName: msg.hook_name as string,
        hookEvent: msg.hook_event as string,
        phase: (msg.subtype === 'hook_started'
          ? 'started'
          : msg.subtype === 'hook_progress'
            ? 'progress'
            : 'response') as 'started' | 'progress' | 'response',
        output: msg.output as string | undefined,
        outcome: msg.outcome as 'success' | 'error' | 'cancelled' | undefined
      }
    }
    return
  }

  // ── system/session_state_changed ──
  if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
    yield { type: 'session_state', content: msg.state as string }
    return
  }

  // ── auth_status ──
  if (msg.type === 'auth_status') {
    yield {
      type: 'auth_status',
      content: msg.error ? `Auth error: ${msg.error}` : 'Authenticating...'
    }
    return
  }

  // ── system/elicitation_complete ──
  if (msg.type === 'system' && msg.subtype === 'elicitation_complete') {
    yield {
      type: 'session_state',
      content: `MCP auth completed for ${msg.mcp_server_name as string}`
    }
    return
  }

  // ── system/local_command_output ──
  if (msg.type === 'system' && msg.subtype === 'local_command_output') {
    const output = msg.content as string | undefined
    if (output) {
      yield { type: 'text', content: output }
    }
    return
  }

  // ── Generic usage accumulation (non-result messages) ──
  if (msg.usage && msg.type !== 'result') {
    tokens.accumulateGeneric(msg.usage as Record<string, number>)
  }
}
