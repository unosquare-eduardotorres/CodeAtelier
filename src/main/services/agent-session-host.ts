/**
 * AgentSessionHost — internal interface exposing AgentSessionService state
 * to its delegate classes (stream processor, recovery manager, executor factory).
 *
 * This interface exists to enable the god-class decomposition without changing
 * field visibility. The session passes `this as unknown as AgentSessionHost`
 * to its delegates — safe because all listed fields exist on the instance.
 *
 * @internal Not for use outside the agent-session module.
 */

import type { LogFunctions } from 'electron-log'
import type {
  AgentStatus,
  ConversationMode,
  ControlToolState,
  CostPreference,
  LLMProvider,
  ExecutorBackend
} from '../../shared/types'
import type { ContextWindowTier } from './context-management'
import type { AgentTokenTracker } from './agent-token-tracker'
import type { AgentCircuitBreaker } from './agent-circuit-breaker'
import type { RecoveryNudgeService } from './agent-recovery-nudge'
import type { ToolActivityAccumulator } from './tool-activity-accumulator'
import type { AgentRoleAdapter, AdapterMcpResult } from './agent-session.types'
import type { CLIExecutor, CLIExecuteOptions } from './cli-executor'
import type { CliMcpConfigWriter } from './cli-mcp-config-writer'
import type { IpcBridge } from './ipc-bridge'
import type { ExecutorResult } from './executor-types'
import type { StreamChunk } from './agent-base.service'

/** Stashed options for executeStream replay on auto-continue */
export interface ExecuteStreamOptions {
  sdkPrompt: string | AsyncIterable<unknown>
  systemPrompt: string
  sessionId: string | undefined
  conversationId: string
  turnCount: number
  isBuildMode: boolean
  mcpResult: AdapterMcpResult
  llmProvider: LLMProvider
  recoveryDepth?: number
  localContextWindow?: number
  contextTier?: ContextWindowTier
}

/** Loop state tracked within executeStream */
export interface StreamLoopState {
  messageStopReceived: boolean
  hasTextAfterLastTool: boolean
  lastTerminalReason?: string
  sessionRecoveryNeeded: boolean
  /**
   * Set when, in Plan mode, the model attempted a blocked Write/Edit and the SDK
   * returned "No such tool available". Triggers a deterministic emit_plan recovery
   * in finalizeStream so the user still gets a plan card.
   */
  planModeToolBlock?: boolean
}

/**
 * Internal state surface of AgentSessionService accessible to delegates.
 *
 * Fields are typed to match the actual runtime shape. The `as unknown as`
 * cast at delegate construction is safe because these fields all exist.
 */
export interface AgentSessionHost {
  // ── Immutable sub-services ──
  readonly log: LogFunctions
  readonly tokenTracker: AgentTokenTracker
  readonly cliExecutor: CLIExecutor
  readonly circuitBreaker: AgentCircuitBreaker
  readonly recoveryNudge: RecoveryNudgeService
  readonly toolActivityAccumulator: ToolActivityAccumulator
  readonly adapter: AgentRoleAdapter
  readonly mcpConfigWriter: CliMcpConfigWriter

  // ── Mutable state ──
  sessionMap: Map<string, string>
  turnCounts: Map<string, number>
  dbSessionId: string | null
  workspacePath: string | null
  workspaceId: string | null
  currentConversationId: string | null
  accumulatedText: string
  currentMode: ConversationMode
  costPreference: CostPreference
  llmProvider: LLMProvider
  executorBackend: ExecutorBackend
  ipcBridge: IpcBridge | null

  // Token state (from AgentBaseService)
  currentStatus: AgentStatus['status']
  tokenUsage: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number

  // Compaction state
  effectiveContextWindow: number | undefined
  lastContextTokens: number | undefined
  compactCount: number
  compactSuggestThreshold: number
  compactAutoThreshold: number
  compactSuggested: boolean
  turnsSinceCompactSuggestion: number

  // Control + continuation state
  controlToolState: ControlToolState
  maxTurnsContinuations: number
  lastStreamOpts: ExecuteStreamOptions | null
  pendingResumeAt: Map<string, string>
  sdkAbortController: AbortController | null

  // ── Methods ──
  emit(event: string | symbol, ...args: unknown[]): boolean
  resolveLocalContextWindow(): number
  /** Cached MCP config path from the most recent CLI spawn (for recovery turns that need control-actions/emit_plan). */
  getCliMcpConfigPath(): string | undefined
  executeStream(opts: ExecuteStreamOptions): Promise<void>
  flushTokenUsage(): void
  emitAdapterEvent(evt: string, payload: unknown): void
  getStatus(): AgentStatus
  clearSession(conversationId: string): void
  /** Save local plan state for the given conversation (used by circuit breaker recovery) */
  saveCurrentPlanState(conversationId: string): void
}

// ── Static constants (replicated from AgentSessionService) ──
export const SESSION_CONSTANTS = {
  MAX_TURN_CONTINUATIONS: 3,
  MAX_INTERACTION_TIMEOUT_MS: 10 * 60_000,
  EXTERNAL_MCP_INTERACTION_TIMEOUT_MS: 30 * 60_000
} as const

export type { StreamChunk, ExecutorResult, CLIExecuteOptions }
