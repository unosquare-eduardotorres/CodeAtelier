import type {
  AgentStatus,
  ConversationMode,
  ControlToolState,
  CostPreference,
  GeneralistIntent,
  HandoffBrief,
  ImageAttachment,
  PlanDetectedEvent,
  TaskPlan
} from '../../shared/types'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_IDS, MCP_TOOLS, GENERALIST_BUDGET_CAP } from '../../shared/constants'
import { generalistLogger } from '../logger'
import { AgentBaseService } from './agent-base.service'
import type { StreamChunk } from './agent-base.service'
import { SDKExecutor } from './sdk-executor'
import type { SDKExecuteResult } from './sdk-executor'
import { authProvider } from './auth-provider'
import { vectorSearchService } from './vector-search.service'
import { semanticSearchMcpService } from './semantic-search.tool'
import { codeGraphMcpService } from './code-graph.tool'
import { githubService } from './github.service'
import { memoryService } from './memory.service'
import { conversationRepository, memoryRepository, workspaceRepository } from '../db/repositories'
import { modelConfigService } from './model-config.service'
import { eventLoggerService } from './event-logger.service'
import type { ControlActionCallbacks } from './control-actions.tool'
import { intentDetector } from './intent-detector'
import { GeneralistTokenTracker } from './generalist-token-tracker'
import type { CacheEfficiencyReport } from './generalist-token-tracker'
import { GeneralistCircuitBreaker } from './generalist-circuit-breaker'
import { GeneralistMcpConfig } from './generalist-mcp-config'
import { decompositionService } from './decomposition.service'
import { RecoveryNudgeService } from './generalist-recovery-nudge'
import { GeneralistPromptAssembler } from './generalist-prompt-assembler'

// Grill regex constants and local event interfaces moved to IntentDetector (intent-detector.ts)

/**
 * Manages the generalist agent via the Agent SDK.
 *
 * Unlike the previous CLI-based implementation that spawned a long-lived
 * `claude` process with stdin/stdout pipes, the SDK-based generalist makes
 * on-demand `query()` calls with session resume for conversation continuity.
 *
 * Runs in plan mode (read-only) or build mode (can execute commands).
 */
export class GeneralistService extends AgentBaseService {
  protected readonly log = generalistLogger
  private workspacePath: string | null = null
  private workspaceId: string | null = null
  private currentConversationId: string | null = null
  private accumulatedText: string = ''
  private currentMode: ConversationMode = 'plan'
  /** Maps conversationId → SDK session_id for resume support */
  private sessionMap: Map<string, string> = new Map()

  /**
   * Token thresholds for context compaction — configurable via workspace settings.
   * Strategy 2: Lowered from 80K/150K to 50K/100K.
   * Strategy 7 (v2): Further lowered — earlier compaction prevents runaway costs.
   * Economy mode uses even lower thresholds for aggressive cost control.
   *
   * These defaults can be overridden per-workspace via settings:
   *   compactSuggestThreshold, compactAutoThreshold
   */
  private static readonly DEFAULT_COMPACT_SUGGEST_THRESHOLD = 35_000
  private static readonly DEFAULT_COMPACT_AUTO_THRESHOLD = 70_000
  private static readonly DEFAULT_COMPACT_SUGGEST_THRESHOLD_ECONOMY = 25_000
  private static readonly DEFAULT_COMPACT_AUTO_THRESHOLD_ECONOMY = 50_000
  /** Workspace-specific compaction thresholds (loaded from settings, fallback to defaults) */
  private compactSuggestThreshold: number = GeneralistService.DEFAULT_COMPACT_SUGGEST_THRESHOLD
  private compactAutoThreshold: number = GeneralistService.DEFAULT_COMPACT_AUTO_THRESHOLD
  private compactSuggested: boolean = false
  /** Tracks number of compactions in this session to avoid over-compacting */
  private compactCount: number = 0
  /** Cost preference from workspace settings — affects compaction aggressiveness */
  private costPreference: CostPreference = 'balanced'

  /** Absolute cap per interaction — aborts SDK query if exceeded (replaces old CLI MAX_INTERACTION_TIMEOUT_MS) */
  private static readonly MAX_INTERACTION_TIMEOUT_MS = 10 * 60_000 // 10 minutes

  /** AbortController for cancelling the current SDK query */
  private sdkAbortController: AbortController | null = null
  /** Reusable SDK executor instance */
  private sdkExecutor: SDKExecutor = new SDKExecutor()

