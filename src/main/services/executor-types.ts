/**
 * Shared types for all executor backends (CLI, OpenCode).
 *
 * These types are consumed by the stream normalizer, agent session service,
 * and each executor implementation. Keeping them in a neutral module avoids
 * circular dependencies between executors and the normalizer.
 */

/**
 * Terminal reason — why a query/session stopped.
 * Emitted by the interactive CLI and OpenCode in the result event.
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

/**
 * Token usage breakdown — unified across all executor backends.
 */
export interface ExecutorTokenUsage {
  input: number
  output: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/**
 * Metadata returned by any executor after a query completes.
 * Attached to the final 'status: complete' StreamChunk as `_meta`.
 */
export interface ExecutorResult {
  sessionId?: string
  result?: string
  terminalReason?: TerminalReason
  sessionTitle?: string
  /** Origin of the result — 'user-prompted' or 'task-notification' */
  resultOrigin?: string
  tokenUsage: ExecutorTokenUsage
}

/**
 * Common execute options shared across executor backends.
 * Each executor may extend this with backend-specific fields.
 */
export interface ExecutorBaseOptions {
  prompt: string
  systemPrompt: string
  model: string
  cwd: string
  permissionMode: 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits' | 'auto' | 'dontAsk'
  allowedTools?: string[]
  disallowedTools?: string[]
  resume?: string
  abortController?: AbortController
  heartbeatIntervalMs?: number
  agentId?: string
  maxTurns?: number
  additionalDirectories?: string[]
  envOverrides?: Record<string, string>
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Completion goal — Claude works autonomously until this condition is met (Claude Code 2.1.139+) */
  goal?: string
}

// ── Types previously from @anthropic-ai/claude-agent-sdk ──
// Defined locally to remove the SDK dependency.

/** MCP server stdio config — replaces McpServerConfig from SDK. */
export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

/** Alias for stdio-based MCP server config. */
export type McpStdioServerConfig = McpServerConfig

/** Prompt input — replaces SDKUserMessage for non-SDK paths. */
export type AgentPromptInput = string | Array<{ type: string; [key: string]: unknown }>
