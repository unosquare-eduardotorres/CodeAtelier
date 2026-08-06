/**
 * AgentSessionService — generic long-lived AI session runtime.
 *
 * Supports two executor backends (derived from LLM provider, not user-configurable):
 *   - 'cli'      — Claude CLI (stream-json mode) — used when provider === 'claude'
 *   - 'opencode'  — OpenCode multi-provider runtime — used for all other providers
 *
 * Rule: provider === 'claude' → 'cli'; everything else → 'opencode'.
 *
 * Phase 1 of the Project Specialist refactor (see
 * docs/architecture/project-specialist-refactor.md). Extracted from
 * chat-agent.service.ts by separating:
 *
 *   - generic session/stream/compaction/recovery lifecycle (THIS FILE)
 *   - role-specific prompt/MCP/intent logic (AgentRoleAdapter)
 *
 * Chat agent behavior is delivered by ProjectSpecialistRoleAdapter.
 * The same service drives all specialist roles.
 */

import type {
  AgentStatus,
  ConversationMode,
  ControlToolState,
  CostPreference,
  GrillQuestion,
  ImageAttachment,
  LLMProvider,
  ExecutorBackend
} from '../../shared/types'
import type { AgentPromptInput } from './executor-types'
import { EXTERNAL_MCP_INTEGRATIONS, resolveModelAction } from '../../shared/constants'
import { parseDbTimestamp } from '../../shared/db-time'
import { chatAgentLogger } from '../logger'
import { AgentBaseService } from './agent-base.service'
import type { StreamChunk } from './agent-base.service'
import type { ExecutorResult } from './executor-types'
import { CLIExecutor } from './cli-executor'
import type { CLIExecuteOptions, CLIExecuteResult } from './cli-executor'
import { resolveContextTier, TIER_LIMITS } from './context-management'
import type { ContextWindowTier } from './context-management'
import { auditContextBudget, estimateToolCount } from './context-budget-auditor'
import { authProvider } from './auth-provider'
import { vectorSearchService } from './vector-search.service'
import { conversationRepository, messageRepository, workspaceRepository } from '../db/repositories'
import { planRepository } from '../db/repositories/plan.repository'
import { modelConfigService } from './model-config.service'
import { eventLoggerService } from './event-logger.service'
import type { ControlActionCallbacks } from './control-actions.tool'
import { evaluateAskUserGuard } from './ask-user-guard'
import { AgentTokenTracker } from './agent-token-tracker'
import type { CacheEfficiencyReport } from './agent-token-tracker'
import { AgentCircuitBreaker } from './agent-circuit-breaker'
import { RecoveryNudgeService } from './agent-recovery-nudge'
import { ToolActivityAccumulator } from './tool-activity-accumulator'
import { localPlanStateService } from './local-plan-state.service'
import { localContextReconstructor } from './local-context-reconstructor'
import { IpcBridge } from './ipc-bridge'
import { parsePlanPayload } from './agent-session-handlers'
import { AgentStreamProcessor } from './agent-stream-processor'
import { AgentRecoveryManager } from './agent-recovery-manager'
import { AgentExecutorFactory } from './agent-executor-factory'
import { openCodeExecutor } from './opencode-executor'
import type { OpenCodeExecuteResult } from './opencode-executor'
import { openCodeConfigWriter } from './opencode-config-writer'
import { openCodeAgentWriter } from './opencode-agent-writer'
import { CliMcpConfigWriter } from './cli-mcp-config-writer'
import { elicitationService } from './elicitation.service'
import { primingContextGatherer } from './priming-context-gatherer'
import {
  ensureOpencodePathInEnv,
  getOpencodePath,
  resolveOpencodePath
} from '../../shared/opencode-cli-path'
import { resolveOpenCodeProviderFromSnapshot } from './snapshot-model-resolver'
import type { McpFeatureFlags } from './workspace-mcp-config'
import type {
  AgentRoleAdapter,
  AgentSessionEventName,
  AdapterMcpResult
} from './agent-session.types'

/**
 * Outcome of the last session.send() — set by handleStreamError terminal paths.
 * 'ok' = normal completion; non-'ok' values record why the session ended abnormally.
 * Used by blueprint executeTask/startVerifyPhase to detect absorbed errors.
 */
export type SendOutcome =
  'ok' | 'overload' | 'turn_limit_exhausted' | 'context_overflow' | 'error' | 'aborted'

/** Internal loop-state book-keeping for executeStream. */
interface StreamLoopState {
  messageStopReceived: boolean
  hasTextAfterLastTool: boolean
  lastTerminalReason: string | undefined
  sessionRecoveryNeeded: boolean
  /** Set when api_retry chunks indicate server overload (529/503/overloaded) */
  overloadDetected?: boolean
}

/** Options bag for the executeStream orchestrator. */
interface ExecuteStreamOptions {
  sdkPrompt: string | AsyncIterable<AgentPromptInput>
  systemPrompt: string
  sessionId: string | undefined
  conversationId: string
  turnCount: number
  isBuildMode: boolean
  mcpResult: AdapterMcpResult
  llmProvider: LLMProvider
  recoveryDepth?: number
  /** Pre-resolved local context window size — avoids redundant lookups. */
  localContextWindow?: number
  /** F3: Pre-resolved context tier — avoids re-resolving per tool_use chunk. */
  contextTier?: ContextWindowTier
  /** Whether the local LLM context window was reliably detected (vs. heuristic fallback). */
  contextWindowConfident?: boolean
  /** Explicit goal condition — takes priority over adapter duck-typing. */
  goal?: string
  goalMode?: 'advisory' | 'enforce'
}

// ── Helpers ──

/**
 * Split SDK content-block arrays (from buildSdkPrompt) into separate text
 * and image components for the OpenCode executor.
 * Pure function — extracted for testability.
 */
export function splitContentBlocks(
  input: string | Iterable<{ type: string; [k: string]: unknown }>
): { text: string; images: ImageAttachment[] | undefined } {
  if (typeof input === 'string') {
    return { text: input, images: undefined }
  }
  const blocks = Array.from(input)
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b as unknown as { text: string }).text)
    .join('\n')
  const images = blocks
    .filter((b) => b.type === 'image')
    .map((b) => {
      const src = (b as unknown as { source: { media_type: string; data: string } }).source
      return { base64: src.data, mimeType: src.media_type, fileName: 'pasted-image' }
    })
  return { text, images: images.length > 0 ? images : undefined }
}

/**
 * Generic session runtime. Accepts an AgentRoleAdapter that supplies the
 * role-specific pieces (prompt, MCP, control callbacks, intent detection).
 */
export class AgentSessionService extends AgentBaseService {
  protected readonly log = chatAgentLogger

  // Compaction defaults — initialization values before applyCompactionThresholds runs.
  // The real thresholds are resolved dynamically based on the model's effective context
  // window (200K for Opus/Haiku, 1M for Sonnet) — see resolveCompactionThresholds().
  // These statics serve as the fallback initialization; 60%/75% of 200K (the most
  // common default since specialist plan mode uses Opus).
  private static readonly DEFAULT_COMPACT_SUGGEST_THRESHOLD = 120_000
  private static readonly DEFAULT_COMPACT_AUTO_THRESHOLD = 150_000
  private static readonly MAX_INTERACTION_TIMEOUT_MS = 10 * 60_000 // 10 minutes
  /** Extended timeout when external MCP tools (Maestro, etc.) are active — flows can run 5+ min each. */
  private static readonly EXTERNAL_MCP_INTERACTION_TIMEOUT_MS = 30 * 60_000 // 30 minutes

  private workspacePath: string | null = null
  private workspaceId: string | null = null
  /** Most-recently-started conversation — for backward-compat queries (logging, UI, bridge). */
  private _lastActiveConversationId: string | null = null
  /** Per-conversation stream contexts (text accumulator + abort controller). */
  private readonly activeStreams = new Map<
    string,
    import('./agent-session-host').ActiveStreamContext
  >()
  /** Fallback accumulator for direct field access when no activeStreams context exists (test compat). */
  private _directAccumulatedText = ''
  /** HEAD sha captured at session start — for memory extraction git delta. */
  private currentStartSha: string | undefined
  /** Per-session set of fact IDs already injected — prevents re-injection on subsequent turns. */
  private injectedFactIds = new Set<string>()
  private currentMode: ConversationMode = 'plan'
  private costPreference: CostPreference = 'balanced'
  private llmProvider: LLMProvider = 'claude'
  /** Active executor backend — derived from llmProvider on start(). Default: 'cli'. */
  private executorBackend: ExecutorBackend = 'cli'

  /** Maps conversationId → SDK session_id for resume. */
  private readonly sessionMap = new Map<string, string>()

  /** Whether the last executeStream was terminated by the interaction timeout. */
  private _lastTimedOut = false

  // sdkAbortController moved into per-conversation ActiveStreamContext (activeStreams map)
  /** OpenCode config path (written to temp dir). */
  private _openCodeConfigPath: string | undefined
  /** A-1: Pending priming context parts — consumed by the first execute() call. */
  private _pendingPrimingContext: Array<{ type: 'text'; text: string }> | undefined
  /** Per-conversation CLI executors — each conversation gets its own interactive claude process. */
  private readonly cliExecutors = new Map<string, CLIExecutor>()
  /**
   * Backward-compat accessor — returns the executor for lastActiveConversationId.
   * Falls back to '__idle__' if no conversation has started yet (e.g. during init).
   * The '__idle__' key is cleaned up on next start() via cliExecutors.clear().
   */
  get cliExecutor(): CLIExecutor {
    return this.getOrCreateCliExecutor(this._lastActiveConversationId ?? '__idle__')
  }

  getOrCreateCliExecutor(conversationId: string): CLIExecutor {
    let executor = this.cliExecutors.get(conversationId)
    if (!executor) {
      executor = new CLIExecutor()
      this.cliExecutors.set(conversationId, executor)
    }
    return executor
  }
  /** CLI MCP config writer — generates --mcp-config JSON for Claude CLI sessions. */
  private readonly mcpConfigWriter = new CliMcpConfigWriter()
  /** IPC bridge — Unix domain socket for control-actions MCP server ↔ Electron main process. */
  private ipcBridge: IpcBridge | null = null

  private readonly tokenTracker = new AgentTokenTracker()
  private readonly circuitBreaker = new AgentCircuitBreaker()
  readonly recoveryNudge = new RecoveryNudgeService()
  /** S8: Tracks tool activity for structured summaries, plan state, and compaction decisions */
  private readonly toolActivityAccumulator = new ToolActivityAccumulator()

  // ── Delegates (extracted from this file to reduce complexity) ──
  private readonly streamProcessor: AgentStreamProcessor
  private readonly recoveryManager: AgentRecoveryManager
  private readonly executorFactory: AgentExecutorFactory

