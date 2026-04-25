import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  Query,
  AgentMcpServerSpec,
  PermissionUpdate,
  PermissionResult
} from '@anthropic-ai/claude-agent-sdk'
import type { StreamChunk } from './agent-base.service'
import { authProvider } from './auth-provider'
import {
  createScopeGuard,
  createCodeGraphFirstHook,
  createFireAndForgetHook,
  createPostToolUseHook,
  createPostToolUseFailureHook,
  createNotificationHook,
  createSessionEndHook,
  createFileChangedHook,
  createPermissionDeniedHook,
  createSubagentStartHook,
  createSubagentStopHook,
  createTaskCreatedHook,
  createTaskCompletedHook,
  createPreCompactHook,
  createPostCompactHook
} from './sdk-hooks'
import { app } from 'electron'
// electron-log imported via sdkLog from sdk-executor barrel
import {
  HeartbeatMonitor,
  TokenAccountant,
  TelemetryRecorder,
  ToolTracker,
  normalizeMessage,
  sdkLog
} from './sdk-executor/index'
import type { StreamState } from './sdk-executor/index'

// Re-export middleware types for external consumers
export type { TelemetryEntry } from './sdk-executor/telemetry-recorder'
export type { TokenUsage } from './sdk-executor/token-accountant'

/**
 * Terminal reason — why a query stopped. SDK 0.2.96+.
 * Used for smarter recovery nudge, circuit breaker, and user-facing diagnostics.
 */
export type TerminalReason =
  | 'blocking_limit'
  | 'rapid_refill_breaker'
  | 'prompt_too_long'
  | 'image_error'
  | 'model_error'
  | 'aborted_streaming'
  | 'aborted_tools'
  | 'stop_hook_prevented'
  | 'hook_stopped'
  | 'tool_deferred'
  | 'max_turns'
  | 'completed'

// requestCounter moved to TelemetryRecorder

export interface SDKAgentDefinition {
  description: string
  prompt: string
  tools?: string[]
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit'
  /** MCP server references for SubAgents — e.g. [{ 'code-graph': { type: 'sdk', name: 'code-graph' } }] */
  mcpServers?: AgentMcpServerSpec[]
  /** Fire-and-forget SubAgent — runs in background, no blocking (SDK 0.2.96+) */
  background?: boolean
  /** Auto-load memory files for the SubAgent (SDK 0.2.96+) */
  memory?: 'project' | 'user' | 'local'
  /** Effort level per SubAgent — simple tasks get 'low', complex get 'high'/'xhigh'/'max' (SDK 0.2.96+, 'xhigh' added 0.2.120+) */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Permission mode per SubAgent — investigation = 'default', implementation = 'auto' (SDK 0.2.96+) */
  permissionMode?: 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits' | 'auto' | 'dontAsk'
}

