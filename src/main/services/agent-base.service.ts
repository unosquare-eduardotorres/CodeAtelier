import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { LogFunctions } from 'electron-log'
import type { AgentStatus } from '../../shared/types'
import { buildEnvWithPath } from './env-utils'
import { agentSessionRepository } from '../db/repositories'
import { summarizeToolInput } from './tool-input-summarizer'

/** Detect if Write content is a structured plan the LLM should have emitted inline */
function isPlanContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.title === 'string' &&
      (Array.isArray(parsed.sections) || Array.isArray(parsed.steps))
    )
  } catch {
    return false
  }
}

export interface StreamChunk {
  type:
    | 'text'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'tool_progress'
    | 'error'
    | 'status'
    | 'turn_boundary'
    | 'subagent_start'
    | 'subagent_progress'
    | 'subagent_complete'
    | 'rate_limit'
    | 'compact_boundary'
    | 'api_retry'
    | 'prompt_suggestion'
    | 'files_persisted'
    | 'hook_lifecycle'
    | 'session_state'
    | 'auth_status'
    | 'tool_use_summary'
    | 'session_recovery'
    | 'context_usage_update'
    | 'permission_request'
    | 'structured_output'
    | 'lsp_diagnostics'
    | 'todo_update'
  content?: string
  toolName?: string
  toolInput?: string
  toolId?: string
  error?: string
  /** Elapsed time in seconds for tool_progress */
  elapsedSeconds?: number
  /** Rate limit info for rate_limit type */
  rateLimit?: {
    status: 'allowed' | 'allowed_warning' | 'rejected'
    utilization?: number
    resetsAt?: number
    rateLimitType?: string
  }
  /** API retry info */
  retryInfo?: {
    attempt: number
    maxRetries: number
    retryDelayMs: number
    errorStatus: number | null
  }
  /** Files persisted list */
  persistedFiles?: Array<{ filename: string; fileId: string }>
  /** Session recovery phase */
  recoveryPhase?: 'started' | 'building_context' | 'resuming' | 'completed' | 'failed'
  /** Live context usage update — emitted each turn for real-time badge updates */
  contextUsageUpdate?: {
    inputTokens: number
    contextWindowSize: number
    percentage: number
    /** Prompt cache hit rate (0–100) — ratio of cache-read tokens to total input. */
    cacheHitRate?: number
  }
  /** Hook lifecycle info */
  hookInfo?: {
    hookId: string
    hookName: string
    hookEvent: string
    phase: 'started' | 'progress' | 'response'
    output?: string
    outcome?: 'success' | 'error' | 'cancelled'
  }
  /** Permission request info (plan mode) */
  permissionRequest?: {
    permissionId: string
    tool: string
    args?: Record<string, unknown>
    message: string
  }
  /** GAP-9: Structured output from agent response (JSON schema result) */
  structuredOutput?: {
    data: unknown
    schemaName?: string
  }
  /** GAP-14: LSP diagnostics from compiler/linter */
  lspDiagnostics?: Array<{
    file: string
    line: number
    severity: 'error' | 'warning' | 'info' | 'hint'
    message: string
    source?: string
  }>
  /** GAP-15: Todo list update from todowrite tool */
  todoUpdate?: {
    action: 'add' | 'complete' | 'remove' | 'update'
    text: string
    index?: number
  }
}

// Re-export for backward compatibility — consumers import from here or the barrel
export { summarizeToolInput }

/**
 * Shared base class for agent services (Generalist and specialist workers).
 * Extracts common stream-json parsing, buffer management, env building, and error handling.
 */
