import type {
  AgentStatus,
  BudgetTier,
  ConversationMode,
  CostPreference,
  DecomposedTask,
  GrillQuestion,
  HandoffBrief,
  ImageAttachment,
  InvestigationDepth,
  TaskPlan
} from '../../shared/types'
import type { SDKUserMessage, McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_IDS, DEFAULT_COST_PREFERENCE } from '../../shared/constants'
import { generalistLogger } from '../logger'
import { AgentBaseService } from './agent-base.service'
import type { StreamChunk } from './agent-base.service'
import { SDKExecutor } from './sdk-executor'
import type { SDKExecuteResult } from './sdk-executor'
import { authProvider } from './auth-provider'
import { PromptBuilder, promptBuilder, type GeneralistConditionalSections } from './prompt-builder'
import {
  ASK_QUESTION_PROMPT,
  CHECKPOINT_CONTEXT_GUIDANCE_PROMPT,
  DIRECT_ANSWER_BOOST_PROMPT,
  GIT_CONTEXT_GUIDANCE_PROMPT,
  GITHUB_CONTEXT_GUIDANCE_PROMPT,
  IMAGE_ATTACHMENTS_PROMPT,
  MEMORY_PROTOCOL_PROMPT,
  REPOMAP_GUIDANCE_PROMPT,
  SEMANTIC_SEARCH_GUIDANCE_PROMPT,
  TASK_CONTEXT_GUIDANCE_PROMPT
} from './default-prompts'
import { vectorSearchService } from './vector-search.service'
import { semanticSearchMcpService } from './semantic-search.tool'
import { gitContextMcpService } from './git-context.tool'
import { taskContextMcpService } from './task-context.tool'
import { checkpointContextMcpService } from './checkpoint-context.tool'
import { gitHubContextMcpService } from './github-context.tool'
import { githubService } from './github.service'
import { memoryService } from './memory.service'
import { isInvestigationIntent } from './specialist'
import {
  conversationRepository,
  conversationSpecialistRepository,
  specialistRepository,
  workspaceRepository,
  turnUsageRepository
} from '../db/repositories'
import { modelConfigService } from './model-config.service'
import { eventLoggerService } from './event-logger.service'
import { enrichTasksWithComplexity } from './complexity-scorer.service'
import { enrichFilesDiscussed } from './mcp-server.service'
import { codeGraphMcpService } from './code-graph.tool'
import { codeGraphService } from './code-graph.service'
import {
  HANDOFF_REGEX,
  parseDecompositionResult as parseDecompositionResultUtil,
  parseHandoffBlock
} from './generalist-utils'

/** Regex to detect grill-summary blocks emitted by the generalist. */
const GRILL_SUMMARY_REGEX = /```grill-summary\n([\s\S]*?)```/

/** Regex to detect grill-question blocks emitted by the generalist. */
const GRILL_QUESTION_REGEX = /```grill-question\n([\s\S]*?)```/g

/** Regex to detect ask-question blocks emitted by the generalist (general chat questions). */
const ASK_QUESTION_REGEX = /```ask-question\n([\s\S]*?)```/g

/** Regex to detect grill-evaluation blocks (new structured format with score + questions). */
const GRILL_EVAL_REGEX = /```grill-evaluation\n([\s\S]*?)```/g

interface GrillCompleteEvent {
  summary: string
  proposedTasks: Array<{ title: string; description: string }>
}

interface GrillQuestionEvent {
  questions: GrillQuestion[]
}

