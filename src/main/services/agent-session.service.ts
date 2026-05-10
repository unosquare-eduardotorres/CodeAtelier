/**
 * AgentSessionService — generic long-lived Claude Agent SDK session.
 *
 * Phase 1 of the Project Specialist refactor (see
 * docs/architecture/project-specialist-refactor.md). Extracted from
 * chat-agent.service.ts by separating:
 *
 *   - generic session/stream/compaction/recovery lifecycle (THIS FILE)
 *   - role-specific prompt/MCP/intent logic (AgentRoleAdapter)
 *
 * The Generalist's public behavior is preserved by plugging in
 * DaVinciRoleAdapter. The same service will later drive Project
 * Specialists via ProjectSpecialistRoleAdapter.
 */

import type {
  AgentStatus,
  ConversationMode,
  ControlToolState,
  CostPreference,
  ElicitationEvent,
  AgentIntent,
  ImageAttachment,
  LLMProvider,
  PlanDetectedEvent
} from '../../shared/types'
import type {
  SDKUserMessage,
  ElicitationRequest,
  ElicitationResult
} from '@anthropic-ai/claude-agent-sdk'
import {
  BUDGET_CAP_MODE_MULTIPLIERS,
  CLAUDE_1M_CONTEXT_WINDOW,
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  MCP_TOOLS,
  RECOMMENDED_LOCAL_MODELS,
  supportsContext1M
} from '../../shared/constants'
import { chatAgentLogger } from '../logger'
import { AgentBaseService } from './agent-base.service'
import type { StreamChunk } from './agent-base.service'
import { SDKExecutor } from './sdk-executor'
import type { SDKExecuteOptions, SDKExecuteResult } from './sdk-executor'
import { createBuildModeSandbox } from './sandbox-config'
import {
  CLAUDE_1M_CONTEXT_CONFIG,
  CLAUDE_200K_CONTEXT_CONFIG,
  CLAUDE_ECONOMY_CONTEXT_CONFIG,
  getLocalLlmContextConfig,
  resolveContextTier,
  TIER_LIMITS
} from './context-management'
import type { ContextWindowTier } from './context-management'
import { authProvider } from './auth-provider'
import { vectorSearchService } from './vector-search.service'
import { semanticSearchMcpService } from './semantic-search.tool'
import { codeGraphMcpService } from './code-graph.tool'
import {
  conversationRepository,
  turnUsageRepository,
  workspaceRepository
} from '../db/repositories'
import { modelConfigService } from './model-config.service'
import type { ModelAction } from '../../shared/types'
import { eventLoggerService } from './event-logger.service'
import type { ControlActionCallbacks } from './control-actions.tool'
import { AgentTokenTracker } from './agent-token-tracker'
import type { CacheEfficiencyReport } from './agent-token-tracker'
import { AgentCircuitBreaker } from './agent-circuit-breaker'
import { RecoveryNudgeService } from './agent-recovery-nudge'
import type {
  AgentRoleAdapter,
  AgentSessionEventName,
  AdapterMcpResult
} from './agent-session.types'

/** Internal loop-state book-keeping for executeStream. */
interface StreamLoopState {
  messageStopReceived: boolean
  hasTextAfterLastTool: boolean
  lastTerminalReason: string | undefined
  sessionRecoveryNeeded: boolean
}

/** Options bag for the executeStream orchestrator. */
interface ExecuteStreamOptions {
  sdkPrompt: string | AsyncIterable<SDKUserMessage>
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
  // common default since Da Vinci plan mode uses Opus).
  private static readonly DEFAULT_COMPACT_SUGGEST_THRESHOLD = 120_000
  private static readonly DEFAULT_COMPACT_AUTO_THRESHOLD = 150_000
  private static readonly MAX_INTERACTION_TIMEOUT_MS = 10 * 60_000 // 10 minutes
  private static readonly MAX_TURN_CONTINUATIONS = 3

  private workspacePath: string | null = null
  private workspaceId: string | null = null
  private currentConversationId: string | null = null
  private accumulatedText = ''
  private currentMode: ConversationMode = 'plan'
  private costPreference: CostPreference = 'balanced'
  private llmProvider: LLMProvider = 'claude'

  /** Maps conversationId → SDK session_id for resume. */
  private readonly sessionMap = new Map<string, string>()

  /** Whether the last executeStream was terminated by the interaction timeout. */
  private _lastTimedOut = false

  /** AbortController for the current in-flight query. */
  private sdkAbortController: AbortController | null = null
  private readonly sdkExecutor = new SDKExecutor()

  private readonly tokenTracker = new AgentTokenTracker()
  private readonly circuitBreaker = new AgentCircuitBreaker()
  private readonly recoveryNudge = new RecoveryNudgeService()

  private compactSuggestThreshold = AgentSessionService.DEFAULT_COMPACT_SUGGEST_THRESHOLD
  private compactAutoThreshold = AgentSessionService.DEFAULT_COMPACT_AUTO_THRESHOLD
  private compactSuggested = false
  private compactCount = 0
  /** Turns elapsed since last compact suggestion — re-suggest every 3 turns if dismissed. */
  private turnsSinceCompactSuggestion = 0
  private lastContextTokens: number | undefined
  /** Effective context window for the current session (model-aware: 200K for Opus, 1M for Sonnet). */
  private effectiveContextWindow: number | undefined

  private pendingResumeAt: string | undefined

  /** Auto-continue on max_turns: how many times we've resumed so far this message. */
  private maxTurnsContinuations = 0
  /** Stashed executeStream options for replay on max_turns auto-continue. */
  private lastStreamOpts: ExecuteStreamOptions | null = null

  private controlToolState: ControlToolState = {
    plan: false,
    askUser: false,
    memory: false
  }

  constructor(private readonly adapter: AgentRoleAdapter) {
    super()
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
    return this.currentConversationId
  }

  getMode(): ConversationMode {
    return this.currentMode
  }

  getStreamedContent(): string {
    return this.accumulatedText
  }

  isRunning(): boolean {
    return this.workspacePath !== null
  }

  /** Whether the last send() was terminated by an interaction timeout. */
  wasTimedOut(): boolean {
    return this._lastTimedOut
  }

  getActiveQuery(): import('@anthropic-ai/claude-agent-sdk').Query | null {
    return this.sdkExecutor.getActiveQuery()
  }

  getSessionId(conversationId: string): string | undefined {
    return this.sessionMap.get(conversationId)
  }

  getCacheEfficiency(): CacheEfficiencyReport {
    return this.tokenTracker.getCacheEfficiency(this.currentConversationId)
  }