export abstract class AgentBaseService extends EventEmitter {
  protected process: ChildProcess | null = null
  protected buffer: string = ''
  protected currentStatus: AgentStatus['status'] = 'idle'
  protected tokenUsage: number = 0
  protected inputTokens: number = 0
  protected outputTokens: number = 0
  protected cacheReadTokens: number = 0
  protected cacheCreationTokens: number = 0
  protected startedAt: number = 0
  protected messageStartedAt: number = 0
  protected hasEmittedContent: boolean = false
  protected currentToolName: string | null = null
  protected currentToolId: string | null = null
  protected currentToolInput: string = ''
  protected toolIdToName: Map<string, string> = new Map()
  /** Track tool IDs already processed via streaming (content_block_start/stop) to skip duplicates from full messages */
  protected processedToolIds: Set<string> = new Set()
  /** One plan block per run — prevents duplicate plan injection from multiple Write calls */
  protected planBlockInjected = false
  /** Counts tool calls in the current interaction for circuit-breaker protection */
  protected toolCallCount: number = 0
  /** When true, all further stdout output is ignored (circuit breaker tripped) */
  protected circuitBroken = false
  /** Workspace directory — used to relativize file paths in tool summaries */
  protected cwd: string | undefined

  /** Database session ID for token tracking */
  protected dbSessionId: string | null = null

  /** Scoped logger — each subclass provides its own scope */
  protected abstract readonly log: LogFunctions

  constructor() {
    super()
    this.on('error', (err) => {
      this.log.error('[AgentBase:unhandled-error]', err)
    })
  }

  abstract getStatus(): AgentStatus

  /**
   * Builds a process environment with PATH augmented for claude CLI discovery.
   * Delegates to shared env-utils for cross-platform PATH construction.
   */
  protected buildEnvWithPath(): NodeJS.ProcessEnv {
    return buildEnvWithPath()
  }

  /**
   * Creates a DB session record for token tracking.
   * Call from subclass start() after spawning the process.
   */
  protected createDbSession(
    agentType: string,
    opts: { pid?: number; conversationId?: string; workspaceId?: string } = {}
  ): void {
    try {
      const session = agentSessionRepository.create(agentType, opts)
      this.dbSessionId = session.id
    } catch (err) {
      this.log.error('Failed to create DB session:', err)
    }
  }

  /**
   * Links the DB session to a conversation after the conversation ID becomes known.
   * Use for long-lived agents (e.g. generalist) where conversationId is not available at start().
   */
  protected updateDbSessionConversation(conversationId: string): void {
    if (!this.dbSessionId) return
    try {
      agentSessionRepository.updateConversationId(this.dbSessionId, conversationId)
    } catch (err) {
      this.log.error('Failed to update DB session conversationId:', err)
    }
  }

  /**
   * Flushes current token usage to the DB session without completing it.
   * Use for long-lived agents (e.g. generalist) so the dashboard shows live data.
   */
  protected flushTokenUsage(): void {
    if (!this.dbSessionId) return
    try {
      agentSessionRepository.updateTokenUsage(this.dbSessionId, this.tokenUsage, {
        input: this.inputTokens,
        output: this.outputTokens,
        cacheRead: this.cacheReadTokens,
        cacheCreation: this.cacheCreationTokens
      })
    } catch (err) {
      this.log.error('Failed to flush token usage:', err)
    }
  }

  /**
   * Completes the DB session record with final status and token usage.
   */
  protected completeDbSession(status: 'completed' | 'failed' | 'terminated'): void {
    if (!this.dbSessionId) return
    try {
      agentSessionRepository.completeWithBreakdown(this.dbSessionId, status, {
        total: this.tokenUsage,
        input: this.inputTokens,
        output: this.outputTokens,
        cacheRead: this.cacheReadTokens,
        cacheCreation: this.cacheCreationTokens
      })
    } catch (err) {
      this.log.error('Failed to complete DB session:', err)
    }
    this.dbSessionId = null
  }