  compactSuggestThreshold = AgentSessionService.DEFAULT_COMPACT_SUGGEST_THRESHOLD
  compactAutoThreshold = AgentSessionService.DEFAULT_COMPACT_AUTO_THRESHOLD
  compactSuggested = false
  private compactCount = 0
  /** Turns elapsed since last compact suggestion — re-suggest every 3 turns if dismissed. */
  turnsSinceCompactSuggestion = 0
  private lastContextTokens: number | undefined
  /** Effective context window for the current session (model-aware: 200K for Opus, 1M for Sonnet). */
  effectiveContextWindow: number | undefined

  // F5: Per-conversation resume target — prevents cross-conversation races.
  // Previously instance-level, which meant switching conversations could
  // consume the wrong conversation's resumeAt target.
  private readonly pendingResumeAt = new Map<string, string>()

  /** Auto-continue on max_turns: how many times we've resumed so far this message. */
  maxTurnsContinuations = 0
  /** Outcome of the last send() — set by handleStreamError, reset in resetForNewMessage. */
  lastSendOutcome: SendOutcome = 'ok'
  /** Stashed executeStream options for replay on max_turns auto-continue. */
  lastStreamOpts: ExecuteStreamOptions | null = null

  /**
   * SES-01: Per-conversation send lock — serializes concurrent send() calls
   * for the same conversation to prevent shared mutable state corruption
   * (accumulatedText, currentConversationId, sdkAbortController, etc.).
   */
  private readonly sendLocks = new Map<string, Promise<void>>()

  /** SES-02: Guard flag to prevent concurrent ensureIpcBridge() calls from creating duplicate bridges. */
  private ipcBridgeStarting = false

  private controlToolState: ControlToolState = {
    plan: false,
    askUser: false
  }

  /**
   * Read-only access to the current turn's control tool state.
   * Used by chat-stream.service for late plan injection when the plan event
   * arrives via IPC socket after the stream complete event via stdout.
   */
  getControlToolState(): ControlToolState {
    return this.controlToolState
  }

  /** G1: Per-session instance ID for MCP config file isolation (parallel build tasks). */
  readonly instanceId: string | undefined

  constructor(
    private readonly adapter: AgentRoleAdapter,
    instanceId?: string
  ) {
    super()
    this.instanceId = instanceId
    this.streamProcessor = new AgentStreamProcessor(this)
    this.recoveryManager = new AgentRecoveryManager(this)
    this.executorFactory = new AgentExecutorFactory(this)
  }

  // ── Per-conversation state proxies ──────────────────────────────
  // Getter/setters proxy through lastActiveConversationId so the 50+
  // existing references in bridge listeners, logging, and error paths
  // work unchanged.  Hot-path delegates (stream processor, recovery manager)
  // use activeStreams.get(conversationId) directly for correctness.

  /** Backward-compat alias — always points at the most-recently-started conversation. */
  get lastActiveConversationId(): string | null {
    return this._lastActiveConversationId
  }
  set lastActiveConversationId(v: string | null) {
    this._lastActiveConversationId = v
  }

  get currentConversationId(): string | null {
    return this._lastActiveConversationId
  }
  set currentConversationId(v: string | null) {
    this._lastActiveConversationId = v
  }

  get accumulatedText(): string {
    const convId = this._lastActiveConversationId
    if (convId) {
      const ctx = this.activeStreams.get(convId)
      if (ctx) return ctx.accumulatedText
    }
    return this._directAccumulatedText
  }
  set accumulatedText(value: string) {
    const convId = this._lastActiveConversationId
    if (convId) {
      const ctx = this.activeStreams.get(convId)
      if (ctx) {
        ctx.accumulatedText = value
        return
      }
    }
    this._directAccumulatedText = value
  }

  private _directAbortController: AbortController | null = null
  get sdkAbortController(): AbortController | null {
    const convId = this._lastActiveConversationId
    if (convId) {
      const ctx = this.activeStreams.get(convId)
      if (ctx) return ctx.abortController
    }
    return this._directAbortController
  }
  set sdkAbortController(value: AbortController | null) {
    const convId = this._lastActiveConversationId
    if (convId) {
      const ctx = this.activeStreams.get(convId)
      if (ctx) {
        ctx.abortController = value
        return
      }
    }
    this._directAbortController = value
  }

  /** Get accumulated text for a specific conversation (or lastActive if omitted). */
  getAccumulatedTextForConversation(conversationId?: string): string {
    const convId = conversationId ?? this._lastActiveConversationId
    return convId ? (this.activeStreams.get(convId)?.accumulatedText ?? '') : ''
  }

  // ── Accessors ─────────────────────────────────────────────────────

  getRole(): AgentRoleAdapter['role'] {
    return this.adapter.role
  }

  getAgentId(): string {
    return this.adapter.agentId
  }