  /** Extracted services for token tracking, circuit breaking, and MCP config */
  private tokenTracker = new GeneralistTokenTracker()
  private circuitBreaker = new GeneralistCircuitBreaker()
  private mcpConfig = new GeneralistMcpConfig()
  private recoveryNudge = new RecoveryNudgeService()
  private promptAssembler = new GeneralistPromptAssembler()

  /** Full system prompt — rebuilt per turn in send(). */
  private fullSystemPrompt: string = ''

  /** Whether repomap code graph is enabled for this workspace */
  private repomapEnabled: boolean = false
  /** Whether semantic search (Ollama embeddings) is enabled for this workspace */
  private semanticSearchEnabled: boolean = false
  /** Whether GitHub token is configured for this workspace */
  private githubConfigured: boolean = false
  /**
   * Strategy γ: User-controlled investigation mode.
   * When OFF, generalist always answers directly and never hands off to specialists.
   * When ON (default), normal handoff protocol applies.
   */
  private investigationModeEnabled: boolean = true

  /** Tracks which control tools fired and their intents during the current turn */
  private controlToolState: ControlToolState = {
    plan: false,
    handoff: false,
    askUser: false,
    memory: false
  }

  /**
   * Refresh feature flags from workspace settings.
   * Called on every send() so toggling Code Graph or Semantic Search
   * takes effect immediately without restarting the session.
   */
  private refreshFeatureFlags(): void {
    if (!this.workspaceId) return
    try {
      const workspace = workspaceRepository.findById(this.workspaceId)
      if (!workspace) return
      const settings = JSON.parse(workspace.settingsJson || '{}')
      this.repomapEnabled = !!settings.repomapEnabled
      this.semanticSearchEnabled = !!settings.semanticSearchEnabled
      this.githubConfigured = githubService.isConfigured(this.workspaceId)
      // Strategy γ: Investigation mode toggle — default ON (normal handoff behavior)
      this.investigationModeEnabled = settings.investigationModeEnabled !== false
    } catch {
      // Non-critical — keep existing flags
    }
  }

  /**
   * Initializes the generalist for the given workspace.
   * Unlike the CLI-based version, this does NOT spawn a process — the SDK
   * makes on-demand query() calls. The generalist is "ready" immediately.
   */
  async start(
    workspacePath: string,
    mode?: ConversationMode,
    resumeSessionId?: string
  ): Promise<void> {
    // Cancel any in-flight SDK query
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
    this.currentConversationId = null
    this.accumulatedText = ''
    this.compactCount = 0
    this.compactSuggested = false
    this.tokenTracker.resetSession()

    // Build system prompt via centralized PromptBuilder
    this.promptAssembler.resetSession()
    try {
      const allWorkspaces = workspaceRepository.findAll()
      const workspace = allWorkspaces.find((w) => w.repoPath === workspacePath)
      if (workspace) this.workspaceId = workspace.id
      const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}

      if (settings.memoryEnabled !== false && workspace) {
        // Strategy 7: Economy mode uses shorter memory context to save tokens
        const memoryBudget = settings.costPreference === 'economy' ? 5000 : 10000
        const ctx = memoryService.getContextForPrompt(workspace.id, memoryBudget)
        if (ctx) this.promptAssembler.setMemoryContext(ctx)
      }

      // Strategy 7: Load cost preference to adjust compaction thresholds
      this.costPreference = (settings.costPreference as CostPreference) || 'balanced'

      // Load configurable compaction thresholds from workspace settings (with defaults)
      if (this.costPreference === 'economy') {
        this.compactSuggestThreshold =
          settings.compactSuggestThreshold ??
          GeneralistService.DEFAULT_COMPACT_SUGGEST_THRESHOLD_ECONOMY
        this.compactAutoThreshold =
          settings.compactAutoThreshold ?? GeneralistService.DEFAULT_COMPACT_AUTO_THRESHOLD_ECONOMY
      } else {
        this.compactSuggestThreshold =
          settings.compactSuggestThreshold ?? GeneralistService.DEFAULT_COMPACT_SUGGEST_THRESHOLD
        this.compactAutoThreshold =
          settings.compactAutoThreshold ?? GeneralistService.DEFAULT_COMPACT_AUTO_THRESHOLD
      }

      // Code graph: enable repomap MCP tools if workspace setting is on
      this.repomapEnabled = !!settings.repomapEnabled
      // Semantic search: enable vector search if workspace setting is on
      this.semanticSearchEnabled = !!settings.semanticSearchEnabled
    } catch {
      // Memory context unavailable — not critical
    }

