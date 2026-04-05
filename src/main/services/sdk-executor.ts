import { query } from '@anthropic-ai/claude-agent-sdk'
import type { StreamChunk } from './agent-base.service'
import { summarizeToolInput } from './agent-base.service'
import { authProvider } from './auth-provider'
import { createScopeGuard } from './sdk-hooks'
import log from 'electron-log/main'

const sdkLog = log.scope('SDKExecutor')

/**
 * Lightweight API request lifecycle telemetry.
 * Tracks start time, completion, errors, and retries for SDK calls.
 */
export interface ApiRequestTelemetry {
  requestId: string
  startedAt: number
  completedAt?: number
  durationMs?: number
  model: string
  status: 'started' | 'succeeded' | 'failed'
  error?: string
  tokenUsage?: {
    input: number
    output: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }
  turnCount?: number
}

/** In-memory telemetry buffer — last 100 requests for dashboard / debugging */
const telemetryBuffer: ApiRequestTelemetry[] = []
const MAX_TELEMETRY_BUFFER = 100
let requestCounter = 0

function recordTelemetry(entry: ApiRequestTelemetry): void {
  telemetryBuffer.push(entry)
  if (telemetryBuffer.length > MAX_TELEMETRY_BUFFER) {
    telemetryBuffer.shift()
  }
}

/** Get recent API request telemetry entries */
export function getRecentTelemetry(limit: number = 50): ApiRequestTelemetry[] {
  return telemetryBuffer.slice(-limit)
}

/** Get aggregate telemetry stats */
export function getTelemetryStats(): {
  totalRequests: number
  successCount: number
  failureCount: number
  avgDurationMs: number
  p95DurationMs: number
} {
  const completed = telemetryBuffer.filter((t) => t.status !== 'started')
  const durations = completed.filter((t) => t.durationMs != null).map((t) => t.durationMs!)
  durations.sort((a, b) => a - b)

  return {
    totalRequests: telemetryBuffer.length,
    successCount: completed.filter((t) => t.status === 'succeeded').length,
    failureCount: completed.filter((t) => t.status === 'failed').length,
    avgDurationMs:
      durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    p95DurationMs: durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : 0
  }
}

export interface SDKAgentDefinition {
  description: string
  prompt: string
  tools?: string[]
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit'
  /** MCP server references for SubAgents — e.g. [{ 'code-graph': { type: 'sdk', name: 'code-graph' } }] */
  mcpServers?: Array<string | Record<string, unknown>>
}

export interface SDKExecuteOptions {
  prompt: string | AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>
  systemPrompt: string
  model: string
  cwd: string
  permissionMode: 'plan' | 'bypassPermissions' | 'acceptEdits'
  allowedTools?: string[]
  /** Tools to completely remove from model context (cannot be used at all) */
  disallowedTools?: string[]
  /** SDK SubAgent definitions — specialists spawned as SubAgents */
  agents?: Record<string, SDKAgentDefinition>
  resume?: string
  hooks?: Record<string, unknown>
  maxThinkingTokens?: number
  /** AbortController for cancelling the SDK query. Passed to query() options. */
  abortController?: AbortController
  /** Heartbeat interval in ms (default: 15000). Set to 0 to disable. */
  heartbeatIntervalMs?: number
  /** Agent ID for tool approval attribution */
  agentId?: string
  /** Task ID for tool approval attribution */
  taskId?: string
  /** Enable per-tool approval flow (default: false — uses permissionMode) */
  enableToolApproval?: boolean
  /** Max agentic turns (tool-use rounds). SDK stops the loop after this many turns. */
  maxTurns?: number
  /** MCP server configurations for in-process MCP tools (e.g. repomap) */
  mcpServers?: Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig>
}

export interface SDKExecuteResult {
  sessionId?: string
  result?: string
  tokenUsage: {
    input: number
    output: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }
}

