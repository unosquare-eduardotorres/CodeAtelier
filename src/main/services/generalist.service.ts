import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatus, ConversationMode } from '../../shared/types'
import { AGENT_IDS } from '../../shared/constants'
import { generalistLogger } from '../logger'
import { AgentBaseService } from './agent-base.service'
import type { StreamChunk } from './agent-base.service'
import { getGeneralistSystemPrompt } from './generalist-prompts'
import { brainService } from './brain.service'
import { conversationRepository, workspaceRepository } from '../db/repositories'

/** Regex to detect handoff blocks emitted by the generalist. */
const HANDOFF_REGEX = /```handoff\n([\s\S]*?)```/

/** Regex to detect grill-summary blocks emitted by the generalist. */
const GRILL_SUMMARY_REGEX = /```grill-summary\n([\s\S]*?)```/

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

  /** Token threshold to suggest compaction (80K tokens — Claude's context is ~200K) */
  private static readonly COMPACT_SUGGEST_THRESHOLD = 80_000
  private static readonly COMPACT_AUTO_THRESHOLD = 150_000
  private compactSuggested: boolean = false

  /** Tracks whether stop() was called intentionally (vs crash) */
  private intentionallyStopped: boolean = false
  /** Number of auto-restart attempts since last successful start */
  private restartAttempts: number = 0

  /**
   * Spawns the long-lived interactive claude process for the given workspace.
   */
  async start(workspacePath: string, mode?: ConversationMode, resumeSessionId?: string): Promise<void> {
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
    this.currentConversationId = null
    this.accumulatedText = ''

    // Build system prompt with workspace context
    let fullSystemPrompt = getGeneralistSystemPrompt(this.currentMode)
    try {
      const claudeMdPath = join(workspacePath, 'CLAUDE.md')
      const workspaceContext = readFileSync(claudeMdPath, 'utf-8')
      fullSystemPrompt += `\n\n---\n\n## Workspace Project Context (from CLAUDE.md)\n\n${workspaceContext}`
    } catch {
      // No CLAUDE.md — that's fine
    }

    // Inject brain context (persistent project memory) into system prompt
    try {
      // Check if brain is enabled for this workspace
      const allWorkspaces = workspaceRepository.findAll()
      const workspace = allWorkspaces.find((w) => w.repoPath === workspacePath)
      const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}

      if (settings.brainEnabled !== false) {
        // default: enabled
        const brainContext = brainService.getContext(workspacePath)
        if (brainContext) {
          fullSystemPrompt += `\n\n---\n\n## Project Brain (Persistent Memory)\n\n${brainContext}`
        }
      }
    } catch {
      // Brain context unavailable — not critical
    }

    const isBuildMode = this.currentMode === 'build'

    const args = [
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      ...(isBuildMode
        ? ['--dangerously-skip-permissions']
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
   * Waits for the Claude CLI process to finish initializing (system init event).
   * Resolves immediately if already ready. Times out after 120 seconds.
   * Retained for external use via isReady() — no longer called from send()
   * since --input-format stream-json initializes on first stdin message.
   */
  // @ts-ignore TS6133 — retained for potential external use; no longer called from send()
  private waitForReady(): Promise<void> {
    if (this.processReady) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        this.removeListener('_processReady', onReady)
        reject(new Error('Claude CLI failed to initialize within 120 seconds'))
      }, 120_000)

      const onReady = (): void => {
        clearTimeout(readyTimeout)
        resolve()
      }
      this.once('_processReady', onReady)

      // Also reject if process exits before ready
      if (this.process) {
        this.process.once('exit', () => {
          clearTimeout(readyTimeout)
          this.removeListener('_processReady', onReady)
          if (!this.processReady) {
            reject(new Error('Claude CLI process exited before initialization'))
          }
        })
      }
    })
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

    this.log.info('send() called', { conversationId, msgLen: message.length, processAlive: !!this.process && !this.process.killed })

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
      const inputTokens = usage.input_tokens ?? 0
      if (inputTokens >= GeneralistService.COMPACT_AUTO_THRESHOLD) {
        this.log.warn(`Context very large (${inputTokens} input tokens) — auto-compacting`)
        this.emit('compactNeeded', { level: 'critical', inputTokens })
      } else if (
        inputTokens >= GeneralistService.COMPACT_SUGGEST_THRESHOLD &&
        !this.compactSuggested
      ) {
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
   */
  private detectHandoff(): void {
    const match = this.accumulatedText.match(HANDOFF_REGEX)
    if (!match) return

    try {
      const handoffData = JSON.parse(match[1].trim())
      if (handoffData.action === 'handoff' && handoffData.summary) {
        const handoff: HandoffEvent = {
          summary: handoffData.summary,
          specialists: Array.isArray(handoffData.specialists) ? handoffData.specialists : [],
          mode: handoffData.mode === 'plan' ? 'plan' : 'build'
        }
        this.log.info('Handoff detected:', handoff)
        this.emit('handoff', handoff)
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
        const wp = this.workspacePath
        const mode = this.currentMode
        const sessionId = this.currentConversationId
          ? this.sessionMap.get(this.currentConversationId)
          : undefined

        setTimeout(() => {
          this.intentionallyStopped = false
          this.start(wp, mode, sessionId).catch((err) => {
            this.log.error('Auto-restart failed:', err)
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

    this.log.info('Compacting conversation context...')
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
