import { spawn, spawnSync } from 'node:child_process'
import type { AgentStatus, ConversationMode, CostPreference, HandoffBrief } from '../../shared/types'
import { AGENT_IDS } from '../../shared/constants'
import { generalistLogger } from '../logger'
import { AgentBaseService } from './agent-base.service'
import type { StreamChunk } from './agent-base.service'
import { promptBuilder } from './prompt-builder'
import { memoryService } from './memory.service'
import { conversationRepository, workspaceRepository } from '../db/repositories'
import { modelConfigService } from './model-config.service'

/** Regex to detect handoff blocks emitted by the generalist. */
const HANDOFF_REGEX = /```handoff\n([\s\S]*?)```/

/** Regex to detect grill-summary blocks emitted by the generalist. */
const GRILL_SUMMARY_REGEX = /```grill-summary\n([\s\S]*?)```/

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

/**
 * Manages a long-lived interactive Claude CLI session for the generalist agent.
 *
 * Unlike the orchestrator (which spawns `claude -p` per message), the generalist
 * keeps a persistent stdin/stdout pipe open. Messages are sent by writing to stdin.
 *
 * Runs in plan mode (read-only) or build mode (can execute commands).
 */
/** Timeout for receiving the first response chunk (in ms) */
const RESPONSE_TIMEOUT_MS = 60_000 // 1 minute

export class GeneralistService extends AgentBaseService {
  protected readonly log = generalistLogger
  private workspacePath: string | null = null
  private currentConversationId: string | null = null
  private accumulatedText: string = ''
  private responseTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private processReady: boolean = false
  private currentMode: ConversationMode = 'plan'
  /** Maps conversationId → Claude CLI session_id for --resume support */
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

  /** Tracks whether stop() was called intentionally (vs crash) */
  private intentionallyStopped: boolean = false
  /** Number of auto-restart attempts since last successful start */
  private restartAttempts: number = 0

  /**
   * Spawns the long-lived interactive claude process for the given workspace.
   */
  async start(
    workspacePath: string,
    mode?: ConversationMode,
    resumeSessionId?: string
  ): Promise<void> {
    if (this.process) {
      await this.stop()
    }

    this.workspacePath = workspacePath
    this.currentMode = mode ?? 'plan'
    this.startedAt = Date.now()
    this.currentStatus = 'idle'
    this.buffer = ''
    this.tokenUsage = 0
    this.processReady = false
    this.intentionallyStopped = false
    this.restartAttempts = 0
    this.compactCount = 0
    this.currentConversationId = null
    this.accumulatedText = ''

    // Build system prompt via centralized PromptBuilder
    let memoryContext: string | undefined
    try {
      const allWorkspaces = workspaceRepository.findAll()
      const workspace = allWorkspaces.find((w) => w.repoPath === workspacePath)
      const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}

      if (settings.memoryEnabled !== false && workspace) {
        // Strategy 7: Economy mode uses shorter memory context to save tokens
        const memoryBudget = settings.costPreference === 'economy' ? 5000 : 10000
        const ctx = memoryService.getContextForPrompt(workspace.id, memoryBudget)
        if (ctx) memoryContext = ctx
      }

      // Strategy 7: Load cost preference to adjust compaction thresholds
      this.costPreference = (settings.costPreference as CostPreference) || 'balanced'
    } catch {
      // Memory context unavailable — not critical
    }

    const fullSystemPrompt = promptBuilder.build({
      role: 'generalist',
      mode: this.currentMode,
      workspacePath,
      memoryContext
    })

    const isBuildMode = this.currentMode === 'build'

    // Strategy 6: Conditional --verbose flag — only in debug mode to reduce stream noise
    let debugMode = false
    try {
      const allWorkspaces2 = workspaceRepository.findAll()
      const workspace2 = allWorkspaces2.find((w) => w.repoPath === workspacePath)
      const settings2 = workspace2 ? JSON.parse(workspace2.settingsJson || '{}') : {}
      debugMode = settings2.debugMode === true
    } catch {
      // Default to no verbose
    }

    const generalistModel = modelConfigService.getModel(workspacePath, 'generalist')
    const args = [
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--model',
      generalistModel,
      ...(debugMode ? ['--verbose'] : []),
      ...(isBuildMode
        ? ['--permission-mode', 'auto']
        : ['--permission-mode', 'plan', '--allowedTools', 'WebSearch,WebFetch']),
      '--system-prompt',
      fullSystemPrompt
    ]

