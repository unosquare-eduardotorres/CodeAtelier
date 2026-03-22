import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatus, ConversationMode } from '../../shared/types'
import { AGENT_IDS } from '../../shared/constants'
import { generalistLogger } from '../logger'
import { AgentBaseService } from './agent-base.service'
import type { StreamChunk } from './agent-base.service'
import { GENERALIST_SYSTEM_PROMPT } from './generalist-prompts'

/** Regex to detect handoff blocks emitted by the generalist. */
const HANDOFF_REGEX = /```handoff\n([\s\S]*?)```/

export interface HandoffEvent {
  summary: string
  specialists: string[]
  mode: ConversationMode
}

/**
 * Manages a long-lived interactive Claude CLI session for the generalist agent.
 *
 * Unlike the orchestrator (which spawns `claude -p` per message), the generalist
 * keeps a persistent stdin/stdout pipe open. Messages are sent by writing to stdin.
 *
 * Always runs with `--permission-mode plan` (read-only).
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

  /**
   * Spawns the long-lived interactive claude process for the given workspace.
   */
  async start(workspacePath: string): Promise<void> {
    if (this.process) {
      await this.stop()
    }

    this.workspacePath = workspacePath
    this.startedAt = Date.now()
    this.currentStatus = 'idle'
    this.buffer = ''
    this.tokenUsage = 0
    this.processReady = false
    this.currentConversationId = null
    this.accumulatedText = ''

    // Build system prompt with workspace context
    let fullSystemPrompt = GENERALIST_SYSTEM_PROMPT
    try {
      const claudeMdPath = join(workspacePath, 'CLAUDE.md')
      const workspaceContext = readFileSync(claudeMdPath, 'utf-8')
      fullSystemPrompt += `\n\n---\n\n## Workspace Project Context (from CLAUDE.md)\n\n${workspaceContext}`
    } catch {
      // No CLAUDE.md — that's fine
    }

    const args = [
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'plan',
      '--allowedTools',
      'WebSearch,WebFetch',
      '--system-prompt',
      fullSystemPrompt
    ]

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
    // If process is dead, attempt auto-restart
    if (!this.process || !this.process.stdin || this.process.killed) {
      if (this.workspacePath) {
        this.log.warn('Process not available, auto-restarting...')
        await this.start(this.workspacePath)
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

    // Capture session info if present
    const sessionId = event.session_id as string | undefined
    if (sessionId) {
      this.log.info('Session ID:', sessionId)
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
    }

    // Check for handoff in accumulated text
    this.detectHandoff()

    this.currentStatus = 'idle'
    this.emit('statusUpdate', this.getStatus())
    this.emit('complete')
  }

  protected onSystemEvent(event: Record<string, unknown>): void {
    this.processReady = true
    const sessionId = event.session_id as string | undefined
    if (sessionId) {
      this.log.info('System init, session:', sessionId)
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

  async stop(): Promise<void> {
    this.clearResponseTimeout()
    await super.stop()
    this.currentConversationId = null
    this.accumulatedText = ''
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
}

export const generalistService = new GeneralistService()
