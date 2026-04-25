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
  PlanDetectedEvent
} from '../../shared/types'
import type {
  SDKUserMessage,
  ElicitationRequest,
  ElicitationResult
} from '@anthropic-ai/claude-agent-sdk'
import { CHAT_AGENT_BUDGET_CAP, MCP_TOOLS } from '../../shared/constants'
import { chatAgentLogger } from '../logger'
import { AgentBaseService } from './agent-base.service'
import type { StreamChunk } from './agent-base.service'
import { SDKExecutor } from './sdk-executor'
import type { SDKExecuteOptions, SDKExecuteResult } from './sdk-executor'
import { createBuildModeSandbox } from './sandbox-config'
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
  recoveryDepth?: number
}

/**
 * Generic session runtime. Accepts an AgentRoleAdapter that supplies the
 * role-specific pieces (prompt, MCP, control callbacks, intent detection).
 */
export class AgentSessionService extends AgentBaseService {
  protected readonly log = chatAgentLogger

  // Compaction defaults — match Claude Code's published behavior:
  //   suggest at ~80% (early warning), auto at ~95% (with ~13K reserve for the
  //   autocompact buffer). Anthropic's docs: cache + creation + read all count
  //   toward the context window, so these thresholds operate on the full
  //   context-pressure metric, not the cheap cache-discounted billing metric.
  // Scaled for the 1M context window (context-1m-2025-08-07).
  // TODO: reserve a literal 13K autocompact buffer once the SDK exposes
  //   autoCompactThreshold reliably — for now the 950K cap leaves ~50K headroom.
  private static readonly DEFAULT_COMPACT_SUGGEST_THRESHOLD = 800_000
  private static readonly DEFAULT_COMPACT_AUTO_THRESHOLD = 950_000
  // Economy preference uses a smaller effective window (200K-class models).
  private static readonly DEFAULT_COMPACT_SUGGEST_THRESHOLD_ECONOMY = 160_000
  private static readonly DEFAULT_COMPACT_AUTO_THRESHOLD_ECONOMY = 190_000
  private static readonly MAX_INTERACTION_TIMEOUT_MS = 10 * 60_000 // 10 minutes

  private workspacePath: string | null = null
  private workspaceId: string | null = null
  private currentConversationId: string | null = null
  private accumulatedText = ''
  private currentMode: ConversationMode = 'plan'
  private costPreference: CostPreference = 'balanced'

  /** Maps conversationId → SDK session_id for resume. */
  private readonly sessionMap = new Map<string, string>()

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
  private lastContextTokens: number | undefined

  private pendingResumeAt: string | undefined

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
    if (this.sdkAbortController) {
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
    this.lastContextTokens = undefined
    this.currentConversationId = null
    this.accumulatedText = ''
    this.compactCount = 0
    this.compactSuggested = false
    this.tokenTracker.resetSession()

    // Resolve workspace id + cost preference
    try {
      const workspaces = workspaceRepository.findAll()
      const workspace = workspaces.find((w) => w.repoPath === workspacePath)
      if (workspace) this.workspaceId = workspace.id
      const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}
      this.costPreference = (settings.costPreference as CostPreference) || 'balanced'
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
      model: modelConfigService.getModel(
        workspacePath,
        `${this.adapter.role}:plan` as ModelAction
      )
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

    const mcpResult = this.adapter.buildMcpConfig({
      mode: this.currentMode,
      workspacePath: this.workspacePath,
      workspaceId: this.workspaceId,
      conversationId: this.currentConversationId,
      controlCallbacks
    })

    await this.executeStream({
      sdkPrompt,
      systemPrompt,
      sessionId,
      conversationId,
      turnCount,
      isBuildMode: this.currentMode === 'build',
      mcpResult
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
    const sessionId = this.sessionMap.get(this.currentConversationId)
    if (!sessionId) throw new Error('No session to compact')

    this.log.info(`[compaction] compact #${this.compactCount + 1}`)
    this.compactCount++
    this.compactSuggested = false
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
    this.messageStartedAt = Date.now()
    this.processedToolIds.clear()
    this.currentConversationId = conversationId
    this.updateDbSessionConversation(conversationId)
    this.accumulatedText = ''
    this.circuitBreaker.reset()
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
    const {
      sdkPrompt,
      systemPrompt,
      sessionId,
      conversationId,
      turnCount,
      isBuildMode,
      mcpResult
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
        mcpResult
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
        mcpResult
      })
      if (recovered !== 'continue') return

      this.finalizeStream({
        conversationId,
        systemPrompt,
        isBuildMode,
        recoveryDepth,
        timedOut,
        streamState
      })
    } catch (error) {
      clearTimeout(interactionTimer)
      this.handleStreamError(error as Error, timedOut, recoveryDepth)
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
  }): Record<string, unknown> {
    const { sdkPrompt, systemPrompt, sessionId, isBuildMode, resumeAt, abortController, mcpResult } =
      params
    const { mcpServers, allowedTools, disallowedTools } = mcpResult

    const modelAction = `${this.adapter.role}:${
      isBuildMode ? 'build' : 'plan'
    }` as ModelAction
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

    return {
      prompt: sdkPrompt,
      systemPrompt,
      model: resolvedModel,
      cwd: this.workspacePath!,
      permissionMode: isBuildMode ? 'auto' : 'default',
      allowedTools,
      disallowedTools,
      maxTurns: isBuildMode ? 50 : 25,
      resume: sessionId,
      ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
      abortController,
      agentId: this.adapter.agentId,
      thinking: { type: 'adaptive' },
      thinkingDisplay: 'summarized',
      effort: resolvedModel.includes('opus') ? 'xhigh' : 'high',
      maxBudgetUsd: CHAT_AGENT_BUDGET_CAP,
      promptSuggestions: true,
      includeHookEvents: true,
      autoCompactWindow: true,
      enableFileCheckpointing: true,
      betas: ['context-1m-2025-08-07'],
      ...(resolvedModel !== 'claude-sonnet-4-6' ? { fallbackModel: 'claude-sonnet-4-6' } : {}),
      ...(additionalDirectories?.length ? { additionalDirectories } : {}),
      ...(isBuildMode
        ? {
            canUseTool: async (
              toolName: string,
              input: Record<string, unknown>,
              opts: {
                signal: AbortSignal
                title?: string
                displayName?: string
                description?: string
                suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[]
                blockedPath?: string
                decisionReason?: string
                toolUseID: string
                agentID?: string
              }
            ): Promise<import('@anthropic-ai/claude-agent-sdk').PermissionResult> => {
              const { toolApprovalService } = await import('./tool-approval.service')
              const result = await toolApprovalService.requestApprovalEnriched(
                toolName,
                input,
                this.adapter.agentId,
                undefined,
                {
                  title: opts.title,
                  displayName: opts.displayName,
                  description: opts.description,
                  suggestions: opts.suggestions
                }
              )
              return result.approved
                ? {
                    behavior: 'allow' as const,
                    updatedPermissions: result.updatedPermissions as
                      | import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[]
                      | undefined
                  }
                : { behavior: 'deny' as const, message: 'Blocked by user' }
            }
          }
        : {}),
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
        const activeQuery = this.sdkExecutor.getActiveQuery()
        if (activeQuery && this.currentConversationId) {
          const { fileChangeRepository } = await import('../db/repositories')
          const files = fileChangeRepository.findByConversation(this.currentConversationId)
          for (const file of files) {
            try {
              const { statSync } = await import('fs')
              const stat = statSync(file.filePath)
              await activeQuery.seedReadState(file.filePath, Math.floor(stat.mtimeMs))
            } catch {
              /* file may have been deleted — skip */
            }
          }
        }
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
      } catch {
        /* diagnostic logging is best-effort */
      }
    }