export interface SDKExecuteOptions {
  prompt: string | AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>
  systemPrompt: string
  model: string
  cwd: string
  permissionMode: 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits' | 'auto' | 'dontAsk'
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
  /** Enable per-tool approval flow via PreToolUse hook (fallback when canUseTool is not available) */
  enableToolApproval?: boolean
  /** Max agentic turns (tool-use rounds). SDK stops the loop after this many turns. */
  maxTurns?: number
  /** MCP server configurations for in-process MCP tools (e.g. repomap) */
  mcpServers?: Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig>
  /** Additional directories for monorepo support — allows reading/writing sibling packages */
  additionalDirectories?: string[]
  /** OS-level sandboxing for Bash commands (Linux bubblewrap / macOS sandbox-exec) */
  sandbox?: {
    enabled: boolean
    autoAllowBashIfSandboxed?: boolean
    failIfUnavailable?: boolean
    allowUnsandboxedCommands?: boolean
    /** Relax restrictions on child processes (e.g. npm → node spawns) */
    enableWeakerNestedSandbox?: boolean
    /** Relax network restrictions for dev servers that bind ports */
    enableWeakerNetworkIsolation?: boolean
    network?: {
      allowLocalBinding?: boolean
    }
    /** Commands that bypass the sandbox entirely (matched as prefixes) */
    excludedCommands?: string[]
  }
  /**
   * Strategy η: Hard cap on output tokens. The model stops generating after this limit.
   * Used to control specialist output verbosity based on investigation depth.
   */
  maxOutputTokens?: number
  /** Enable native SDK file checkpointing for rewindFiles() */
  enableFileCheckpointing?: boolean
  /** Enable follow-up prompt suggestions (nearly free — uses prompt cache) */
  promptSuggestions?: boolean
  /** Guarantee all hook lifecycle events are emitted (SDK 0.2.96+) */
  includeHookEvents?: boolean
  /** Native auto-compact window control (SDK 0.2.96+) — SDK handles compaction timing */
  autoCompactWindow?: boolean
  /** Beta features — 1M context window */
  betas?: 'context-1m-2025-08-07'[]
  /** Fallback model when primary is unavailable/rate-limited */
  fallbackModel?: string
  /** Custom permission handler — richer than PreToolUse hooks.
   *  When provided, replaces the PreToolUse approval hook. */
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      signal: AbortSignal
      title?: string
      displayName?: string
      description?: string
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      decisionReason?: string
      toolUseID: string
      agentID?: string
    }
  ) => Promise<PermissionResult>
  /** Callback before context compaction (receives pre-compaction token count) */
  onPreCompact?: (preTokens: number) => void
  /** Callback after context compaction (receives pre and post token counts) */
  onPostCompact?: (preTokens: number, postTokens: number) => void
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
   * Mapped from complexity tier: simple→low, moderate→medium, complex→xhigh (SDK 0.2.120+).
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /**
   * Thinking display mode (SDK 0.2.96+):
   * - 'summarized' — condensed reasoning for transparency (generalist)
   * - 'omitted' — skip thinking entirely for specialist queries
   */
  thinkingDisplay?: 'summarized' | 'omitted'
  /** Hard USD budget cap. SDK returns error_max_budget_usd when exceeded. */
  maxBudgetUsd?: number
  /** Token-aware pacing budget — model self-paces instead of being hard-killed (@alpha) */
  taskBudget?: { total: number }
  /** Callback when SDK denies a tool call (PermissionMode: 'auto' classifier) */
  onPermissionDenied?: (toolName: string, reason: string) => void
  /** Callback for MCP server elicitation requests (structured forms / URL auth) */
  onElicitation?: (
    request: import('@anthropic-ai/claude-agent-sdk').ElicitationRequest,
    options: { signal: AbortSignal }
  ) => Promise<import('@anthropic-ai/claude-agent-sdk').ElicitationResult>
  /** Callback when a SubAgent starts (before stream messages) */
  onSubagentStart?: (agentId: string, description: string) => void
  /** Callback when a SubAgent stops */
  onSubagentStop?: (agentId: string, status: string) => void
  /** Callback when a task object is created (before execution) */
  onTaskCreated?: (taskId: string, description: string) => void
  /** Callback when a task finishes execution */
  onTaskCompleted?: (taskId: string, status: string) => void
  /** Resume session at a specific message point — enables 'Undo to here' (SDK 0.2.96+) */
  resumeSessionAt?: string
  /**
   * Force login to specific organization(s) (SDK 0.2.96+).
   * Accepts a single UUID or an array for multi-org support (e.g., consulting setups).
   */
  forceLoginOrgUUID?: string | string[]
}

export interface SDKExecuteResult {
  sessionId?: string
  result?: string
  /** Why the query stopped — SDK 0.2.96+ terminal_reason field */
  terminalReason?: TerminalReason
  /** Session title generated by the SDK — free, no extra API call needed */
  sessionTitle?: string
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
    // ── Composable middleware ──
    const telemetry = new TelemetryRecorder(options.model)
    const heartbeat = new HeartbeatMonitor(options.heartbeatIntervalMs ?? 15000)
    const tokens = new TokenAccountant()
    const tools = new ToolTracker()
    const state: StreamState = { streamedTextLength: 0 }

