/**
 * Types for the generic AgentSessionService and its role adapters.
 *
 * Introduced for Phase 1 of the Project Specialist refactor — see
 * docs/architecture/project-specialist-refactor.md.
 *
 * The generic session service drives a long-lived Claude CLI session and
 * defers role-specific concerns (prompt assembly, MCP config, intent
 * detection, control-tool callbacks) to an AgentRoleAdapter.
 */

import type {
  AgentRole,
  ConversationMode,
  ControlToolState,
  CostPreference
} from '../../shared/types'
import type { ControlActionCallbacks } from './control-actions.tool'

// ── Config for starting a session ────────────────────────────────────

export interface AgentSessionStartParams {
  workspacePath: string
  mode?: ConversationMode
  resumeSessionId?: string
}

// ── Prompt + MCP context passed to adapters each turn ────────────────

export interface AdapterPromptContext {
  message: string
  conversationId: string
  hasImages: boolean
  turnCount: number
  sessionId: string | undefined
  mode: ConversationMode
  workspacePath: string
  workspaceId: string | null
  costPreference: CostPreference
}

export interface AdapterPromptResult {
  systemPrompt: string
  effectiveMessage: string
}

export interface AdapterMcpContext {
  mode: ConversationMode
  workspacePath: string
  workspaceId: string | null
  conversationId: string | null
  controlCallbacks: ControlActionCallbacks
}

export interface AdapterMcpResult {
  mcpServers?: Record<string, unknown>
  allowedTools?: string[]
  disallowedTools?: string[]
}

export interface AdapterIntentContext {
  accumulatedText: string
  controlToolState: ControlToolState
  mode: ConversationMode
  conversationId: string
  /** Emits onto the session's EventEmitter — same channels the Generalist uses today. */
  emit: (event: AgentSessionEventName, payload: unknown) => void
}

export interface AdapterSessionLifecycleCtx {
  workspacePath: string
  workspaceId: string | null
  conversationId: string | null
}

// ── Events emitted by AgentSessionService ────────────────────────────
//
// These names mirror the events the Generalist already emits today. Any
// change to this list is a breaking change for IPC consumers — keep in
// sync with src/main/ipc/agent.ipc.ts.

export type AgentSessionEventName =
  | 'chunk'
  | 'statusUpdate'
  | 'complete'
  | 'intent'
  | 'handoff'
  | 'plan'
  | 'askQuestion'
  | 'promptSuggestion'
  | 'compactNeeded'
  | 'elicitation'
  | 'elicitationResponse'

// ── Role adapter interface ───────────────────────────────────────────

export interface AgentRoleAdapter {
  /** Which role this adapter implements. */
  readonly role: AgentRole

  /**
   * Stable identifier written to event logs, agent_sessions.agent_id,
   * and passed to the SDK as `agentId`. Generalist returns DA_VINCI_AGENT_ID;
   * Project Specialist returns `workspace-specialist-<workspaceId>`.
   */
  readonly agentId: string

  /** Absolute interaction cap; null = use session default. */
  readonly interactionTimeoutMs?: number

  /**
   * Called from AgentSessionService.start() to warm role state
   * (load prompt, feature flags, persona, etc.).
   */
  onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void>

  /**
   * Refresh feature flags / settings from the workspace before each send().
   * Adapters can no-op if they hold no mutable flags.
   */
  refreshFeatureFlags(ctx: AdapterSessionLifecycleCtx): void

  /**
   * Signal that conversation or persona state has changed so the adapter can
   * invalidate cached prompts.
   */
  onConversationSwitch(conversationId: string): void

  /** Assemble system prompt + effective user message for the upcoming turn. */
  buildPrompts(ctx: AdapterPromptContext): AdapterPromptResult

  /** Compose MCP servers + allow/deny tool lists for the turn. */
  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult

  /**
   * Wire control-tool callbacks (plan/handoff/askUser/memory).
   * Adapters without control tools may return no-op callbacks.
   */
  buildControlCallbacks(params: {
    conversationId: string | null
    emit: (event: AgentSessionEventName, payload: unknown) => void
    getAccumulatedText: () => string
  }): ControlActionCallbacks

  /**
   * Post-stream: detect + emit intents from accumulated text and control-tool state.
   * Generalist runs the full intent detector; Project Specialist emits a single
   * 'response' intent unconditionally.
   */
  emitDetectedIntents(ctx: AdapterIntentContext): void

  /** Compaction-specific tweaks — adapter can override compaction thresholds. */
  getCompactionThresholds?(costPreference: CostPreference): {
    suggest: number
    auto: number
  } | null

  /** Persona support — adapter can expose a persona override or return null. */
  getPersonaId?(): string | null

  /** Reset adapter state when the session stops. */
  onSessionStop(): void
}

// ── Status snapshot helpers ──────────────────────────────────────────

export interface AgentSessionStatusInput {
  role: AgentRole
  agentId: string
  currentStatus: 'idle' | 'thinking' | 'writing' | 'reviewing' | 'failed'
  tokenUsage: number
  contextTokens?: number
  elapsedMs: number
  activeMcpTools?: string[]
}
