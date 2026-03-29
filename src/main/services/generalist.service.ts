import type {
  AgentStatus,
  ConversationMode,
  CostPreference,
  GrillQuestion,
  HandoffBrief
} from '../../shared/types'
import { AGENT_IDS } from '../../shared/constants'
import { generalistLogger } from '../logger'
import { AgentBaseService } from './agent-base.service'
import type { StreamChunk } from './agent-base.service'
import { SDKExecutor } from './sdk-executor'
import type { SDKExecuteResult } from './sdk-executor'
import { authProvider } from './auth-provider'
import { promptBuilder } from './prompt-builder'
import { memoryService } from './memory.service'
import { conversationRepository, workspaceRepository } from '../db/repositories'
import { modelConfigService } from './model-config.service'
import { eventLoggerService } from './event-logger.service'

/** Regex to detect handoff blocks emitted by the generalist. */
const HANDOFF_REGEX = /```handoff\n([\s\S]*?)```/

/** Regex to detect grill-summary blocks emitted by the generalist. */
const GRILL_SUMMARY_REGEX = /```grill-summary\n([\s\S]*?)```/

/** Regex to detect grill-question blocks emitted by the generalist. */
const GRILL_QUESTION_REGEX = /```grill-question\n([\s\S]*?)```/g

/** Regex to detect ask-question blocks emitted by the generalist (general chat questions). */
const ASK_QUESTION_REGEX = /```ask-question\n([\s\S]*?)```/g

/** Regex to detect grill-evaluation blocks (new structured format with score + questions). */
const GRILL_EVAL_REGEX = /```grill-evaluation\n([\s\S]*?)```/g

/**
 * @deprecated Use HandoffBrief from shared/types.ts instead.
 * Kept for backward compatibility with legacy listeners.
 */
export interface HandoffEvent {
  summary: string
  specialists: string[]
  mode: ConversationMode
}

export interface GrillCompleteEvent {
  summary: string
  proposedTasks: Array<{ title: string; description: string }>
}

export interface GrillQuestionEvent {
  questions: GrillQuestion[]
}

export interface AskQuestionEvent {
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
  /** Maps conversationId → SDK session_id for resume support */
  private sessionMap: Map<string, string> = new Map()

  /**
   * Token thresholds for context compaction.
   * Strategy 2: Lowered from 80K/150K to 50K/100K — prompt caching helps but
   * context still grows linearly. Earlier compaction prevents runaway costs.
   *
   * Strategy 7: Economy mode uses even lower thresholds (40K/80K).
   */
  private static readonly COMPACT_SUGGEST_THRESHOLD = 50_000
  private static readonly COMPACT_AUTO_THRESHOLD = 100_000
  private static readonly COMPACT_SUGGEST_THRESHOLD_ECONOMY = 40_000
  private static readonly COMPACT_AUTO_THRESHOLD_ECONOMY = 80_000
  private compactSuggested: boolean = false
  /** Tracks number of compactions in this session to avoid over-compacting */
  private compactCount: number = 0
  /** Cost preference from workspace settings — affects compaction aggressiveness */
  private costPreference: CostPreference = 'balanced'

  /** Tool call limits — plan mode is tighter since it should mostly chat */
  private static readonly MAX_PLAN_TOOL_CALLS = 25
  private static readonly MAX_BUILD_TOOL_CALLS = 60

  /** Absolute cap per interaction — aborts SDK query if exceeded (replaces old CLI MAX_INTERACTION_TIMEOUT_MS) */
  private static readonly MAX_INTERACTION_TIMEOUT_MS = 10 * 60_000 // 10 minutes

  /** AbortController for cancelling the current SDK query */
  private sdkAbortController: AbortController | null = null
  /** Reusable SDK executor instance */
  private sdkExecutor: SDKExecutor = new SDKExecutor()