    heartbeat.start()

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
        // PermissionDenied hook — surfaces SDK-denied tool calls to the UI
        ...(options.onPermissionDenied
          ? {
              PermissionDenied: [
                { hooks: [createPermissionDeniedHook(options.onPermissionDenied)] }
              ]
            }
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
        // Compaction lifecycle hooks — log pre/post compaction for diagnostics + optional callbacks
        PreCompact: [
          {
            hooks: [
              (input: Record<string, unknown>) => {
                sdkLog.info(
                  `[compact:pre] Compaction starting — trigger=${input.trigger ?? 'unknown'}`
                )
                return { decision: 'proceed' }
              },
              ...(options.onPreCompact ? [createPreCompactHook(options.onPreCompact)] : [])
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
              },
              ...(options.onPostCompact ? [createPostCompactHook(options.onPostCompact)] : [])
            ]
          }
        ],
        ...(options.onSubagentStart
          ? { SubagentStart: [{ hooks: [createSubagentStartHook(options.onSubagentStart)] }] }
          : {}),
        ...(options.onSubagentStop
          ? { SubagentStop: [{ hooks: [createSubagentStopHook(options.onSubagentStop)] }] }
          : {}),
        ...(options.onTaskCreated
          ? { TaskCreated: [{ hooks: [createTaskCreatedHook(options.onTaskCreated)] }] }
          : {}),
        ...(options.onTaskCompleted
          ? { TaskCompleted: [{ hooks: [createTaskCompletedHook(options.onTaskCompleted)] }] }
          : {})
      }

      this.activeQuery = query({
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
          ...(options.disallowedTools?.length ? { disallowedTools: options.disallowedTools } : {}),
          resume: options.resume,
          // Modern thinking config takes precedence over deprecated maxThinkingTokens
          ...(options.thinking
            ? { thinking: options.thinking }
            : options.maxThinkingTokens
              ? { maxThinkingTokens: options.maxThinkingTokens }
              : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.thinkingDisplay ? { thinkingDisplay: options.thinkingDisplay } : {}),
          ...(options.maxBudgetUsd ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
          // Structured output — forces model to return schema-valid JSON
          ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
          // Required safety flag when using bypassPermissions (legacy — prefer 'auto' mode)
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
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
          ...(options.additionalDirectories?.length
            ? { additionalDirectories: options.additionalDirectories }
            : {}),
          // Strategy η: Hard cap on output tokens — model stops generating after this limit
          ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
          // New SDK options
          ...(options.enableFileCheckpointing ? { enableFileCheckpointing: true } : {}),
          ...(options.promptSuggestions ? { promptSuggestions: true } : {}),
          ...(options.includeHookEvents ? { includeHookEvents: true } : {}),
          ...(options.autoCompactWindow ? { autoCompactWindow: true } : {}),
          ...(options.betas?.length ? { betas: options.betas } : {}),
          // taskBudget — disabled until API supports 'task-budgets' beta header
          // ...(options.taskBudget ? { taskBudget: options.taskBudget } : {}),
          ...(options.resumeSessionAt ? { resumeSessionAt: options.resumeSessionAt } : {}),
          ...(options.fallbackModel ? { fallbackModel: options.fallbackModel } : {}),
          ...(options.canUseTool ? { canUseTool: options.canUseTool } : {}),
          // Multi-org login support (SDK 0.2.96+ — accepts string | string[])
          ...(options.forceLoginOrgUUID ? { forceLoginOrgUUID: options.forceLoginOrgUUID } : {}),
          env: {
            ...process.env,
            CLAUDE_AGENT_SDK_CLIENT_APP: `agent-studio/${app.getVersion()}`
          },
          // Get typed streaming events — eliminates need for dedup with assistant replay
          includePartialMessages: true,
          // Wire elicitation callback for MCP server user input requests
          ...(options.onElicitation ? { onElicitation: options.onElicitation } : {})
        }
      })

      try {
        for await (const message of this.activeQuery) {
          heartbeat.touch()

          // Emit pending heartbeat if timer fired between iterations
          if (heartbeat.consumeHeartbeat()) {
            yield { type: 'status', content: 'heartbeat' }
          }
          const msg = message as Record<string, unknown>

          // ── Delegate to stream normalizer for all message type handling ──
          yield* normalizeMessage(msg, tools, tokens, state, options.cwd)
        }
      } finally {
        this.activeQuery = null
      }
    } catch (error) {
      sdkLog.error('SDK execution error:', error)
      telemetry.recordFailure(error as Error)
      yield {
        type: 'error',
        error: `SDK execution failed: ${(error as Error).message}`
      }
    } finally {
      heartbeat.stop()
    }

    // Telemetry: record success
    const tokenSummary = tokens.getSummary()
    telemetry.finalize(tokenSummary)

    // Yield final metadata chunk (callers can check for _meta)
    yield {
      type: 'status',
      content: 'complete',
      _meta: {
        sessionId: state.sessionId,
        result: state.resultText,
        terminalReason: state.terminalReason,
        sessionTitle: state.sessionTitle,
        tokenUsage: tokenSummary
      }
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
