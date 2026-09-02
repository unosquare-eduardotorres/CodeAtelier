/**
 * Shared types for all executor backends (CLI, OpenCode).
 *
 * These types are consumed by the stream normalizer, agent session service,
 * and each executor implementation. Keeping them in a neutral module avoids
 * circular dependencies between executors and the normalizer.
 */

import type { ContextManagementConfig } from './context-management'

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
  /**
   * Current context-window occupancy — the prompt size of the latest API
   * round-trip, NOT the per-turn accumulated sum. Used for the context badge
   * and compaction thresholds. Optional: backends that don't report per-call
   * usage (e.g. OpenCode) omit it, and consumers fall back to the summed totals.
   */
  contextWindowTokens?: number
  /**
   * Prompt size of the FIRST API round-trip of the turn — the invariant prefix
   * (system prompt + tool schemas + user message) before any tool result was
   * appended. Unlike `contextWindowTokens` it is never overwritten, so it is
   * the only quantity against which prefix-reduction work can be measured.
   * Omitted by backends that report no per-call usage (e.g. OpenCode); there is
   * NO summed-total fallback — the sum over-counts by ~10-30x.
   */
  firstCallContextTokens?: number
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
  /** Enable auto-compact */
  autoCompactEnabled?: boolean
  /** Context window size for auto-compact threshold */
  contextWindowSize?: number
  /** App-level context management config (tool-result clearing, compaction thresholds) */
  contextManagement?: ContextManagementConfig
}

// ── Types previously from @anthropic-ai/claude-agent-sdk ──
// Defined locally to remove the SDK dependency.

/** Prompt input — replaces SDKUserMessage for non-SDK paths. */
export type AgentPromptInput =
  | string
  | Array<{ type: string; [key: string]: unknown }>
  | { message: { role: string; content: unknown }; parent_tool_use_id: string | null }
