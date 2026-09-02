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
import type { SendOutcome } from './agent-session.service'

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
   * Set when, in Plan mode, the model attempted a blocked tool (Write/Edit/MultiEdit/
   * ExitPlanMode) and the SDK returned "No such tool available". Triggers a deterministic
   * emit_plan recovery in finalizeStream so the user still gets a plan card.
   */
  planModeToolBlock?: boolean
  /** Which tool was blocked — so the recovery prompt can name it accurately. */
  planModeBlockedTool?: string
  /** Set when api_retry chunks indicate server overload (529/503/overloaded) */
  overloadDetected?: boolean
  /**
   * LLM provider actually serving this stream, resolved from the conversation
   * rather than the session default (they differ when a conversation overrides
   * the workspace provider). Carried here so token attribution records the
   * provider that ran the turn, not the one the session started on.
   *
   * The provider is stored rather than the derived `ExecutorBackend` because the
   * backend is a pure function of it (`claude` → cli, everything else → opencode)
   * while the reverse is lossy — `opencode` alone cannot distinguish a free
   * local model from paid GLM.
   */
  llmProvider?: LLMProvider
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
  /** Resolve the CLI executor for a specific conversation (creates one if needed). */
  getOrCreateCliExecutor(conversationId: string): CLIExecutor
  readonly circuitBreaker: AgentCircuitBreaker
  readonly recoveryNudge: RecoveryNudgeService
  readonly toolActivityAccumulator: ToolActivityAccumulator
  readonly adapter: AgentRoleAdapter
  readonly mcpConfigWriter: CliMcpConfigWriter
  /** G1: Per-session instance ID for MCP config isolation (parallel build tasks). */
  readonly instanceId: string | undefined

  // ── Mutable state ──
  sessionMap: Map<string, string>
  turnCounts: Map<string, number>
  dbSessionId: string | null
  workspacePath: string | null
  workspaceId: string | null
  /** Most-recently-started conversation — backward-compat alias for currentConversationId. */
  lastActiveConversationId: string | null
  /** Per-conversation stream contexts (text accumulator + abort controller). */
  activeStreams: Map<string, ActiveStreamContext>
  /**
   * Backward-compat proxy — reads/writes lastActiveConversationId's context.
   * Delegates with conversationId in scope should prefer activeStreams.get(conversationId).
   */
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
  lastSendOutcome: SendOutcome
  lastStreamOpts: ExecuteStreamOptions | null
  pendingResumeAt: Map<string, string>
  sdkAbortController: AbortController | null

  /** Get accumulated text for a specific conversation (or lastActive if omitted). */
  getAccumulatedTextForConversation(conversationId?: string): string

  /**
   * Absolute cwd to spawn this conversation's CLI in.
   *
   * Returns the conversation's worktree when it has one, otherwise the
   * workspace root. Always prefer passing `conversationId` explicitly — the
   * omitted form resolves through `lastActiveConversationId`, which is exactly
   * the ambiguity that concurrent streams break.
   */
  resolveExecutionPath(conversationId?: string): string

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
  /**
   * OPENCODE-RECOVERY: one-shot recovery turn on an existing OpenCode session
   * (recovery-nudge path — the main turn ended without a summary/completion
   * block). Fresh abort scope; chunks forwarded via onChunk.
   */
  executeOpenCodeRecoveryTurn(params: {
    sessionId: string
    prompt: string
    onChunk: (chunk: StreamChunk) => void
  }): AsyncGenerator<StreamChunk>
}

// ── Static constants (replicated from AgentSessionService) ──
export const SESSION_CONSTANTS = {
  MAX_TURN_CONTINUATIONS: 5,
  /**
   * `--max-turns` for every spawned CLI process, regardless of mode.
   *
   * This is a runaway guard, not a mode policy. Mode-aware limiting already
   * exists one layer up and is finer-grained (MAX_PLAN_TOOL_CALLS = 250 /
   * MAX_BUILD_TOOL_CALLS = 400 in agent-circuit-breaker, plus
   * MAX_TURN_CONTINUATIONS). A second, coarser mode-coupled ceiling in argv
   * bought nothing and made the process non-reusable across a plan⇄build
   * toggle — the flag is spawn-time only, so a mode-dependent value forces a
   * respawn (and a full MCP reconnection) on the first message after a toggle.
   */
  CLI_MAX_TURNS: 200,
  /**
   * Base idle budget. The extended external-MCP budget is NOT mirrored here:
   * it lives only as `AgentSessionService.EXTERNAL_MCP_INTERACTION_TIMEOUT_MS`,
   * which `buildStreamTimeout` applies to `longRunningTools` integrations only.
   * A copy here had no readers and drifted out of step with that rule.
   */
  MAX_INTERACTION_TIMEOUT_MS: 10 * 60_000
} as const

/** Per-conversation streaming state — isolates accumulatedText + abortController per conversation. */
export interface ActiveStreamContext {
  accumulatedText: string
  /**
   * Length of `accumulatedText` at the start of the current TURN.
   * `accumulatedText` is per-message (cleared only in resetForNewMessage), but the
   * circuit breaker's gratuitous-tool heuristic is per-turn (it keys off
   * `_toolCallCount === 1`). Subtracting this baseline gives the text written
   * *this* turn. Reset to the current length by continueTurnLimit.
   */
  accumulatedTextBaseline?: number
  abortController: AbortController | null
  /**
   * Absolute cwd for this conversation's CLI process.
   *
   * Per-conversation rather than per-session because a session serves many
   * conversations and each one may own a different git worktree. Reading the
   * session-wide `workspacePath` instead is what allowed three concurrent
   * streams to write into one working tree on whichever branch happened to be
   * checked out. Undefined means "no isolation resolved yet" and callers fall
   * back to `workspacePath`.
   */
  executionPath?: string
  /**
   * The user asked for this turn to stop (Stop button, pipeline cancel).
   *
   * Set by cancelCurrentQuery, read by executeStream once the turn ends. A
   * gracefully cancelled turn ends with a normal `result` and an unaborted
   * signal, so this flag is the only remaining way to tell it apart from a turn
   * that finished on its own — and the post-turn continuation paths (recovery
   * nudge, max_turns auto-continue) would otherwise start a new turn right after
   * the user pressed Stop. Lives on the per-turn context, which is recreated on
   * every send, so it cannot leak into the next turn.
   */
  cancelledByUser?: boolean
}

export type { StreamChunk, ExecutorResult, CLIExecuteOptions }