interface AskQuestionEvent {
  questions: GrillQuestion[]
}

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
  private currentBrief: HandoffBrief | null = null
  /** Maps conversationId → SDK session_id for resume support */
  private sessionMap: Map<string, string> = new Map()
  /** Tracks per-conversation turn count for adaptive prompt budgets. */
  private turnCountMap: Map<string, number> = new Map()

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

  /** Tool call limits — plan mode needs room for file reads + searches */
  private static readonly MAX_PLAN_TOOL_CALLS = 50
  private static readonly MAX_BUILD_TOOL_CALLS = 80

  /** Absolute cap per interaction — aborts SDK query if exceeded (replaces old CLI MAX_INTERACTION_TIMEOUT_MS) */
  private static readonly MAX_INTERACTION_TIMEOUT_MS = 10 * 60_000 // 10 minutes

  /** AbortController for cancelling the current SDK query */
  private sdkAbortController: AbortController | null = null
  /** Reusable SDK executor instance */
  private sdkExecutor: SDKExecutor = new SDKExecutor()

  /** Full system prompt — rebuilt per turn in send(). */
  private fullSystemPrompt: string = ''
  /** Memory context string, cached for switchMode() rebuilds */
  private memoryContext: string | undefined
  /** Pending mode switch — when set, the next send() prefixes the message with mode-change context */
  private pendingModeSwitch: { from: ConversationMode; to: ConversationMode } | null = null

  /**
   * Strategy A: Pending context injection — stored here and prepended to the next send() call.
   * Eliminates the expensive injectContext() SDK call that replays the entire session (30-50K tokens).
   * Maps conversationId → context string to inject.
   */
  private pendingContextInjection: Map<string, string> = new Map()

  /**
   * Strategy B: Pending compaction flag — when set, the next send() prefixes with /compact.
   * Eliminates the expensive compact() SDK call that replays the entire session (30-50K tokens).
   * Maps conversationId → compaction prompt.
   */
  private pendingCompaction: Map<string, string> = new Map()

  /**
   * Strategy M: Aggregate prompt cache statistics for dashboard.
   * Tracks cache read/creation across all turns for cache efficiency analysis.
   */
  private cacheStats = { totalInput: 0, cacheRead: 0, cacheCreation: 0, turns: 0 }

  /**
   * Strategy θ: Per-turn cost breakdown for diagnostics.
   * Tracks input/output/cache tokens per turn to identify cost hot spots.
   * Exposed via getCacheEfficiency() for the renderer cost waterfall chart.
   */
  private turnBreakdown: Array<{
    turn: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    cacheHitRate: number
    timestamp: number
  }> = []

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

  /**
   * Strategy β: Specialist roster string, built once per turn by buildPromptForTurn()
   * and injected into the user message on turn 1 only. Removed from system prompt entirely.
   */
  private specialistRoster: string | null = null

  /**
   * Strategy ζ: Cached system prompt snapshot. Rebuilt only when mode changes,
   * conversation changes, or workspace settings update. Eliminates redundant DB queries
   * + disk I/O (stat calls) on every turn.
   */
  private systemPromptSnapshot: string | null = null
  private systemPromptSnapshotMode: ConversationMode | null = null
  private systemPromptSnapshotConversationId: string | null = null

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

    // Build system prompt via centralized PromptBuilder
    this.memoryContext = undefined
    try {
      const allWorkspaces = workspaceRepository.findAll()
      const workspace = allWorkspaces.find((w) => w.repoPath === workspacePath)
      if (workspace) this.workspaceId = workspace.id
      const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}

      if (settings.memoryEnabled !== false && workspace) {
        // Strategy 7: Economy mode uses shorter memory context to save tokens
        const memoryBudget = settings.costPreference === 'economy' ? 5000 : 10000
        const ctx = memoryService.getContextForPrompt(workspace.id, memoryBudget)
        if (ctx) this.memoryContext = ctx
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
    this.turnCountMap.clear()

    // Strategy ζ: Invalidate system prompt snapshot on start
    this.systemPromptSnapshot = null
    this.systemPromptSnapshotMode = null
    this.systemPromptSnapshotConversationId = null

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
    if (!this.workspacePath) {
      throw new Error('Generalist not started — call start() first')
    }

    // Refresh feature flags so settings changes take effect immediately
    this.refreshFeatureFlags()
    this.log.info(
      `[PIPELINE:feature-flags] repomap=${this.repomapEnabled} semanticSearch=${this.semanticSearchEnabled}`
    )

    // Conversation switch: log it (SDK handles session resume seamlessly)
    if (this.currentConversationId && this.currentConversationId !== conversationId) {
      this.log.info(`Conversation switch: ${this.currentConversationId} → ${conversationId}`)
    }

    this.currentStatus = 'thinking'
    this.hasEmittedContent = false
    this.messageStartedAt = Date.now()
    this.processedToolIds.clear()
    this.currentConversationId = conversationId
    this.accumulatedText = ''
    this.toolCallCount = 0
    this.circuitBroken = false
    let hasTextAfterLastTool = true
    this.emit('statusUpdate', this.getStatus())

    // ── Strategy A: Prepend any pending context injection ──
    // This replaces the old injectContext() SDK call that replayed the entire session.
    // The context piggybacks on this send() call at zero additional cost.
    let effectiveMessage = message
    const pendingContext = this.pendingContextInjection.get(conversationId)
    if (pendingContext) {
      effectiveMessage = `[Context from prior specialist execution — use this to answer follow-up questions without re-delegating]\n\n${pendingContext}\n\n---\n\n${effectiveMessage}`
      this.pendingContextInjection.delete(conversationId)
      this.log.info(
        `[PIPELINE:lazy-inject] Prepended ${pendingContext.length} chars of specialist context to user message (saves ~30-50K tokens vs SDK replay)`
      )
    }

    // ── Strategy B: Prepend any pending compaction ──
    // This replaces the old compact() SDK call that replayed the entire session.
    const pendingCompact = this.pendingCompaction.get(conversationId)
    if (pendingCompact) {
      effectiveMessage = `${pendingCompact}\n\n---\n\n${effectiveMessage}`
      this.pendingCompaction.delete(conversationId)
      this.log.info(
        '[PIPELINE:lazy-compact] Prepended compaction instruction to user message (saves ~30-50K tokens vs SDK replay)'
      )
    }

    // If a mode switch is pending, prefix the user's message with context so the agent
    // knows its permissions changed — without clearing the session (preserves history).
    if (this.pendingModeSwitch) {
      const { from, to } = this.pendingModeSwitch
      const modeLabel = to === 'build' ? 'Build (read + execute)' : 'Plan (read-only)'
      const permissions =
        to === 'build'
          ? 'You now have full permissions to execute commands, run apps, install dependencies, and perform all operational tasks. You can also hand off code changes to specialists.'
          : 'You are now in read-only mode. You can read files, search the codebase, and provide guidance, but you cannot run commands or write files.'
      effectiveMessage = `[Mode switched from ${from} to ${to}. Mode: ${modeLabel}. ${permissions} The conversation history above is still valid — continue from where we left off.]\n\n${message}`
      this.log.info(`Mode switch context injected: ${from} → ${to}`)
      this.pendingModeSwitch = null
    }

    // Look up session for resume (in-memory first, then DB)
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

    // For resumed sessions, inject a mode indicator prefix.
    if (sessionId) {
      effectiveMessage = `[Current mode: ${this.currentMode.toUpperCase()}]\n\n${effectiveMessage}`
      this.log.info('Rules reminder injected for resumed session:', sessionId)
    }

    // S17: rebuild prompt on every turn, using adaptive budget by turn count.
    const hasImages = (images?.length ?? 0) > 0
    const turnCount = this.incrementTurnCount(conversationId)
    this.fullSystemPrompt = this.buildPromptForTurn(message, hasImages, turnCount)

    // Strategy α: Move ALL conditional sections to user prompt prefix.
    // This makes the system prompt 100% deterministic per mode — every turn after the first
    // gets a 90% cache discount (~630-900 tokens saved). The conditionals (ASK_QUESTION,
    // MEMORY_PROTOCOL, IMAGE_ATTACHMENTS, DIRECT_ANSWER_BOOST) now live in the user message
    // where they can toggle freely without breaking the system prompt cache.
    const conditionalPrefix = this.buildConditionalPrefix(message, hasImages)
    if (conditionalPrefix) {
      effectiveMessage = `${conditionalPrefix}\n\n---\n\n${effectiveMessage}`
    }

    // Strategy β: Inject specialist roster on turn 1 only — already in history on turns 2+.
    // This removes ~400 tokens of static overhead from the system prompt on every turn.
    if (turnCount <= 1 && this.specialistRoster) {
      effectiveMessage = `${this.specialistRoster}\n\n---\n\n${effectiveMessage}`
    }

    // Strategy C: Inject memory context into user prompt (not system prompt).
    // buildPromptForTurn() refreshes this.memoryContext but no longer puts it in the system prompt.
    // This keeps the system prompt stable across turns for prompt cache hits (~90% discount).
    if (this.memoryContext) {
      effectiveMessage = `## Auto Memory\n\n${this.memoryContext}\n\n---\n\n${effectiveMessage}`
    }

    const isBuildMode = this.currentMode === 'build'
    const abortController = new AbortController()
    this.sdkAbortController = abortController

    // Start absolute interaction timeout — aborts SDK query after 10 minutes
    let timedOut = false
    const interactionTimer = setTimeout(() => {
      timedOut = true
      this.log.error(
        `Interaction timeout after ${GeneralistService.MAX_INTERACTION_TIMEOUT_MS / 60_000} minutes — ${this.toolCallCount} tool calls made`
      )
      eventLoggerService.logAgentTimeout({
        agentId: 'generalist',
        conversationId,
        elapsedMs: GeneralistService.MAX_INTERACTION_TIMEOUT_MS,
        toolCallCount: this.toolCallCount
      })
      abortController.abort()
    }, GeneralistService.MAX_INTERACTION_TIMEOUT_MS)

    try {
      // Build SDK-native prompt with image content blocks when images are present
      let sdkPrompt: string | AsyncIterable<SDKUserMessage> = effectiveMessage

      if (images && images.length > 0) {
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
        sdkPrompt = singleMessage()
        this.log.info(`Built SDK vision prompt with ${images.length} image(s)`)
      }

      let handoffDetectedInStream = false
      /** Stream termination validation — tracks whether the SDK emitted a proper completion signal */
      let messageStopReceived = false
      for await (const chunk of this.sdkExecutor.execute({
        prompt: sdkPrompt,
        // Always send system prompt — ensures prompt updates propagate to resumed sessions
        systemPrompt: this.fullSystemPrompt,
        model: modelConfigService.getModel(this.workspacePath, 'generalist'),
        cwd: this.workspacePath,
        permissionMode: isBuildMode ? 'bypassPermissions' : 'default',
        allowedTools: isBuildMode
          ? undefined
          : [
              'Read',
              'Glob',
              'Grep',
              'WebSearch',
              'WebFetch',
              // Existing MCP tools
              ...(this.repomapEnabled && this.workspaceId
                ? ['mcp__code-graph__repo_map', 'mcp__code-graph__search_identifiers']
                : []),
              ...(this.semanticSearchEnabled && this.workspaceId
                ? ['mcp__semantic-search__semantic_search']
                : []),
              // Git context (always available)
              'mcp__git-context__git_log',
              'mcp__git-context__git_diff',
              'mcp__git-context__git_blame',
              // Task context (always available — no-ops gracefully if no active plan)
              'mcp__task-context__list_tasks',
              'mcp__task-context__get_task_output',
              // Checkpoint context
              'mcp__checkpoint-context__list_checkpoints',
              'mcp__checkpoint-context__get_checkpoint',
              // GitHub context (conditional on token)
              ...(this.githubConfigured
                ? [
                    'mcp__github-context__get_pr_status',
                    'mcp__github-context__list_pr_comments',
                    'mcp__github-context__list_issues'
                  ]
                : [])
            ],
        // Plan mode: block write tools AND SDK built-in tools that conflict with our ````plan UI
        disallowedTools: isBuildMode
          ? ['Agent'] // Force handoff protocol — all code work goes through specialist-pool
          : ['Write', 'Edit', 'ExitPlanMode', 'ToolSearch'],
        maxTurns: isBuildMode ? 50 : 25,
        resume: sessionId,
        abortController,
        agentId: AGENT_IDS.GENERALIST,
        // MCP tools: expose all configured servers to the generalist
        ...(() => {
          const servers: Record<string, McpServerConfig> = {}
          // Existing: code graph + semantic search (conditional)
          if (this.repomapEnabled && this.workspaceId)
            Object.assign(
              servers,
              codeGraphMcpService.getMcpServersConfig(this.workspaceId, this.workspacePath!)
            )
          if (this.semanticSearchEnabled && this.workspaceId)
            Object.assign(servers, semanticSearchMcpService.getMcpServersConfig(this.workspaceId))
          // Git context: always on
          Object.assign(servers, gitContextMcpService.getMcpServersConfig(this.workspacePath!))
          // Task + checkpoint context: conversation-scoped
          if (this.currentConversationId) {
            Object.assign(
              servers,
              taskContextMcpService.getMcpServersConfig(
                this.currentConversationId,
                this.workspacePath!
              )
            )
            Object.assign(
              servers,
              checkpointContextMcpService.getMcpServersConfig(this.currentConversationId)
            )
          }
          // GitHub context: conditional on token
          if (this.githubConfigured && this.workspaceId)
            Object.assign(
              servers,
              gitHubContextMcpService.getMcpServersConfig(this.workspaceId, this.workspacePath!)
            )
          return Object.keys(servers).length > 0 ? { mcpServers: servers } : {}
        })()
      })) {
        // Circuit breaker check
        if (this.circuitBroken) break

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
          // Track token usage + compaction logic
          this.tokenUsage += meta.tokenUsage.input + meta.tokenUsage.output
          // S8 + Strategy M: Log and aggregate prompt cache effectiveness
          const { cacheReadInputTokens, cacheCreationInputTokens } = meta.tokenUsage
          if (cacheReadInputTokens > 0 || cacheCreationInputTokens > 0) {
            const totalInput =
              meta.tokenUsage.input + cacheReadInputTokens + cacheCreationInputTokens
            const cacheHitRate = totalInput > 0 ? (cacheReadInputTokens / totalInput) * 100 : 0
            this.log.info(
              `[PIPELINE:prompt-cache] read=${cacheReadInputTokens} creation=${cacheCreationInputTokens} hitRate=${cacheHitRate.toFixed(1)}%`
            )
          }
          // Strategy M: Accumulate cache stats for dashboard
          this.cacheStats.totalInput += meta.tokenUsage.input
          this.cacheStats.cacheRead += cacheReadInputTokens
          this.cacheStats.cacheCreation += cacheCreationInputTokens
          this.cacheStats.turns++

          // Strategy θ: Per-turn cost breakdown for diagnostics
          const totalInputForRate =
            meta.tokenUsage.input + cacheReadInputTokens + cacheCreationInputTokens
          this.turnBreakdown.push({
            turn: turnCount,
            inputTokens: meta.tokenUsage.input,
            outputTokens: meta.tokenUsage.output,
            cacheReadTokens: cacheReadInputTokens,
            cacheCreationTokens: cacheCreationInputTokens,
            cacheHitRate:
              totalInputForRate > 0 ? (cacheReadInputTokens / totalInputForRate) * 100 : 0,
            timestamp: Date.now()
          })

          // Per-turn token breakdown storage — enables cost debugging and cache rate trends
          if (this.dbSessionId && conversationId) {
            try {
              const previousTurn = turnUsageRepository.getLastTurn(conversationId)
              turnUsageRepository.record({
                sessionId: this.dbSessionId,
                conversationId,
                turnNumber: turnCount,
                inputTokens: meta.tokenUsage.input,
                outputTokens: meta.tokenUsage.output,
                cacheReadTokens: cacheReadInputTokens,
                cacheCreationTokens: cacheCreationInputTokens,
                model: modelConfigService.getModel(this.workspacePath!, 'generalist')
              })
              // Token growth rate alert — warn if input tokens spiked >30%
              if (previousTurn && previousTurn.inputTokens > 0) {
                const growthRate =
                  (meta.tokenUsage.input - previousTurn.inputTokens) / previousTurn.inputTokens
                if (growthRate > 0.3) {
                  this.log.warn(
                    `[PIPELINE:token-spike] ${(growthRate * 100).toFixed(0)}% input growth (${previousTurn.inputTokens} → ${meta.tokenUsage.input}) — possible context explosion`
                  )
                }
              }
            } catch (err) {
              this.log.error('Failed to record turn usage:', err)
            }
          }

          this.checkCompaction(meta.tokenUsage.input)
        } else {
          // Accumulate text for handoff/grill detection
          if (chunk.type === 'text' && chunk.content) {
            this.accumulatedText += chunk.content
            hasTextAfterLastTool = true
            if (this.detectHandoff()) {
              handoffDetectedInStream = true
            }
          }
          // Tool call counting + circuit breaker
          if (chunk.type === 'tool_use') {
            hasTextAfterLastTool = false
            this.toolCallCount++

            // Soft warning at 5 tool calls — approaching prompt-stated target
            if (this.toolCallCount === 5 && isBuildMode) {
              this.log.warn(
                `[PIPELINE:tool-limit-warning] conversationId=${conversationId} — 5 tool calls reached, approaching limit`
              )
            }
            // Hard limit warning at 8 — prompt-stated HARD LIMIT exceeded
            if (this.toolCallCount === 8 && isBuildMode) {
              this.log.warn(
                `[PIPELINE:tool-limit-reached] conversationId=${conversationId} — 8 tool calls, prompt hard limit exceeded`
              )
            }

            const toolCallLimit = isBuildMode
              ? GeneralistService.MAX_BUILD_TOOL_CALLS
              : GeneralistService.MAX_PLAN_TOOL_CALLS
            if (this.toolCallCount >= toolCallLimit) {
              this.circuitBroken = true
              this.log.error(
                `Generalist circuit breaker: ${this.toolCallCount} tool calls exceeded ${isBuildMode ? 'build' : 'plan'} limit of ${toolCallLimit}`
              )
              this.currentStatus = 'failed'
              this.emit('statusUpdate', this.getStatus())
              const errorMessage = isBuildMode
                ? `I made ${this.toolCallCount} tool calls, which suggests I got stuck. Try breaking your request into smaller steps (e.g., "run npm install" then "run npm start").`
                : `I made ${this.toolCallCount} tool calls trying to help, which is more than expected for plan mode. If you need me to run commands, switch to **Build mode** using the toggle in the chat header.`
              this.emit('chunk', {
                type: 'error',
                error: errorMessage
              } as StreamChunk)
              this.emit('complete')
              return
            }
            // Log tool call to event log
            eventLoggerService.logAgentToolCall({
              agentId: 'generalist',
              conversationId,
              toolName: chunk.toolName ?? 'unknown',
              toolCallNumber: this.toolCallCount
            })
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

      // Stream termination validation — warn if stream ended without proper completion
      if (!messageStopReceived && !this.circuitBroken && !timedOut) {
        this.log.warn(
          `[PIPELINE:stream-incomplete] Stream ended without MessageStop event for conversationId=${conversationId}`
        )
      }

      this.log.info(
        `[PIPELINE:generalist-response-complete] conversationId=${conversationId} textLen=${this.accumulatedText.length}`
      )

      // Guardrail: if tools were used but model didn't produce follow-up text,
      // inject a synthetic feedback message so the user isn't left without feedback.
      // Skip if handoff was detected (handoff responses don't need post-tool text).
      if (this.toolCallCount > 0 && !hasTextAfterLastTool && !handoffDetectedInStream) {
        const fallbackMessage =
          this.toolCallCount === 1
            ? '\n\n_I read a file but my response was cut short. Could you repeat your question?_'
            : `\n\n_I used ${this.toolCallCount} tools but didn't produce a summary. Try rephrasing or asking what I found._`
        this.log.warn(
          `[PIPELINE:silent-tool-completion] conversationId=${conversationId} toolCalls=${this.toolCallCount} — injecting fallback message`
        )
        this.accumulatedText += fallbackMessage
        this.emit('chunk', {
          type: 'text',
          content: fallbackMessage
        } as StreamChunk)
      }

      // Detect control blocks in accumulated text. Handoff is detected in-stream to reduce latency.
      if (!handoffDetectedInStream) {
        this.detectHandoff()
      }
      this.detectGrillSummary()
      this.detectGrillEvaluation()
      this.detectGrillQuestion()
      this.detectAskQuestion()

      this.currentStatus = 'idle'
      this.flushTokenUsage()
      this.emit('statusUpdate', this.getStatus())
      this.log.info(`[PIPELINE:generalist-complete-emitting] conversationId=${conversationId}`)
      this.emit('complete')
    } catch (error) {
      clearTimeout(interactionTimer)
      this.sdkAbortController = null
      if ((error as Error).name === 'AbortError') {
        if (timedOut) {
          this.log.error('SDK query timed out')
          this.emit('chunk', {
            type: 'error',
            error: `Response exceeded maximum time (${GeneralistService.MAX_INTERACTION_TIMEOUT_MS / 60_000} minutes) after ${this.toolCallCount} tool calls. The agent may be stuck. Try simplifying your request.`
          } as StreamChunk)
        } else {
          this.log.info('SDK query cancelled by user')
        }
      } else {
        this.log.error('SDK send failed:', error)
        this.emit('chunk', {
          type: 'error',
          error: `Generalist SDK error: ${(error as Error).message}`
        } as StreamChunk)
      }
      this.currentStatus = 'failed'
      this.flushTokenUsage()
      this.emit('statusUpdate', this.getStatus())
      this.emit('complete')
    }
  }

  private incrementTurnCount(conversationId: string): number {
    const nextTurn = (this.turnCountMap.get(conversationId) ?? 0) + 1
    this.turnCountMap.set(conversationId, nextTurn)
    return nextTurn
  }

  /**
   * Scale memory budget by turn count.
   * Turn 1: full budget (memory is fresh context). Turn 3+: reduced (already in history). Turn 6+: zero.
   * Strategy S3: saves ~429 tokens on late turns.
   */
  private getMemoryBudgetForTurn(turnCount: number): number {
    if (this.costPreference === 'economy') {
      return turnCount <= 1 ? 3000 : turnCount <= 3 ? 1000 : 0
    }
    return turnCount <= 1 ? 5000 : turnCount <= 3 ? 2000 : 0
  }

  /**
   * Builds the generalist system prompt for the current turn using:
   * 1) DB-backed base prompt via PromptBuilder
   * 2) adaptive budget tier by turn count
   * 3) optional conditional sections appended after base prompt resolution
   */
  private buildPromptForTurn(message: string, hasImages: boolean, turnCount: number): string {
    if (!this.workspacePath) return this.fullSystemPrompt

    // Strategy C: Memory context is now injected into the user prompt (not system prompt).
    // This keeps the system prompt identical across turns → Claude prompt caching gives
    // a 90% discount on the entire system prompt after the first turn (~1,350 tokens/turn saved).
    // Memory is still refreshed per turn — it just lives in a different location.
    if (this.workspaceId) {
      const memoryBudget = this.getMemoryBudgetForTurn(turnCount)
      try {
        const memoryContextForTurn = memoryService.getContextForPrompt(
          this.workspaceId,
          memoryBudget,
          message
        )
        this.memoryContext = memoryContextForTurn || undefined
      } catch (error) {
        this.log.warn('Failed to refresh filtered memory context; using cached context', error)
      }
    }

    // Strategy ζ: System prompt snapshot — reuse cached prompt when mode + conversation
    // haven't changed. Eliminates DB queries + disk I/O on every turn.
    // The snapshot is invalidated on mode switches and conversation changes.
    const canReuseSnapshot =
      this.systemPromptSnapshot &&
      this.systemPromptSnapshotMode === this.currentMode &&
      this.systemPromptSnapshotConversationId === this.currentConversationId &&
      turnCount > 1 // Always rebuild on turn 1 to pick up latest settings

    const budgetTier = promptBuilder.getGeneralistBudgetTierForTurn(turnCount)
    let promptWithMcpGuidance: string
    if (canReuseSnapshot) {
      promptWithMcpGuidance = this.systemPromptSnapshot!
      this.log.info(
        `[PIPELINE:prompt-snapshot] Reusing cached system prompt (turn ${turnCount}, mode=${this.currentMode})`
      )
    } else {
      const basePrompt = promptBuilder.build({
        role: 'generalist',
        mode: this.currentMode,
        workspacePath: this.workspacePath,
        // Strategy C: memoryContext is NO LONGER passed here — it goes into the user prompt
        // via the effectiveMessage prefix in send(). The system prompt stays stable for caching.
        budgetTier
      })

      // Strategy α: Conditional sections (ASK_QUESTION, MEMORY_PROTOCOL, IMAGE_ATTACHMENTS,
      // DIRECT_ANSWER_BOOST) are NO LONGER appended to the system prompt. They are now injected
      // into the user message prefix via buildConditionalPrefix() in send().
      // This makes the system prompt deterministic per mode → 90% cache discount on every turn.
      //
      // MCP tool guidance sections are still appended here on turn 1 only (Strategy δ),
      // since they are workspace-stable and don't toggle between turns.
      promptWithMcpGuidance = this.appendMcpToolGuidance(basePrompt, turnCount)

      // Cache the snapshot for reuse on subsequent turns
      this.systemPromptSnapshot = promptWithMcpGuidance
      this.systemPromptSnapshotMode = this.currentMode
      this.systemPromptSnapshotConversationId = this.currentConversationId
    }

    // Strategy β: Specialist roster is now injected into the user prompt on turn 1 only.
    // On turn 2+, the roster is already in conversation history. This removes ~400 tokens
    // of static overhead from the system prompt on every turn.
    // The roster is built and stored in this.specialistRoster for the user prefix in send().
    this.specialistRoster = this.buildSpecialistRoster()

    this.log.info(
      `[PIPELINE:prompt-adaptive] conversationId=${this.currentConversationId} turn=${turnCount} budget=${budgetTier} rosterSize=${this.specialistRoster ? this.specialistRoster.split('\n').length : 0}`
    )

    // S8: Prompt size check — warn if approaching model context limits
    // TODO: Wire up actual model tier resolution from modelConfigService instead of defaulting to 'sonnet'
    const sizeCheck = PromptBuilder.checkPromptSize(promptWithMcpGuidance, message, 'sonnet')
    if (sizeCheck.warning) {
      this.log.warn(
        `[PIPELINE:prompt-size] conversationId=${this.currentConversationId} turn=${turnCount} ${sizeCheck.warning}`
      )
    }

    return promptWithMcpGuidance
  }

  /**
   * Strategy α: Build a conditional prefix for the user message.
   * These sections (ASK_QUESTION, MEMORY_PROTOCOL, IMAGE_ATTACHMENTS, DIRECT_ANSWER_BOOST)
   * toggle based on the user's message content. Moving them to the user prompt prefix
   * makes the system prompt 100% deterministic per mode → 90% cache discount on every turn.
   */
  private buildConditionalPrefix(message: string, hasImages: boolean): string {
    const conditionalSections = promptBuilder.getGeneralistConditionalSections(message, hasImages)
    const sections: string[] = []

    if (conditionalSections.includeAskQuestionPrompt) {
      sections.push(ASK_QUESTION_PROMPT)
    }

    if (conditionalSections.includeMemoryProtocolPrompt) {
      sections.push(MEMORY_PROTOCOL_PROMPT)
    }

    if (conditionalSections.includeImageAttachmentsPrompt) {
      sections.push(IMAGE_ATTACHMENTS_PROMPT)
    }

    // Strategy N: Direct Answer Boost — nudge generalist to answer directly for simple questions
    if (conditionalSections.includeDirectAnswerBoost) {
      sections.push(DIRECT_ANSWER_BOOST_PROMPT)
    }

    // Strategy γ: When investigation mode is OFF, inject NO HANDOFF directive.
    // The generalist must answer everything directly — no specialist delegation.
    // Saves 5-12K tokens per question that would otherwise trigger a handoff.
    if (!this.investigationModeEnabled) {
      sections.push(
        `## NO HANDOFF MODE (Investigation Mode OFF)\n\n` +
        `Do NOT hand off to specialists. Answer everything directly using your own tool access.\n` +
        `If you need to read files, do it yourself. Target ≤5 tool calls.\n` +
        `If you genuinely cannot answer after reading 3-5 files, tell the user:\n` +
        `"I couldn't fully answer this — enable Investigation Mode in settings for a deeper specialist analysis."`
      )
    }

    this.log.info(
      `[PIPELINE:conditional-prefix] ask=${conditionalSections.includeAskQuestionPrompt} memory=${conditionalSections.includeMemoryProtocolPrompt} image=${conditionalSections.includeImageAttachmentsPrompt} directBoost=${conditionalSections.includeDirectAnswerBoost} investigationMode=${this.investigationModeEnabled}`
    )

    return sections.length > 0 ? `[Contextual guidelines for this message]\n\n${sections.join('\n\n')}` : ''
  }

  /**
   * Strategy δ: Append MCP tool guidance sections to system prompt — turn 1 only.
   * These are workspace-stable (don't toggle between turns) so they are safe in the system prompt.
   * On turns 2+, the guidance is already in conversation history from turn 1.
   */
  private appendMcpToolGuidance(basePrompt: string, turnCount: number): string {
    // Strategy δ: Only inject MCP guidance on turn 1. On turns 2+, guidance is in history.
    if (turnCount > 1) return basePrompt

    const appendSections: string[] = []

    // Code graph: inject repomap tool guidance when enabled
    if (this.repomapEnabled && !basePrompt.includes('## Code Graph Tools')) {
      appendSections.push(REPOMAP_GUIDANCE_PROMPT)
    }

    // Semantic search: inject tool guidance when enabled
    if (this.semanticSearchEnabled && !basePrompt.includes('## Semantic Search')) {
      appendSections.push(SEMANTIC_SEARCH_GUIDANCE_PROMPT)
    }

    // Git context: always inject guidance
    if (!basePrompt.includes('## Git Context Tools')) {
      appendSections.push(GIT_CONTEXT_GUIDANCE_PROMPT)
    }

    // Task context: inject when in multi-task plan
    if (this.currentConversationId && !basePrompt.includes('## Task Context Tools')) {
      appendSections.push(TASK_CONTEXT_GUIDANCE_PROMPT)
    }

    // Checkpoint context: inject guidance
    if (!basePrompt.includes('## Checkpoint Tools')) {
      appendSections.push(CHECKPOINT_CONTEXT_GUIDANCE_PROMPT)
    }

    // GitHub context: conditional on token
    if (this.githubConfigured && !basePrompt.includes('## GitHub Tools')) {
      appendSections.push(GITHUB_CONTEXT_GUIDANCE_PROMPT)
    }

    if (appendSections.length === 0) return basePrompt
    return `${basePrompt}\n\n---\n\n${appendSections.join('\n\n---\n\n')}`
  }

  /**
   * Strategy β: Build specialist roster string for user prompt injection.
   * Returns the roster with compressed format (IDs only), or null if no specialists.
   */
  private buildSpecialistRoster(): string | null {
    let activeSpecialists = specialistRepository.findActive()

    if (this.currentConversationId) {
      const overrides = conversationSpecialistRepository.findByConversation(this.currentConversationId)
      if (overrides.length > 0) {
        const activeSpecialistIds = new Set(
          overrides.filter((o) => o.isActive).map((o) => o.specialistId)
        )
        activeSpecialists = activeSpecialists.filter((s) => activeSpecialistIds.has(s.id))
      }
    }

    const nonCoreSpecialists = activeSpecialists.filter(
      (s) => !['generalist', 'generalist-agent', 'user'].includes(s.agentId)
    )

    if (nonCoreSpecialists.length === 0) return null

    // Compressed format: IDs only — saves ~200 tokens vs full descriptions.
    // The generalist already knows specialist capabilities from CLAUDE.md.
    return `Available specialists: ${nonCoreSpecialists.map((s) => s.agentId).join(', ')}`
  }

  /**
   * Strategy A: Lazy context injection — stores context to be prepended to the next send() call.
   *
   * Previously this method fired a full SDK query() with session resume, which replayed the
   * entire conversation history (30-50K tokens on long conversations). Now we simply store
   * the context and piggyback it on the next user message at zero additional cost — the
   * session resume is already happening for the user's message.
   *
   * The context is prepended as a clearly-delimited block so the generalist can distinguish
   * it from the user's actual message.
   */
  async injectContext(context: string, conversationId: string): Promise<void> {
    if (!this.workspacePath) {
      this.log.warn('Cannot inject context — generalist not started')
      return
    }

    // Accumulate multiple injections (e.g. multi-specialist results) — they'll all
    // be prepended together on the next send().
    const existing = this.pendingContextInjection.get(conversationId)
    if (existing) {
      this.pendingContextInjection.set(conversationId, `${existing}\n\n${context}`)
      this.log.info(
        `Appended to pending context injection for conversation ${conversationId} (${context.length} chars added, total: ${existing.length + context.length + 2} chars)`
      )
    } else {
      this.pendingContextInjection.set(conversationId, context)
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

  /**
   * Checks the accumulated response text for a handoff block and emits a `handoff` event if found.
   * Parses the enriched HandoffBrief format with decisions, constraints, and files discussed.
   * Falls back gracefully if only the legacy { summary, specialists, mode } fields are present.
   */
  private detectHandoff(): boolean {
    // Strategy γ: When investigation mode is OFF, ignore handoff blocks entirely.
    // The generalist should answer directly — any handoff blocks are stale LLM behavior.
    if (!this.investigationModeEnabled) {
      return false
    }

    const match = this.accumulatedText.match(HANDOFF_REGEX)
    if (!match) return false

    let handoffData: { mode?: unknown; summary?: unknown } | null = null
    try {
      handoffData = JSON.parse(match[1].trim()) as { mode?: unknown; summary?: unknown }
    } catch (error) {
      this.log.error('Failed to parse handoff block:', error)
      return false
    }

    const brief = parseHandoffBlock(this.accumulatedText)
    if (!brief) return false

    // Log when Da Vinci sends mode=build — conversation DB mode is the source of truth
    if (handoffData.mode === 'build') {
      this.log.info('[PIPELINE:mode-detected] Da Vinci sent mode=build — will use conversation mode as source of truth')
    }

    // Log summary rewrite safety net
    if (typeof handoffData.summary === 'string' && handoffData.summary !== brief.summary) {
      this.log.warn(`[PIPELINE:summary-rewrite] "${handoffData.summary}" → "${brief.summary}"`)
    }

    this.log.info('Handoff detected:', {
      summary: brief.summary,
      decisions: brief.decisions.length,
      constraints: brief.constraints.length,
      filesDiscussed: brief.filesDiscussed.length,
      specialists: brief.specialists
    })
    this.log.info(
      `[PIPELINE:handoff-detected] specialists=${brief.specialists.join(',')} mode=${brief.mode}`
    )
    this.emit('handoff', brief)
    this.log.info(`[PIPELINE:handoff-emitted] conversationId=${this.currentConversationId}`)

    // Strategy 2: Post-handoff auto-compact — delay until specialist results
    // have been injected back. The specialist execution takes at minimum 30s,
    // so 120s gives enough buffer for context injection before compaction.
    if (this.tokenUsage > 30_000 && this.compactCount < 5) {
      this.log.info(
        `Post-handoff auto-compact scheduled (tokens: ${this.tokenUsage}, compacts: ${this.compactCount}) — delayed 120s for result injection`
      )
      setTimeout(() => this.compact(), 120_000)
    }

    return true
  }

  /**
   * Checks the accumulated response text for a grill-summary block and emits a `grillComplete` event if found.
   */
  private detectGrillSummary(): void {
    const match = this.accumulatedText.match(GRILL_SUMMARY_REGEX)
    if (!match) return

    try {
      const data = JSON.parse(match[1].trim())
      if (data.summary) {
        const grillEvent: GrillCompleteEvent = {
          summary: data.summary,
          proposedTasks: Array.isArray(data.proposedTasks) ? data.proposedTasks : []
        }
        this.log.info('Grill summary detected:', grillEvent)
        this.emit('grillComplete', grillEvent)
      }
    } catch (error) {
      this.log.error('Failed to parse grill-summary block:', error)
    }
  }

  /**
   * Checks the accumulated response text for grill-question blocks and emits a `grillQuestion` event if found.
   */
  private detectGrillQuestion(): void {
    const matches = [...this.accumulatedText.matchAll(GRILL_QUESTION_REGEX)]
    if (matches.length === 0) return

    const allQuestions: GrillQuestion[] = []
    for (const match of matches) {
      try {
        const data = JSON.parse(match[1].trim())
        if (data.questions && Array.isArray(data.questions)) {
          allQuestions.push(...data.questions)
        }
      } catch (error) {
        this.log.error('Failed to parse grill-question block:', error)
      }
    }

    if (allQuestions.length > 0) {
      this.log.info(`Grill questions detected: ${allQuestions.length} questions`)
      this.emit('grillQuestion', { questions: allQuestions } as GrillQuestionEvent)
    }
  }

  /**
   * Checks the accumulated response text for ask-question blocks and emits an `askQuestion` event if found.
   * Used for general chat clarifying questions (outside of Grill sessions).
   */
  private detectAskQuestion(): void {
    const matches = [...this.accumulatedText.matchAll(ASK_QUESTION_REGEX)]
    if (matches.length === 0) return

    const allQuestions: GrillQuestion[] = []
    for (const match of matches) {
      try {
        const data = JSON.parse(match[1].trim())
        if (data.questions && Array.isArray(data.questions)) {
          allQuestions.push(...data.questions)
        }
      } catch (error) {
        this.log.error('Failed to parse ask-question block:', error)
      }
    }

    if (allQuestions.length > 0) {
      this.log.info(`Ask-question detected: ${allQuestions.length} questions`)
      this.emit('askQuestion', { questions: allQuestions } as AskQuestionEvent)
    }
  }

  /**
   * Checks the accumulated response text for grill-evaluation blocks (new structured format)
   * and emits a `grillEvaluation` event if found. Contains score + feedback + questions.
   */
  private detectGrillEvaluation(): void {
    const matches = [...this.accumulatedText.matchAll(GRILL_EVAL_REGEX)]
    if (matches.length === 0) return

    for (const match of matches) {
      try {
        const data = JSON.parse(match[1].trim())
        if (typeof data.score === 'number' && Array.isArray(data.questions)) {
          this.log.info(
            `Grill evaluation detected: score=${data.score}, questions=${data.questions.length}`
          )
          this.emit('grillEvaluation', {
            trackId: data.trackId ?? undefined,
            score: data.score,
            scoreLabel: data.scoreLabel ?? '',
            feedback: data.feedback ?? '',
            questions: data.questions,
            suggestedNextTrack: data.suggestedNextTrack ?? undefined
          })
        }
      } catch (error) {
        this.log.error('Failed to parse grill-evaluation block:', error)
      }
    }
  }

  async decompose(
    brief: HandoffBrief,
    conversationId: string,
    mode: ConversationMode
  ): Promise<TaskPlan> {
    if (!this.workspacePath) {
      throw new Error('Generalist not started — no workspace path set')
    }

    // Refresh feature flags so settings changes take effect immediately
    this.refreshFeatureFlags()

    // ── Code Graph + Semantic Search: enrich filesDiscussed ──
    if (this.repomapEnabled || this.semanticSearchEnabled) {
      try {
        const sources: { source: string; files: string[]; priority: number }[] = [
          { source: 'generalist', files: brief.filesDiscussed, priority: 0 }
        ]

        if (this.repomapEnabled && this.workspaceId) {
          const repomapFiles = await codeGraphService.getTopRankedFiles(
            this.workspaceId,
            brief.filesDiscussed,
            50
          )
          if (repomapFiles.length > 0) {
            sources.push({ source: 'repomap', files: repomapFiles, priority: 1 })
          }
        }

        if (this.semanticSearchEnabled && this.workspaceId) {
          try {
            const semanticResults = await vectorSearchService.search(
              this.workspaceId,
              brief.summary,
              { nResults: 10 }
            )
            if (semanticResults.length > 0) {
              const semanticFiles = semanticResults.map((r) => r.filePath)
              sources.push({ source: 'semantic', files: semanticFiles, priority: 2 })
            }
          } catch (semanticError) {
            this.log.warn(
              '[PIPELINE:semantic-enrich] Failed — skipping semantic enrichment:',
              semanticError
            )
          }
        }

        if (sources.length > 1) {
          const originalCount = brief.filesDiscussed.length
          const { files, contributions } = enrichFilesDiscussed(sources)
          brief.filesDiscussed = files
          const contribStr = Object.entries(contributions)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')
          this.log.info(
            `[PIPELINE:file-enrich] ${originalCount} → ${files.length} files (${contribStr})`
          )
        }
      } catch (error) {
        this.log.warn('[PIPELINE:file-enrich] Failed — using original filesDiscussed:', error)
      }
    }

    // ── FAST PATH: single specialist → skip decomposition LLM call entirely ──
    // When the handoff names exactly 1 specialist, decomposition is a no-op
    // (it would just return 1 task). Save ~2K tokens + 3-5s latency.
    if (brief.specialists.length === 1) {
      this.log.info(
        `Single-specialist fast path: skipping decomposition for ${brief.specialists[0]}`
      )

      const isInvestigation = mode === 'plan' || isInvestigationIntent(brief.summary)

      const description = isInvestigation
        ? `${brief.summary} Produce a structured investigation report.`
        : brief.summary

      const syntheticTask: DecomposedTask = {
        id: 't1',
        specialist: brief.specialists[0],
        description,
        dependsOn: [],
        verificationCommand: isInvestigation ? (null as unknown as undefined) : 'npm run typecheck'
      }

      // Enrich with complexity scoring (same as full path)
      const settings = this.workspacePath
        ? workspaceRepository.getSettingsByPath(this.workspacePath)
        : {}
      const costPreference = (settings.costPreference as CostPreference) || DEFAULT_COST_PREFERENCE
      const enrichedTasks = enrichTasksWithComplexity([syntheticTask], costPreference)

      eventLoggerService.logDecompositionStarted({
        conversationId,
        summary: brief.summary,
        specialists: brief.specialists
      })
      eventLoggerService.logDecompositionCompleted({
        conversationId,
        taskCount: 1,
        tasks: enrichedTasks.map((t) => ({
          id: t.id,
          specialist: t.specialist,
          model: t.model
        }))
      })

      this.log.info(
        `  ${enrichedTasks[0].id}: ${enrichedTasks[0].complexity?.tier}/${enrichedTasks[0].model} (score: ${enrichedTasks[0].complexity?.total}) [fast-path]`
      )

      // Strategy 13: Pre-select investigation depth based on question complexity.
      // Quick mode (3 turns, 5 tools) saves 1,500-3,500 tokens for simple questions.
      const filesCount = brief.filesDiscussed?.length ?? 0
      const summaryLower = brief.summary.toLowerCase()
      const needsDeepInvestigation =
        summaryLower.includes('audit') ||
        summaryLower.includes('comprehensive') ||
        summaryLower.includes('all files') ||
        summaryLower.includes('across the codebase') ||
        filesCount > 3
      const suggestedDepth = needsDeepInvestigation ? 'standard' : 'quick'
      this.log.info(`[PIPELINE:depth-preselect] files=${filesCount} suggested=${suggestedDepth}`)

      return {
        conversationId,
        summary: brief.summary,
        mode,
        tasks: enrichedTasks,
        brief,
        investigationDepth: suggestedDepth as InvestigationDepth
      }
    }

    // ── FULL PATH: multi-specialist → decompose via LLM ──
    const { prompt } = this.buildDecompositionInputs(brief, mode, conversationId)

    this.log.info('Decomposing task for specialists:', brief.specialists.join(', '))

    eventLoggerService.logDecompositionStarted({
      conversationId,
      summary: brief.summary,
      specialists: brief.specialists
    })

    const executor = new SDKExecutor()
    try {
      const { result } = await executor.executeAndCollect({
        prompt,
        systemPrompt: promptBuilder.getDecompositionPrompt(),
        model: modelConfigService.getModel(this.workspacePath, 'generalist'),
        cwd: this.workspacePath,
        permissionMode: 'plan',
        allowedTools: []
      })

      return this.parseDecompositionResult(result, conversationId, brief, mode)
    } catch (error) {
      eventLoggerService.logDecompositionFailed({
        conversationId,
        error: (error as Error).message,
        fallback: 'none'
      })
      throw error
    }
  }

  private buildDecompositionInputs(
    brief: HandoffBrief,
    mode?: ConversationMode,
    conversationId?: string
  ): { prompt: string; specialistList: string } {
    const globallyActiveSpecialists = specialistRepository.findActive()
    let activeSpecialists = globallyActiveSpecialists

    if (conversationId) {
      const overrides = conversationSpecialistRepository.findByConversation(conversationId)
      if (overrides.length > 0) {
        const activeSpecialistIds = new Set(
          overrides.filter((override) => override.isActive).map((override) => override.specialistId)
        )
        activeSpecialists = globallyActiveSpecialists.filter((specialist) =>
          activeSpecialistIds.has(specialist.id)
        )
      }
    }

    const relevantSpecialists =
      brief.specialists.length > 0
        ? activeSpecialists.filter((s) => brief.specialists.includes(s.agentId))
        : activeSpecialists

    const specialistList = relevantSpecialists
      .map(
        (s) =>
          `- "${s.agentId}" — ${s.displayName}: ${s.prompt?.substring(0, 150) || 'General specialist'}`
      )
      .join('\n')

    // ── Build rich context for decomposition ──
    const decisionsBlock =
      brief.decisions.length > 0
        ? `\nKey decisions already made:\n${brief.decisions.map((d) => `- ${d}`).join('\n')}`
        : ''

    const constraintsBlock =
      brief.constraints.length > 0
        ? `\nConstraints to respect:\n${brief.constraints.map((c) => `- ${c}`).join('\n')}`
        : ''

    const filesBlock =
      brief.filesDiscussed.length > 0
        ? `\nFiles discussed/planned:\n${brief.filesDiscussed.map((f) => `- ${f}`).join('\n')}`
        : ''

    // Strategy 5: Truncate recentMessages to prevent unbounded context in decomposition.
    const MAX_CONVERSATION_CHARS = 3000
    const rawConversation =
      brief.recentMessages.length > 0
        ? brief.recentMessages.map((m) => `[${m.role}]: ${m.content}`).join('\n---\n')
        : ''
    const conversationBlock = rawConversation
      ? `\nRecent conversation context:\n${rawConversation.length > MAX_CONVERSATION_CHARS ? rawConversation.substring(rawConversation.length - MAX_CONVERSATION_CHARS) + '\n[... earlier messages truncated]' : rawConversation}`
      : ''

    const modeInstruction =
      mode === 'plan'
        ? '\n\nIMPORTANT: This is a PLAN-MODE decomposition. Create ONLY investigation/analysis tasks. Every task MUST end with "Produce a structured investigation report." Do NOT create fix, implementation, rebuild, or test tasks.'
        : ''

    const prompt = `Think step by step about the dependencies and potential file conflicts before decomposing.

Task to decompose: "${brief.summary}"
${modeInstruction}
${decisionsBlock}
${constraintsBlock}
${filesBlock}
${conversationBlock}

Available specialists:
${specialistList}

Decompose this task into sub-tasks and respond with ONLY valid JSON.`

    return { prompt, specialistList }
  }

  private parseDecompositionResult(
    result: string,
    conversationId: string,
    brief: HandoffBrief,
    mode: ConversationMode
  ): TaskPlan {
    // Keep parsed JSON preview for parity with existing parse-error logging.
    let jsonPreview = result
    const previewFenceMatch = jsonPreview.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (previewFenceMatch) {
      jsonPreview = previewFenceMatch[1].trim()
    }

    try {
      const taskPlan = parseDecompositionResultUtil(
        result,
        conversationId,
        brief,
        mode,
        (tasks: DecomposedTask[]) => {
          // Preserve previous behavior: ignore any model field from raw LLM JSON.
          const normalizedTasks = tasks.map((task) => ({
            ...task,
            model: undefined
          }))

          // Read workspace cost preference and enrich tasks with validated complexity scores
          const settings = this.workspacePath
            ? workspaceRepository.getSettingsByPath(this.workspacePath)
            : {}
          const costPreference =
            (settings.costPreference as CostPreference) || DEFAULT_COST_PREFERENCE

          const enrichedTasks = enrichTasksWithComplexity(normalizedTasks, costPreference)

          this.log.info(`Decomposed into ${enrichedTasks.length} tasks (cost: ${costPreference})`)
          for (const t of enrichedTasks) {
            this.log.info(
              `  ${t.id}: ${t.complexity?.tier}/${t.model} (score: ${t.complexity?.total})`
            )
          }

          return enrichedTasks
        }
      )

      // ── Event: decomposition completed ──
      eventLoggerService.logDecompositionCompleted({
        conversationId,
        taskCount: taskPlan.tasks.length,
        tasks: taskPlan.tasks.map((t) => ({
          id: t.id,
          specialist: t.specialist,
          model: t.model
        }))
      })

      return taskPlan
    } catch (error) {
      const originalError =
        error instanceof Error ? error.message : 'Task decomposition returned no tasks'
      const normalizedError =
        originalError === 'Task decomposition response missing tasks array'
          ? 'Task decomposition returned no tasks'
          : originalError

      if (normalizedError === 'Failed to parse task decomposition — LLM returned invalid JSON') {
        this.log.error('Failed to parse decomposition JSON:', jsonPreview.substring(0, 500))
      }

      eventLoggerService.logDecompositionFailed({
        conversationId,
        error: normalizedError,
        fallback: 'none'
      })
      throw new Error(normalizedError)
    }
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
    this.turnCountMap.clear()
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
   * Tracks cumulative cache read/creation across all turns for this session.
   */
  getCacheEfficiency(): {
    hitRate: number
    savedTokens: number
    totalInput: number
    turns: number
    /** Strategy θ: Per-turn cost breakdown for cost waterfall chart */
    turnBreakdown: Array<{
      turn: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreationTokens: number
      cacheHitRate: number
      timestamp: number
    }>
  } {
    const totalWithCache =
      this.cacheStats.totalInput + this.cacheStats.cacheRead + this.cacheStats.cacheCreation
    const hitRate = totalWithCache > 0 ? (this.cacheStats.cacheRead / totalWithCache) * 100 : 0
    return {
      hitRate,
      savedTokens: this.cacheStats.cacheRead,
      totalInput: this.cacheStats.totalInput,
      turns: this.cacheStats.turns,
      turnBreakdown: this.turnBreakdown
    }
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
    this.pendingCompaction.set(
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
    this.turnCountMap.delete(conversationId)
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
    this.log.info(`Switching mode: ${previousMode} → ${mode}`)
    this.currentMode = mode

    // Strategy ζ: Invalidate system prompt snapshot on mode switch
    this.systemPromptSnapshot = null

    // Flag the mode switch — the next send() will prefix the user's message with
    // mode-change context so the agent knows its permissions changed, while
    // preserving the full conversation history (session is NOT cleared).
    this.pendingModeSwitch = { from: previousMode, to: mode }

    // Prompt is rebuilt on each send() turn; mode change only updates pending switch context.
  }
}

export const generalistService = new GeneralistService()