    this.checkCompaction(totalContextTokens, breakdown)

    if (this.dbSessionId && conversationId && sdkContextData?.totalTokens) {
      try {
        turnUsageRepository.updateLastTurnTokens(conversationId, {
          inputTokens: sdkContextData.totalTokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        })
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
  }): Promise<void> {
    const { conversationId, systemPrompt, isBuildMode, recoveryDepth, timedOut, streamState } =
      params

    if (!streamState.messageStopReceived && !this.circuitBreaker.isBroken && !timedOut) {
      this.log.warn(
        `[PIPELINE:stream-incomplete] Stream ended without MessageStop event for conversationId=${conversationId}`
      )
    }

    this.log.info(
      `[PIPELINE:response-complete] conversationId=${conversationId} textLen=${this.accumulatedText.length}`
    )

    const skipNudgeReasons = new Set([
      'max_turns',
      'hook_stopped',
      'aborted_tools',
      'aborted_streaming'
    ])
    const shouldSkipNudge =
      streamState.lastTerminalReason && skipNudgeReasons.has(streamState.lastTerminalReason)
    if (this.circuitBreaker.count > 0 && !streamState.hasTextAfterLastTool && !shouldSkipNudge) {
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

  private handleStreamError(error: Error, timedOut: boolean, recoveryDepth = 0): void {
    this.sdkAbortController = null
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
    if (this.costPreference === 'economy') {
      this.compactSuggestThreshold =
        (settings.compactSuggestThreshold as number) ??
        AgentSessionService.DEFAULT_COMPACT_SUGGEST_THRESHOLD_ECONOMY
      this.compactAutoThreshold =
        (settings.compactAutoThreshold as number) ??
        AgentSessionService.DEFAULT_COMPACT_AUTO_THRESHOLD_ECONOMY
    } else {
      this.compactSuggestThreshold =
        (settings.compactSuggestThreshold as number) ??
        AgentSessionService.DEFAULT_COMPACT_SUGGEST_THRESHOLD
      this.compactAutoThreshold =
        (settings.compactAutoThreshold as number) ??
        AgentSessionService.DEFAULT_COMPACT_AUTO_THRESHOLD
    }
  }

  private checkCompaction(
    inputTokens: number,
    breakdown?: import('../../shared/types').ContextUsageBreakdown
  ): void {
    const autoThreshold = this.compactAutoThreshold
    const suggestThreshold = this.compactSuggestThreshold
    const warningThreshold = Math.floor(suggestThreshold * 0.8)

    if (inputTokens >= autoThreshold) {
      this.log.warn(
        `Context very large (${inputTokens} input tokens) — prompting user to compact`
      )
      this.emit('compactNeeded', { level: 'critical', inputTokens, breakdown })
    } else if (inputTokens >= suggestThreshold && !this.compactSuggested) {
      this.compactSuggested = true
      this.log.info(`Context growing large (${inputTokens} input tokens) — suggesting compact`)
      this.emit('compactNeeded', { level: 'suggest', inputTokens, breakdown })
    } else if (inputTokens >= warningThreshold && !this.compactSuggested) {
      this.log.info(
        `[PIPELINE:compact-warning] Context approaching threshold (${inputTokens}/${suggestThreshold} tokens)`
      )
      this.emit('compactNeeded', {
        level: 'warning',
        inputTokens,
        estimatedNextCost: Math.round(inputTokens * 0.05),
        breakdown
      })
    }
  }

}