  getAdapter(): AgentRoleAdapter {
    return this.adapter
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  getWorkspaceId(): string | null {
    return this.workspaceId
  }

  getCurrentConversationId(): string | null {
    return this._lastActiveConversationId
  }

  getMode(): ConversationMode {
    return this.currentMode
  }

  getStreamedContent(conversationId?: string): string {
    const convId = conversationId ?? this._lastActiveConversationId
    return convId ? (this.activeStreams.get(convId)?.accumulatedText ?? '') : ''
  }

  /** Return the outcome of the most recent send() call. */
  getLastSendOutcome(): SendOutcome {
    return this.lastSendOutcome
  }

  isRunning(): boolean {
    return this.workspacePath !== null
  }

  /** Whether the last send() was terminated by an interaction timeout. */
  wasTimedOut(): boolean {
    return this._lastTimedOut
  }

  getSessionId(conversationId: string): string | undefined {
    return this.sessionMap.get(conversationId)
  }

  getCacheEfficiency(): CacheEfficiencyReport {
    return this.tokenTracker.getCacheEfficiency(this.currentConversationId)
  }

  clearSession(conversationId: string): void {
    this.sessionMap.delete(conversationId)
    // TURN-COUNT-01: Reset turn count so the next session starts at turn 1,
    // ensuring adapters apply first-turn setup (specialist roster, MCP guidance, etc.)
    this.turnCounts.delete(conversationId)
    // SESSION-PENDING-01: Clear stale resume target to prevent cross-session resume races
    this.pendingResumeAt.delete(conversationId)
    // SENDLOCKS-LEAK-01: Clean up send lock — it's a synchronization artifact,
    // not resumable state. Once a conversation is cleared, its lock is dead weight.
    this.sendLocks.delete(conversationId)
    // Phase-2: Clean up per-conversation stream context and CLI executor
    this.activeStreams.delete(conversationId)
    const executor = this.cliExecutors.get(conversationId)
    if (executor) {
      executor.killProcess().catch(() => {})
      this.cliExecutors.delete(conversationId)
    }
  }

  /**
   * #11: Generate an AI-generated summary of the current session.
   * Uses OpenCode's native session.summarize() for OpenCode backend,
   * falls back to the stored conversation summary for other backends.
   *
   * Note on CLI backend: Claude CLI has no native summarize command.
   * Summaries are populated via `extractStructuredSummary` during stream
   * processing (regex-based extraction from assistant output). The fallback
   * path below retrieves that stored summary from the conversation repository.
   */
  async summarizeSession(conversationId?: string): Promise<string | undefined> {
    const targetConversationId = conversationId ?? this.currentConversationId
    if (!targetConversationId) return undefined

    // Try OpenCode native summarize first
    if (this.executorBackend === 'opencode') {
      const sessionId = openCodeExecutor.getSessionId(targetConversationId)
      if (sessionId) {
        try {
          const summary = await openCodeExecutor.summarizeSession(sessionId)
          if (summary) {
            // Also persist it for future use
            conversationRepository.updateSummary(targetConversationId, summary)
            return summary
          }
        } catch (err) {
          this.log.warn('[summarizeSession] OpenCode summarize failed:', err)
        }
      }
    }

    // Fallback: return stored summary (CLI/local-direct rely on extractStructuredSummary)
    return conversationRepository.getSummary(targetConversationId)
  }

  /**
   * Send a user's response to a pending ask_user request.
   * Called by the IPC handler when the renderer sends back an answer.
   * Routes through the IPC bridge to the control-actions MCP server.
   */
  respondToAskUser(requestId: string, response: string): void {
    // ASK-OVERWRITE-01: Clear the askUser flag so subsequent ask_user calls aren't blocked
    this.controlToolState.askUser = false
    if (this.ipcBridge) {
      this.ipcBridge.sendAskUserResponse(requestId, response)
    } else {
      this.log.warn(`[respondToAskUser] No IPC bridge available for requestId=${requestId}`)
    }
  }

  /**
   * Send a user's response to a pending permission_prompt request.
   * Called by the IPC handler when the renderer approves/denies a tool permission.
   * Routes through the IPC bridge to the control-actions MCP server.
   */
  respondToPermission(requestId: string, approved: boolean): void {
    if (this.ipcBridge) {
      this.ipcBridge.sendPermissionResponse(requestId, approved)
    } else {
      this.log.warn(`[respondToPermission] No IPC bridge available for requestId=${requestId}`)
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start(
    workspacePath: string,
    mode?: ConversationMode,
    resumeSessionId?: string
  ): Promise<void> {
    // Don't abort an active stream if we're re-starting for the same workspace.
    // This prevents HMR, React strict mode, or auto-open from killing in-flight queries.
    // Check if ANY stream is active in this workspace
    // PERF-01: Use for...of with early exit instead of spread+some to avoid O(n)
    // temporary array allocation when activeStreams has many completed entries.
    let hasActiveStream = false
    for (const ctx of this.activeStreams.values()) {
      if (ctx.abortController !== null) {
        hasActiveStream = true
        break
      }
    }
    if (
      hasActiveStream &&
      this.workspacePath === workspacePath &&
      this.currentStatus !== 'idle' &&
      this.currentStatus !== 'failed'
    ) {
      this.log.info(`[start] Skipping restart — stream active for same workspace: ${workspacePath}`)
      return
    }

    if (hasActiveStream) {
      this.log.warn(
        `[start] Aborting ${this.activeStreams.size} active stream(s) — ` +
          `currentWorkspace=${this.workspacePath} newWorkspace=${workspacePath} ` +
          `status=${this.currentStatus} conversationId=${this._lastActiveConversationId}`
      )
      for (const [, ctx] of this.activeStreams) {
        if (ctx.abortController) {
          ctx.abortController.abort()
          ctx.abortController = null
        }
      }
    }

    this.workspacePath = workspacePath
    this.cwd = workspacePath
    this.workspaceId = null
    this.currentMode = mode ?? 'plan'
    this.startedAt = Date.now()
    this.currentStatus = 'idle'
    this.tokenUsage = 0
    this.inputTokens = 0
    this.outputTokens = 0
    this.cacheReadTokens = 0
    this.cacheCreationTokens = 0
    this.lastContextTokens = undefined
    this._lastActiveConversationId = null
    this.activeStreams.clear()
    // GHOST-PROC-01: Kill and clear CLI executors on workspace switch.
    // Without this, orphaned CLI processes from the previous workspace
    // continue running in the background.
    for (const executor of this.cliExecutors.values()) {
      executor.killProcess().catch(() => {})
    }
    this.cliExecutors.clear()
    this._directAccumulatedText = ''
    this._directAbortController = null
    this.compactCount = 0
    this.compactSuggested = false
    this.turnsSinceCompactSuggestion = 0
    this.tokenTracker.resetSession()

    // Capture HEAD sha for memory extraction
    this.currentStartSha = undefined
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: only needed on this rare path
      const { execSync } = require('node:child_process')
      this.currentStartSha =
        (
          execSync('git rev-parse HEAD 2>/dev/null || true', {
            cwd: workspacePath,
            encoding: 'utf-8',
            timeout: 2000,
            windowsHide: true
          }) as string
        ).trim() || undefined
    } catch {
      /* no git — fine */
    }

    // Resolve workspace id + cost preference + executor backend
    try {
      const workspaces = workspaceRepository.findAll()
      const workspace = workspaces.find((w) => w.repoPath === workspacePath)
      if (workspace) this.workspaceId = workspace.id
      const settings = workspace ? workspaceRepository.getSettings(workspace.id) : {}
      this.costPreference = settings.costPreference || 'balanced'
      this.llmProvider = settings.llmProvider || 'claude'
      // Derive executor backend from provider: claude → CLI, everything else → OpenCode.
      // No longer reads settings.executorBackend (was user-configurable, now derived).
      const storedBackend = settings.executorBackend as string | undefined
      this.executorBackend = this.llmProvider === 'claude' ? 'cli' : 'opencode'
      if (storedBackend && storedBackend !== this.executorBackend) {
        this.log.info(
          `[start] Ignoring stored executorBackend='${storedBackend}' — ` +
            `derived from provider='${this.llmProvider}' → '${this.executorBackend}'`
        )
      }
      this.log.info(
        `[start] executorBackend=${this.executorBackend} llmProvider=${this.llmProvider} costPreference=${this.costPreference}`
      )
      this.applyCompactionThresholds(settings)
    } catch {
      /* non-fatal */
    }

    // Let the adapter prime itself (prompt caches, feature flags, persona)
    await this.adapter.onSessionStart({
      workspacePath,
      workspaceId: this.workspaceId,
      conversationId: null
    })

    // Pre-populate session map for resume
    if (resumeSessionId && this._lastActiveConversationId) {
      this.sessionMap.set(this._lastActiveConversationId, resumeSessionId)
    }

    // Load declarative hooks
    const { hookEngine } = await import('./hook-engine.service')
    hookEngine.loadHooks(workspacePath).catch((err) => {
      this.log.warn('Failed to load workspace hooks:', err)
    })

    authProvider.loadFromWorkspace(workspacePath)

    this.createDbSession(this.adapter.agentId, {
      workspaceId: this.workspaceId ?? undefined
    })

    // G7: Uses live model resolution intentionally — at session start no conversation
    // exists yet, so there's no snapshot to read. This is log-only; the actual model
    // for API calls is resolved via resolveModelFromSnapshot() once a conversation ID exists.
    eventLoggerService.logSessionStarted({
      agentId: this.adapter.agentId,
      model: modelConfigService.getModel(
        workspacePath,
        resolveModelAction(this.adapter.role, false)
      )
    })

    this.log.info(`${this.adapter.role} SDK session initialized for workspace:`, workspacePath)
    this.emit('statusUpdate', this.getStatus())
  }

  async send(message: string, conversationId: string, images?: ImageAttachment[]): Promise<void> {
    if (!this.workspacePath) {
      throw new Error(`${this.adapter.role} not started — call start() first`)
    }

    // SES-01: Serialize sends per-conversation to prevent concurrent state corruption.
    // If a send is already in-flight for this conversation, chain after it.
    const prevLock = this.sendLocks.get(conversationId) ?? Promise.resolve()
    const thisLock = prevLock.then(
      () => this._doSend(message, conversationId, images),
      () => this._doSend(message, conversationId, images) // Still proceed after prior error
    )
    this.sendLocks.set(
      conversationId,
      thisLock.catch(() => {})
    ) // Swallow for chain continuity
    return thisLock
  }

  private async _doSend(
    message: string,
    conversationId: string,
    images?: ImageAttachment[]
  ): Promise<void> {
    this.resetForNewMessage(conversationId)

    const sessionId = this.resolveSession(conversationId)

    // Adapter may adjust internal turn counters on resume
    this.adapter.refreshFeatureFlags({
      workspacePath: this.workspacePath!,
      workspaceId: this.workspaceId,
      conversationId
    })

    const hasImages = (images?.length ?? 0) > 0

    // Track turn count locally so we can supply it to the adapter.
    const turnCount = this.incrementTurnCount(conversationId, sessionId !== undefined)

    // Resolve per-conversation LLM provider BEFORE building prompts/MCP config
    let conversationProvider: LLMProvider = this.llmProvider
    try {
      const conv = conversationRepository.findById(conversationId)
      if (conv?.llmProvider) {
        conversationProvider = conv.llmProvider as LLMProvider
      }
    } catch {
      /* non-fatal — keep session default */
    }

    const { systemPrompt, effectiveMessage } = this.adapter.buildPrompts({
      message,
      conversationId,
      hasImages,
      turnCount,
      sessionId,
      mode: this.currentMode,
      workspacePath: this.workspacePath!,
      workspaceId: this.workspaceId,
      costPreference: this.costPreference
    })

    // Resolve context tier for local LLMs — gates tool selection in MCP config.
    // Use the async resolver to get accurate context window + confidence flag.
    // Declared early because the S6+S12 context injection block below also references these.
    const isLocalForMcp = conversationProvider === 'local-llm'
    let localContextWindow: number | undefined
    let contextTier: ContextWindowTier | undefined
    let contextWindowConfident = false
    if (isLocalForMcp) {
      const resolved = await this.resolveLocalContextWindowAsync()
      localContextWindow = resolved.contextWindow
      contextWindowConfident = resolved.confident
      contextTier = resolveContextTier(localContextWindow)
    }

    // S6+S12: Inject conversation context for local LLMs on subsequent turns.
    let enrichedMessage = effectiveMessage
    if (conversationProvider === 'local-llm' && turnCount > 1 && !sessionId) {
      const ctxWindow = localContextWindow ?? this.resolveLocalContextWindow()
      enrichedMessage = this.enrichLocalLLMContext({
        message: effectiveMessage,
        conversationId,
        localContextWindow: ctxWindow,
        contextTier: contextTier ?? resolveContextTier(ctxWindow)
      })
    }

    // CLI context injection: when there's no session to resume and
    // the conversation has prior history, inject a condensed context
    // so the model doesn't cold-start with a greeting.
    // Uses a fixed 4K-token budget (not %-based) since Claude's
    // context window is large enough that this is negligible.
    if (conversationProvider !== 'local-llm' && !sessionId) {
      try {
        const cliContext = localContextReconstructor.buildContextFromHistory({
          conversationId,
          maxTokenBudget: 4000,
          tier: 'large'
        })
        if (cliContext) {
          enrichedMessage = `## Session Context\n${cliContext}\n\n## Current Request\n${enrichedMessage}`
          this.log.info(
            `[CLI:context-injected] conversationId=${conversationId} len=${cliContext.length}`
          )
        }
      } catch {
        /* non-fatal — proceed without context */
      }
    }

    // Per-turn memory injection: prepend relevant facts
    try {
      if (this.workspaceId) {
        const { memoryRetrievalService } = await import('./memory-retrieval.service')
        const { resolveActivePaths } = await import('./active-paths')
        // Facts scoped to a file this session is working on are on-topic even
        // when the message never names it ("fix this bug").
        const activePaths = resolveActivePaths(
          this.workspacePath,
          this.toolActivityAccumulator.getExploredFiles()
        )
        const memoryContext = await memoryRetrievalService.getContextForTurn(
          this.workspaceId,
          enrichedMessage,
          contextTier ?? 'medium',
          this.injectedFactIds,
          activePaths
        )
        if (memoryContext) {
          enrichedMessage = `[Relevant Workspace Knowledge]\n${memoryContext}\n\n---\n\n${enrichedMessage}`
        }
      }
    } catch (memErr) {
      this.log.debug('[_doSend] Per-turn memory retrieval failed (non-fatal):', memErr)
    }

    const sdkPrompt = this.buildSdkPrompt(enrichedMessage, images)

    const controlCallbacks = this.adapter.buildControlCallbacks({
      conversationId,
      emit: (evt, payload) => this.emitAdapterEvent(evt, payload),
      getAccumulatedText: () => this.activeStreams?.get(conversationId)?.accumulatedText ?? ''
    })
    this.wrapControlCallbacks(controlCallbacks)

    const mcpResult = this.adapter.buildMcpConfig({
      mode: this.currentMode,
      workspacePath: this.workspacePath!,
      workspaceId: this.workspaceId,
      conversationId,
      controlCallbacks,
      contextTier
    })

    // Start IPC bridge — the control-actions MCP server sends plan/askUser/memory
    // events through a Unix domain socket.  (ExecutorBackend is exhaustively
    // 'cli' | 'opencode', so the guard was always-true — removed per M3.)
    try {
      await this.ensureIpcBridge(conversationId)
    } catch (err) {
      this.log.error('[send] IPC bridge failed — control-actions in log-only mode:', err)
    }

    // S9: Pre-flight context budget audit for local LLMs — catch "system prompt ate
    // the whole window" before sending the request.
    if (isLocalForMcp && localContextWindow && contextTier) {
      const toolCount = estimateToolCount({
        allowedTools: mcpResult.allowedTools,
        disallowedTools: mcpResult.disallowedTools ?? [],
        isLocalProvider: true
      })
      auditContextBudget({
        systemPrompt,
        toolCount,
        contextWindow: localContextWindow,
        tier: contextTier
      })
    }

    // Consume per-conversation goal from adapter (chat builds via CHAT_SET_GOAL IPC)
    let chatGoal: string | undefined
    let chatGoalMode: 'advisory' | 'enforce' = 'advisory'
    if ('consumeGoalForConversation' in this.adapter) {
      const consumed = (
        this.adapter as {
          consumeGoalForConversation(
            id: string
          ): { goal: string; mode: 'advisory' | 'enforce' } | null
        }
      ).consumeGoalForConversation(conversationId)
      if (consumed) {
        chatGoal = consumed.goal
        chatGoalMode = consumed.mode
      }
    }

    await this.executeStream({
      sdkPrompt,
      systemPrompt,
      sessionId,
      conversationId,
      turnCount,
      isBuildMode: this.currentMode === 'build' || this.currentMode === 'danger',
      mcpResult,
      llmProvider: conversationProvider,
      localContextWindow,
      contextTier,
      contextWindowConfident,
      goal: chatGoal,
      goalMode: chatGoalMode
    })

    // COMPACT-LOST-01: Confirm pending injections (compaction, context) were sent successfully.
    // If executeStream() threw, this line is skipped and the pending state is preserved for retry.
    this.adapter.onSendSuccess?.(conversationId)

    // MEMLEAK-01: Delete the per-conversation activeStreams entry after the stream completes
    // (both success and error paths — error path lands in handleStreamError which already
    // nulls the abortController). Without this, entries accumulate unboundedly, each
    // holding the full accumulatedText (can be 50KB+ per conversation).
    this.activeStreams.delete(conversationId)
  }

  /**
   * Cancels an in-flight query (SDK, CLI, or OpenCode).
   * @param conversationId — cancel only this conversation. If omitted, cancels ALL active streams.
   */
  cancelCurrentQuery(conversationId?: string): void {
    if (conversationId) {
      // Per-conversation cancel
      const ctx = this.activeStreams.get(conversationId)
      if (ctx?.abortController) {
        ctx.abortController.abort()
        ctx.abortController = null
      }
      if (this.executorBackend === 'cli') {
        const executor = this.cliExecutors.get(conversationId)
        if (executor?.isAlive()) {
          executor.killProcess().catch(() => {
            /* best-effort */
          })
        }
      }
      if (this.executorBackend === 'opencode') {
        const sessionId = openCodeExecutor.getSessionId(conversationId)
        if (sessionId && openCodeExecutor.isRunning()) {
          openCodeExecutor.abortSession(sessionId).catch((err) => {
            this.log.warn('[opencode] Session abort failed:', err)
          })
          this.log.info(
            `[cancelCurrentQuery] OpenCode session ${sessionId} abort requested for ${conversationId}`
          )
        }
      }
    } else {
      // Cancel ALL active streams (full reset / backward compat)
      for (const [convId, ctx] of this.activeStreams) {
        if (ctx.abortController) {
          ctx.abortController.abort()
          ctx.abortController = null
        }
        if (this.executorBackend === 'opencode') {
          const sessionId = openCodeExecutor.getSessionId(convId)
          if (sessionId && openCodeExecutor.isRunning()) {
            openCodeExecutor.abortSession(sessionId).catch(() => {})
          }
        }
      }
      if (this.executorBackend === 'cli') {
        for (const executor of this.cliExecutors.values()) {
          if (executor.isAlive()) executor.killProcess().catch(() => {})
        }
      }
    }
  }

  async stop(): Promise<void> {
    // DEADLOCK-GUARD: wrap the entire stop body in a 10s hard timeout.
    // If any sub-step (killProcess, opencode stop, IPC teardown) wedges,
    // the pipeline still advances and markPipelineStopped() can fire.
    const stopBody = async (): Promise<void> => {
      // Abort all per-conversation streams
      for (const [, ctx] of this.activeStreams) {
        if (ctx.abortController) {
          ctx.abortController.abort()
          ctx.abortController = null
        }
      }
      // Fallback: abort _directAbortController if set (test compat + direct assignment)
      if (this._directAbortController) {
        this._directAbortController.abort()
        this._directAbortController = null
      }
      // Kill ALL CLI executors
      if (this.executorBackend === 'cli') {
        for (const executor of this.cliExecutors.values()) {
          await executor.killProcess().catch(() => {})
        }
      }

      // Clean up CLI MCP config
      if (this.workspacePath) {
        this.mcpConfigWriter.dispose(this.workspacePath, this.instanceId)
      }

      // Stop OpenCode server
      if (this.executorBackend === 'opencode') {
        await openCodeExecutor.stop()
        if (this.workspacePath) {
          openCodeConfigWriter.dispose(this.workspacePath)
        }
      }

      // Stop IPC bridge
      if (this.ipcBridge) {
        await this.ipcBridge.stop()
        this.ipcBridge = null
      }

      if (this.workspaceId) {
        await vectorSearchService.dispose(this.workspaceId)
      }
      // ELICIT-NOCLEANUP-01: Cancel any pending elicitations so their promises don't hang forever
      elicitationService.resolveAll()
    }

    const STOP_TIMEOUT_MS = 10_000
    try {
      await Promise.race([
        stopBody(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('stop() timed out after 10s')), STOP_TIMEOUT_MS)
        )
      ])
    } catch (err) {
      chatAgentLogger.warn(
        `[stop] hard timeout — forcing cleanup: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // Cleanup that MUST run even if stopBody timed out
    this.adapter.onSessionStop()
    this.completeDbSession('terminated')
    this.currentStatus = 'idle'
    this._lastActiveConversationId = null
    this.activeStreams.clear()
    this._directAccumulatedText = ''
    this._directAbortController = null
    // Dispose all per-conversation CLI executors
    for (const executor of this.cliExecutors.values()) {
      executor.killProcess().catch(() => {})
    }
    this.cliExecutors.clear()

    // SENDLOCKS-LEAK-01: Clear all locks on session stop. New conversations
    // will create fresh locks on their first send().
    this.sendLocks.clear()

    // NOTE: keep sessionMap populated — we may resume later.
    this.emit('statusUpdate', this.getStatus())
  }

  async switchMode(mode: ConversationMode): Promise<void> {
    if (mode === this.currentMode) return
    if (!this.workspacePath) return

    // MODE-SWITCH-NOLOCK-01: Serialize after the current send (if any) to prevent
    // mid-stream permission changes and MCP cache invalidation.
    const conversationId = this.currentConversationId
    if (!conversationId) {
      // Fresh session (e.g. after app restart) — no send in flight, no lock to
      // serialize against. Apply directly so the first send doesn't run with the
      // stale default 'plan' mode. (Was a silent return — dropped the deferred
      // mode switch from chat-stream.dispatchToAgent and left Build-mode chats
      // streaming with a Plan-mode system prompt.)
      return this._doSwitchMode(mode)
    }
    const prevLock = this.sendLocks.get(conversationId) ?? Promise.resolve()
    const thisLock = prevLock.then(
      () => this._doSwitchMode(mode),
      () => this._doSwitchMode(mode)
    )
    this.sendLocks.set(
      conversationId,
      thisLock.catch(() => {})
    )
    return thisLock
  }

  private async _doSwitchMode(mode: ConversationMode): Promise<void> {
    const previousMode = this.currentMode
    this.log.info(
      `[PIPELINE:mode-switch] ${previousMode} → ${mode} conversationId=${this.currentConversationId}`
    )
    this.currentMode = mode

    // Let the adapter flag a system-prompt rebuild + mode-switch prefix
    this.adapter.onConversationSwitch(this.currentConversationId ?? '')

    if (this.executorBackend === 'cli') {
      // CLI interactive mode: send control message to change permission mode mid-session.
      // No restart needed — the control protocol supports set_permission_mode.
      // acceptEdits: auto-approves working-dir file edits + common fs Bash (deterministic, no account gating).
      const cliPermMap: Record<ConversationMode, string> = {
        plan: 'plan',
        build: 'acceptEdits',
        danger: 'bypassPermissions'
      }
      const cliMode = cliPermMap[mode] ?? 'plan'
      // WRONG-EXECUTOR-01: Use getOrCreateCliExecutor with currentConversationId
      // instead of the cliExecutor getter, which resolves via _lastActiveConversationId
      // and can target the wrong process when multiple streams are active.
      const executor = this.getOrCreateCliExecutor(this.currentConversationId ?? '__idle__')
      executor.setPermissionMode(cliMode as 'plan' | 'auto' | 'bypassPermissions')
      // F6: Invalidate cached MCP config so the next continueSession turn
      // rebuilds it with the new mode's permission level.
      this.executorFactory.invalidateMcpConfigCache()
      this.log.info(
        `[PIPELINE:mode-switch] CLI backend — sent set_permission_mode(${cliMode}) + invalidated MCP cache`
      )
    } else if (this.executorBackend === 'opencode') {
      // OpenCode: update the opencode.json permissions and regenerate config.
      // The new permissions take effect on the next prompt via the config file.
      this.log.info(
        `[PIPELINE:mode-switch] OpenCode backend — regenerating config with ${mode} permissions`
      )
      try {
        if (this.workspacePath) {
          // Provider config now reads from conversation snapshot (no workspace-default bleed)
          const providerConfig = this.resolveOpenCodeProviderConfig()
          const featureFlags = this.resolveWorkspaceMcpFlags()
          // Derive isLocal from the snapshot-resolved providerId
          const isLocal =
            providerConfig.providerId === 'ollama' || providerConfig.providerId === 'omlx'
          openCodeConfigWriter.writeConfig({
            workspacePath: this.workspacePath,
            workspaceId: this.workspaceId,
            conversationId: this.currentConversationId,
            mode,
            provider: providerConfig,
            featureFlags,
            ipcSocketPath: this.ipcBridge?.getSocketPath() ?? undefined,
            isLocalProvider: isLocal
          })
        }
      } catch (err) {
        this.log.warn('[PIPELINE:mode-switch] OpenCode config update failed:', err)
      }
    }
  }

  async compact(): Promise<void> {
    if (!this.workspacePath || !this.currentConversationId) {
      throw new Error('Session not running — nothing to compact')
    }

    // Local LLMs: compaction is not available (no session resume).
    // Signal the UI to suggest a new conversation instead.
    // Read provider from conversation DB to avoid workspace-default cross-contamination.
    let compactConv: ReturnType<typeof conversationRepository.findById> | undefined
    try {
      compactConv = this.currentConversationId
        ? conversationRepository.findById(this.currentConversationId)
        : undefined
    } catch {
      // DB unavailable (e.g. better-sqlite3 ABI mismatch in test env) — fall back to session provider
    }
    const compactProvider = (compactConv?.llmProvider as LLMProvider) ?? this.llmProvider
    if (compactProvider === 'local-llm' && this.executorBackend !== 'opencode') {
      this.log.info('[compaction] Local LLM — compaction unavailable, suggesting new conversation')
      this.emit('compactNeeded', {
        level: 'local-unsupported',
        inputTokens: this.lastContextTokens ?? 0,
        isLocalProvider: true
      })
      return
    }

    // COMPACT-NOLOCK-01: Serialize compact after the current send (if any).
    // Without this, compact() can modify adapter state, send CLI commands,
    // and mutate counters while executeStream() is actively streaming.
    const conversationId = this.currentConversationId
    const prevLock = this.sendLocks.get(conversationId) ?? Promise.resolve()
    const thisLock = prevLock.then(
      () => this._doCompact(),
      () => this._doCompact()
    )
    this.sendLocks.set(
      conversationId,
      thisLock.catch(() => {})
    )
    return thisLock
  }

  private async _doCompact(): Promise<void> {
    // OpenCode backend: use session command API for compaction
    if (this.executorBackend === 'opencode') {
      const openCodeSessionId = this.currentConversationId
        ? openCodeExecutor.getSessionId(this.currentConversationId)
        : undefined
      if (!openCodeSessionId) {
        this.log.warn('[compaction] OpenCode — no session found for this conversation')
        return
      }
      this.compactCount++
      this.compactSuggested = false
      // N9: Actually send the compact command to OpenCode
      try {
        const result = await openCodeExecutor.compactSession(openCodeSessionId)
        if (result.success) {
          this.log.info(
            `[compaction] OpenCode compact #${this.compactCount} sent for session ${openCodeSessionId}`
          )
        } else {
          this.log.warn(`[compaction] OpenCode compact failed: ${result.error ?? 'unknown error'}`)
        }
      } catch (err) {
        this.log.warn('[compaction] OpenCode compact threw:', err)
      }
      // The session.compacted event will be forwarded via normalizeEvent()
      return
    }

    // CLI backend: send /compact slash command to the interactive process
    if (this.executorBackend === 'cli') {
      // WRONG-EXECUTOR-02: Resolve the correct per-conversation executor
      // instead of using the getter which goes through _lastActiveConversationId.
      const executor = this.getOrCreateCliExecutor(this.currentConversationId ?? '__idle__')
      if (executor.isAlive()) {
        this.log.info(`[compaction] CLI backend — sending /compact #${this.compactCount + 1}`)
        this.compactCount++
        this.compactSuggested = false
        executor.compact()
        return
      }
      this.log.warn('[compaction] CLI backend — no active process to compact')
      return
    }

    // SDK backend: use session resume for compaction
    const sessionId = this.currentConversationId
      ? this.sessionMap.get(this.currentConversationId)
      : undefined
    if (!sessionId) throw new Error('No session to compact')

    this.log.info(`[compaction] compact #${this.compactCount + 1}`)
    this.compactCount++
    this.compactSuggested = false
    this.turnsSinceCompactSuggestion = 0
    // SDK-COMPACT-01: Queue the compaction instruction so the next send() prepends it.
    // Previously only invalidated the snapshot (no-op for compaction).
    if (this.currentConversationId) {
      this.adapter.setPendingCompaction?.(this.currentConversationId, '/compact')
      this.adapter.onConversationSwitch(this.currentConversationId)
    }
  }

  async resumeAt(messageId: string): Promise<void> {
    if (this.executorBackend === 'opencode') {
      // #1: Use OpenCode's native session.revert() which preserves session
      // history and restores file snapshots — far better than clearing the
      // session entirely. Falls back to clearSession() if revert fails.
      if (this.currentConversationId) {
        const sessionId = openCodeExecutor.getSessionId(this.currentConversationId)
        if (sessionId) {
          try {
            await openCodeExecutor.revertSession(sessionId, messageId)
            this.log.info(
              `[resumeAt] OpenCode — reverted session ${sessionId} to message ${messageId}`
            )
          } catch (err) {
            // Fallback: clear session and create fresh on next message
            this.log.warn('[resumeAt] OpenCode revert failed, falling back to clearSession:', err)
            openCodeExecutor.clearSession(this.currentConversationId)
          }
        } else {
          this.log.info('[resumeAt] OpenCode — no session found, will create fresh on next message')
        }
      }
    }
    // F5: CLI mode — store per-conversation to prevent cross-conversation resume races
    if (this.currentConversationId) {
      this.pendingResumeAt.set(this.currentConversationId, messageId)
    }
    this.log.info(
      `[resumeAt] pending resume at message=${messageId} conversation=${this.currentConversationId} backend=${this.executorBackend}`
    )
  }

  getStatus(): AgentStatus {
    const isActive =
      this.currentStatus === 'thinking' ||
      this.currentStatus === 'writing' ||
      this.currentStatus === 'reviewing'

    return {
      agentId: this.adapter.agentId,
      agentType: 'specialist',
      status: this.currentStatus,
      elapsedMs: isActive && this.messageStartedAt ? Date.now() - this.messageStartedAt : 0,
      tokenUsage: this.tokenUsage,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      contextTokens: this.lastContextTokens
    }
  }

  // ── Internal: per-message reset ───────────────────────────────────

  private resetForNewMessage(conversationId: string): void {
    if (this._lastActiveConversationId && this._lastActiveConversationId !== conversationId) {
      this.log.info(`Conversation switch: ${this._lastActiveConversationId} → ${conversationId}`)

      // F6: Abandon stale in-progress plans for this workspace when switching conversations.
      // Prevents getLatestForWorkspace() from returning plans from a prior conversation.
      if (this.workspaceId) {
        try {
          localPlanStateService.markAbandonedForWorkspace(this.workspaceId, conversationId)
        } catch (err) {
          this.log.warn('[F6:abandon-stale-plans-failed]', err)
        }
      }
    }

    this.currentStatus = 'thinking'
    this._lastTimedOut = false
    this.messageStartedAt = Date.now()
    this._lastActiveConversationId = conversationId
    this.updateDbSessionConversation(conversationId)
    // Create per-conversation stream context
    this.activeStreams.set(conversationId, {
      accumulatedText: '',
      abortController: null
    })
    // SES-03: Only reset circuit breaker and tool accumulator when switching TO
    // this conversation. The send lock (SES-01) prevents concurrent sends within
    // the same conversation, but a conversation switch mid-stream could wipe the
    // breaker counter for an active stream on the old conversation. Since the send
    // lock serializes per-conversation, this reset is now safe — the old stream
    // has already finished or will finish on its own abort path.
    this.circuitBreaker.reset()
    this.toolActivityAccumulator.reset()
    this.maxTurnsContinuations = 0
    this.lastSendOutcome = 'ok'
    // SES-04: Don't null-out lastStreamOpts here — executeStream sets it at the
    // start of each stream, and the recovery manager reads it on error. The send
    // lock ensures no concurrent access within the same conversation.
    this.lastStreamOpts = null
    this.controlToolState = { plan: false, askUser: false }
    this.emit('statusUpdate', this.getStatus())
  }

  /** Matches the same format validated by CLIExecutor.buildCLIArgs before passing --resume. */
  private static readonly SESSION_ID_FORMAT = /^[a-zA-Z0-9_-]{8,}$/

  /** Sessions older than 7 days are unlikely to be resumable on the server. */
  private static readonly SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

  private resolveSession(conversationId: string): string | undefined {
    let sessionId = this.sessionMap.get(conversationId)
    const fromMemory = !!sessionId
    if (!sessionId) {
      try {
        sessionId = conversationRepository.getSessionId(conversationId)
        if (sessionId) {
          // Don't cache in sessionMap — cross-restart check below will reject it.
          // The stream processor will set the NEW session ID after the first turn.
          this.log.info('Session found in DB (previous app lifecycle):', sessionId)
        }
      } catch (err) {
        this.log.error('Failed to load session:', err)
      }
    }

    // Validate format — a corrupt or truncated session ID would cause the
    // CLI to silently skip --resume while our context injection is also
    // skipped (because sessionId is truthy). Treat invalid IDs as absent.
    if (sessionId && !AgentSessionService.SESSION_ID_FORMAT.test(sessionId)) {
      this.log.warn(
        `[resolveSession] Invalid session ID format for ${conversationId} — clearing: "${sessionId.slice(0, 30)}"`
      )
      this.sessionMap.delete(conversationId)
      try {
        conversationRepository.updateSessionId(conversationId, '')
      } catch {
        /* non-fatal */
      }
      return undefined
    }

    // Cross-restart guard: if the session was loaded from the database
    // (not already in the in-memory map), the CLI process that created it
    // no longer exists. Resuming with --resume would inherit orphaned
    // background shell commands that trigger "No completion record" errors.
    // Start fresh — context reconstruction (S12) at line ~618 provides
    // 4K-token continuity from stored messages + plan state.
    if (sessionId && !fromMemory) {
      this.log.info(
        `[resolveSession] Session ${sessionId} for ${conversationId} loaded from DB — ` +
          `previous CLI process is gone. Starting fresh to avoid orphaned background tasks.`
      )
      try {
        conversationRepository.updateSessionId(conversationId, '')
      } catch {
        /* non-fatal */
      }
      return undefined
    }

    // Staleness check — sessions older than 7 days are unlikely to still exist
    // on Anthropic's servers. Treat them as absent to avoid a wasted --resume
    // attempt that would fail with "No conversation found with session ID".
    if (sessionId) {
      try {
        const lastMsgTime = messageRepository.getLastMessageTimestamp(conversationId)
        if (lastMsgTime) {
          // created_at is SQLite's naive-UTC "YYYY-MM-DD HH:MM:SS"; parsing it
          // as local time skews the age by the machine's UTC offset — east of
          // UTC that expires sessions hours early and drops --resume.
          const parsedTime = parseDbTimestamp(lastMsgTime).getTime()
          if (Number.isNaN(parsedTime)) {
            this.log.warn(
              `[resolveSession] Malformed created_at for ${conversationId} — skipping staleness check: "${lastMsgTime.slice(0, 30)}"`
            )
          } else {
            const ageMs = Date.now() - parsedTime
            if (ageMs > AgentSessionService.SESSION_MAX_AGE_MS) {
              this.log.info(
                `[resolveSession] Session for ${conversationId} is ${Math.round(ageMs / 86400000)}d old — treating as stale`
              )
              this.sessionMap.delete(conversationId)
              try {
                conversationRepository.updateSessionId(conversationId, '')
                // Clear stale summary — a 7d-old summary likely references
                // files/APIs that no longer exist. Better to cold-start from
                // recent messages than inject outdated context.
                conversationRepository.updateSummary(conversationId, '')
              } catch {
                /* non-fatal */
              }
              return undefined
            }
          }
        }
      } catch {
        /* non-fatal — if we can't check age, proceed with the session ID */
      }
    }

    return sessionId
  }

  // Local per-conversation turn counter (adapter may also maintain its own).
  private readonly turnCounts = new Map<string, number>()
  private incrementTurnCount(conversationId: string, hasExistingSession: boolean): number {
    // When resuming an existing session, the first turn after resume should be
    // treated as turn 2+ so adapters skip one-time injections.
    if (hasExistingSession && !this.turnCounts.has(conversationId)) {
      this.turnCounts.set(conversationId, 1)
    }
    const next = (this.turnCounts.get(conversationId) ?? 0) + 1
    this.turnCounts.set(conversationId, next)
    return next
  }

  private buildSdkPrompt(
    effectiveMessage: string,
    images?: ImageAttachment[]
  ): string | AsyncIterable<AgentPromptInput> {
    if (!images || images.length === 0) return effectiveMessage

    const contentBlocks = [
      ...images.map((img) => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: img.base64
        }
      })),
      { type: 'text' as const, text: effectiveMessage }
    ]

    async function* singleMessage(): AsyncIterable<AgentPromptInput> {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: contentBlocks },
        parent_tool_use_id: null
      } as AgentPromptInput
    }

    this.log.info(`Built SDK vision prompt with ${images.length} image(s)`)
    return singleMessage()
  }

  /**
   * Instrument adapter control callbacks so we also update ControlToolState
   * + forward the expected events on this EventEmitter.
   */
  private wrapControlCallbacks(cb: ControlActionCallbacks): void {
    const origPlan = cb.onPlan
    cb.onPlan = (plan) => {
      this.controlToolState.plan = true
      const planEvent = parsePlanPayload(plan, this.accumulatedText)
      this.controlToolState.planIntent = { type: 'plan', plan: planEvent }
      this.emit('plan', planEvent)
      origPlan(plan)
    }

    const origAsk = cb.onAskUser
    cb.onAskUser = (questions, action, requestId) => {
      // ASK-OVERWRITE-01: If a question is already pending, auto-resolve the new one
      // to prevent the first request's promise from deadlocking forever.
      if (this.controlToolState.askUser && requestId) {
        this.respondToAskUser(
          requestId,
          'A question is already pending. Wait for the user to answer.'
        )
        this.log.info(
          `[wrapControlCallbacks] askUser intercepted (question already pending) for ${this.currentConversationId} requestId=${requestId}`
        )
        return
      }
      this.controlToolState.askUser = true
      this.controlToolState.askUserIntent = { type: 'askUser', questions, action, requestId }
      // Include requestId so the renderer can route the response back (mirrors
      // the bridge.on('askUser') path used by the production CLI).
      this.emit('askQuestion', { questions, action, requestId })
      origAsk(questions, action, requestId)
    }

    // onMemory removed — memory tools now on dedicated memory MCP server
  }

  private emitAdapterEvent(evt: AgentSessionEventName, payload: unknown): void {
    this.emit(evt, payload)
  }

  // ── Stream helpers ─────────────────────────────────────────────────

  /**
   * Derive the executor backend from the conversation-level LLM provider.
   * Rule: provider === 'claude' → 'cli'; everything else → 'opencode'.
   */
  private resolveExecutorBackend(llmProvider: LLMProvider | undefined): ExecutorBackend {
    const provider = llmProvider ?? this.llmProvider
    return provider === 'claude' ? 'cli' : 'opencode'
  }

  /**
   * Build the interaction timeout timer, extending for external MCP integrations.
   * Returns the timeout duration and the timer handle for cleanup.
   */
  private buildStreamTimeout(
    mcpServers: Record<string, unknown> | undefined,
    abortController: AbortController,
    conversationId: string
  ): { timeoutMs: number; timer: NodeJS.Timeout } {
    const baseTimeoutMs =
      this.adapter.interactionTimeoutMs ?? AgentSessionService.MAX_INTERACTION_TIMEOUT_MS

    const hasExternalMcps =
      mcpServers &&
      Object.keys(mcpServers).some((id) => EXTERNAL_MCP_INTEGRATIONS.some((i) => i.id === id))
    const timeoutMs = hasExternalMcps
      ? Math.max(baseTimeoutMs, AgentSessionService.EXTERNAL_MCP_INTERACTION_TIMEOUT_MS)
      : baseTimeoutMs

    const timer = setTimeout(() => {
      this._lastTimedOut = true
      this.log.error(
        `Interaction timeout after ${timeoutMs / 60_000} minutes — ${this.circuitBreaker.count} tool calls made`
      )
      eventLoggerService.logAgentTimeout({
        agentId: this.adapter.agentId,
        conversationId,
        elapsedMs: timeoutMs,
        toolCallCount: this.circuitBreaker.count
      })
      abortController.abort()
    }, timeoutMs)

    return { timeoutMs, timer }
  }

  // ── Stream orchestration ──────────────────────────────────────────

  private async executeStream(opts: ExecuteStreamOptions): Promise<void> {
    // Stash for max_turns auto-continue replay (handleStreamError needs these)
    this.lastStreamOpts = opts

    const {
      sdkPrompt,
      systemPrompt,
      sessionId,
      conversationId,
      turnCount,
      isBuildMode,
      mcpResult,
      llmProvider,
      localContextWindow,
      contextTier: passedContextTier
    } = opts
    const recoveryDepth = opts.recoveryDepth ?? 0
    const MAX_RECOVERY_DEPTH = 1

    // F5: Consume per-conversation resumeAt and clear to prevent stale reuse
    const resumeAt = this.pendingResumeAt.get(conversationId)
    this.pendingResumeAt.delete(conversationId)
    const abortController = new AbortController()
    // Set abort controller on per-conversation context (not global)
    const streamCtx = this.activeStreams.get(conversationId)
    if (streamCtx) streamCtx.abortController = abortController

    // Reset timeout flag before building timer (buildStreamTimeout sets _lastTimedOut on fire)
    this._lastTimedOut = false
    const { timeoutMs, timer: interactionTimer } = this.buildStreamTimeout(
      mcpResult.mcpServers,
      abortController,
      conversationId
    )

    try {
      const streamState: StreamLoopState = {
        messageStopReceived: false,
        hasTextAfterLastTool: true,
        lastTerminalReason: undefined,
        sessionRecoveryNeeded: false,
        overloadDetected: false
      }

      // ── Select executor backend ──
      const cliPromptInput = await this.extractPromptContent(sdkPrompt)

      const effectiveBackend = this.resolveExecutorBackend(llmProvider)

      let executorStream: AsyncGenerator<StreamChunk>
      switch (effectiveBackend) {
        case 'opencode': {
          const { text: ocPrompt, images: ocImages } = splitContentBlocks(
            cliPromptInput as string | Array<{ type: string; [k: string]: unknown }>
          )
          executorStream = this.executeOpenCodeStream({
            prompt: ocPrompt,
            images: ocImages,
            systemPrompt,
            isBuildMode,
            abortController,
            mcpResult
          })
          break
        }
        case 'cli':
        default:
          {
            // Explicit goal from opts (chat path) takes priority over adapter duck-typing (blueprint/MPA path)
            const adapterGoal =
              opts.goal ??
              ('getGoalCondition' in this.adapter
                ? (this.adapter as { getGoalCondition(): string | null }).getGoalCondition()
                : null)
            const adapterGoalMode =
              opts.goalMode ??
              ('getGoalMode' in this.adapter
                ? (this.adapter as { getGoalMode(): 'advisory' | 'enforce' }).getGoalMode()
                : ('advisory' as const))
            executorStream = this.executeCLIStream({
              prompt: cliPromptInput,
              systemPrompt,
              sessionId,
              isBuildMode,
              mode: this.currentMode,
              resumeAt,
              abortController,
              mcpResult,
              localContextWindow,
              goal: adapterGoal ?? undefined,
              goalMode: adapterGoalMode,
              conversationId
            })
          }
          break
      }

      for await (const chunk of executorStream) {
        if (this.circuitBreaker.isBroken) break

        if ('_meta' in chunk && chunk._meta) {
          await this.processMetaChunk(chunk._meta as ExecutorResult, {
            conversationId,
            turnCount,
            streamState
          })
        } else {
          const action = this.processContentChunk(chunk, {
            conversationId,
            isBuildMode,
            streamState,
            contextTier: passedContextTier
          })
          if (action === 'break') break
          if (action === 'continue') continue
        }
      }

      clearTimeout(interactionTimer)
      // Clear per-conversation abort controller
      const postCtx = this.activeStreams.get(conversationId)
      if (postCtx) postCtx.abortController = null

      const recovered = await this.handleSessionRecovery({
        sessionRecoveryNeeded: streamState.sessionRecoveryNeeded,
        recoveryDepth,
        maxRecoveryDepth: MAX_RECOVERY_DEPTH,
        sdkPrompt,
        systemPrompt,
        conversationId,
        turnCount,
        isBuildMode,
        mcpResult,
        llmProvider
      })
      if (recovered !== 'continue') return

      await this.finalizeStream({
        conversationId,
        systemPrompt,
        isBuildMode,
        recoveryDepth,
        timedOut: this._lastTimedOut,
        streamState,
        mcpResult,
        llmProvider
      })

      // Enqueue memory extraction from session transcript + git delta
      try {
        const convAccText = this.activeStreams.get(conversationId)?.accumulatedText ?? ''
        if (this.workspaceId && convAccText.length > 200) {
          // Gate on sessionCapture setting
          const wSettings = workspaceRepository.getSettings(this.workspaceId) as Record<
            string,
            unknown
          >
          if (wSettings.memorySessionCapture !== false) {
            const { memoryExtractionService } = await import('./memory-extraction.service')
            memoryExtractionService.enqueueSessionExtraction({
              workspaceId: this.workspaceId,
              workspacePath: this.workspacePath,
              transcript: convAccText,
              startSha: this.currentStartSha ?? null,
              conversationId
            })
          }
        }
      } catch (memErr) {
        this.log.debug('[executeStream] Memory extraction enqueue failed (non-fatal):', memErr)
      }
    } catch (error) {
      clearTimeout(interactionTimer)
      await this.handleStreamError(error as Error, this._lastTimedOut, recoveryDepth, timeoutMs)
    }
  }

  /**
   * Resolve the context window size for the active local LLM model.
   * Sync path — checks static RECOMMENDED_LOCAL_MODELS only; falls back to 128K.
   */
  private resolveLocalContextWindow(): number {
    return this.executorFactory.resolveLocalContextWindow()
  }

  /**
   * Async resolver — uses the full ContextWindowResolver chain:
   *   user override → backend API → known models → 128K fallback.
   * Caches for the session lifetime. Returns a confidence flag.
   */
  private resolveLocalContextWindowAsync(): Promise<{ contextWindow: number; confident: boolean }> {
    return this.executorFactory.resolveLocalContextWindowAsync()
  }

  /** Host method: cached MCP config path for recovery turns needing control-actions/emit_plan. */
  getCliMcpConfigPath(): string | undefined {
    return this.executorFactory.getCachedMcpConfigPath()
  }

  // ── Feature flag helpers ────────────────────────────────────

  /**
   * Resolve MCP feature flags from workspace settings.
   * Single source of truth — called by all executor paths (CLI, local-direct, OpenCode).
   */
  private resolveWorkspaceMcpFlags(): McpFeatureFlags {
    return this.executorFactory.resolveWorkspaceMcpFlags()
  }

  // ── Local conversation history helpers ──────────────────────────────

  // ── Executor dispatch methods ──────────────────────────────────────

  /**
   * CLI executor stream — delegates to CLIExecutor.execute().
   * Uses interactive claude with stream-json mode (subscription billing).
   */
  private executeCLIStream(params: {
    prompt: string | Array<Record<string, unknown>>
    systemPrompt: string
    sessionId: string | undefined
    isBuildMode: boolean
    mode?: ConversationMode
    resumeAt: string | undefined
    abortController: AbortController
    mcpResult: AdapterMcpResult
    localContextWindow?: number
    goal?: string
    goalMode?: 'advisory' | 'enforce'
    conversationId?: string
  }): AsyncGenerator<StreamChunk & { _meta?: CLIExecuteResult }> {
    const convId = params.conversationId ?? this._lastActiveConversationId ?? '__idle__'
    const executor = this.getOrCreateCliExecutor(convId)
    // WRONG-EXECUTOR-03: Pass the resolved executor to buildCLIExecuteOptions so
    // the canContinue check uses THIS conversation's executor, not _lastActiveConversationId's.
    const cliOptions = this.buildCLIExecuteOptions(params, executor)
    return executor.execute(cliOptions)
  }

  /**
   * OpenCode executor stream — runs through the @opencode-ai/sdk runtime.
   *
   * Supports 75+ providers through a single executor. Uses OpenCode's
   * built-in agent loop, MCP support, and session management.
   */
  private async *executeOpenCodeStream(params: {
    prompt: string
    images?: ImageAttachment[]
    systemPrompt: string
    isBuildMode: boolean
    abortController: AbortController
    mcpResult: AdapterMcpResult
  }): AsyncGenerator<StreamChunk> {
    const { prompt, images, isBuildMode, abortController } = params

    // Resolve provider config from conversation snapshot (snapshot-first, no workspace bleed)
    let providerConfig: { providerId: string; modelId: string; baseUrl?: string; apiKey?: string }
    try {
      providerConfig = this.resolveOpenCodeProviderConfig()
    } catch {
      /* non-fatal — use defaults */
      providerConfig = {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        baseUrl: undefined,
        apiKey: undefined
      }
    }

    // Generate opencode.json config + agent definitions
    await this.writeOpenCodeConfigFiles({ providerConfig, systemPrompt: params.systemPrompt })

    // Start OpenCode server if not running
    if (!openCodeExecutor.isRunning()) {
      let pathResolved = false
      try {
        // Ensure opencode path is resolved and in PATH (uses cached value)
        if (!getOpencodePath()) {
          resolveOpencodePath()
        }
        pathResolved = ensureOpencodePathInEnv()

        if (pathResolved) {
          this.log.info('[opencode] Ensured opencode path in PATH at session start')
        }

        await openCodeExecutor.start(this.workspacePath!, {
          configPath: this._openCodeConfigPath,
          isLocal: providerConfig.providerId === 'ollama' || providerConfig.providerId === 'omlx'
        })
      } catch (error) {
        const err = error as Error
        this.log.error('[opencode] Failed to start server:', err)

        // Provide more helpful error message for missing CLI
        let userFriendlyError = err.message
        if (
          err.message.includes('ENOENT') ||
          err.message.includes('not found') ||
          err.message.includes('spawn opencode') ||
          err.message.includes('Failed to create OpenCode session')
        ) {
          const opencodePath = getOpencodePath() || 'not resolved'

          userFriendlyError =
            `OpenCode CLI is not installed or not in PATH.\n\n` +
            `Resolved path: ${opencodePath}\n` +
            `Current PATH: ${process.env.PATH?.slice(0, 600) || 'not set'}\n` +
            `Spawn path injected: ${pathResolved ? 'yes' : 'no'}\n\n` +
            'Install it globally:\n' +
            '  npm install -g @opencode-ai/cli\n\n' +
            'Or download from: https://opencode.ai/getting-started'
        }

        yield {
          type: 'error',
          error: userFriendlyError
        }
        return
      }
    }

    // Prepare priming context for first message, then consume it
    await this.prepareOpenCodePriming(prompt)
    const primingContext = this._pendingPrimingContext
    this._pendingPrimingContext = undefined

    // MAXTURNS-HARDCODED-01: Use tier-appropriate maxTurns for local LLMs.
    // Use the async resolver so user overrides and backend API queries take effect.
    const maxTurns = await (async () => {
      const { contextWindow } = await this.resolveLocalContextWindowAsync()
      const tier = resolveContextTier(contextWindow)
      const limits = TIER_LIMITS[tier]
      return isBuildMode ? limits.maxTurnsBuild : limits.maxTurnsPlan
    })()

    // Execute through OpenCode — pass conversationId for multi-turn session reuse
    for await (const chunk of openCodeExecutor.execute({
      prompt,
      images,
      systemPrompt: params.systemPrompt,
      provider: providerConfig,
      cwd: this.workspacePath!,
      abortController,
      conversationId: this.currentConversationId ?? undefined,
      maxTurns,
      primingContext
    })) {
      // Forward chunks, converting OpenCode meta to executor meta format
      if ('_meta' in chunk && chunk._meta) {
        const meta = chunk._meta as OpenCodeExecuteResult
        yield {
          ...chunk,
          _meta: {
            result: meta.result,
            tokenUsage: meta.tokenUsage,
            terminalReason: meta.terminalReason ?? 'completed',
            sessionId: meta.openCodeSessionId
          }
        } as StreamChunk & { _meta: unknown }
      } else {
        yield chunk
      }
    }

    // F9: Sync OpenCode session ID to sessionMap so recovery paths
    // (agent-recovery-manager) can find the correct session on resume.
    if (this.currentConversationId) {
      const ocSessionId = openCodeExecutor.getSessionId(this.currentConversationId)
      if (ocSessionId) {
        this.sessionMap.set(this.currentConversationId, ocSessionId)
      }
    }
  }

  /**
   * Extract prompt content from either a string or AsyncIterable<AgentPromptInput>.
   * For images, the iterable contains content blocks (image + text) that need
   * extraction for CLI/OpenCode backends.
   * Extracted from executeStream() — reusable prompt resolution concern.
   */
  private async extractPromptContent(
    sdkPrompt: string | AsyncIterable<AgentPromptInput>
  ): Promise<string | Array<Record<string, unknown>>> {
    if (typeof sdkPrompt === 'string') return sdkPrompt
    try {
      for await (const msg of sdkPrompt) {
        const message = (msg as { message?: { content: Array<Record<string, unknown>> } }).message
        if (message?.content) {
          return message.content
        }
      }
    } catch {
      return '[failed to extract image content]'
    }
    return ''
  }

  /**
   * S6+S12: Enrich a message with conversation context for local LLMs.
   * Tries S12 full context reconstruction first (plan state + messages),
   * falls back to S6 conversation summary alone.
   * Extracted from send() — dual-fallback context injection concern.
   */
  private enrichLocalLLMContext(params: {
    message: string
    conversationId: string
    localContextWindow: number
    contextTier: ContextWindowTier
  }): string {
    try {
      const reconstructed = localContextReconstructor.buildContextFromHistory({
        conversationId: params.conversationId,
        maxTokenBudget: Math.floor(params.localContextWindow * 0.25), // 25% of context window
        tier: params.contextTier
      })
      if (reconstructed) {
        this.log.info(
          `[S12:context-reconstructed] conversationId=${params.conversationId} len=${reconstructed.length}`
        )
        return `## Previous Context\n${reconstructed}\n\n## Current Request\n${params.message}`
      }
      // S6: Fallback to simple conversation summary
      const summary = conversationRepository.getSummary(params.conversationId)
      if (summary) {
        this.log.info(
          `[S6:context-injected] conversationId=${params.conversationId} summaryLen=${summary.length}`
        )
        return `## Previous Context\n${summary}\n\n## Current Request\n${params.message}`
      }
      // Neither S12 reconstruction nor an S6 summary was available — the raw
      // message is sent unchanged. Logged so live runs can confirm the path.
      this.log.info(
        `[S6:no-context] conversationId=${params.conversationId} — no reconstruction or summary, using raw message`
      )
    } catch {
      /* non-fatal — proceed without context */
    }
    return params.message
  }

  /**
   * Prepare priming context for the first OpenCode message.
   * Checks for an existing session; if none, gathers workspace context
   * and stores it as _pendingPrimingContext for the executor to consume.
   * Extracted from executeOpenCodeStream() — self-contained priming concern.
   */
  private async prepareOpenCodePriming(prompt: string): Promise<void> {
    const existingSessionId = this.currentConversationId
      ? openCodeExecutor.getSessionId(this.currentConversationId)
      : undefined
    if (existingSessionId) return

    try {
      const contextParts = await this.buildPrimingContext(prompt)
      if (contextParts.length > 0) {
        this.log.info(`[opencode] Priming session with ${contextParts.length} context parts`)
        this._pendingPrimingContext = contextParts
      }
    } catch (primingErr) {
      // Non-fatal — priming failure should not block the real prompt
      this.log.warn('[opencode] Context priming failed:', primingErr)
    }
  }

  /**
   * Write opencode.json config + agent definitions to disk.
   * Extracted from executeOpenCodeStream() — cohesive config generation concern.
   */
  private async writeOpenCodeConfigFiles(params: {
    providerConfig: { providerId: string; modelId: string; baseUrl?: string; apiKey?: string }
    systemPrompt: string
  }): Promise<void> {
    try {
      const featureFlags = this.resolveWorkspaceMcpFlags()
      const socketPath = this.ipcBridge?.getSocketPath() ?? undefined

      // Resolve context tier for tier-aware config (compaction, timeouts)
      const isLocal =
        params.providerConfig.providerId === 'ollama' || params.providerConfig.providerId === 'omlx'
      let contextTier: ContextWindowTier | undefined
      let contextWindowConfident = false
      if (isLocal) {
        const resolved = await this.resolveLocalContextWindowAsync()
        contextTier = resolveContextTier(resolved.contextWindow)
        contextWindowConfident = resolved.confident
      }

      const configPath = openCodeConfigWriter.writeConfig({
        workspacePath: this.workspacePath!,
        workspaceId: this.workspaceId,
        conversationId: this.currentConversationId,
        mode: this.currentMode,
        provider: params.providerConfig,
        featureFlags,
        ipcSocketPath: socketPath,
        isLocalProvider: isLocal,
        contextTier,
        contextWindowConfident
      })

      this._openCodeConfigPath = configPath

      // #6: Generate OpenCode agent definitions (specialist + OpenCode agents)
      try {
        openCodeAgentWriter.writeAgents({
          workspacePath: this.workspacePath!,
          provider: params.providerConfig,
          davinciSystemPrompt: params.systemPrompt,
          mode: this.currentMode
        })
      } catch (agentErr) {
        this.log.warn('[opencode] Failed to write agent definitions:', agentErr)
      }
    } catch (error) {
      this.log.warn('[opencode] Failed to write config:', error)
    }
  }

  /**
   * A-1: Build context parts for session priming.
   * Gathers recent git changes, active plan state, and relevant workspace memories
   * to inject before the first prompt so the session starts warm.
   * Delegates to PrimingContextGatherer (each source independently testable).
   */
  private async buildPrimingContext(
    userPrompt: string
  ): Promise<Array<{ type: 'text'; text: string }>> {
    return primingContextGatherer.gather({
      workspaceId: this.workspaceId,
      workspacePath: this.workspacePath,
      conversationId: this.currentConversationId,
      userPrompt
    })
  }

  /**
   * Build CLI execute options from session parameters.
   * Maps the same information that buildSdkExecuteOptions uses to CLI flags.
   */
  private buildCLIExecuteOptions(
    params: {
      prompt: string | Array<Record<string, unknown>>
      systemPrompt: string
      sessionId: string | undefined
      isBuildMode: boolean
      mode?: ConversationMode
      resumeAt: string | undefined
      abortController: AbortController
      mcpResult: AdapterMcpResult
      localContextWindow?: number
      goal?: string
      goalMode?: 'advisory' | 'enforce'
    },
    executor?: CLIExecutor
  ): CLIExecuteOptions {
    return this.executorFactory.buildCLIExecuteOptions(params, executor)
  }

  /**
   * Ensure the IPC bridge is running and wired to session events.
   * The bridge provides a Unix domain socket that externalized MCP servers
   * (control-actions) connect to for plan/askUser/memory event delivery.
   */
  private async ensureIpcBridge(_conversationId: string): Promise<void> {
    if (this.ipcBridge?.isListening()) return

    // SES-02: Re-entrance guard — prevent concurrent calls from creating duplicate bridges.
    // Two concurrent send() calls can both pass isListening() before bridge.start() resolves.
    if (this.ipcBridgeStarting) return
    this.ipcBridgeStarting = true

    // N10: Clean up stale listeners if the bridge is being restarted
    if (this.ipcBridge) {
      this.ipcBridge.removeAllListeners()
      // Invalidate cached MCP config so the next turn rebuilds with the new socket path
      this.executorFactory.invalidateMcpConfigCache()
    }

    let bridge: IpcBridge
    try {
      bridge = new IpcBridge()
      await bridge.start()
      this.ipcBridge = bridge
    } finally {
      this.ipcBridgeStarting = false
    }

    // Wire bridge events to session events (same handling as wrapControlCallbacks).
    // Listeners read from this.currentConversationId (live) rather than a captured
    // conversationId closure to avoid stale references across conversation switches.
    bridge.on('plan', (payload: unknown) => {
      this.controlToolState.plan = true
      const planEvent = parsePlanPayload(payload, this.accumulatedText)
      this.controlToolState.planIntent = { type: 'plan', plan: planEvent }
      this.emit('plan', planEvent)
      this.log.info(
        `[ipc-bridge] Plan event received — conversationId=${this.currentConversationId} ` +
          `structuredPlan=${!!planEvent.structuredPlan} rawContentLen=${planEvent.rawContent.length}`
      )

      // Persist the plan so phase/task progress has a DB row to attach to.
      // Without this, planRepository.findActiveByConversationId() (used by the
      // phaseProgress listener below) always returns null and phase progress
      // persistence silently no-ops — progress only ever lives in renderer state.
      if (planEvent.structuredPlan && this.workspaceId && this.currentConversationId) {
        try {
          planRepository.savePlan({
            workspaceId: this.workspaceId,
            source: 'chat',
            sourceId: this.currentConversationId,
            title: planEvent.structuredPlan.title,
            summary: planEvent.structuredPlan.summary,
            structuredPlan: planEvent.structuredPlan,
            linkedConversationId: this.currentConversationId
          })
        } catch (err) {
          this.log.warn(
            `[ipc-bridge] Failed to persist plan for ${this.currentConversationId}:`,
            err
          )
        }
      }
    })

    bridge.on('askUser', (payload: unknown, requestId?: string) => {
      // Structural guard: questions must come BEFORE the plan, never after. If a
      // plan was already emitted this turn (controlToolState.plan, reset per-turn
      // in resetForNewMessage), auto-resolve the blocked ask_user promise with a
      // corrective message instead of stacking a question card under the plan.
      // ask-then-plan is untouched; only plan-then-ask is intercepted.
      const rejection = evaluateAskUserGuard(this.controlToolState.plan)
      if (rejection && requestId) {
        this.respondToAskUser(requestId, rejection)
        this.log.info(
          `[ipc-bridge] askUser intercepted (plan already emitted this turn) for ${this.currentConversationId} requestId=${requestId}`
        )
        return
      }

      // ASK-OVERWRITE-01: If a question is already pending, auto-resolve the new one
      // to prevent the first request's promise from deadlocking forever.
      if (this.controlToolState.askUser && requestId) {
        this.respondToAskUser(
          requestId,
          'A question is already pending. Wait for the user to answer.'
        )
        this.log.info(
          `[ipc-bridge] askUser intercepted (question already pending) for ${this.currentConversationId} requestId=${requestId}`
        )
        return
      }

      this.controlToolState.askUser = true
      const askPayload = payload as { questions: GrillQuestion[]; action?: string }
      this.controlToolState.askUserIntent = {
        type: 'askUser',
        questions: askPayload.questions,
        action: askPayload.action,
        requestId
      }
      // Include requestId so the renderer can send a response back
      this.emit('askQuestion', { ...askPayload, requestId })
      this.log.info(
        `[ipc-bridge] askUser event received for ${this.currentConversationId} requestId=${requestId}`
      )
    })

    // phaseProgress bridge listener — surfaces plan execution phase transitions in the UI
    bridge.on('phaseProgress', (payload: unknown) => {
      const progress = payload as {
        planTitle: string
        phaseId: number
        phaseTitle: string
        status: string
        totalPhases: number
        message?: string
        taskId?: string
        taskTitle?: string
        taskStatus?: string
        totalTasks?: number
      }

      // Resolve planId from the plan registry for this conversation
      let planId: string | null = null
      try {
        const plan = planRepository.findActiveByConversationId(this.currentConversationId ?? '')
        if (plan) planId = plan.id
      } catch {
        /* non-critical */
      }

      // Persist phase progress to DB (non-critical)
      if (planId) {
        // When a phase completes, extract its file list from the structured plan
        // to persist as touchedFiles (all files are considered touched when phase is done)
        let touchedFiles: string[] | undefined
        if (progress.status === 'completed') {
          try {
            const plan = planRepository.findActiveByConversationId(this.currentConversationId ?? '')
            const phaseData = plan?.structuredPlan?.phases?.find((p) => p.id === progress.phaseId)
            if (phaseData?.files && phaseData.files.length > 0) {
              touchedFiles = phaseData.files.map((f) => f.file)
            }
          } catch {
            /* non-critical */
          }
        }

        // Build optional task update for persistence
        const taskUpdate =
          progress.taskId && progress.taskStatus
            ? {
                taskId: progress.taskId,
                title: progress.taskTitle ?? progress.taskId,
                status: progress.taskStatus
              }
            : undefined

        try {
          planRepository.updatePhaseProgress(
            planId,
            progress.phaseId,
            progress.status,
            undefined,
            touchedFiles,
            taskUpdate
          )
        } catch {
          /* non-critical */
        }

        // Auto-detect plan completion: if all phases are done, mark plan completed
        if (progress.status === 'completed') {
          try {
            const allProgress = planRepository.getPhaseProgress(planId)
            const allCompleted =
              allProgress.length >= progress.totalPhases &&
              allProgress.every((p) => p.status === 'completed' || p.status === 'skipped')
            if (allCompleted) {
              planRepository.markCompleted(planId)
              this.log.info(`[ipc-bridge] Plan ${planId} auto-completed — all phases done`)
            }
          } catch {
            /* non-critical */
          }
        }
      }

      // Emit as a StreamChunk so it flows through the standard chunk pipeline
      // (chunk-router → IPC → renderer)
      this.emit('chunk', {
        type: 'phase_progress',
        phaseProgress: {
          planId,
          phaseId: progress.phaseId,
          phaseTitle: progress.phaseTitle,
          status: progress.status,
          totalPhases: progress.totalPhases,
          message: progress.message,
          taskId: progress.taskId,
          taskTitle: progress.taskTitle,
          taskStatus: progress.taskStatus,
          totalTasks: progress.totalTasks
        }
      } as StreamChunk)
      this.log.info(
        `[ipc-bridge] phaseProgress event received for ${this.currentConversationId} phase=${progress.phaseId} status=${progress.status}`
      )
    })

    // permission_prompt bridge listener — surfaces tool permission requests in the UI
    bridge.on('permission', (payload: unknown, requestId?: string) => {
      this.emit('permissionRequest', { ...(payload as Record<string, unknown>), requestId })
      this.log.info(
        `[ipc-bridge] permission event received for ${this.currentConversationId} requestId=${requestId}`
      )
    })

    // memory bridge listener removed — memory tools now on dedicated memory MCP server

    const socketPath = bridge.getSocketPath()
    this.log.info(
      `[ensureIpcBridge] Bridge started — socketPath=${socketPath ? socketPath : 'MISSING'}`
    )
    if (!socketPath) {
      this.log.warn(
        '[ensureIpcBridge] Socket path is null — control-actions MCP server will run in log-only mode'
      )
    }
  }

  private async processMetaChunk(
    meta: ExecutorResult,
    ctx: { conversationId: string; turnCount: number; streamState: StreamLoopState }
  ): Promise<void> {
    await this.streamProcessor.processMetaChunk(meta, ctx)
  }

  private processContentChunk(
    chunk: StreamChunk & { type?: string; content?: string; error?: string; toolName?: string },
    ctx: {
      conversationId: string
      isBuildMode: boolean
      streamState: StreamLoopState
      contextTier?: ContextWindowTier
    }
  ): 'next' | 'break' | 'continue' {
    return this.streamProcessor.processContentChunk(chunk, ctx)
  }

  private async handleSessionRecovery(params: {
    sessionRecoveryNeeded: boolean
    recoveryDepth: number
    maxRecoveryDepth: number
    sdkPrompt: string | AsyncIterable<AgentPromptInput>
    systemPrompt: string
    conversationId: string
    turnCount: number
    isBuildMode: boolean
    mcpResult: AdapterMcpResult
    llmProvider: LLMProvider
  }): Promise<'continue' | 'returned'> {
    return this.recoveryManager.handleSessionRecovery(params)
  }

  private async finalizeStream(params: {
    conversationId: string
    systemPrompt: string
    isBuildMode: boolean
    recoveryDepth: number
    timedOut: boolean
    streamState: StreamLoopState
    mcpResult: AdapterMcpResult
    llmProvider: LLMProvider
  }): Promise<void> {
    await this.recoveryManager.finalizeStream(params)
  }

  private async handleStreamError(
    error: Error,
    timedOut: boolean,
    recoveryDepth = 0,
    effectiveTimeoutMs?: number
  ): Promise<void> {
    await this.recoveryManager.handleStreamError(error, timedOut, recoveryDepth, effectiveTimeoutMs)
  }

  saveCurrentPlanState(conversationId: string): void {
    this.recoveryManager.saveCurrentPlanState(conversationId)
  }

  // ── Compaction ────────────────────────────────────────────────────

  private applyCompactionThresholds(settings: Record<string, unknown>): void {
    this.streamProcessor.applyCompactionThresholds(settings)
  }

  /**
   * Resolve OpenCode provider configuration — snapshot-first.
   *
   * Reads provider identity (providerId + modelId) from the conversation's frozen
   * snapshot to prevent config bleed between chats. Infrastructure settings
   * (baseUrl, apiKey) always come from live workspace settings.
   *
   * Falls back to live workspace settings when no snapshot exists (legacy chats).
   */
  private resolveOpenCodeProviderConfig(_llmProvider?: LLMProvider): {
    providerId: string
    modelId: string
    baseUrl: string | undefined
    apiKey: string | undefined
  } {
    if (!this.workspacePath) {
      return {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        baseUrl: undefined,
        apiKey: undefined
      }
    }

    return resolveOpenCodeProviderFromSnapshot(
      this.currentConversationId,
      this.workspacePath,
      this.currentMode !== 'plan'
    )
  }
}