  clearSession(conversationId: string): void {
    this.sessionMap.delete(conversationId)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start(
    workspacePath: string,
    mode?: ConversationMode,
    resumeSessionId?: string
  ): Promise<void> {
    // Don't abort an active stream if we're re-starting for the same workspace.
    // This prevents HMR, React strict mode, or auto-open from killing in-flight queries.
    if (
      this.sdkAbortController &&
      this.workspacePath === workspacePath &&
      this.currentStatus !== 'idle' &&
      this.currentStatus !== 'failed'
    ) {
      this.log.info(
        `[start] Skipping restart — stream active for same workspace: ${workspacePath}`
      )
      return
    }

    if (this.sdkAbortController) {
      this.log.warn(
        `[start] Aborting active sdkAbortController — ` +
          `currentWorkspace=${this.workspacePath} newWorkspace=${workspacePath} ` +
          `status=${this.currentStatus} conversationId=${this.currentConversationId}`
      )
      this.sdkAbortController.abort()
      this.sdkAbortController = null
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
    this.currentConversationId = null
    this.accumulatedText = ''
    this.compactCount = 0
    this.compactSuggested = false
    this.turnsSinceCompactSuggestion = 0
    this.tokenTracker.resetSession()

    // Resolve workspace id + cost preference
    try {
      const workspaces = workspaceRepository.findAll()
      const workspace = workspaces.find((w) => w.repoPath === workspacePath)
      if (workspace) this.workspaceId = workspace.id
      const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}
      this.costPreference = (settings.costPreference as CostPreference) || 'balanced'
      this.llmProvider = (settings.llmProvider as LLMProvider) || 'claude'
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
    if (resumeSessionId && this.currentConversationId) {
      this.sessionMap.set(this.currentConversationId, resumeSessionId)
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

    eventLoggerService.logSessionStarted({
      agentId: this.adapter.agentId,
      model: modelConfigService.getModel(workspacePath, `${this.adapter.role}:plan` as ModelAction)
    })

    this.log.info(`${this.adapter.role} SDK session initialized for workspace:`, workspacePath)
    this.emit('statusUpdate', this.getStatus())
  }

  async send(message: string, conversationId: string, images?: ImageAttachment[]): Promise<void> {
    if (!this.workspacePath) {
      throw new Error(`${this.adapter.role} not started — call start() first`)
    }
    this.resetForNewMessage(conversationId)

    const sessionId = this.resolveSession(conversationId)

    // Adapter may adjust internal turn counters on resume
    this.adapter.refreshFeatureFlags({
      workspacePath: this.workspacePath,
      workspaceId: this.workspaceId,
      conversationId
    })

    const hasImages = (images?.length ?? 0) > 0

    // Track turn count locally so we can supply it to the adapter.
    const turnCount = this.incrementTurnCount(conversationId, sessionId !== undefined)

    const { systemPrompt, effectiveMessage } = this.adapter.buildPrompts({
      message,
      conversationId,
      hasImages,
      turnCount,
      sessionId,
      mode: this.currentMode,
      workspacePath: this.workspacePath,
      workspaceId: this.workspaceId,
      costPreference: this.costPreference
    })

    const sdkPrompt = this.buildSdkPrompt(effectiveMessage, images)

    const controlCallbacks = this.adapter.buildControlCallbacks({
      conversationId,
      emit: (evt, payload) => this.emitAdapterEvent(evt, payload),
      getAccumulatedText: () => this.accumulatedText
    })
    this.wrapControlCallbacks(controlCallbacks)

    // Resolve context tier for local LLMs — gates tool selection in MCP config.
    // Resolve the local context window once here; pass it through to avoid redundant lookups.
    const isLocalForMcp = this.llmProvider === 'local-llm'
    const localContextWindow: number | undefined = isLocalForMcp
      ? this.resolveLocalContextWindow()
      : undefined
    const contextTier: ContextWindowTier | undefined = isLocalForMcp
      ? resolveContextTier(localContextWindow!)
      : undefined

    const mcpResult = this.adapter.buildMcpConfig({
      mode: this.currentMode,
      workspacePath: this.workspacePath,
      workspaceId: this.workspaceId,
      conversationId: this.currentConversationId,
      controlCallbacks,
      contextTier
    })

    // Resolve per-conversation LLM provider (falls back to session default)
    let conversationProvider: LLMProvider = this.llmProvider
    try {
      const conv = conversationRepository.findById(conversationId)
      if (conv?.llmProvider) {
        conversationProvider = conv.llmProvider as LLMProvider
      }
    } catch {
      /* non-fatal — keep session default */
    }

    await this.executeStream({
      sdkPrompt,
      systemPrompt,
      sessionId,
      conversationId,
      turnCount,
      isBuildMode: this.currentMode === 'build',
      mcpResult,
      llmProvider: conversationProvider,
      localContextWindow
    })
  }

  /** Cancels the current in-flight SDK query (if any). */
  cancelCurrentQuery(): void {
    if (this.sdkAbortController) {
      this.sdkAbortController.abort()
      this.sdkAbortController = null
    }
  }

  async stop(): Promise<void> {
    if (this.sdkAbortController) {
      this.sdkAbortController.abort()
      this.sdkAbortController = null
    }
    if (this.workspaceId) {
      codeGraphMcpService.dispose(this.workspaceId)
      semanticSearchMcpService.dispose(this.workspaceId)
      await vectorSearchService.dispose(this.workspaceId)
    }
    this.adapter.onSessionStop()
    this.completeDbSession('terminated')
    this.currentStatus = 'idle'
    this.currentConversationId = null
    this.accumulatedText = ''
    // NOTE: keep sessionMap populated — we may resume later.
    this.emit('statusUpdate', this.getStatus())
  }

  async switchMode(mode: ConversationMode): Promise<void> {
    if (mode === this.currentMode) return
    if (!this.workspacePath) return

    const previousMode = this.currentMode
    this.log.info(
      `[PIPELINE:mode-switch] ${previousMode} → ${mode} conversationId=${this.currentConversationId}`
    )
    this.currentMode = mode

    // Let the adapter flag a system-prompt rebuild + mode-switch prefix
    this.adapter.onConversationSwitch(this.currentConversationId ?? '')

    const activeQuery = this.sdkExecutor.getActiveQuery()
    if (activeQuery) {
      const sdkMode = mode === 'build' ? 'auto' : 'default'
      try {
        await activeQuery.setPermissionMode(sdkMode)
        this.log.info(`[PIPELINE:mode-switch] SDK permissionMode set to '${sdkMode}'`)
      } catch (err) {
        this.log.warn('[PIPELINE:mode-switch] SDK setPermissionMode failed:', err)
      }
    }
  }

  async compact(): Promise<void> {
    if (!this.workspacePath || !this.currentConversationId) {
      throw new Error('Session not running — nothing to compact')
    }

    // Local LLMs: SDK compaction is not available (no session resume).
    // Signal the UI to suggest a new conversation instead.
    if (this.llmProvider === 'local-llm') {
      this.log.info(
        '[compaction] Local LLM — SDK compaction unavailable, suggesting new conversation'
      )
      this.emit('compactNeeded', {
        level: 'local-unsupported',
        inputTokens: this.lastContextTokens ?? 0,
        isLocalProvider: true
      })
      return
    }

    const sessionId = this.sessionMap.get(this.currentConversationId)
    if (!sessionId) throw new Error('No session to compact')

    this.log.info(`[compaction] compact #${this.compactCount + 1}`)
    this.compactCount++
    this.compactSuggested = false
    this.turnsSinceCompactSuggestion = 0
    // Adapters wire /compact into their own prompt assembler — signal via invalidate.
    this.adapter.onConversationSwitch(this.currentConversationId)
  }

  async resumeAt(messageId: string): Promise<void> {
    const activeQuery = this.sdkExecutor.getActiveQuery()
    if (activeQuery) {
      await activeQuery.rewindFiles(messageId)
    }
    this.pendingResumeAt = messageId
    this.log.info(`[resumeAt] pending resume at message=${messageId}`)
  }

  getStatus(): AgentStatus {
    const isActive =
      this.currentStatus === 'thinking' ||
      this.currentStatus === 'writing' ||
      this.currentStatus === 'reviewing'

    return {
      agentId: this.adapter.agentId,
      agentType: this.adapter.role === 'da-vinci' ? 'da-vinci' : 'specialist',
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
    if (this.currentConversationId && this.currentConversationId !== conversationId) {
      this.log.info(`Conversation switch: ${this.currentConversationId} → ${conversationId}`)
    }

    this.currentStatus = 'thinking'
    this.hasEmittedContent = false
    this.planBlockInjected = false
    this._lastTimedOut = false
    this.messageStartedAt = Date.now()
    this.processedToolIds.clear()
    this.currentConversationId = conversationId
    this.updateDbSessionConversation(conversationId)
    this.accumulatedText = ''
    this.circuitBreaker.reset()
    this.maxTurnsContinuations = 0
    this.lastStreamOpts = null
    this.controlToolState = { plan: false, askUser: false, memory: false }
    this.emit('statusUpdate', this.getStatus())
  }

  private resolveSession(conversationId: string): string | undefined {
    let sessionId = this.sessionMap.get(conversationId)
    if (!sessionId) {
      try {
        sessionId = conversationRepository.getSessionId(conversationId)
        if (sessionId) {
          this.sessionMap.set(conversationId, sessionId)
          this.log.info('Session loaded from DB:', sessionId)
        }
      } catch (err) {
        this.log.error('Failed to load session:', err)
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
  ): string | AsyncIterable<SDKUserMessage> {
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

    async function* singleMessage(): AsyncIterable<SDKUserMessage> {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: contentBlocks },
        parent_tool_use_id: null
      } as SDKUserMessage
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
      const planEvent: PlanDetectedEvent = {
        rawContent: JSON.stringify(plan),
        structuredPlan: plan,
        beforePlan: this.accumulatedText,
        afterPlan: ''
      }
      this.controlToolState.planIntent = { type: 'plan', plan: planEvent }
      this.emit('plan', planEvent)
      origPlan(plan)
    }

    const origAsk = cb.onAskUser
    cb.onAskUser = (questions, action) => {
      this.controlToolState.askUser = true
      this.controlToolState.askUserIntent = { type: 'askUser', questions, action }
      this.emit('askQuestion', { questions, action })
      origAsk(questions, action)
    }

    const origMemory = cb.onMemory
    cb.onMemory = (memory) => {
      this.controlToolState.memory = true
      origMemory(memory)
    }
  }

  private emitAdapterEvent(evt: AgentSessionEventName, payload: unknown): void {
    this.emit(evt, payload)
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
      localContextWindow
    } = opts
    const recoveryDepth = opts.recoveryDepth ?? 0
    const MAX_RECOVERY_DEPTH = 1

    const resumeAt = this.pendingResumeAt
    this.pendingResumeAt = undefined
    const abortController = new AbortController()
    this.sdkAbortController = abortController

    const timeoutMs =
      this.adapter.interactionTimeoutMs ?? AgentSessionService.MAX_INTERACTION_TIMEOUT_MS
    let timedOut = false
    const interactionTimer = setTimeout(() => {
      timedOut = true
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

    try {
      const streamState: StreamLoopState = {
        messageStopReceived: false,
        hasTextAfterLastTool: true,
        lastTerminalReason: undefined,
        sessionRecoveryNeeded: false
      }

      const executeOptions = this.buildSdkExecuteOptions({
        sdkPrompt,
        systemPrompt,
        sessionId,
        isBuildMode,
        resumeAt,
        abortController,
        mcpResult,
        llmProvider,
        localContextWindow
      })

      for await (const chunk of this.sdkExecutor.execute(
        executeOptions as unknown as SDKExecuteOptions
      )) {
        if (this.circuitBreaker.isBroken) break

        if ('_meta' in chunk && chunk._meta) {
          await this.processMetaChunk(chunk._meta as SDKExecuteResult, {
            conversationId,
            turnCount,
            streamState
          })
        } else {
          const action = this.processContentChunk(chunk, {
            conversationId,
            isBuildMode,
            streamState
          })
          if (action === 'break') break
          if (action === 'continue') continue
          if (action === 'return') return
        }
      }

      clearTimeout(interactionTimer)
      this.sdkAbortController = null

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
        timedOut,
        streamState,
        mcpResult,
        llmProvider
      })
    } catch (error) {
      clearTimeout(interactionTimer)
      await this.handleStreamError(error as Error, timedOut, recoveryDepth)
    }
  }

  /**
   * Resolve the context window size for the active local LLM model.
   * Looks up the model in RECOMMENDED_LOCAL_MODELS; falls back to 32K for
   * unknown models (conservative default).
   */
  private resolveLocalContextWindow(): number {
    if (!this.workspacePath) return 32_768
    try {
      const localConfig = modelConfigService.getLocalLLMConfig(this.workspacePath)
      const model = localConfig.localModel
      const recommended = RECOMMENDED_LOCAL_MODELS.find(
        (m) => m.ollamaId === model || m.omlxId === model
      )
      return recommended?.contextWindow ?? 32_768
    } catch {
      return 32_768
    }
  }

  private buildSdkExecuteOptions(params: {
    sdkPrompt: string | AsyncIterable<SDKUserMessage>
    systemPrompt: string
    sessionId: string | undefined
    isBuildMode: boolean
    resumeAt: string | undefined
    abortController: AbortController
    mcpResult: AdapterMcpResult
    llmProvider: LLMProvider
    localContextWindow?: number
  }): Record<string, unknown> {
    const {
      sdkPrompt,
      systemPrompt,
      sessionId,
      isBuildMode,
      resumeAt,
      abortController,
      mcpResult,
      llmProvider,
      localContextWindow: passedLocalCtxWindow
    } = params
    const { mcpServers, allowedTools, disallowedTools } = mcpResult

    const modelAction = `${this.adapter.role}:${isBuildMode ? 'build' : 'plan'}` as ModelAction
    const resolvedModel = modelConfigService.getModel(this.workspacePath!, modelAction)

    let additionalDirectories: string[] | undefined
    try {
      if (this.workspaceId) {
        const workspace = workspaceRepository.findById(this.workspaceId)
        if (workspace) {
          const settings = JSON.parse(workspace.settingsJson || '{}')
          additionalDirectories = settings.additionalDirectories as string[] | undefined
        }
      }
    } catch {
      /* non-fatal */
    }

    // ── Local LLM provider overrides ──
    const isLocal = llmProvider === 'local-llm'
    let finalModel = resolvedModel
    let envOverrides: Record<string, string> | undefined

    if (isLocal && this.workspacePath) {
      const localConfig = modelConfigService.getLocalLLMConfig(this.workspacePath)
      finalModel = localConfig.localModel
      const baseUrl = modelConfigService.getLocalBaseUrl(localConfig)

      // Use the real API key if configured, otherwise fall back to dummy
      const localKey = localConfig.localApiKey || 'local'

      // Both oMLX and Ollama expose Anthropic-compatible endpoints at the base URL
      envOverrides = {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: localKey,
        ANTHROPIC_API_KEY: localKey
      }
      this.log.info(
        `[PIPELINE:local-llm] backend=${localConfig.backend} model=${finalModel} baseUrl=${baseUrl}`
      )
    }

    // For 200K models: force SDK auto-compact to trigger earlier (80% of window)
    // The default ~95% leaves only 10K headroom, insufficient for large tool turns.
    if (!isLocal && !supportsContext1M(finalModel)) {
      envOverrides = {
        ...(envOverrides ?? {}),
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80'
      }
    }

    // Resolve context management config — needed for maxTurns and hook parameterization
    const localContextWindow = isLocal
      ? (passedLocalCtxWindow ?? this.resolveLocalContextWindow())
      : undefined

    // ── Model-aware context window resolution ──
    // The context-1m beta only works with Sonnet models. Opus/Haiku get 200K.
    const supports1M = !isLocal && supportsContext1M(finalModel)
    const effectiveContextWindow = isLocal
      ? localContextWindow!
      : supports1M
        ? CLAUDE_1M_CONTEXT_WINDOW
        : CLAUDE_DEFAULT_CONTEXT_WINDOW

    // Store on instance for live context badge updates during streaming
    this.effectiveContextWindow = effectiveContextWindow

    const contextManagement = isLocal
      ? getLocalLlmContextConfig(localContextWindow!)
      : supports1M
        ? (this.costPreference === 'economy'
            ? CLAUDE_ECONOMY_CONTEXT_CONFIG
            : CLAUDE_1M_CONTEXT_CONFIG)
        : CLAUDE_200K_CONTEXT_CONFIG
    const tierLimits = contextManagement._tierLimits

    // Diagnostic: log tier resolution for local LLMs
    if (isLocal && tierLimits) {
      this.log.info(
        `[PIPELINE:local-context-tier] model=${finalModel} contextWindow=${localContextWindow} ` +
          `tier=${contextManagement._tier} maxTurns=${isBuildMode ? tierLimits.maxTurnsBuild : tierLimits.maxTurnsPlan} ` +
          `readLimit=${tierLimits.readLineLimit} toolBudget=${tierLimits.toolResultBudgetChars}`
      )
    }

    // Diagnostic: log compact config so we can trace why compaction did/didn't fire
    const resolvedAutoCompactWindow = isLocal
      ? localContextWindow!
      : supports1M
        ? effectiveContextWindow
        : Math.round(effectiveContextWindow * 0.80)
    this.log.info(
      `[PIPELINE:compact-config] model=${finalModel} effectiveWindow=${effectiveContextWindow} ` +
        `autoCompactWindow=${isLocal ? 'disabled' : resolvedAutoCompactWindow} ` +
        `suggestThreshold=${this.compactSuggestThreshold} autoThreshold=${this.compactAutoThreshold} ` +
        `compactCount=${this.compactCount}`
    )

    return {
      prompt: sdkPrompt,
      systemPrompt,
      model: finalModel,
      cwd: this.workspacePath!,
      permissionMode: isBuildMode ? 'bypassPermissions' : 'default',
      allowedTools,
      disallowedTools,
      // Tier-aware turn limits: small=8/12, medium=15/25, large=30/50, Claude=30/50
      maxTurns: isLocal
        ? isBuildMode
          ? (tierLimits?.maxTurnsBuild ?? 12)
          : (tierLimits?.maxTurnsPlan ?? 8)
        : isBuildMode
          ? 50
          : 30,

      // Session resume: disabled for local (Ollama has no SDK sessions)
      resume: isLocal ? undefined : sessionId,
      ...(resumeAt && !isLocal ? { resumeSessionAt: resumeAt } : {}),
      abortController,
      agentId: this.adapter.agentId,

      // Thinking: adaptive for Claude, omitted entirely for local (oMLX/Ollama reject unknown params)
      thinking: isLocal ? undefined : { type: 'adaptive' },
      thinkingDisplay: isLocal ? undefined : 'summarized',
      effort: isLocal ? undefined : resolvedModel.includes('opus') ? 'xhigh' : 'high',

      // Budget: no cap by default (Claude Max subscription = flat rate).
      // Only apply if user opted into a custom cap via workspace settings.
      maxBudgetUsd: this.resolveBudgetCap(isLocal, isBuildMode),

      // Features: disabled for local (Ollama doesn't support these SDK features)
      promptSuggestions: isLocal ? false : true,
      includeHookEvents: true,
      autoCompactEnabled: isLocal ? false : true,
      // For 200K models (Opus/Haiku), shrink the autoCompactWindow so the SDK's
      // internal compaction fires earlier (~80% of window = 128K instead of 160K).
      // For 1M models, pass the full effective window — they have ample headroom.
      contextWindowSize: isLocal
        ? localContextWindow!
        : supports1M
          ? effectiveContextWindow
          : Math.round(effectiveContextWindow * 0.80), // 200K × 0.8 = 160K
      contextManagement,
      enableFileCheckpointing: isLocal ? false : true,
      betas: isLocal ? undefined : supports1M ? ['context-1m-2025-08-07'] : undefined,
      fallbackModel: isLocal
        ? undefined
        : resolvedModel !== 'claude-sonnet-4-6'
          ? 'claude-sonnet-4-6'
          : undefined,

      // Env overrides for Ollama SDK passthrough
      ...(envOverrides ? { envOverrides } : {}),
      ...(additionalDirectories?.length ? { additionalDirectories } : {}),
      onPermissionDenied: (toolName: string, reason: string) => {
        this.log.info(`[PIPELINE:permission-denied] tool=${toolName} reason=${reason}`)
        this.emit('chunk', {
          type: 'status',
          content: `⚠️ Permission denied: ${toolName} — ${reason}`
        } as StreamChunk)
      },
      onSubagentStart: (agentId: string, description: string) => {
        this.log.info(`[PIPELINE:subagent-start] agent=${agentId} desc=${description}`)
      },
      onSubagentStop: (agentId: string, status: string) => {
        this.log.info(`[PIPELINE:subagent-stop] agent=${agentId} status=${status}`)
      },
      onTaskCreated: (taskId: string, description: string) => {
        this.log.info(`[PIPELINE:task-created] task=${taskId} desc=${description}`)
      },
      onTaskCompleted: (taskId: string, status: string) => {
        this.log.info(`[PIPELINE:task-completed] task=${taskId} status=${status}`)
      },
      sandbox: isBuildMode ? createBuildModeSandbox() : undefined,
      ...(mcpServers ? { mcpServers } : {}),
      onPostCompact: async (preTokens: number, postTokens: number) => {
        this.log.info(`[Compaction] ${preTokens} → ${postTokens} tokens`)

        // Update in-memory + DB metrics with post-compaction value so subsequent
        // getContextUsage calls (SDK or DB fallback) return the compacted size.
        this.lastContextTokens = postTokens
        if (this.currentConversationId) {
          try {
            const { turnUsageRepository } = await import('../db/repositories')
            turnUsageRepository.updateLastTurnContextTokens(this.currentConversationId, postTokens)
          } catch {
            /* non-fatal */
          }
        }

        // Notify the UI to refresh its context bar. Reuses the compactNeeded
        // event chain with level='compacted' — renderer refreshes silently
        // instead of opening the compact modal.
        this.compactSuggested = false
        this.turnsSinceCompactSuggestion = 0
        this.emit('compactNeeded', {
          level: 'compacted',
          inputTokens: postTokens,
          isLocalProvider: this.llmProvider === 'local-llm'
        })
      },
      onElicitation: async (request: ElicitationRequest, { signal }: { signal: AbortSignal }) => {
        this.log.info(
          `[elicitation] server=${request.serverName} message="${request.message?.substring(0, 80)}"`
        )
        const elicitationEvent: ElicitationEvent = {
          serverName: request.serverName,
          message: request.message,
          mode: request.mode ?? 'form',
          requestedSchema: request.requestedSchema as Record<string, unknown> | undefined,
          url: request.url,
          elicitationId: request.elicitationId
        }
        this.emit('elicitation', elicitationEvent)
        return new Promise<ElicitationResult>((resolve) => {
          const handler = (result: ElicitationResult): void => {
            this.removeListener('elicitationResponse', handler)
            resolve(result)
          }
          this.on('elicitationResponse', handler)
          signal.addEventListener(
            'abort',
            () => {
              this.removeListener('elicitationResponse', handler)
              resolve({ action: 'decline' } as ElicitationResult)
            },
            { once: true }
          )
        })
      }
    }
  }

  /**
   * Resolve the USD budget cap for the current execution.
   * - Local LLMs: no cap (free).
   * - Claude without user override: no cap (subscription = flat rate).
   * - Claude with user override: base × mode multiplier.
   */
  private resolveBudgetCap(isLocal: boolean, isBuildMode: boolean): number | undefined {
    if (isLocal) return undefined

    // Check workspace settings for user-defined cap
    if (!this.workspacePath) return undefined
    try {
      const workspace = workspaceRepository.findAll().find((w) => w.repoPath === this.workspacePath)
      if (!workspace) return undefined
      const settings = JSON.parse(workspace.settingsJson || '{}')
      const baseCap = settings.budgetCapUsd as number | undefined
      if (!baseCap || baseCap <= 0) return undefined // No cap configured

      // Apply mode multiplier
      const multiplier = isBuildMode
        ? BUDGET_CAP_MODE_MULTIPLIERS.build
        : BUDGET_CAP_MODE_MULTIPLIERS.plan
      return baseCap * multiplier
    } catch {
      return undefined
    }
  }

  private async processMetaChunk(
    meta: SDKExecuteResult,
    ctx: {
      conversationId: string
      turnCount: number
      streamState: StreamLoopState
    }
  ): Promise<void> {
    const { conversationId, turnCount, streamState } = ctx
    streamState.messageStopReceived = true

    if (meta.sessionId && conversationId) {
      this.sessionMap.set(conversationId, meta.sessionId)
      this.log.info('Session captured for conversation:', conversationId)
      try {
        conversationRepository.updateSessionId(conversationId, meta.sessionId)
      } catch (err) {
        this.log.error('Failed to persist session ID:', err)
      }
    }

    if (meta.sessionTitle && conversationId) {
      try {
        const conv = conversationRepository.findById(conversationId)
        if (conv && (conv.title === 'New Conversation' || conv.title === '')) {
          conversationRepository.updateTitle(conversationId, meta.sessionTitle)
          this.log.info(`[PIPELINE:auto-title] "${meta.sessionTitle}" for ${conversationId}`)
        }
      } catch (err) {
        this.log.warn('Failed to auto-name conversation from session_title:', err)
      }
    }

    if (meta.terminalReason) {
      streamState.lastTerminalReason = meta.terminalReason
      this.log.info(`[PIPELINE:terminal-reason] ${meta.terminalReason} for ${conversationId}`)
    }

    const { totalTokens } = this.tokenTracker.recordTurn(meta, {
      turnCount,
      conversationId,
      dbSessionId: this.dbSessionId,
      workspacePath: this.workspacePath!
    })
    this.tokenUsage += totalTokens
    this.inputTokens += meta.tokenUsage.input
    this.outputTokens += meta.tokenUsage.output
    this.cacheReadTokens += meta.tokenUsage.cacheReadInputTokens
    this.cacheCreationTokens += meta.tokenUsage.cacheCreationInputTokens

    let sdkContextData:
      | {
          totalTokens?: number
          categories?: { name: string; tokens: number; color: string; isDeferred?: boolean }[]
          mcpTools?: {
            name: string
            serverName: string
            tokens: number
            isLoaded?: boolean
          }[]
          systemTools?: { name: string; tokens: number }[]
          deferredBuiltinTools?: { name: string; tokens: number; isLoaded: boolean }[]
          memoryFiles?: { path: string; type: string; tokens: number }[]
          autoCompactThreshold?: number
          isAutoCompactEnabled?: boolean
        }
      | undefined
    try {
      const sdkUsage = await this.sdkExecutor.getActiveQuery()?.getContextUsage()
      sdkContextData = sdkUsage as typeof sdkContextData
    } catch {
      /* SDK not available — fallback */
    }

    if (sdkContextData?.totalTokens) {
      this.lastContextTokens = sdkContextData.totalTokens
    }

    const totalContextTokens =
      sdkContextData?.totalTokens ??
      meta.tokenUsage.input +
        meta.tokenUsage.cacheReadInputTokens +
        meta.tokenUsage.cacheCreationInputTokens

    // Build the Claude Code-style breakdown for the compact-context modal.
    // Only forward the fields the modal actually renders — keeps the IPC
    // payload small and avoids leaking SDK shape changes through the protocol.
    const breakdown = sdkContextData
      ? ({
          categories: sdkContextData.categories,
          mcpTools: sdkContextData.mcpTools,
          systemTools: sdkContextData.systemTools,
          deferredBuiltinTools: sdkContextData.deferredBuiltinTools,
          memoryFiles: sdkContextData.memoryFiles,
          autoCompactThreshold: sdkContextData.autoCompactThreshold,
          isAutoCompactEnabled: sdkContextData.isAutoCompactEnabled
        } as const)
      : undefined

    // One-shot diagnostic logging — surfaces what's eating the context window
    // so we can tell whether the bloat is messages, MCP tool definitions, or
    // skills/CLAUDE.md. Logged once per turn (not committed forever — remove
    // after we have a sense of typical breakdowns in production).
    if (breakdown) {
      try {
        const fmt = (n?: number): string =>
          n === undefined ? '?' : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
        const cats = (breakdown.categories ?? [])
          .map((c) => `${c.name}=${fmt(c.tokens)}${c.isDeferred ? '(deferred)' : ''}`)
          .join(' | ')
        const topMcp = (breakdown.mcpTools ?? [])
          .slice()
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 5)
          .map((t) => `${t.serverName}.${t.name}(${fmt(t.tokens)})`)
          .join(', ')
        this.log.info(
          `[PIPELINE:context-breakdown] total=${fmt(totalContextTokens)} | ${cats}` +
            (topMcp ? ` | top-mcp: ${topMcp}` : '')
        )
        // Log context management effectiveness — track whether server-side strategies are working
        if (breakdown?.autoCompactThreshold != null) {
          this.log.info(
            `[PIPELINE:context-mgmt] autoCompactThreshold=${fmt(breakdown.autoCompactThreshold)} ` +
              `autoCompactEnabled=${breakdown.isAutoCompactEnabled} ` +
              `compactCount=${this.compactCount}`
          )
        }
      } catch {
        /* diagnostic logging is best-effort */
      }
    }

    // Push live context update to the renderer — allows the badge to update
    // during streaming instead of only on completion.
    if (totalContextTokens > 0) {
      const effectiveWindow = this.effectiveContextWindow ?? CLAUDE_DEFAULT_CONTEXT_WINDOW
      this.emit('chunk', {
        type: 'context_usage_update',
        content: '',
        contextUsageUpdate: {
          inputTokens: totalContextTokens,
          contextWindowSize: effectiveWindow,
          percentage: Math.round((totalContextTokens / effectiveWindow) * 100),
        }
      } as StreamChunk)
    }

    this.checkCompaction(totalContextTokens, breakdown)

    // Store the SDK context window total separately — preserves the original
    // API-reported input_tokens and cache_* fields recorded by recordTurn().
    if (this.dbSessionId && conversationId && sdkContextData?.totalTokens) {
      try {
        turnUsageRepository.updateLastTurnContextTokens(conversationId, sdkContextData.totalTokens)
      } catch {
        /* non-fatal */
      }
    }
  }

  private processContentChunk(
    chunk: StreamChunk & { type?: string; content?: string; error?: string; toolName?: string },
    ctx: {
      conversationId: string
      isBuildMode: boolean
      streamState: StreamLoopState
    }
  ): 'next' | 'break' | 'continue' | 'return' {
    const { conversationId, isBuildMode, streamState } = ctx

    if (chunk.type === 'error' && chunk.error?.includes('No conversation found with session ID')) {
      this.log.warn(
        `[PIPELINE:session-recovery] Stale session detected for conversationId=${conversationId} — initiating recovery`
      )

      this.emit('chunk', {
        type: 'session_recovery',
        recoveryPhase: 'started',
        content: 'Session expired — recovering conversation context...'
      } as StreamChunk)

      this.clearSession(conversationId)
      try {
        conversationRepository.updateSessionId(conversationId, '')
      } catch (err) {
        this.log.error('[PIPELINE:session-recovery] Failed to clear DB session:', err)
      }

      this.emit('chunk', {
        type: 'session_recovery',
        recoveryPhase: 'building_context',
        content: 'Rebuilding conversation context from history...'
      } as StreamChunk)

      // Recovery context is adapter-agnostic: just recent messages.
      // (The Generalist adapter injects its own richer summary.)
      streamState.sessionRecoveryNeeded = true
      return 'break'
    }

    // Intercept SDK abort errors that weren't user-initiated
    if (
      chunk.type === 'error' &&
      chunk.error?.includes('Claude Code process aborted by user') &&
      this.currentStatus !== 'idle'
    ) {
      this.log.warn(
        `[PIPELINE:unexpected-abort] Session was aborted without user action — ` +
          `status=${this.currentStatus} conversationId=${conversationId}`
      )
      // Rewrite the error to something more helpful
      this.emit('chunk', {
        type: 'error',
        error:
          'The agent session was interrupted unexpectedly. This can happen during app reloads. Please resend your message to continue.'
      } as StreamChunk)
      return 'break'
    }

    // Intercept budget cap exceeded — offer the user a choice to continue
    if (chunk.type === 'error' && chunk.error?.includes('budget cap exceeded')) {
      this.log.warn(
        `[PIPELINE:budget-cap-reached] conversationId=${conversationId} — offering continuation`
      )
      this.emit('budgetCapReached', {
        conversationId,
        message: chunk.error
      })
      // Don't emit the raw error to the renderer — the budgetCapReached
      // event will show a user-friendly banner instead.
      return 'break'
    }

    if (chunk.type === 'text' && chunk.content) {
      this.accumulatedText += chunk.content
      streamState.hasTextAfterLastTool = true
    }

    if (chunk.type === 'tool_use') {
      const isControlTool = chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)
      if (isControlTool) {
        this.log.debug(`[PIPELINE:control-tool-use] ${chunk.toolName}`)
        return 'continue'
      }

      streamState.hasTextAfterLastTool = false
      const cbResult = this.circuitBreaker.onToolUse({
        isBuildMode,
        accumulatedTextLength: this.accumulatedText.length,
        conversationId
      })

      if (cbResult.broken) {
        this.currentStatus = 'failed'
        this.emit('statusUpdate', this.getStatus())
        if (cbResult.errorChunk) {
          this.emit('chunk', cbResult.errorChunk)
        }
        this.emit('complete')
        return 'return'
      }

      this.circuitBreaker.logToolCall(conversationId, chunk.toolName ?? 'unknown')
    }

    if (chunk.type === 'prompt_suggestion' && chunk.content) {
      this.emit('promptSuggestion', {
        conversationId,
        suggestion: chunk.content
      })
    }

    if (chunk.type === 'text') this.currentStatus = 'writing'
    if (chunk.type === 'tool_use') this.currentStatus = 'reviewing'
    this.emit('statusUpdate', this.getStatus())
    this.emit('chunk', chunk)
    return 'next'
  }

  private async handleSessionRecovery(params: {
    sessionRecoveryNeeded: boolean
    recoveryDepth: number
    maxRecoveryDepth: number
    sdkPrompt: string | AsyncIterable<SDKUserMessage>
    systemPrompt: string
    conversationId: string
    turnCount: number
    isBuildMode: boolean
    mcpResult: AdapterMcpResult
    llmProvider: LLMProvider
  }): Promise<'continue' | 'returned'> {
    if (!params.sessionRecoveryNeeded) return 'continue'

    if (params.recoveryDepth >= params.maxRecoveryDepth) {
      this.log.error('[PIPELINE:session-recovery-depth-exceeded] Max recovery depth reached')
      this.emit('chunk', {
        type: 'session_recovery',
        recoveryPhase: 'failed',
        content: 'Session recovery failed (max retries). Please start a new conversation.'
      } as StreamChunk)
      this.currentStatus = 'failed'
      this.flushTokenUsage()
      this.emit('statusUpdate', this.getStatus())
      this.emit('complete')
      return 'returned'
    }

    try {
      await this.executeStream({
        sdkPrompt: params.sdkPrompt,
        systemPrompt: params.systemPrompt,
        sessionId: undefined,
        conversationId: params.conversationId,
        turnCount: params.turnCount,
        isBuildMode: params.isBuildMode,
        mcpResult: params.mcpResult,
        llmProvider: params.llmProvider,
        recoveryDepth: params.recoveryDepth + 1
      })
      return 'returned'
    } catch (retryError) {
      this.log.error('[PIPELINE:session-recovery-failed]', retryError)
      this.currentStatus = 'failed'
      this.flushTokenUsage()
      this.emit('statusUpdate', this.getStatus())
      this.emit('complete')
      return 'returned'
    }
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
    const {
      conversationId,
      systemPrompt,
      isBuildMode,
      recoveryDepth,
      timedOut,
      streamState,
      mcpResult,
      llmProvider
    } = params

    if (!streamState.messageStopReceived && !this.circuitBreaker.isBroken && !timedOut) {
      this.log.warn(
        `[PIPELINE:stream-incomplete] Stream ended without MessageStop event for conversationId=${conversationId}`
      )
    }

    this.log.info(
      `[PIPELINE:response-complete] conversationId=${conversationId} textLen=${this.accumulatedText.length}`
    )

    // ── Auto-continue on max_turns ──────────────────────────────────
    // When the SDK stops at the turn limit but has more work to do,
    // automatically resume the session with a continuation prompt.
    if (
      streamState.lastTerminalReason === 'max_turns' &&
      this.maxTurnsContinuations < AgentSessionService.MAX_TURN_CONTINUATIONS
    ) {
      this.maxTurnsContinuations++
      this.log.info(
        `[PIPELINE:max-turns-continue] continuation=${this.maxTurnsContinuations}/${AgentSessionService.MAX_TURN_CONTINUATIONS} ` +
          `conversationId=${conversationId}`
      )

      // Notify the renderer that we're auto-continuing
      this.emit('chunk', {
        type: 'text',
        content: `\n\n_Continuing... (turn limit reached, auto-resuming ${this.maxTurnsContinuations}/${AgentSessionService.MAX_TURN_CONTINUATIONS})_\n\n`
      } as StreamChunk)

      // Re-enter the stream loop with a continuation prompt.
      // The session is preserved via resume, so context is not lost.
      await this.executeStream({
        sdkPrompt: isBuildMode
          ? 'Continue implementing from where you left off. Do not repeat completed work.'
          : 'Continue your analysis from where you left off. Do not repeat completed work.',
        systemPrompt,
        sessionId: this.sessionMap.get(conversationId),
        conversationId,
        turnCount: this.turnCounts.get(conversationId) ?? 1,
        isBuildMode,
        mcpResult,
        llmProvider
      })
      return // executeStream handles its own finalization
    }

    const skipNudgeReasons = new Set([
      'max_turns',
      'hook_stopped',
      'aborted_tools',
      'aborted_streaming'
    ])
    const shouldSkipNudge =
      streamState.lastTerminalReason && skipNudgeReasons.has(streamState.lastTerminalReason)
    if (
      this.circuitBreaker.count > 0 &&
      !streamState.hasTextAfterLastTool &&
      !shouldSkipNudge &&
      !timedOut
    ) {
      this.log.warn(
        `[PIPELINE:recovery-nudge-triggered] conversationId=${conversationId} ` +
          `toolCalls=${this.circuitBreaker.count} accumulatedTextLen=${this.accumulatedText.length}`
      )
      const recoveryResult = await this.recoveryNudge.attemptRecovery({
        sdkExecutor: this.sdkExecutor,
        systemPrompt,
        workspacePath: this.workspacePath!,
        model: modelConfigService.getModel(this.workspacePath!, this.adapter.role as ModelAction),
        isBuildMode,
        sessionId: this.sessionMap.get(conversationId),
        conversationId,
        toolCallCount: this.circuitBreaker.count,
        onSessionCapture: (sid) => this.sessionMap.set(conversationId, sid),
        onChunk: (chunk) => this.emit('chunk', chunk),
        onTokens: (tokens) => {
          this.tokenUsage += tokens
        }
      })
      this.log.info(
        `[PIPELINE:recovery-nudge-result] recovered=${recoveryResult.recovered} textLen=${recoveryResult.text.length}`
      )
      this.accumulatedText += recoveryResult.text
    }

    // Delegate intent detection to the adapter.
    this.adapter.emitDetectedIntents({
      accumulatedText: this.accumulatedText,
      controlToolState: this.controlToolState,
      mode: this.currentMode,
      conversationId,
      emit: (evt, payload) => this.emitAdapterEvent(evt, payload)
    })

    // Baseline "response" intent if adapter emitted nothing interesting.
    if (!this.controlToolState.plan && !this.controlToolState.askUser) {
      this.emit('intent', {
        type: 'response',
        content: this.accumulatedText
      } as AgentIntent)
    }

    this.currentStatus = 'idle'
    this.flushTokenUsage()
    this.emit('statusUpdate', this.getStatus())

    if (recoveryDepth > 0) {
      this.emit('chunk', {
        type: 'session_recovery',
        recoveryPhase: 'completed',
        content: 'Session recovered successfully.'
      } as StreamChunk)
    }

    this.emit('complete')
  }

  private async handleStreamError(
    error: Error,
    timedOut: boolean,
    recoveryDepth = 0
  ): Promise<void> {
    this.sdkAbortController = null

    // ── Auto-continue on max_turns error ────────────────────────────
    // The SDK may throw "Reached maximum number of turns (N)" instead
    // of terminating gracefully via the meta chunk. Handle both paths.
    const isMaxTurns =
      !timedOut &&
      error.name !== 'AbortError' &&
      error.message?.includes('maximum number of turns')

    if (
      isMaxTurns &&
      this.lastStreamOpts &&
      this.maxTurnsContinuations < AgentSessionService.MAX_TURN_CONTINUATIONS
    ) {
      this.maxTurnsContinuations++
      const { conversationId, systemPrompt, isBuildMode, mcpResult, llmProvider } =
        this.lastStreamOpts
      this.log.info(
        `[PIPELINE:max-turns-continue-error] continuation=${this.maxTurnsContinuations}/${AgentSessionService.MAX_TURN_CONTINUATIONS} ` +
          `conversationId=${conversationId}`
      )

      this.emit('chunk', {
        type: 'text',
        content: `\n\n_Continuing... (turn limit reached, auto-resuming ${this.maxTurnsContinuations}/${AgentSessionService.MAX_TURN_CONTINUATIONS})_\n\n`
      } as StreamChunk)

      await this.executeStream({
        sdkPrompt: isBuildMode
          ? 'Continue implementing from where you left off. Do not repeat completed work.'
          : 'Continue your analysis from where you left off. Do not repeat completed work.',
        systemPrompt,
        sessionId: this.sessionMap.get(conversationId),
        conversationId,
        turnCount: this.turnCounts.get(conversationId) ?? 1,
        isBuildMode,
        mcpResult,
        llmProvider
      })
      return // executeStream handles its own finalization
    }

    if (error.name === 'AbortError') {
      if (timedOut) {
        this.log.error('SDK query timed out')
        this.emit('chunk', {
          type: 'error',
          error: `Response exceeded maximum time (${AgentSessionService.MAX_INTERACTION_TIMEOUT_MS / 60_000} minutes) after ${this.circuitBreaker.count} tool calls. The agent may be stuck. Try simplifying your request.`
        } as StreamChunk)
      } else {
        this.log.info('SDK query cancelled by user')
      }
    } else {
      this.log.error('SDK send failed:', error)
      this.emit('chunk', {
        type: 'error',
        error: `${this.adapter.role} SDK error: ${error.message}`
      } as StreamChunk)
    }
    this.currentStatus = 'failed'
    this.flushTokenUsage()
    this.emit('statusUpdate', this.getStatus())

    if (recoveryDepth > 0) {
      this.emit('chunk', {
        type: 'session_recovery',
        recoveryPhase: 'failed',
        content: 'Session recovery failed. Please start a new conversation.'
      } as StreamChunk)
    }

    this.emit('complete')
  }

  // ── Compaction ────────────────────────────────────────────────────

  private applyCompactionThresholds(settings: Record<string, unknown>): void {
    const isLocal = (settings.llmProvider as string) === 'local-llm'

    if (isLocal) {
      // Reuse resolveLocalContextWindow() to avoid duplicating model lookup logic
      const ctx = this.resolveLocalContextWindow()
      const tier = resolveContextTier(ctx)
      const limits = TIER_LIMITS[tier]
      this.compactSuggestThreshold = limits.compactSuggestThreshold
      this.compactAutoThreshold = limits.compactAutoThreshold
    } else {
      // Resolve the effective context window for this model — 1M beta only applies to Sonnet
      const modelAction = `${this.adapter.role}:${this.currentMode}` as ModelAction
      const model = modelConfigService.getModel(this.workspacePath!, modelAction)
      const supports1M = supportsContext1M(model)
      const effectiveWindow = supports1M
        ? CLAUDE_1M_CONTEXT_WINDOW
        : CLAUDE_DEFAULT_CONTEXT_WINDOW
      const defaults = this.resolveCompactionThresholds(effectiveWindow)

      this.compactSuggestThreshold =
        (settings.compactSuggestThreshold as number) ?? defaults.suggest
      this.compactAutoThreshold =
        (settings.compactAutoThreshold as number) ?? defaults.auto
    }
  }

  /**
   * Compute compaction thresholds proportional to the actual context window.
   * For 200K windows, compact earlier (60%/75%) since there's less headroom —
   * a single large tool turn can consume 20-30K tokens.
   * For 1M windows, use the original ratios (70%/85%) — ample room.
   */
  private resolveCompactionThresholds(effectiveContextWindow: number): {
    suggest: number
    auto: number
  } {
    const isSmallWindow = effectiveContextWindow <= 200_000
    return {
      suggest: Math.round(effectiveContextWindow * (isSmallWindow ? 0.60 : 0.70)),
      auto: Math.round(effectiveContextWindow * (isSmallWindow ? 0.75 : 0.85)),
    }
  }

  private checkCompaction(
    inputTokens: number,
    breakdown?: import('../../shared/types').ContextUsageBreakdown
  ): void {
    const autoThreshold = this.compactAutoThreshold
    const suggestThreshold = this.compactSuggestThreshold
    const warningThreshold = Math.floor(suggestThreshold * 0.8)
    const isLocal = this.llmProvider === 'local-llm'

    if (inputTokens >= autoThreshold) {
      this.log.warn(
        `[PIPELINE:compact-critical] Context at ${inputTokens} tokens ` +
        `(threshold=${autoThreshold}) — critical notification`
      )
      // Critical always fires (no compactSuggested gate) — user must act.
      this.emit('compactNeeded', {
        level: 'critical',
        inputTokens,
        breakdown,
        isLocalProvider: isLocal
      })
    } else if (inputTokens >= suggestThreshold) {
      // Re-suggest every 3 turns after initial suggestion (user may have dismissed)
      if (!this.compactSuggested || this.turnsSinceCompactSuggestion >= 3) {
        this.compactSuggested = true
        this.turnsSinceCompactSuggestion = 0
        this.log.info(`Context growing large (${inputTokens} input tokens) — suggesting compact`)
        this.emit('compactNeeded', {
          level: 'suggest',
          inputTokens,
          breakdown,
          isLocalProvider: isLocal
        })
      } else {
        this.turnsSinceCompactSuggestion++
      }
    } else if (inputTokens >= warningThreshold && !this.compactSuggested) {
      this.log.info(
        `[PIPELINE:compact-warning] Context approaching threshold (${inputTokens}/${suggestThreshold} tokens)`
      )
      this.emit('compactNeeded', {
        level: 'warning',
        inputTokens,
        estimatedNextCost: Math.round(inputTokens * 0.05),
        breakdown,
        isLocalProvider: isLocal
      })
    }
  }
}