    // Resume existing session if available (preserves conversation context)
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId)
      this.log.info('Resuming session:', resumeSessionId)
    }

    const env = this.buildEnvWithPath()

    // Log which CLI binary was resolved and its version for diagnostics
    const whichResult = spawnSync('which', ['claude'], { env })
    const resolvedPath = whichResult.stdout?.toString().trim() || '(not found)'
    this.log.info(`Using CLI: ${resolvedPath}`)

    const versionResult = spawnSync('claude', ['--version'], { env })
    const resolvedVersion = versionResult.stdout?.toString().trim() || '(unknown)'
    this.log.info(`CLI version: ${resolvedVersion}`)

    this.log.info('Starting interactive session for workspace:', workspacePath)

    const currentProcess = spawn('claude', args, {
      cwd: workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    })
    this.process = currentProcess

    // Create DB session for token tracking
    this.createDbSession('generalist', {
      pid: currentProcess.pid
    })

    // Handle stdin errors (EPIPE when process dies unexpectedly)
    currentProcess.stdin?.on('error', (err: Error) => {
      this.log.error('stdin error:', err.message)
      if (this.process === currentProcess && this.currentStatus !== 'idle') {
        this.clearResponseTimeout()
        this.currentStatus = 'failed'
        this.emit('statusUpdate', this.getStatus())
        this.emit('chunk', {
          type: 'error',
          error: `Connection to Claude CLI lost: ${err.message}. Try sending the message again.`
        } as StreamChunk)
        this.emit('complete')
      }
    })

    currentProcess.stdout?.on('data', (data: Buffer) => {
      if (this.process !== currentProcess) return
      this.clearResponseTimeout()
      this.log.debug('stdout:', data.toString().substring(0, 200))
      this.handleOutput(data)
    })

    currentProcess.stderr?.on('data', (data: Buffer) => {
      if (this.process !== currentProcess) return
      this.handleError(data)
    })

    currentProcess.on('exit', (code: number | null) => {
      if (this.process !== currentProcess) {
        this.log.debug(`Stale process exit ignored (code: ${code})`)
        return
      }
      this.handleExit(code)
    })

    currentProcess.on('error', (err: Error) => {
      if (this.process !== currentProcess) return
      this.log.error('Process error:', err.message)
      this.currentStatus = 'failed'
      this.emit('statusUpdate', this.getStatus())
      this.emit('chunk', {
        type: 'error',
        error: `Failed to spawn Claude CLI: ${err.message}`
      })
      this.emit('complete')
    })

    // Process spawned — return immediately (non-blocking)
    // Readiness is gated in send() via waitForReady()
    this.emit('statusUpdate', this.getStatus())
  }

  /**
   * Sends a message to the long-lived process by writing to stdin.
   * Each message is a newline-terminated line written to the process stdin.
   */
  async send(message: string, conversationId: string): Promise<void> {
    // If process is dead, attempt auto-restart with session resume
    if (!this.process || !this.process.stdin || this.process.killed) {
      if (this.workspacePath) {
        this.log.warn('Process not available, auto-restarting...')
        // Try in-memory session first, then fall back to DB
        let sessionId = this.sessionMap.get(conversationId)
        if (!sessionId) {
          try {
            sessionId = conversationRepository.getSessionId(conversationId)
            if (sessionId) {
              this.sessionMap.set(conversationId, sessionId)
              this.log.info('Session loaded from DB:', sessionId)
            }
          } catch (err) {
            this.log.error('Failed to load session from DB:', err)
          }
        }
        await this.start(this.workspacePath, this.currentMode, sessionId)
      }
      // Re-check after restart attempt
      if (!this.process || !this.process.stdin || this.process.killed) {
        throw new Error('Generalist not started — no active process')
      }
    }

    this.log.info('send() called', {
      conversationId,
      msgLen: message.length,
      processAlive: !!this.process && !this.process.killed
    })

    this.currentStatus = 'thinking'
    this.hasEmittedContent = false
    this.messageStartedAt = Date.now()
    this.currentConversationId = conversationId
    this.accumulatedText = ''
    this.emit('statusUpdate', this.getStatus())

    // Start response timeout — if no stdout data arrives within the limit, auto-fail
    this.startResponseTimeout()

    // Format as stream-json message (required for --input-format stream-json)
    const jsonMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message }
    })
    const writeOk = this.process.stdin.write(jsonMessage + '\n')
    this.log.debug('Message written to stdin (stream-json)')
    if (!writeOk) {
      this.log.warn('stdin write buffer full, waiting for drain...')
    }
  }

  private startResponseTimeout(): void {
    this.clearResponseTimeout()
    this.responseTimeoutTimer = setTimeout(() => {
      if (
        this.currentStatus === 'thinking' ||
        this.currentStatus === 'writing' ||
        this.currentStatus === 'reviewing'
      ) {
        this.log.error(`Response timeout after ${RESPONSE_TIMEOUT_MS / 1000}s`)
        this.currentStatus = 'failed'
        this.emit('statusUpdate', this.getStatus())
        this.emit('chunk', {
          type: 'error',
          error: `Claude CLI did not respond within ${RESPONSE_TIMEOUT_MS / 1000} seconds. The process may be unresponsive. Try stopping all agents and sending the message again.`
        } as StreamChunk)
        this.emit('complete')
      }
    }, RESPONSE_TIMEOUT_MS)
  }

  private clearResponseTimeout(): void {
    if (this.responseTimeoutTimer) {
      clearTimeout(this.responseTimeoutTimer)
      this.responseTimeoutTimer = null
    }
  }

  /**
   * Override to detect handoff signals in the accumulated text on result/complete.
   */
  protected onResultEvent(event: Record<string, unknown>): void {
    this.clearResponseTimeout()

    // Capture session info and persist for --resume support
    const sessionId = event.session_id as string | undefined
    if (sessionId) {
      this.log.info('Session ID:', sessionId)
      if (this.currentConversationId) {
        this.sessionMap.set(this.currentConversationId, sessionId)
        this.log.info('Session captured for conversation:', this.currentConversationId)
        // Persist to database for cross-restart recovery
        try {
          conversationRepository.updateSessionId(this.currentConversationId, sessionId)
        } catch (err) {
          this.log.error('Failed to persist session ID to DB:', err)
        }
      }
    }

    // Emit result text if assistant events didn't already provide it
    const result = event.result as string | undefined
    if (result && !this.hasEmittedContent) {
      this.emit('chunk', { type: 'text', content: result })
      this.accumulatedText += result
    }

    const usage = event.usage as Record<string, number> | undefined
    if (usage) {
      this.tokenUsage += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)

      // Emit context size warning when approaching limits
      // Strategy 7: Economy mode uses tighter thresholds
      const inputTokens = usage.input_tokens ?? 0
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
        // Auto-trigger compaction at critical threshold to prevent lossy auto-compaction
        // at 83.5% (Claude CLI's built-in threshold). Max 5 compactions per session.
        if (this.compactCount < 5) {
          setTimeout(() => this.compact(), 1000)
        }
      } else if (inputTokens >= suggestThreshold && !this.compactSuggested) {
        this.compactSuggested = true
        this.log.info(`Context growing large (${inputTokens} input tokens) — suggesting compact`)
        this.emit('compactNeeded', { level: 'suggest', inputTokens })
      }
    }

    // Check for handoff or grill summary in accumulated text
    this.detectHandoff()
    this.detectGrillSummary()

    this.currentStatus = 'idle'
    this.emit('statusUpdate', this.getStatus())
    this.emit('complete')
  }

  protected onSystemEvent(event: Record<string, unknown>): void {
    this.processReady = true
    const sessionId = event.session_id as string | undefined
    if (sessionId) {
      this.log.info('System init, session:', sessionId)
      if (this.currentConversationId) {
        this.sessionMap.set(this.currentConversationId, sessionId)
      }
    }
    this.emit('_processReady')
    this.emit('ready')
  }

  /**
   * Override handleOutput to also accumulate text for handoff detection.
   */
  protected handleOutput(data: Buffer): void {
    this.buffer += data.toString()

    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const event = JSON.parse(trimmed)
        // Track text content for handoff detection
        if (event.type === 'assistant') {
          const message = event.message as Record<string, unknown> | undefined
          if (message) {
            const content = message.content as Array<Record<string, unknown>> | undefined
            if (content) {
              for (const block of content) {
                if (block.type === 'text') {
                  this.accumulatedText += block.text as string
                }
              }
            }
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown> | undefined
          if (delta?.type === 'text_delta' && delta.text) {
            this.accumulatedText += delta.text as string
          }
        } else if (event.type === 'content_block_start') {
          const contentBlock = event.content_block as Record<string, unknown> | undefined
          if (contentBlock?.type === 'text' && contentBlock.text) {
            this.accumulatedText += contentBlock.text as string
          }
        }
        this.processStreamEvent(event)
      } catch {
        if (trimmed) {
          this.accumulatedText += trimmed
          this.emit('chunk', {
            type: 'text',
            content: trimmed
          })
        }
      }
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

        // Strategy 2: Post-handoff auto-compact — conversation context before the handoff
        // is mostly historical. Compact it to save tokens on subsequent messages.
        if (this.tokenUsage > 30_000 && this.compactCount < 5) {
          this.log.info(
            `Post-handoff auto-compact triggered (tokens: ${this.tokenUsage}, compacts: ${this.compactCount})`
          )
          setTimeout(() => this.compact(), 2000)
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
   * Override to detect fast mode rate limit fallback from Claude CLI stderr.
   * When fast mode hits a rate limit, the CLI falls back to standard speed — we
   * surface this to the user as a status notification instead of a scary error.
   */
  protected handleError(data: Buffer): void {
    const text = data.toString().trim()
    if (!text) return

    // Detect fast mode rate limit fallback
    if (
      (text.includes('fast mode') || text.includes('fast_mode') || text.includes('Fast mode')) &&
      (text.includes('fallback') || text.includes('rate limit') || text.includes('rate_limit'))
    ) {
      this.log.warn('Fast mode rate limit detected — falling back to standard speed')
      this.emit('chunk', {
        type: 'status',
        content: 'Fast mode rate limit reached — temporarily using standard speed'
      } as StreamChunk)
      return
    }

    // Delegate all other stderr to base handler
    super.handleError(data)
  }

  /**
   * Override to add auto-restart on unexpected crashes.
   */
  protected handleExit(code: number | null): void {
    this.clearResponseTimeout()
    super.handleExit(code)

    // Auto-restart if crashed unexpectedly (not intentional stop)
    if (code !== 0 && code !== null && this.workspacePath && !this.intentionallyStopped) {
      this.restartAttempts++

      if (this.restartAttempts <= 3) {
        const delay = 3000 * this.restartAttempts
        this.log.warn(
          `Generalist crashed (code ${code}) — auto-restarting in ${delay}ms (attempt ${this.restartAttempts}/3)...`
        )

        // Notify the UI about the reconnection attempt
        this.emit('chunk', {
          type: 'status',
          content: `Reconnecting to Claude CLI (attempt ${this.restartAttempts}/3)…`
        } as StreamChunk)

        const wp = this.workspacePath
        const mode = this.currentMode
        const sessionId = this.currentConversationId
          ? this.sessionMap.get(this.currentConversationId)
          : undefined

        setTimeout(() => {
          this.intentionallyStopped = false
          this.start(wp, mode, sessionId).catch((err) => {
            this.log.error('Auto-restart failed:', err)
            this.emit('chunk', {
              type: 'error',
              error: `Auto-restart failed: ${err instanceof Error ? err.message : String(err)}`
            } as StreamChunk)
          })
        }, delay)
      } else {
        this.log.error('Generalist restart attempts exhausted — giving up')
        this.emit('chunk', {
          type: 'error',
          error:
            'Claude CLI crashed repeatedly. Please restart the app or check your Claude CLI installation.'
        } as StreamChunk)
      }
    }
  }

  async stop(): Promise<void> {
    this.intentionallyStopped = true
    this.clearResponseTimeout()
    await super.stop()
    this.currentConversationId = null
    this.accumulatedText = ''
    // NOTE: Do NOT clear sessionMap — sessions persist across process restarts
    // so we can resume them with --resume
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

  isRunning(): boolean {
    return this.process !== null && !this.process.killed
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  getCurrentConversationId(): string | null {
    return this.currentConversationId
  }

  isReady(): boolean {
    return this.processReady && this.isRunning()
  }

  getMode(): ConversationMode {
    return this.currentMode
  }

  /**
   * Restart the generalist with a different permission mode.
   * Stops the current session and spawns a new one.
   */
  /**
   * Sends a compact command to the Claude CLI process, asking it to
   * summarize and compress the conversation context to save tokens.
   */
  async compact(): Promise<void> {
    if (!this.process || !this.process.stdin || this.process.killed) {
      throw new Error('Generalist not running — nothing to compact')
    }

    this.log.info(`Compacting conversation context... (compact #${this.compactCount + 1})`)
    this.compactCount++
    this.compactSuggested = false // Reset so we can re-suggest after compacting if needed
    this.currentStatus = 'thinking'
    this.emit('statusUpdate', this.getStatus())

    const compactMessage = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content:
          '/compact — Summarize our entire conversation so far into a concise context summary. ' +
          'Include: key decisions made, current task state, any pending items, and important code/file references. ' +
          'Then continue using this summary as your working context.'
      }
    })
    this.process.stdin.write(compactMessage + '\n')
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

  async switchMode(mode: ConversationMode): Promise<void> {
    if (mode === this.currentMode) return
    if (!this.workspacePath) return

    this.log.info(`Switching mode: ${this.currentMode} → ${mode}`)
    const wp = this.workspacePath
    const sessionId = this.currentConversationId
      ? this.sessionMap.get(this.currentConversationId)
      : undefined
    await this.stop()
    await this.start(wp, mode, sessionId)
  }
}

export const generalistService = new GeneralistService()