    // S17: prompt is rebuilt per turn in send() so turn-aware shrinking can apply.
    this.fullSystemPrompt = ''

    // If a resume session ID was passed, pre-populate the session map
    if (resumeSessionId && this.currentConversationId) {
      this.sessionMap.set(this.currentConversationId, resumeSessionId)
    }

    // Load auth settings for SDK
    authProvider.loadFromWorkspace(workspacePath)

    // Create DB session for token tracking (with workspaceId so dashboard queries find it)
    this.createDbSession('generalist', {
      workspaceId: this.workspaceId ?? undefined
    })

    // Log session started event
    eventLoggerService.logSessionStarted({
      agentId: AGENT_IDS.GENERALIST,
      model: modelConfigService.getModel(workspacePath, 'generalist')
    })

    this.log.info('Generalist SDK session initialized for workspace:', workspacePath)
    this.emit('statusUpdate', this.getStatus())
  }

  /**
   * Sends a message via the Agent SDK's query() async generator.
   * Each call resumes the existing session (if available) for conversation continuity.
   */
  async send(message: string, conversationId: string, images?: ImageAttachment[]): Promise<void> {
    this.validateStarted()
    this.resetForNewMessage(conversationId)

    const sessionId = this.resolveSession(conversationId)
    const hasImages = (images?.length ?? 0) > 0
    const turnCount = this.promptAssembler.incrementTurnCount(conversationId)

    const { systemPrompt, effectiveMessage } = this.preparePrompts(
      message,
      conversationId,
      hasImages,
      turnCount,
      sessionId
    )
    this.fullSystemPrompt = systemPrompt

    const sdkPrompt = this.buildSdkPrompt(effectiveMessage, images)
    const controlCallbacks = this.buildControlCallbacks()
    const mcpResult = this.mcpConfig.build({
      mode: this.currentMode,
      workspacePath: this.workspacePath!,
      workspaceId: this.workspaceId,
      conversationId: this.currentConversationId,
      featureFlags: {
        repomapEnabled: this.repomapEnabled,
        semanticSearchEnabled: this.semanticSearchEnabled,
        githubConfigured: this.githubConfigured
      },
      controlCallbacks,
      investigationModeEnabled: this.investigationModeEnabled
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

  // ── send() decomposition: private helper methods ──

  /** Validate the generalist is started before sending. */
  private validateStarted(): void {
    if (!this.workspacePath) {
      throw new Error('Generalist not started — call start() first')
    }
  }

  /** Reset per-message state and emit initial status. */
  private resetForNewMessage(conversationId: string): void {
    this.refreshFeatureFlags()
    this.log.info(
      `[PIPELINE:feature-flags] repomap=${this.repomapEnabled} semanticSearch=${this.semanticSearchEnabled}`
    )

    if (this.currentConversationId && this.currentConversationId !== conversationId) {
      this.log.info(`Conversation switch: ${this.currentConversationId} → ${conversationId}`)
    }

    this.currentStatus = 'thinking'
    this.hasEmittedContent = false
    this.messageStartedAt = Date.now()
    this.processedToolIds.clear()
    this.currentConversationId = conversationId
    this.accumulatedText = ''
    this.circuitBreaker.reset()
    this.controlToolState = { plan: false, handoff: false, askUser: false, memory: false }
    this.emit('statusUpdate', this.getStatus())
  }

  /** Look up session for resume (in-memory first, then DB). */
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

  /** Build system prompt and effective user message via PromptAssembler. */
  private preparePrompts(
    message: string,
    conversationId: string,
    hasImages: boolean,
    turnCount: number,
    sessionId: string | undefined
  ): { systemPrompt: string; effectiveMessage: string } {
    const systemPrompt = this.promptAssembler.buildSystemPromptForTurn({
      message,
      hasImages,
      turnCount,
      workspacePath: this.workspacePath!,
      workspaceId: this.workspaceId,
      conversationId: this.currentConversationId,
      mode: this.currentMode,
      featureFlags: {
        repomapEnabled: this.repomapEnabled,
        semanticSearchEnabled: this.semanticSearchEnabled,
        githubConfigured: this.githubConfigured
      },
      costPreference: this.costPreference,
      investigationModeEnabled: this.investigationModeEnabled
    })

    const effectiveMessage = this.promptAssembler.buildEffectiveMessage({
      message,
      conversationId,
      hasImages,
      turnCount,
      sessionId,
      mode: this.currentMode,
      investigationModeEnabled: this.investigationModeEnabled
    })

    return { systemPrompt, effectiveMessage }
  }

  /** Build SDK-native prompt, converting to vision format when images are present. */
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

  /** Wire control action callbacks that populate ControlToolState during streaming. */
  private buildControlCallbacks(): ControlActionCallbacks {
    return {
      onPlan: (plan) => {
        this.controlToolState.plan = true
        const planEvent: PlanDetectedEvent = {
          rawContent: JSON.stringify(plan),
          structuredPlan: plan,
          beforePlan: this.accumulatedText,
          afterPlan: ''
        }
        this.controlToolState.planIntent = { type: 'plan', plan: planEvent }
        this.log.info(`[PIPELINE:control-tool:plan] "${plan.title}" — tool-based emission`)
        this.emit('plan', planEvent)
      },
      onHandoff: (brief) => {
        this.controlToolState.handoff = true
        this.controlToolState.handoffIntent = { type: 'handoff', brief }
        this.log.info(
          `[PIPELINE:control-tool:handoff] specialists="${brief.specialists}" — tool-based emission`
        )
        this.emit('handoff', brief)
      },
      onAskUser: (questions) => {
        this.controlToolState.askUser = true
        this.controlToolState.askUserIntent = { type: 'askUser', questions }
        this.log.info(
          `[PIPELINE:control-tool:ask-user] ${questions.length} questions — tool-based emission`
        )
        this.emit('askQuestion', { questions })
      },
      onMemory: (memory) => {
        this.controlToolState.memory = true
        this.log.info(
          `[PIPELINE:control-tool:memory] type="${memory.type}" title="${memory.title}" — tool-based emission`
        )
        // Persist immediately — no need to wait for stream finalize
        try {
          const wpPath = this.getWorkspacePath()
          const allWorkspaces = wpPath ? workspaceRepository.findAll() : []
          const workspace = allWorkspaces.find((w) => w.repoPath === wpPath)
          const memWorkspaceId =
            memory.type === 'user' || memory.type === 'feedback'
              ? null
              : workspace?.id ?? null
          const conversationId = this.currentConversationId
          const mem = memoryRepository.createIfNotDuplicate({
            workspaceId: memWorkspaceId,
            type: memory.type,
            title: memory.title,
            content: memory.content,
            tags: [],
            sourceConversationId: conversationId ?? undefined,
            sourceAgentId: 'generalist',
            importance: 5
          })
          if (mem) {
            this.log.info(`Memory created via tool: [${memory.type}] ${memory.title}`)
          } else {
            this.log.info(`Memory skipped (duplicate): [${memory.type}] ${memory.title}`)
          }
        } catch (err) {
          this.log.warn('Failed to persist tool-emitted memory:', err)
        }
      }
    }
  }

  /** Core stream loop + post-stream processing (recovery, intent detection, compaction). */
  private async executeStream(opts: {
    sdkPrompt: string | AsyncIterable<SDKUserMessage>
    systemPrompt: string
    sessionId: string | undefined
    conversationId: string
    turnCount: number
    isBuildMode: boolean
    mcpResult: {
      mcpServers?: Record<string, unknown>
      allowedTools?: string[]
      disallowedTools?: string[]
    }
  }): Promise<void> {
    const {
      sdkPrompt,
      systemPrompt,
      sessionId,
      conversationId,
      turnCount,
      isBuildMode,
      mcpResult
    } = opts
    const { mcpServers, allowedTools, disallowedTools } = mcpResult
    const abortController = new AbortController()
    this.sdkAbortController = abortController

    // Start absolute interaction timeout
    let timedOut = false
    const interactionTimer = setTimeout(() => {
      timedOut = true
      this.log.error(
        `Interaction timeout after ${GeneralistService.MAX_INTERACTION_TIMEOUT_MS / 60_000} minutes — ${this.circuitBreaker.count} tool calls made`
      )
      eventLoggerService.logAgentTimeout({
        agentId: 'generalist',
        conversationId,
        elapsedMs: GeneralistService.MAX_INTERACTION_TIMEOUT_MS,
        toolCallCount: this.circuitBreaker.count
      })
      abortController.abort()
    }, GeneralistService.MAX_INTERACTION_TIMEOUT_MS)

    try {
      let handoffDetectedInStream = false
      let messageStopReceived = false
      let hasTextAfterLastTool = true

      for await (const chunk of this.sdkExecutor.execute({
        prompt: sdkPrompt,
        systemPrompt,
        model: modelConfigService.getModel(this.workspacePath!, 'generalist'),
        cwd: this.workspacePath!,
        permissionMode: isBuildMode ? 'bypassPermissions' : 'default',
        allowedTools,
        disallowedTools,
        maxTurns: isBuildMode ? 50 : 25,
        resume: sessionId,
        abortController,
        agentId: AGENT_IDS.GENERALIST,
        // Generalist: adaptive thinking + high effort (coordinator needs deep reasoning)
        thinking: { type: 'adaptive' },
        effort: 'high',
        maxBudgetUsd: GENERALIST_BUDGET_CAP,
        ...(mcpServers ? { mcpServers } : {})
      })) {
        if (this.circuitBreaker.isBroken) break

        if ('_meta' in chunk && chunk._meta) {
          messageStopReceived = true
          const meta = chunk._meta as SDKExecuteResult
          // Capture session ID for resume
          if (meta.sessionId && conversationId) {
            this.sessionMap.set(conversationId, meta.sessionId)
            this.log.info('Session captured for conversation:', conversationId)
            try {
              conversationRepository.updateSessionId(conversationId, meta.sessionId)
            } catch (err) {
              this.log.error('Failed to persist session ID:', err)
            }
          }
          // Track token usage
          const { totalTokens } = this.tokenTracker.recordTurn(meta, {
            turnCount,
            conversationId,
            dbSessionId: this.dbSessionId,
            workspacePath: this.workspacePath!
          })
          this.tokenUsage += totalTokens
          this.checkCompaction(meta.tokenUsage.input)
        } else {
          // Accumulate text for handoff/grill detection
          if (chunk.type === 'text' && chunk.content) {
            this.accumulatedText += chunk.content
            hasTextAfterLastTool = true
            if (
              intentDetector.hasHandoff(
                this.accumulatedText,
                this.currentMode,
                this.investigationModeEnabled
              )
            ) {
              handoffDetectedInStream = true
            }
          }
          // Tool call counting + circuit breaker
          if (chunk.type === 'tool_use') {
            const isControlTool = chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)
            if (isControlTool) {
              this.log.debug(`[PIPELINE:control-tool-use] ${chunk.toolName}`)
              continue
            }

            hasTextAfterLastTool = false
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
              return
            }

            this.circuitBreaker.logToolCall(conversationId, chunk.toolName ?? 'unknown')
          }
          // Update status based on chunk type
          if (chunk.type === 'text') this.currentStatus = 'writing'
          if (chunk.type === 'tool_use') this.currentStatus = 'reviewing'
          this.emit('statusUpdate', this.getStatus())
          this.emit('chunk', chunk)

          if (handoffDetectedInStream) {
            this.log.info(
              `[PIPELINE:handoff-short-circuit] conversationId=${conversationId} streamedLen=${this.accumulatedText.length}`
            )
            break
          }
        }
      }

      clearTimeout(interactionTimer)
      this.sdkAbortController = null

      // Stream termination validation
      if (!messageStopReceived && !this.circuitBreaker.isBroken && !timedOut) {
        this.log.warn(
          `[PIPELINE:stream-incomplete] Stream ended without MessageStop event for conversationId=${conversationId}`
        )
      }

      this.log.info(
        `[PIPELINE:generalist-response-complete] conversationId=${conversationId} textLen=${this.accumulatedText.length}`
      )

      // Recovery nudge for silent tool completion
      if (this.circuitBreaker.count > 0 && !hasTextAfterLastTool && !handoffDetectedInStream) {
        const recoveryResult = await this.recoveryNudge.attemptRecovery({
          sdkExecutor: this.sdkExecutor,
          systemPrompt,
          workspacePath: this.workspacePath!,
          model: modelConfigService.getModel(this.workspacePath!, 'generalist'),
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
        this.accumulatedText += recoveryResult.text
      }

      // ── Intent detection + emission ──
      this.emitDetectedIntents(conversationId, handoffDetectedInStream)

      this.currentStatus = 'idle'
      this.flushTokenUsage()
      this.emit('statusUpdate', this.getStatus())
      this.log.info(`[PIPELINE:generalist-complete-emitting] conversationId=${conversationId}`)
      this.emit('complete')
    } catch (error) {
      clearTimeout(interactionTimer)
      this.handleStreamError(error as Error, timedOut)
    }
  }

  /** Detect and emit intents from accumulated text and control tool state. */
  private emitDetectedIntents(conversationId: string, handoffDetectedInStream: boolean): void {
    const detectionState: ControlToolState = handoffDetectedInStream
      ? { ...this.controlToolState, handoff: true }
      : this.controlToolState
    const detectedIntents = intentDetector.detectAll(
      this.accumulatedText,
      detectionState,
      this.currentMode,
      this.investigationModeEnabled
    )

    for (const intent of detectedIntents) {
      this.emit('intent', intent)
    }

    if (detectedIntents.length === 0) {
      this.log.info(`[PIPELINE:response-path] no-action textLen=${this.accumulatedText.length}`)
      this.emit('intent', { type: 'response', content: this.accumulatedText } as GeneralistIntent)
    }

    // Dual-mode telemetry
    intentDetector.logDetectionPaths(
      this.accumulatedText,
      this.controlToolState,
      handoffDetectedInStream
    )

    // Post-handoff auto-compact
    const hasHandoffIntent =
      detectedIntents.some((i) => i.type === 'handoff') || handoffDetectedInStream
    if (hasHandoffIntent && this.tokenUsage > 30_000 && this.compactCount < 5) {
      this.log.info(
        `Post-handoff auto-compact scheduled (tokens: ${this.tokenUsage}, compacts: ${this.compactCount}) — delayed 120s for result injection`
      )
      setTimeout(() => this.compact(), 120_000)
    }
  }

  /** Handle errors from the stream execution — timeout, abort, or SDK failure. */
  private handleStreamError(error: Error, timedOut: boolean): void {
    this.sdkAbortController = null
    if (error.name === 'AbortError') {
      if (timedOut) {
        this.log.error('SDK query timed out')
        this.emit('chunk', {
          type: 'error',
          error: `Response exceeded maximum time (${GeneralistService.MAX_INTERACTION_TIMEOUT_MS / 60_000} minutes) after ${this.circuitBreaker.count} tool calls. The agent may be stuck. Try simplifying your request.`
        } as StreamChunk)
      } else {
        this.log.info('SDK query cancelled by user')
      }
    } else {
      this.log.error('SDK send failed:', error)
      this.emit('chunk', {
        type: 'error',
        error: `Generalist SDK error: ${error.message}`
      } as StreamChunk)
    }
    this.currentStatus = 'failed'
    this.flushTokenUsage()
    this.emit('statusUpdate', this.getStatus())
    this.emit('complete')
  }

  // ── Prompt methods moved to GeneralistPromptAssembler (generalist-prompt-assembler.ts) ──

  /**
   * Strategy A: Lazy context injection — stores context to be prepended to the next send() call.
   *
   * Previously this method fired a full SDK query() with session resume, which replayed the
   * entire conversation history (30-50K tokens on long conversations). Now we simply store
   * the context and piggyback it on the next user message at zero additional cost — the
   * session resume is already happening for the user's message.
   */
  async injectContext(context: string, conversationId: string): Promise<void> {
    if (!this.workspacePath) {
      this.log.warn('Cannot inject context — generalist not started')
      return
    }

    // Accumulate multiple injections via the assembler
    const existingSize = this.promptAssembler.getPendingContextSize(conversationId)
    this.promptAssembler.addPendingContext(conversationId, context)
    if (existingSize > 0) {
      this.log.info(
        `Appended to pending context injection for conversation ${conversationId} (${context.length} chars added, total: ${existingSize + context.length + 2} chars)`
      )
    } else {
      this.log.info(
        `Stored pending context injection for conversation ${conversationId} (${context.length} chars — will prepend to next send())`
      )
    }
  }

  /**
   * Cancels the current in-flight SDK query (if any).
   * Called from CHAT_STOP handler to abort streaming.
   */
  cancelCurrentQuery(): void {
    if (this.sdkAbortController) {
      this.sdkAbortController.abort()
      this.sdkAbortController = null
    }
  }

  /**
   * Checks input token count against compaction thresholds and emits
   * compactNeeded events or auto-triggers compaction.
   */
  /**
   * Strategy 7: Smarter compaction triggers.
   * - Only auto-compact when idle (never during active tool execution)
   * - Prefer compacting after specialist results are injected (not before)
   * - Use structured compaction via injectContext() instead of send()
   */
  private checkCompaction(inputTokens: number): void {
    const autoThreshold = this.compactAutoThreshold
    const suggestThreshold = this.compactSuggestThreshold
    // Strategy μ: Pre-compact warning threshold at 80% of suggest threshold.
    // Warns the user proactively before the next message triggers compaction.
    const warningThreshold = Math.floor(suggestThreshold * 0.8)

    if (inputTokens >= autoThreshold) {
      this.log.warn(`Context very large (${inputTokens} input tokens) — auto-compacting`)
      this.emit('compactNeeded', { level: 'critical', inputTokens })
      // Auto-trigger compaction at critical threshold. Max 5 compactions per session.
      // Strategy 7: Delay slightly to allow specialist results to be injected first.
      if (this.compactCount < 5) {
        setTimeout(() => {
          // Only compact when idle — don't interrupt active queries
          if (this.currentStatus === 'idle') {
            this.compact().catch((err) => this.log.error('Auto-compaction failed:', err))
          } else {
            this.log.info('Deferring compaction — generalist is busy')
          }
        }, 2000)
      }
    } else if (inputTokens >= suggestThreshold && !this.compactSuggested) {
      this.compactSuggested = true
      this.log.info(`Context growing large (${inputTokens} input tokens) — suggesting compact`)
      this.emit('compactNeeded', { level: 'suggest', inputTokens })
    } else if (inputTokens >= warningThreshold && !this.compactSuggested) {
      // Strategy μ: Proactive warning — inform the UI that compaction is approaching.
      // The renderer can display a non-intrusive banner:
      // "⚡ Context is getting large (~45K tokens). Your next message may include a compaction step."
      this.log.info(
        `[PIPELINE:compact-warning] Context approaching threshold (${inputTokens}/${suggestThreshold} tokens)`
      )
      this.emit('compactNeeded', {
        level: 'warning',
        inputTokens,
        estimatedNextCost: Math.round(inputTokens * 0.05) // ~5% overhead for compaction
      })
    }
  }

  // ── Detection methods moved to IntentDetector (intent-detector.ts) ──
  // ── Decomposition moved to DecompositionService (decomposition.service.ts) ──

  /**
   * @deprecated Use decompositionService.decompose() directly.
   * Preserved as a delegation wrapper for backward compatibility during migration.
   */
  async decompose(
    brief: HandoffBrief,
    conversationId: string,
    mode: ConversationMode
  ): Promise<TaskPlan> {
    if (!this.workspacePath) {
      throw new Error('Generalist not started — no workspace path set')
    }
    this.refreshFeatureFlags()
    return decompositionService.decompose(brief, conversationId, mode, {
      workspacePath: this.workspacePath,
      workspaceId: this.workspaceId,
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled
    })
  }

  /**
   * Stops the generalist — cancels any in-flight SDK query and resets state.
   * Unlike the CLI version, there is no process to kill.
   */
  async stop(): Promise<void> {
    if (this.sdkAbortController) {
      this.sdkAbortController.abort()
      this.sdkAbortController = null
    }
    // Clean up code graph MCP server
    if (this.workspaceId) codeGraphMcpService.dispose(this.workspaceId)
    this.repomapEnabled = false
    // Clean up semantic search
    if (this.semanticSearchEnabled && this.workspaceId) {
      semanticSearchMcpService.dispose(this.workspaceId)
      await vectorSearchService.dispose(this.workspaceId)
    }
    this.semanticSearchEnabled = false

    this.completeDbSession('terminated')
    this.currentStatus = 'idle'
    this.currentConversationId = null
    this.accumulatedText = ''
    this.promptAssembler.resetSession()
    // NOTE: Do NOT clear sessionMap — sessions persist so we can resume them
    this.emit('statusUpdate', this.getStatus())
  }

  getStatus(): AgentStatus {
    const isActive =
      this.currentStatus === 'thinking' ||
      this.currentStatus === 'writing' ||
      this.currentStatus === 'reviewing'

    const activeMcpTools: string[] = []
    if (this.repomapEnabled) activeMcpTools.push('code-graph')
    if (this.semanticSearchEnabled) activeMcpTools.push('semantic-search')

    return {
      agentId: AGENT_IDS.GENERALIST,
      agentType: 'generalist',
      status: this.currentStatus,
      elapsedMs: isActive && this.messageStartedAt ? Date.now() - this.messageStartedAt : 0,
      tokenUsage: this.tokenUsage,
      activeMcpTools: activeMcpTools.length > 0 ? activeMcpTools : undefined
    }
  }

  /** SDK-based generalist is running when a workspace path is set. */
  isRunning(): boolean {
    return this.workspacePath !== null
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  getCurrentConversationId(): string | null {
    return this.currentConversationId
  }

  /** Returns the streamed content accumulated so far in the current response cycle */
  getStreamedContent(): string {
    return this.accumulatedText
  }

  getMode(): ConversationMode {
    return this.currentMode
  }

  /**
   * Strategy M: Returns prompt cache efficiency metrics for dashboard display.
   * Delegates to GeneralistTokenTracker.
   */
  getCacheEfficiency(): CacheEfficiencyReport {
    return this.tokenTracker.getCacheEfficiency()
  }

  /**
   * Strategy 7: Structured compaction via injectContext() instead of send().
   *
   * Previous approach used send() which:
   * - Counted as a user turn (changed budget tier)
   * - Triggered full prompt rebuild pipeline
   * - Produced unstructured prose summaries
   *
   * New approach uses injectContext() which:
   * - Does NOT count as a user turn
   * - Does NOT rebuild the system prompt
   * - Sends a structured compaction prompt that produces a concise summary
   * - Only fires after specialist results are injected (not before)
   */
  /**
   * Strategy B: Lazy compaction — stores a compaction instruction to be prepended to the next send().
   *
   * Previously this called injectContext() which fired a full SDK query() with session resume,
   * replaying the entire conversation history (30-50K tokens). Now we store the compaction
   * instruction and piggyback it on the next user message — the compaction happens as part
   * of the normal message flow at zero additional cost.
   */
  async compact(): Promise<void> {
    if (!this.workspacePath || !this.currentConversationId) {
      throw new Error('Generalist not running — nothing to compact')
    }

    const sessionId = this.sessionMap.get(this.currentConversationId)
    if (!sessionId) {
      throw new Error('No session to compact')
    }

    this.log.info(
      `Scheduling lazy compaction (compact #${this.compactCount + 1}) — will execute on next send()`
    )
    this.compactCount++
    this.compactSuggested = false

    // Strategy μ: Smarter compaction — compress only the oldest conversation context,
    // keeping recent specialist findings and current task context verbatim.
    // This preserves recent context quality while still reducing total size.
    this.promptAssembler.setPendingCompaction(
      this.currentConversationId,
      `/compact — Before answering the user's message below, compress our conversation context:

**Instructions:**
1. Summarize ONLY the OLDER parts of our conversation (first ~50% of messages) into bullet points.
2. Keep the MOST RECENT specialist findings and current task context VERBATIM — do not summarize recent work.
3. Preserve ALL file paths, decisions, and specialist report data from the last 2-3 turns exactly.

**Summary format (terse bullet points only, omit empty categories):**
- **Decisions:** Architecture choices, approach selections
- **Current Task:** What we're actively working on
- **Files:** Important file paths referenced or modified
- **Pending:** Unresolved items or next steps
- **Specialist Findings:** Key results from investigations (preserve report data)

Then continue using this summary as your working context and answer the user's message that follows.`
    )
  }

  /** Returns the session ID for a given conversation, if captured. */
  getSessionId(conversationId: string): string | undefined {
    return this.sessionMap.get(conversationId)
  }

  /** Removes session tracking for a conversation (e.g. on delete). */
  clearSession(conversationId: string): void {
    this.sessionMap.delete(conversationId)
    this.promptAssembler.clearConversation(conversationId)
  }

  /**
   * Switches the generalist mode (plan ↔ build).
   * With SDK, this is lightweight — just rebuild the system prompt and change permissionMode.
   * No process restart needed; the next send() call uses the new settings.
   */
  async switchMode(mode: ConversationMode): Promise<void> {
    if (mode === this.currentMode) return
    if (!this.workspacePath) return

    const previousMode = this.currentMode
    this.log.info(`[PIPELINE:mode-switch] ${previousMode} → ${mode} conversationId=${this.currentConversationId}`)
    this.currentMode = mode

    // Strategy ζ: Invalidate system prompt snapshot on mode switch
    this.promptAssembler.invalidateSnapshot()

    // Flag the mode switch — the next send() will prefix the user's message with
    // mode-change context so the agent knows its permissions changed, while
    // preserving the full conversation history (session is NOT cleared).
    this.promptAssembler.setPendingModeSwitch(previousMode, mode)

    // Prompt is rebuilt on each send() turn; mode change only updates pending switch context.
  }
}

export const generalistService = new GeneralistService()