export class SDKExecutor {
  /**
   * Execute a query via the Agent SDK.
   * Returns an async generator of StreamChunks — same interface as CLI-based agents.
   * Callers don't need to know if they're talking to CLI or SDK.
   */
  async *execute(
    options: SDKExecuteOptions
  ): AsyncGenerator<StreamChunk & { _meta?: SDKExecuteResult }> {
    const totalUsage = {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    }
    let sessionId: string | undefined
    let resultText: string | undefined

    // API lifecycle telemetry
    const requestId = `sdk-${++requestCounter}-${Date.now()}`
    const telemetryEntry: ApiRequestTelemetry = {
      requestId,
      startedAt: Date.now(),
      model: options.model,
      status: 'started'
    }
    recordTelemetry(telemetryEntry)
    sdkLog.info(`[TELEMETRY:request-started] id=${requestId} model=${options.model}`)

    // Heartbeat / stall detection
    const heartbeatInterval = options.heartbeatIntervalMs ?? 15000
    let lastActivityAt = Date.now()
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let pendingHeartbeat = false
    const STALL_THRESHOLD_MS = 60000

    // Deduplication tracking — prevents double emission from stream_event + assistant replay.
    // The SDK yields stream_event deltas in real-time, then an `assistant` message with the
    // complete content as a replay. Without dedup, every text/tool block gets yielded twice.
    let hasStreamedText = false
    const processedToolIds = new Set<string>()

    // Start heartbeat timer — sets a flag that the generator checks on each iteration
    if (heartbeatInterval > 0) {
      heartbeatTimer = setInterval(() => {
        const stalledMs = Date.now() - lastActivityAt
        if (stalledMs > STALL_THRESHOLD_MS) {
          sdkLog.warn(
            `SDK query appears stalled — no activity for ${Math.round(stalledMs / 1000)}s`
          )
        }
        pendingHeartbeat = true
      }, heartbeatInterval)
    }

    try {
      // Ensure API key from workspace settings is available to the SDK.
      // The SDK reads ANTHROPIC_API_KEY from process.env automatically.
      // If the user configured an API key via workspace settings (not env var),
      // we must inject it into the environment before calling query().
      const apiKey = authProvider.getApiKey()
      if (apiKey && !process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = apiKey
      }

      // Build PreToolUse scope guard hooks — defense-in-depth even with bypassPermissions
      const scopeGuard = createScopeGuard(options.cwd)
      const preToolUseHooks = [scopeGuard]

      // Add per-tool approval hook if enabled
      if (options.enableToolApproval) {
        const { createToolApprovalHook } = await import('./sdk-hooks')
        preToolUseHooks.push(createToolApprovalHook(options.agentId ?? 'unknown', options.taskId))
      }

      const q = query({
        prompt: options.prompt,
        options: {
          model: options.model,
          systemPrompt: options.systemPrompt,
          cwd: options.cwd,
          permissionMode: options.permissionMode,
          // Wire SubAgent definitions (pass through mcpServers per agent if defined)
          ...(options.agents
            ? {
                agents: Object.fromEntries(
                  Object.entries(options.agents).map(([name, agent]) => [
                    name,
                    {
                      ...agent,
                      ...(agent.mcpServers?.length ? { mcpServers: agent.mcpServers } : {})
                    }
                  ])
                )
              }
            : {}),
          // Auto-include Agent tool when agents are defined
          allowedTools: options.agents
            ? [...new Set([...(options.allowedTools ?? []), 'Agent'])]
            : options.allowedTools,
          // Block tools completely — removes them from model context
          ...(options.disallowedTools?.length
            ? { disallowedTools: options.disallowedTools }
            : {}),
          resume: options.resume,
          maxThinkingTokens: options.maxThinkingTokens,
          // Required safety flag when using bypassPermissions
          allowDangerouslySkipPermissions: options.permissionMode === 'bypassPermissions',
          // Wire scope guard hooks for file-scope and dangerous-command protection
          hooks: {
            PreToolUse: [{ hooks: preToolUseHooks }]
          },
          // Cap agentic turns at the SDK level (defense-in-depth alongside circuit breaker)
          ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
          // Pass AbortController for cancellation support
          ...(options.abortController ? { abortController: options.abortController } : {}),
          // Enable AI-generated progress summaries for sub-agents (~30s intervals)
          ...(options.agents ? { agentProgressSummaries: true } : {}),
          // Wire in-process MCP servers (e.g. repomap code graph)
          ...(options.mcpServers ? { mcpServers: options.mcpServers } : {})
        }
      })

      for await (const message of q) {
        lastActivityAt = Date.now()

        // Emit pending heartbeat if timer fired between iterations
        if (pendingHeartbeat) {
          pendingHeartbeat = false
          yield { type: 'status', content: 'heartbeat' }
        }
        const msg = message as Record<string, unknown>

        // Capture session ID from system.init messages
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id as string | undefined
        }

        // ── SubAgent lifecycle events ──
        if (msg.type === 'system' && msg.subtype === 'task_started') {
          const taskMsg = msg as Record<string, unknown>
          yield {
            type: 'subagent_start',
            content: taskMsg.description as string,
            toolId: taskMsg.task_id as string,
            toolName: (taskMsg.task_type as string) || 'Agent'
          }
        }

        if (msg.type === 'system' && msg.subtype === 'task_progress') {
          const taskMsg = msg as Record<string, unknown>
          yield {
            type: 'subagent_progress',
            content: (taskMsg.summary as string) || (taskMsg.description as string),
            toolId: taskMsg.task_id as string,
            toolName: taskMsg.last_tool_name as string | undefined
          }
        }

        if (msg.type === 'system' && msg.subtype === 'task_notification') {
          const taskMsg = msg as Record<string, unknown>
          yield {
            type: 'subagent_complete',
            content: taskMsg.summary as string,
            toolId: taskMsg.task_id as string,
            toolInput: taskMsg.status as string // 'completed' | 'failed' | 'stopped'
          }
        }

        // Map assistant messages to StreamChunks.
        // The assistant message is a full replay of the response — only yield blocks
        // that weren't already emitted via stream_event deltas (dedup).
        if (msg.type === 'assistant') {
          const assistantMsg = msg.message as Record<string, unknown> | undefined
          if (assistantMsg?.content && Array.isArray(assistantMsg.content)) {
            for (const block of assistantMsg.content as Record<string, unknown>[]) {
              if (block.type === 'text' && block.text && !hasStreamedText) {
                hasStreamedText = true // prevent result message from re-yielding
                yield { type: 'text', content: block.text as string }
              } else if (block.type === 'tool_use') {
                const toolId = block.id as string | undefined
                if (toolId && processedToolIds.has(toolId)) continue
                const toolName = block.name as string
                const toolInput = block.input as Record<string, unknown> | undefined
                yield {
                  type: 'tool_use',
                  toolName,
                  toolInput: toolInput
                    ? summarizeToolInput(toolName, toolInput, options.cwd)
                    : undefined
                }
              }
            }
          }
        }

        // Map stream_event (SDK wraps Anthropic API events in a stream_event wrapper)
        if (msg.type === 'stream_event') {
          const streamEvent = (msg as Record<string, unknown>).event as Record<string, unknown>
          if (!streamEvent) continue

          // Real-time text streaming
          if (streamEvent.type === 'content_block_delta') {
            const delta = streamEvent.delta as Record<string, unknown> | undefined
            if (delta?.type === 'text_delta' && delta.text) {
              hasStreamedText = true
              yield { type: 'text', content: delta.text as string }
            }
          }

          // Tool use start — track ID for dedup against assistant replay
          if (streamEvent.type === 'content_block_start') {
            const cb = streamEvent.content_block as Record<string, unknown> | undefined
            if (cb?.type === 'tool_use') {
              const toolId = cb.id as string | undefined
              if (toolId) processedToolIds.add(toolId)
              const toolName = cb.name as string
              const toolInput = cb.input as Record<string, unknown> | undefined
              yield {
                type: 'tool_use',
                toolName,
                toolInput: toolInput ? summarizeToolInput(toolName, toolInput) : undefined
              }
            }
          }

          // Token usage from message_start
          if (streamEvent.type === 'message_start') {
            const startMsg = streamEvent.message as Record<string, unknown> | undefined
            const startUsage = startMsg?.usage as Record<string, number> | undefined
            if (startUsage) {
              totalUsage.input += startUsage.input_tokens ?? 0
              totalUsage.cacheReadInputTokens += startUsage.cache_read_input_tokens ?? 0
              totalUsage.cacheCreationInputTokens += startUsage.cache_creation_input_tokens ?? 0
            }
          }

          // Token usage from message_delta
          if (streamEvent.type === 'message_delta') {
            const deltaUsage = streamEvent.usage as Record<string, number> | undefined
            if (deltaUsage) {
              totalUsage.output += deltaUsage.output_tokens ?? 0
            }
          }
        }

        // Map user messages for tool results
        if (msg.type === 'user') {
          const userMsg = msg.message as Record<string, unknown> | undefined
          if (userMsg?.content && Array.isArray(userMsg.content)) {
            for (const block of userMsg.content as Record<string, unknown>[]) {
              if (block.type === 'tool_result') {
                yield { type: 'tool_result', toolName: 'tool' }
              }
            }
          }
        }

        // Capture result text
        if (msg.type === 'result') {
          resultText = msg.result as string | undefined
          if (resultText && !hasStreamedText) {
            yield { type: 'text', content: resultText }
          }
          // SDK result has rich usage — prefer it over accumulated stream usage
          const resultUsage = msg.usage as Record<string, number> | undefined
          if (resultUsage) {
            totalUsage.input =
              resultUsage.input_tokens ?? resultUsage.inputTokens ?? totalUsage.input
            totalUsage.output =
              resultUsage.output_tokens ?? resultUsage.outputTokens ?? totalUsage.output
            totalUsage.cacheReadInputTokens =
              resultUsage.cache_read_input_tokens ??
              resultUsage.cacheReadInputTokens ??
              totalUsage.cacheReadInputTokens
            totalUsage.cacheCreationInputTokens =
              resultUsage.cache_creation_input_tokens ??
              resultUsage.cacheCreationInputTokens ??
              totalUsage.cacheCreationInputTokens
          }
        }

        // Accumulate token usage from all event types
        const usage = msg.usage as Record<string, number> | undefined
        if (usage && msg.type !== 'result') {
          totalUsage.input += usage.input_tokens ?? 0
          totalUsage.output += usage.output_tokens ?? 0
          totalUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
          totalUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
        }
      }
    } catch (error) {
      sdkLog.error('SDK execution error:', error)
      // Telemetry: record failure
      telemetryEntry.status = 'failed'
      telemetryEntry.completedAt = Date.now()
      telemetryEntry.durationMs = telemetryEntry.completedAt - telemetryEntry.startedAt
      telemetryEntry.error = (error as Error).message
      sdkLog.info(
        `[TELEMETRY:request-failed] id=${requestId} duration=${telemetryEntry.durationMs}ms error=${telemetryEntry.error}`
      )
      yield {
        type: 'error',
        error: `SDK execution failed: ${(error as Error).message}`
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
    }

    // Telemetry: record success
    if (telemetryEntry.status === 'started') {
      telemetryEntry.status = 'succeeded'
      telemetryEntry.completedAt = Date.now()
      telemetryEntry.durationMs = telemetryEntry.completedAt - telemetryEntry.startedAt
      telemetryEntry.tokenUsage = { ...totalUsage }
      sdkLog.info(
        `[TELEMETRY:request-succeeded] id=${requestId} duration=${telemetryEntry.durationMs}ms input=${totalUsage.input} output=${totalUsage.output}`
      )
    }

    // Yield final metadata chunk (callers can check for _meta)
    yield {
      type: 'status',
      content: 'complete',
      _meta: { sessionId, result: resultText, tokenUsage: totalUsage }
    } as StreamChunk & { _meta: SDKExecuteResult }
  }

  /**
   * Execute a single prompt and collect the full text result (non-streaming).
   * Used for decomposition and other one-shot queries.
   */
  async executeAndCollect(options: SDKExecuteOptions): Promise<{
    result: string
    sessionId?: string
    tokenUsage: { input: number; output: number }
  }> {
    let result = ''
    let sessionId: string | undefined
    const totalUsage = { input: 0, output: 0 }

    for await (const chunk of this.execute(options)) {
      if (chunk.type === 'text' && chunk.content) {
        result += chunk.content
      }
      if ('_meta' in chunk && chunk._meta) {
        const meta = chunk._meta as SDKExecuteResult
        sessionId = meta.sessionId
        totalUsage.input = meta.tokenUsage.input
        totalUsage.output = meta.tokenUsage.output
      }
    }

    return { result, sessionId, tokenUsage: totalUsage }
  }
}

export const sdkExecutor = new SDKExecutor()