  /**
   * Processes raw stdout data into newline-delimited JSON events.
   */
  protected handleOutput(data: Buffer): void {
    // Circuit breaker tripped — ignore all further output
    if (this.circuitBroken) return

    this.buffer += data.toString()

    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const event = JSON.parse(trimmed)
        try {
          this.processStreamEvent(event)
        } catch (processError) {
          this.log.error('Error processing stream event:', processError, trimmed.substring(0, 200))
        }
      } catch {
        if (trimmed) {
          try {
            this.emit('chunk', { type: 'text', content: trimmed } as StreamChunk)
          } catch (emitError) {
            this.log.error('Failed to emit raw chunk:', emitError)
          }
        }
      }
    }
  }

  /**
   * Processes a single stream-json event from Claude CLI.
   */
  protected processStreamEvent(event: Record<string, unknown>): void {
    const type = event.type as string

    switch (type) {
      case 'assistant':
        return this.handleAssistantEvent(event)
      case 'user':
        return this.handleUserEvent(event)
      case 'content_block_delta':
        return this.handleContentBlockDelta(event)
      case 'content_block_start':
        return this.handleContentBlockStart(event)
      case 'content_block_stop':
        return this.handleContentBlockStop()
      case 'message_start': {
        const usage = (event.message as Record<string, unknown>)?.usage as
          | Record<string, number>
          | undefined
        if (usage?.input_tokens) this.tokenUsage += usage.input_tokens
        break
      }
      case 'message_delta': {
        const usage = event.usage as Record<string, number> | undefined
        if (usage?.output_tokens) this.tokenUsage += usage.output_tokens
        break
      }
      case 'message_stop':
        break // No-op: handled by 'result'
      case 'result':
        return this.onResultEvent(event)
      case 'system':
        return this.onSystemEvent(event)
      case 'error': {
        this.currentStatus = 'failed'
        this.emit('statusUpdate', this.getStatus())
        this.emit('chunk', {
          type: 'error',
          error: (event.error as Record<string, string>)?.message ?? 'Unknown error'
        } as StreamChunk)
        this.emit('complete')
        break
      }
      default:
        this.log.debug(
          `Unhandled stream event type: "${type}"`,
          JSON.stringify(event).substring(0, 200)
        )
    }
  }

  // ── Extracted event handlers (reduce processStreamEvent complexity) ──

  /** Handle 'assistant' events — text blocks and tool_use blocks from full messages */
  private handleAssistantEvent(event: Record<string, unknown>): void {
    this.currentStatus = 'writing'
    this.emit('statusUpdate', this.getStatus())

    const message = event.message as Record<string, unknown> | undefined
    if (message) {
      const content = message.content as Array<Record<string, unknown>> | undefined
      if (content) {
        for (const block of content) {
          if (block.type === 'text') {
            if (!this.hasEmittedContent) {
              this.emit('chunk', { type: 'text', content: block.text as string } as StreamChunk)
            }
            this.hasEmittedContent = true
          } else if (block.type === 'tool_use') {
            this.handleAssistantToolUseBlock(block)
          }
        }
      }
    }

    // Inline text_delta from assistant message
    const contentBlock = event.content_block as Record<string, unknown> | undefined
    const delta = event.delta as Record<string, unknown> | undefined
    if (contentBlock?.type === 'text_delta' || delta?.type === 'text_delta') {
      const text = contentBlock?.text ?? delta?.text
      if (text) this.emit('chunk', { type: 'text', content: text } as StreamChunk)
    }
  }

  /** Handle a single tool_use block from an assistant full message */
  private handleAssistantToolUseBlock(block: Record<string, unknown>): void {
    const toolName = block.name as string
    const toolId = block.id as string
    const toolInput = block.input as Record<string, unknown> | undefined
    if (toolId) this.toolIdToName.set(toolId, toolName)

    // Skip if already processed via content_block_start/stop streaming
    if (toolId && this.processedToolIds.has(toolId)) return

    this.currentStatus = 'reviewing'
    this.emit('statusUpdate', this.getStatus())
    this.emit('chunk', {
      type: 'tool_use',
      toolName,
      toolId,
      toolInput: toolInput ? summarizeToolInput(toolName, toolInput, this.cwd) : undefined
    } as StreamChunk)

    this.tryInjectPlanBlock(toolName, toolInput, 'full-message path')
  }

  /** Handle 'user' events — tool_result blocks */
  private handleUserEvent(event: Record<string, unknown>): void {
    const userMessage = event.message as Record<string, unknown> | undefined
    if (!userMessage) return
    const userContent = userMessage.content as Array<Record<string, unknown>> | undefined
    if (!userContent) return

    for (const block of userContent) {
      if (block.type !== 'tool_result') continue
      const toolUseId = block.tool_use_id as string
      // Skip if already handled by content_block_stop streaming
      if (toolUseId && this.processedToolIds.has(toolUseId)) {
        this.processedToolIds.delete(toolUseId)
        this.toolIdToName.delete(toolUseId)
        break
      }
      const toolName = this.toolIdToName.get(toolUseId) ?? 'Unknown'
      if (toolUseId) this.toolIdToName.delete(toolUseId)
      this.emit('chunk', { type: 'tool_result', toolName, toolId: toolUseId } as StreamChunk)
    }
  }

  /** Handle 'content_block_delta' — streaming text or tool input accumulation */
  private handleContentBlockDelta(event: Record<string, unknown>): void {
    const delta = event.delta as Record<string, unknown> | undefined
    if (delta?.type === 'text_delta' && delta.text) {
      this.emit('chunk', { type: 'text', content: delta.text as string } as StreamChunk)
      this.hasEmittedContent = true
    } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
      this.currentToolInput += delta.partial_json as string
    }
  }

  /** Handle 'content_block_start' — tool call circuit breaker + tool_use emission */
  private handleContentBlockStart(event: Record<string, unknown>): void {
    const contentBlock = event.content_block as Record<string, unknown> | undefined
    if (contentBlock?.type === 'tool_use') {
      this.toolCallCount++

      // Circuit breaker: too many tool calls suggests an infinite loop
      if (this.toolCallCount > MAX_TOOL_CALLS_PER_INTERACTION) {
        this.log.error(
          `Circuit breaker: ${this.toolCallCount} tool calls exceeded limit of ${MAX_TOOL_CALLS_PER_INTERACTION}`
        )
        this.currentStatus = 'failed'
        this.emit('statusUpdate', this.getStatus())
        this.emit('chunk', {
          type: 'error',
          error: `The agent made ${this.toolCallCount} tool calls, which suggests it got stuck in a loop. The response has been stopped. Try rephrasing your request.`
        } as StreamChunk)
        this.emit('complete')
        this.circuitBroken = true
        return
      }

      this.currentStatus = 'reviewing'
      this.currentToolName = contentBlock.name as string
      this.currentToolId = contentBlock.id as string
      this.currentToolInput = ''
      const toolId = contentBlock.id as string
      if (toolId) this.processedToolIds.add(toolId)
      const toolInput = contentBlock.input as Record<string, unknown> | undefined

      // Pre-fill with serialized input when available at start time
      if (toolInput && Object.keys(toolInput).length > 0) {
        this.currentToolInput = JSON.stringify(toolInput)
      }

      this.emit('statusUpdate', this.getStatus())
      this.emit('chunk', {
        type: 'tool_use',
        toolName: this.currentToolName,
        toolId: this.currentToolId,
        toolInput: toolInput
          ? summarizeToolInput(this.currentToolName, toolInput, this.cwd)
          : undefined
      } as StreamChunk)
    } else if (contentBlock?.type === 'text' && contentBlock.text) {
      this.emit('chunk', { type: 'text', content: contentBlock.text as string } as StreamChunk)
      this.hasEmittedContent = true
    }
  }

  /** Handle 'content_block_stop' — emit tool_result + plan injection */
  private handleContentBlockStop(): void {
    if (!this.currentToolName) return

    // Plan file safety net (streaming path)
    if (this.currentToolName === 'Write' && this.currentToolInput) {
      try {
        const toolInput = JSON.parse(this.currentToolInput)
        this.tryInjectPlanBlock(this.currentToolName, toolInput, 'streaming path')
      } catch {
        // currentToolInput may be incomplete JSON — skip plan injection
      }
    }

    this.emit('chunk', {
      type: 'tool_result',
      toolName: this.currentToolName,
      toolId: this.currentToolId ?? undefined,
      content: this.currentToolInput || undefined
    } as StreamChunk)
    this.currentToolName = null
    this.currentToolId = null
    this.currentToolInput = ''
  }

  /**
   * Inject plan content as a ````plan block when a Write tool targets .claude/plans/
   * or the content matches a plan JSON structure. Guards against double-injection.
   */
  private tryInjectPlanBlock(
    toolName: string,
    toolInput: Record<string, unknown> | undefined,
    path: string
  ): void {
    if (
      this.planBlockInjected ||
      toolName !== 'Write' ||
      !toolInput ||
      typeof toolInput.content !== 'string' ||
      typeof toolInput.file_path !== 'string'
    ) return

    if (
      (toolInput.file_path as string).includes('.claude/plans/') ||
      isPlanContent(toolInput.content as string)
    ) {
      this.planBlockInjected = true
      this.emit('chunk', {
        type: 'text',
        content: `\n\n\`\`\`\`plan\n${toolInput.content as string}\n\`\`\`\`\n`
      } as StreamChunk)
      this.log.info(`Injected plan content from Write to ${toolInput.file_path} (${path})`)
    }
  }

  /**
   * Override in subclasses to handle `result` events (session capture, etc.).
   */
  protected onResultEvent(event: Record<string, unknown>): void {
    const result = event.result as string | undefined
    if (result && !this.hasEmittedContent) {
      this.emit('chunk', { type: 'text', content: result } as StreamChunk)
    }
    const usage = event.usage as Record<string, number> | undefined
    if (usage) {
      this.tokenUsage += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
    }
    this.toolIdToName.clear()
    this.currentStatus = 'idle'
    this.emit('statusUpdate', this.getStatus())
    this.emit('complete')
  }

  /**
   * Override in subclasses to handle `system` init events.
   */

  protected onSystemEvent(_event: Record<string, unknown>): void {
    // Default: no-op — subclasses override for session tracking
  }

  /**
   * Handles stderr output.
   */
  protected handleError(data: Buffer): void {
    const text = data.toString().trim()
    if (text) {
      this.log.error('stderr:', text)
      this.emit('chunk', {
        type: 'error',
        error: text
      } as StreamChunk)
    }
  }

  /**
   * Handles process exit — flushes buffer and updates status.
   */
  protected handleExit(code: number | null): void {
    this.emit('processExit', code)
    this.log.info(`Process exited with code ${code}`)

    if (this.buffer.trim()) {
      try {
        const event = JSON.parse(this.buffer.trim())
        this.processStreamEvent(event)
      } catch {
        if (this.buffer.trim()) {
          this.emit('chunk', { type: 'text', content: this.buffer.trim() } as StreamChunk)
        }
      }
      this.buffer = ''
    }

    const wasProcessing =
      this.currentStatus === 'thinking' ||
      this.currentStatus === 'writing' ||
      this.currentStatus === 'reviewing'

    if (wasProcessing) {
      this.currentStatus = code === 0 ? 'idle' : 'failed'
      this.emit('statusUpdate', this.getStatus())
    }

    // Complete the DB session record
    this.completeDbSession(code === 0 ? 'completed' : 'failed')

    this.toolIdToName.clear()
    this.emit('complete')
    this.process = null
  }

  /**
   * Gracefully stops the process.
   */
  async stop(): Promise<void> {
    if (this.process) {
      // Complete DB session before killing
      this.completeDbSession('terminated')

      this.process.kill('SIGTERM')

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill('SIGKILL')
          resolve()
        }, 5000)

        this.process?.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })

      this.process = null
    }
    this.currentStatus = 'idle'
    this.emit('statusUpdate', this.getStatus())
  }
}
