import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { StreamChunk } from './agent-base.service'
import { summarizeToolInput } from './agent-base.service'
import { authProvider } from './auth-provider'
import {
  createScopeGuard,
  createCodeGraphFirstHook,
  createFireAndForgetHook,
  createPostToolUseHook,
  createPostToolUseFailureHook,
  createNotificationHook,
  createSessionEndHook,
  createFileChangedHook
} from './sdk-hooks'
import log from 'electron-log/main'

const sdkLog = log.scope('SDKExecutor')

/** Internal telemetry tracking for SDK request lifecycle logging */
interface TelemetryEntry {
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
}

let requestCounter = 0

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
  permissionMode: 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits'
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
  /**
   * Strategy η: Hard cap on output tokens. The model stops generating after this limit.
   * Used to control specialist output verbosity based on investigation depth.
   */
  maxOutputTokens?: number
  /** Enable native SDK file checkpointing for rewindFiles() */
  enableFileCheckpointing?: boolean
  /** Enable follow-up prompt suggestions (nearly free — uses prompt cache) */
  promptSuggestions?: boolean
  /** Beta features — e.g. ['context-1m-2025-08-07'] for 1M context */
  betas?: string[]
  /** Fallback model when primary is unavailable/rate-limited */
  fallbackModel?: string
  /** Custom permission handler — richer than PreToolUse hooks */
  canUseTool?: unknown
  /** Callback when session ends (for cleanup) */
  onSessionEnd?: () => void
  /** Callback when a file is changed by the agent */
  onFileChanged?: (filePath: string, changeType: string) => void
  /**
   * Structured output format. Forces the model to return JSON matching this schema.
   * SDK guarantees valid JSON — no regex extraction needed.
   * On schema violation, SDK retries up to 3x (error_max_structured_output_retries on exhaustion).
   */
  outputFormat?: {
    type: 'json_schema'
    schema: Record<string, unknown>
  }
  /**
   * Modern thinking config — replaces deprecated maxThinkingTokens.
   * - { type: 'adaptive' } — Claude decides thinking depth (Opus 4.6+)
   * - { type: 'enabled', budgetTokens: N } — Fixed budget
   * - { type: 'disabled' } — No extended thinking
   */
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' }
  /**
   * Effort level — controls reasoning depth independently of thinking budget.
   * Mapped from complexity tier: simple→low, moderate→medium, complex→high.
   */
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Hard USD budget cap. SDK returns error_max_budget_usd when exceeded. */
  maxBudgetUsd?: number
  /** Callback for MCP server elicitation requests (structured forms / URL auth) */
  onElicitation?: (
    request: import('@anthropic-ai/claude-agent-sdk').ElicitationRequest,
    options: { signal: AbortSignal }
  ) => Promise<import('@anthropic-ai/claude-agent-sdk').ElicitationResult>
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
  private activeQuery: Query | null = null

  /** Get the active Query reference for instance method calls */
  getActiveQuery(): Query | null {
    return this.activeQuery
  }

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
    const telemetryEntry: TelemetryEntry = {
      requestId,
      startedAt: Date.now(),
      model: options.model,
      status: 'started'
    }
    sdkLog.info(`[TELEMETRY:request-started] id=${requestId} model=${options.model}`)

    // Heartbeat / stall detection
    const heartbeatInterval = options.heartbeatIntervalMs ?? 15000
    let lastActivityAt = Date.now()
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let pendingHeartbeat = false
    const STALL_THRESHOLD_MS = 60000

    // With includePartialMessages: true, stream_event messages are guaranteed for real-time
    // streaming. The `assistant` message is a complete replay — we skip yielding from it.
    // Only toolIdToName is needed to map tool_result back to tool names.
    const toolIdToName = new Map<string, string>()
    // Track whether any content has been emitted this turn (for turn_boundary detection)
    let hasPriorContent = false

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

      // Add fire-and-forget detection for long-running Bash commands
      preToolUseHooks.push(createFireAndForgetHook())

      // Add Code Graph-first enforcement when code-graph MCP server is active (warn mode — logs but doesn't block)
      if (
        options.mcpServers &&
        Object.keys(options.mcpServers).some((k) => k.includes('code-graph'))
      ) {
        preToolUseHooks.push(createCodeGraphFirstHook('warn'))
      }

      // Add per-tool approval hook if enabled
      if (options.enableToolApproval) {
        const { createToolApprovalHook } = await import('./sdk-hooks')
        preToolUseHooks.push(createToolApprovalHook(options.agentId ?? 'unknown', options.taskId))
      }

      // Build hooks config — PreToolUse + optional PostToolUse, Notification, etc.
      const hooksConfig: Record<string, unknown> = {
        PreToolUse: [{ hooks: preToolUseHooks }],
        PostToolUse: [{ hooks: [createPostToolUseHook(options.agentId ?? 'unknown')] }],
        PostToolUseFailure: [
          { hooks: [createPostToolUseFailureHook(options.agentId ?? 'unknown')] }
        ],
        Notification: [{ hooks: [createNotificationHook()] }],
        ...(options.onSessionEnd
          ? { SessionEnd: [{ hooks: [createSessionEndHook(options.onSessionEnd)] }] }
          : {}),
        ...(options.onFileChanged
          ? { FileChanged: [{ hooks: [createFileChangedHook(options.onFileChanged)] }] }
          : {}),
        // Elicitation lifecycle hooks — log MCP server elicitation requests
        Elicitation: [
          {
            hooks: [
              (input: Record<string, unknown>) => {
                sdkLog.info(
                  `[elicitation:requested] server=${input.mcp_server_name} mode=${input.mode ?? 'form'}`
                )
                return {}
              }
            ]
          }
        ],
        ElicitationResult: [
          {
            hooks: [
              (input: Record<string, unknown>) => {
                sdkLog.info(`[elicitation:result] action=${input.action}`)
                return {}
              }
            ]
          }
        ],
        // Compaction lifecycle hooks — log pre/post compaction for diagnostics
        PreCompact: [
          {
            hooks: [
              (input: Record<string, unknown>) => {
                sdkLog.info(
                  `[compact:pre] Compaction starting — trigger=${input.trigger ?? 'unknown'}`
                )
                return { decision: 'proceed' }
              }
            ]
          }
        ],
        PostCompact: [
          {
            hooks: [
              (input: Record<string, unknown>) => {
                const summary = input.compact_summary as string | undefined
                sdkLog.info(
                  `[compact:post] Compaction complete — summary_length=${summary?.length ?? 0}`
                )
                return {}
              }
            ]
          }
        ]
      }

      this.activeQuery = query({
        prompt: options.prompt,
        // @ts-expect-error — TODO: agents.mcpServers type drift with SDK AgentMcpServerSpec
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
          ...(options.disallowedTools?.length ? { disallowedTools: options.disallowedTools } : {}),
          resume: options.resume,
          // Modern thinking config takes precedence over deprecated maxThinkingTokens
          ...(options.thinking
            ? { thinking: options.thinking }
            : options.maxThinkingTokens
              ? { maxThinkingTokens: options.maxThinkingTokens }
              : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.maxBudgetUsd ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
          // Structured output — forces model to return schema-valid JSON
          ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
          // Required safety flag when using bypassPermissions
          allowDangerouslySkipPermissions: options.permissionMode === 'bypassPermissions',
          // Wire scope guard + PostToolUse + Notification + lifecycle hooks
          hooks: hooksConfig,
          // Cap agentic turns at the SDK level (defense-in-depth alongside circuit breaker)
          ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
          // Pass AbortController for cancellation support
          ...(options.abortController ? { abortController: options.abortController } : {}),
          // Enable AI-generated progress summaries for sub-agents (~30s intervals)
          ...(options.agents ? { agentProgressSummaries: true } : {}),
          // Wire in-process MCP servers (e.g. repomap code graph)
          ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
          // Strategy η: Hard cap on output tokens — model stops generating after this limit
          ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
          // New SDK options
          ...(options.enableFileCheckpointing ? { enableFileCheckpointing: true } : {}),
          ...(options.promptSuggestions ? { promptSuggestions: true } : {}),
          ...(options.betas?.length ? { betas: options.betas } : {}),
          ...(options.fallbackModel ? { fallbackModel: options.fallbackModel } : {}),
          ...(options.canUseTool ? { canUseTool: options.canUseTool } : {}),
          // Get typed streaming events — eliminates need for dedup with assistant replay
          includePartialMessages: true,
          // Wire elicitation callback for MCP server user input requests
          ...(options.onElicitation ? { onElicitation: options.onElicitation } : {})
        }
      })

      try {
        for await (const message of this.activeQuery) {
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

          // Assistant messages are complete replays — with includePartialMessages: true,
          // all content was already streamed via stream_event. We only use assistant messages
          // to populate toolIdToName for any tool_use blocks not yet tracked.
          if (msg.type === 'assistant') {
            const assistantMsg = msg.message as Record<string, unknown> | undefined
            if (assistantMsg?.content && Array.isArray(assistantMsg.content)) {
              for (const block of assistantMsg.content as Record<string, unknown>[]) {
                if (block.type === 'tool_use') {
                  const toolId = block.id as string | undefined
                  const toolName = block.name as string
                  if (toolId && !toolIdToName.has(toolId)) {
                    toolIdToName.set(toolId, toolName)
                  }
                }
              }
            }
          }

          // Map stream_event — with includePartialMessages: true, these are the
          // authoritative source for real-time text and tool_use streaming.
          if (msg.type === 'stream_event') {
            const streamEvent = (msg as Record<string, unknown>).event as Record<string, unknown>
            if (!streamEvent) continue

            // Real-time text streaming
            if (streamEvent.type === 'content_block_delta') {
              const delta = streamEvent.delta as Record<string, unknown> | undefined
              if (delta?.type === 'text_delta' && delta.text) {
                hasPriorContent = true
                yield { type: 'text', content: delta.text as string }
              }
              // Structured output may stream as json_delta
              if (delta?.type === 'json_delta' && delta.json) {
                hasPriorContent = true
                yield { type: 'text', content: delta.json as string }
              }
            }

            // Tool use start
            if (streamEvent.type === 'content_block_start') {
              const cb = streamEvent.content_block as Record<string, unknown> | undefined
              if (cb?.type === 'tool_use') {
                const toolId = cb.id as string | undefined
                const toolName = cb.name as string
                const toolInput = cb.input as Record<string, unknown> | undefined
                const hasInput = toolInput && Object.keys(toolInput).length > 0

                if (toolId) {
                  toolIdToName.set(toolId, toolName)
                }

                hasPriorContent = true
                yield {
                  type: 'tool_use',
                  toolName,
                  toolId,
                  toolInput: hasInput
                    ? summarizeToolInput(toolName, toolInput, options.cwd)
                    : undefined
                }
              }
            }

            // Token usage from message_start + turn boundary detection
            if (streamEvent.type === 'message_start') {
              // Turn boundary — signal renderer to finalize current bubble and start a new one
              // Only emit when there's been prior content (text or tools) to avoid empty bubbles
              if (hasPriorContent) {
                yield { type: 'turn_boundary' as const, content: `turn-${Date.now()}` }
              }

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
                  const toolUseId = block.tool_use_id as string | undefined
                  const toolName = (toolUseId && toolIdToName.get(toolUseId)) ?? 'Unknown'
                  if (toolUseId) {
                    toolIdToName.delete(toolUseId)
                  }

                  // Extract tool result content for forwarding to renderer
                  let resultContent: string | undefined
                  if (typeof block.content === 'string') {
                    resultContent = block.content
                  } else if (Array.isArray(block.content)) {
                    // Content blocks array — extract text parts
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
          }

          // Capture result text
          if (msg.type === 'result') {
            const subtype = (msg as Record<string, unknown>).subtype as string | undefined
            const isError = (msg as Record<string, unknown>).is_error as boolean | undefined

            // Detect SDK-level execution errors (budget exceeded, max turns, schema validation)
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
              yield {
                type: 'error',
                error: `SDK execution stopped: ${errorDetail}`
              }
            }

            resultText = msg.result as string | undefined

            // For structured output (json_schema), the JSON is in structured_output, not result
            if (!resultText) {
              const structuredOutput = (msg as Record<string, unknown>).structured_output
              if (structuredOutput) {
                resultText =
                  typeof structuredOutput === 'string'
                    ? structuredOutput
                    : JSON.stringify(structuredOutput)
              }
            }

            if (resultText && !hasPriorContent) {
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

          // ── tool_progress — elapsed time updates for running tools ──
          if (msg.type === 'tool_progress') {
            const toolMsg = msg as Record<string, unknown>
            yield {
              type: 'tool_progress',
              toolId: toolMsg.tool_use_id as string,
              toolName: toolMsg.tool_name as string,
              elapsedSeconds: toolMsg.elapsed_time_seconds as number,
              content: `${toolMsg.elapsed_time_seconds}s`
            }
          }

          // ── rate_limit_event — subscription rate limit warnings/rejections ──
          if (msg.type === 'rate_limit_event') {
            const rateMsg = msg as Record<string, unknown>
            const info = rateMsg.rate_limit_info as Record<string, unknown>
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
          }

          // ── system/api_retry — API retry events ──
          if (msg.type === 'system' && msg.subtype === 'api_retry') {
            const retryMsg = msg as Record<string, unknown>
            yield {
              type: 'api_retry',
              retryInfo: {
                attempt: retryMsg.attempt as number,
                maxRetries: retryMsg.max_retries as number,
                retryDelayMs: retryMsg.retry_delay_ms as number,
                errorStatus: retryMsg.error_status as number | null
              }
            }
          }

          // ── system/compact_boundary — context compaction ──
          if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
            const meta = (msg as Record<string, unknown>).compact_metadata as
              | Record<string, unknown>
              | undefined
            yield {
              type: 'compact_boundary',
              content: `Context compacted (trigger: ${meta?.trigger ?? 'auto'}, pre-tokens: ${meta?.pre_tokens ?? '?'})`
            }
          }

          // ── system/status — compacting status ──
          if (msg.type === 'system' && msg.subtype === 'status') {
            const status = (msg as Record<string, unknown>).status as string | null
            yield { type: 'session_state', content: status ?? 'idle' }
          }

          // ── prompt_suggestion — follow-up prompt suggestions ──
          if (msg.type === 'prompt_suggestion') {
            yield {
              type: 'prompt_suggestion',
              content: (msg as Record<string, unknown>).suggestion as string
            }
          }

          // ── system/files_persisted — track file changes ──
          if (msg.type === 'system' && msg.subtype === 'files_persisted') {
            const filesMsg = msg as Record<string, unknown>
            yield {
              type: 'files_persisted',
              persistedFiles: (
                filesMsg.files as Array<{ filename: string; file_id: string }> | undefined
              )?.map((f) => ({
                filename: f.filename,
                fileId: f.file_id
              }))
            }
          }

          // ── tool_use_summary — batch tool summaries ──
          if (msg.type === 'tool_use_summary') {
            yield {
              type: 'tool_use_summary',
              content: (msg as Record<string, unknown>).summary as string
            }
          }

          // ── system/hook_started, hook_progress, hook_response ──
          if (
            msg.type === 'system' &&
            ['hook_started', 'hook_progress', 'hook_response'].includes(msg.subtype as string)
          ) {
            const hookMsg = msg as Record<string, unknown>
            yield {
              type: 'hook_lifecycle',
              hookInfo: {
                hookId: hookMsg.hook_id as string,
                hookName: hookMsg.hook_name as string,
                hookEvent: hookMsg.hook_event as string,
                phase: (msg.subtype === 'hook_started'
                  ? 'started'
                  : msg.subtype === 'hook_progress'
                    ? 'progress'
                    : 'response') as 'started' | 'progress' | 'response',
                output: hookMsg.output as string | undefined,
                outcome: hookMsg.outcome as 'success' | 'error' | 'cancelled' | undefined
              }
            }
          }

          // ── system/session_state_changed ──
          if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
            yield {
              type: 'session_state',
              content: (msg as Record<string, unknown>).state as string
            }
          }

          // ── auth_status ──
          if (msg.type === 'auth_status') {
            const authMsg = msg as Record<string, unknown>
            yield {
              type: 'auth_status',
              content: authMsg.error ? `Auth error: ${authMsg.error}` : 'Authenticating...'
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
      } finally {
        this.activeQuery = null
      }
    } catch (error) {
      sdkLog.error('SDK execution error:', error)
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
        // Fallback: if no text was streamed, use the result from SDK metadata
        // This handles structured output (json_schema) which may arrive as tool_use blocks
        if (!result && meta.result) {
          result = typeof meta.result === 'string' ? meta.result : JSON.stringify(meta.result)
        }
      }
    }

    return { result, sessionId, tokenUsage: totalUsage }
  }
}

export const sdkExecutor = new SDKExecutor()