  /** Full system prompt — rebuilt on start() and switchMode() */
  private fullSystemPrompt: string = ''
  /** Memory context string, cached for switchMode() rebuilds */
  private memoryContext: string | undefined
  /** Pending mode switch — when set, the next send() prefixes the message with mode-change context */
  private pendingModeSwitch: { from: ConversationMode; to: ConversationMode } | null = null

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
    } catch {
      // Memory context unavailable — not critical
    }

    this.fullSystemPrompt = promptBuilder.build({
      role: 'generalist',
      mode: this.currentMode,
      workspacePath,
      memoryContext: this.memoryContext
    })

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
  async send(message: string, conversationId: string): Promise<void> {
    if (!this.workspacePath) {
      throw new Error('Generalist not started — call start() first')
    }

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
    this.emit('statusUpdate', this.getStatus())

    // If a mode switch is pending, prefix the user's message with context so the agent
    // knows its permissions changed — without clearing the session (preserves history).
    let effectiveMessage = message
    if (this.pendingModeSwitch) {
      const { from, to } = this.pendingModeSwitch
      const modeLabel = to === 'build' ? 'Build (read + execute)' : 'Plan (read-only)'
      const permissions = to === 'build'
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

    // For resumed sessions, inject critical rules as a message prefix because
    // the SDK ignores systemPrompt updates when --resume is set (the CLI uses
    // the original session's baked-in system prompt instead).
    if (sessionId) {
      const RULES_REMINDER = `[RULES REMINDER — These override all prior instructions]
Current mode: ${this.currentMode === 'build' ? 'BUILD' : 'PLAN'}

${this.currentMode === 'plan'
  ? 'PLAN MODE: Answer questions, generate plans, hand off investigations. NEVER modify files. If user asks for code changes, say "Switch to Build mode."'
  : 'BUILD MODE: Execute operational commands directly. Hand off ALL code changes to specialists via handoff block. NEVER write source code yourself.'}

RESPONSE STYLE (MANDATORY):
- Be CONCISE. Match response length to question complexity.
- Simple yes/no questions → 1-3 sentences max.
- NEVER repeat the same information twice in a response. If you catch yourself repeating, stop.
- NEVER use emoji bullets (✅, 🟢, 🚀, 🎉, 📊) as section markers — plain markdown only.
- NEVER produce status-report dashboards or decorated summary blocks.
- Lead with the answer. No preamble.

When I ask you to involve a specialist:
1. Emit a \`\`\`handoff block IMMEDIATELY — do NOT explore code first
2. Pick the specialist by technology
3. Use "mode": "${this.currentMode}" in the handoff block
4. The handoff block format:
\`\`\`handoff
{"action":"handoff","summary":"...","decisions":[],"constraints":[],"filesDiscussed":[],"specialists":["specialist-id"],"mode":"${this.currentMode}"}
\`\`\`
Do NOT use any tools before emitting the handoff block when I request a specialist.`

      effectiveMessage = `${RULES_REMINDER}\n\n${effectiveMessage}`
      this.log.info('Rules reminder injected for resumed session:', sessionId)
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
      for await (const chunk of this.sdkExecutor.execute({
        prompt: effectiveMessage,
        // Always send system prompt — ensures prompt updates propagate to resumed sessions
        systemPrompt: this.fullSystemPrompt,
        model: modelConfigService.getModel(this.workspacePath, 'generalist'),
        cwd: this.workspacePath,
        permissionMode: isBuildMode ? 'bypassPermissions' : 'plan',
        allowedTools: isBuildMode ? undefined : ['WebSearch', 'WebFetch'],
        maxTurns: isBuildMode ? 50 : 25,
        resume: sessionId,
        abortController,
        agentId: AGENT_IDS.GENERALIST
      })) {
        // Circuit breaker check
        if (this.circuitBroken) break

        if ('_meta' in chunk && chunk._meta) {
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
          this.checkCompaction(meta.tokenUsage.input)
        } else {
          // Accumulate text for handoff/grill detection
          if (chunk.type === 'text' && chunk.content) {
            this.accumulatedText += chunk.content
          }
          // Tool call counting + circuit breaker
          if (chunk.type === 'tool_use') {
            this.toolCallCount++
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
        }
      }

      clearTimeout(interactionTimer)
      this.sdkAbortController = null

      // Detect handoff/grill patterns in accumulated text
      this.detectHandoff()
      this.detectGrillSummary()
      this.detectGrillEvaluation()
      this.detectGrillQuestion()
      this.detectAskQuestion()

      this.currentStatus = 'idle'
      this.flushTokenUsage()
      this.emit('statusUpdate', this.getStatus())
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

  /**
   * Injects a context message into the generalist's conversation without
   * triggering the full send/response cycle. Used to feed orchestrator/specialist
   * results back so the generalist has awareness for follow-up questions.
   * The generalist's response is silently consumed (not forwarded to renderer).
   */
  async injectContext(context: string, conversationId: string): Promise<void> {
    if (!this.workspacePath) {
      this.log.warn('Cannot inject context — generalist not started')
      return
    }
    if (this.currentStatus !== 'idle') {
      this.log.warn('Cannot inject context — generalist is busy:', this.currentStatus)
      return
    }

    this.log.info('Injecting context via SDK (silent query)')

    // Look up session for the conversation
    const sessionId = this.sessionMap.get(conversationId)
    if (!sessionId) {
      this.log.warn('Cannot inject context — no session for conversation:', conversationId)
      return
    }

    // Fire a silent SDK query that doesn't emit chunks to the renderer
    const executor = new SDKExecutor()
    try {
      for await (const chunk of executor.execute({
        prompt: context,
        systemPrompt: '',
        model: modelConfigService.getModel(this.workspacePath, 'generalist'),
        cwd: this.workspacePath,
        permissionMode: this.currentMode === 'build' ? 'bypassPermissions' : 'plan',
        resume: sessionId,
        // Disable tool use during context injection
        allowedTools: [],
        agentId: AGENT_IDS.GENERALIST
      })) {
        // Only capture session ID and token usage — suppress all other output
        if ('_meta' in chunk && chunk._meta) {
          const meta = chunk._meta as SDKExecuteResult
          if (meta.sessionId) {
            this.sessionMap.set(conversationId, meta.sessionId)
            try {
              conversationRepository.updateSessionId(conversationId, meta.sessionId)
            } catch (err) {
              this.log.error('Failed to persist session ID:', err)
            }
          }
          this.tokenUsage += meta.tokenUsage.input + meta.tokenUsage.output
        }
      }
      this.log.info('Context injection complete')
    } catch (error) {
      this.log.error('Context injection failed:', error)
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
  private checkCompaction(inputTokens: number): void {
    const autoThreshold =
      this.costPreference === 'economy'
        ? GeneralistService.COMPACT_AUTO_THRESHOLD_ECONOMY
        : GeneralistService.COMPACT_AUTO_THRESHOLD
    const suggestThreshold =
      this.costPreference === 'economy'
        ? GeneralistService.COMPACT_SUGGEST_THRESHOLD_ECONOMY
        : GeneralistService.COMPACT_SUGGEST_THRESHOLD

    if (inputTokens >= autoThreshold) {
      this.log.warn(`Context very large (${inputTokens} input tokens) — auto-compacting`)
      this.emit('compactNeeded', { level: 'critical', inputTokens })
      // Auto-trigger compaction at critical threshold. Max 5 compactions per session.
      if (this.compactCount < 5) {
        setTimeout(() => this.compact(), 1000)
      }
    } else if (inputTokens >= suggestThreshold && !this.compactSuggested) {
      this.compactSuggested = true
      this.log.info(`Context growing large (${inputTokens} input tokens) — suggesting compact`)
      this.emit('compactNeeded', { level: 'suggest', inputTokens })
    }
  }

  /**
   * Checks the accumulated response text for a handoff block and emits a `handoff` event if found.
   * Parses the enriched HandoffBrief format with decisions, constraints, and files discussed.
   * Falls back gracefully if only the legacy { summary, specialists, mode } fields are present.
   */
  private detectHandoff(): void {
    const match = this.accumulatedText.match(HANDOFF_REGEX)
    if (!match) return

    try {
      const handoffData = JSON.parse(match[1].trim())
      if (handoffData.action === 'handoff' && handoffData.summary) {
        const brief: HandoffBrief = {
          summary: handoffData.summary,
          decisions: Array.isArray(handoffData.decisions) ? handoffData.decisions : [],
          constraints: Array.isArray(handoffData.constraints) ? handoffData.constraints : [],
          filesDiscussed: Array.isArray(handoffData.filesDiscussed)
            ? handoffData.filesDiscussed
            : [],
          recentMessages: [], // populated later in chat.ipc.ts from DB
          specialists: Array.isArray(handoffData.specialists) ? handoffData.specialists : [],
          mode: handoffData.mode === 'plan' ? 'plan' : 'build'
        }
        this.log.info('Handoff detected (enriched brief):', {
          summary: brief.summary,
          decisions: brief.decisions.length,
          constraints: brief.constraints.length,
          filesDiscussed: brief.filesDiscussed.length,
          specialists: brief.specialists
        })
        this.emit('handoff', brief)

        // Strategy 2: Post-handoff auto-compact — delay until specialist results
        // have been injected back. The specialist execution takes at minimum 30s,
        // so 120s gives enough buffer for context injection before compaction.
        if (this.tokenUsage > 30_000 && this.compactCount < 5) {
          this.log.info(
            `Post-handoff auto-compact scheduled (tokens: ${this.tokenUsage}, compacts: ${this.compactCount}) — delayed 120s for result injection`
          )
          setTimeout(() => this.compact(), 120_000)
        }
      }
    } catch (error) {
      this.log.error('Failed to parse handoff block:', error)
    }
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

  /**
   * Stops the generalist — cancels any in-flight SDK query and resets state.
   * Unlike the CLI version, there is no process to kill.
   */
  async stop(): Promise<void> {
    if (this.sdkAbortController) {
      this.sdkAbortController.abort()
      this.sdkAbortController = null
    }
    this.completeDbSession('terminated')
    this.currentStatus = 'idle'
    this.currentConversationId = null
    this.accumulatedText = ''
    // NOTE: Do NOT clear sessionMap — sessions persist so we can resume them
    this.emit('statusUpdate', this.getStatus())
  }

  getStatus(): AgentStatus {
    const isActive =
      this.currentStatus === 'thinking' ||
      this.currentStatus === 'writing' ||
      this.currentStatus === 'reviewing'

    return {
      agentId: AGENT_IDS.GENERALIST,
      agentType: 'generalist',
      status: this.currentStatus,
      elapsedMs: isActive && this.messageStartedAt ? Date.now() - this.messageStartedAt : 0,
      tokenUsage: this.tokenUsage
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

  /** SDK-based generalist is always ready when started (no process to wait for). */
  isReady(): boolean {
    return this.workspacePath !== null
  }

  getMode(): ConversationMode {
    return this.currentMode
  }

  /**
   * Sends a compact command via the SDK, asking the agent to summarize
   * and compress the conversation context to save tokens.
   */
  async compact(): Promise<void> {
    if (!this.workspacePath || !this.currentConversationId) {
      throw new Error('Generalist not running — nothing to compact')
    }

    const sessionId = this.sessionMap.get(this.currentConversationId)
    if (!sessionId) {
      throw new Error('No session to compact')
    }

    this.log.info(`Compacting context... (compact #${this.compactCount + 1})`)
    this.compactCount++
    this.compactSuggested = false

    // Send compaction prompt via SDK using the existing session
    await this.send(
      '/compact — Summarize our entire conversation so far into a concise context summary. ' +
        'Include: key decisions made, current task state, any pending items, and important code/file references. ' +
        'Then continue using this summary as your working context.',
      this.currentConversationId
    )
  }

  /** Returns the session ID for a given conversation, if captured. */
  getSessionId(conversationId: string): string | undefined {
    return this.sessionMap.get(conversationId)
  }

  /** Stores a session ID for a conversation (e.g. loaded from DB). */
  setSessionId(conversationId: string, sessionId: string): void {
    this.sessionMap.set(conversationId, sessionId)
  }

  /** Removes session tracking for a conversation (e.g. on delete). */
  clearSession(conversationId: string): void {
    this.sessionMap.delete(conversationId)
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

    // Flag the mode switch — the next send() will prefix the user's message with
    // mode-change context so the agent knows its permissions changed, while
    // preserving the full conversation history (session is NOT cleared).
    this.pendingModeSwitch = { from: previousMode, to: mode }

    // Rebuild system prompt for the new mode (used for new sessions only)
    this.fullSystemPrompt = promptBuilder.build({
      role: 'generalist',
      mode: this.currentMode,
      workspacePath: this.workspacePath,
      memoryContext: this.memoryContext
    })
  }
}

export const generalistService = new GeneralistService()
