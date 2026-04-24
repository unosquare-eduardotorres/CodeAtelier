import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { LogFunctions } from 'electron-log'
import type { AgentStatus } from '../../shared/types'
import { MCP_TOOLS } from '../../shared/constants'
import { buildEnvWithPath } from './env-utils'
import { agentSessionRepository } from '../db/repositories'

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
  /** Hook lifecycle info */
  hookInfo?: {
    hookId: string
    hookName: string
    hookEvent: string
    phase: 'started' | 'progress' | 'response'
    output?: string
    outcome?: 'success' | 'error' | 'cancelled'
  }
}

/** Strip workspace prefix from an absolute path to produce a relative display path. */
function toRelativePath(absolutePath: string, workspacePath?: string): string {
  if (!workspacePath || !absolutePath.startsWith(workspacePath)) return absolutePath
  const relative = absolutePath.slice(workspacePath.length)
  return relative.startsWith('/') ? relative.slice(1) : relative
}

/**
 * Extracts a human-readable summary from raw tool input for display in the UI.
 */
export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
  workspacePath?: string
): string {
  switch (toolName) {
    case 'Bash':
      return (input.description as string) || (input.command as string) || ''
    case 'Read':
      return toRelativePath((input.file_path as string) || '', workspacePath)
    case 'Write':
    case 'Edit':
      return toRelativePath((input.file_path as string) || '', workspacePath)
    case 'Grep':
      return (
        `/${input.pattern as string}/` +
        (input.path ? ` in ${toRelativePath(input.path as string, workspacePath)}` : '')
      )
    case 'Glob':
      return (input.pattern as string) || ''
    case 'WebSearch':
      return (input.query as string) || ''
    case 'WebFetch':
      return (input.url as string) || ''
    case 'TodoRead':
    case 'TodoWrite':
      return 'Task management'
    case 'TaskOutput':
      return `Reading output of task ${(input.id as string)?.slice(0, 7) ?? ''}…`

    // ── MCP tools: Code Graph ──
    case MCP_TOOLS.CODE_GRAPH.GRAPH_MAP.name:
      return `graph_map${input.focusFiles ? ` (focus: ${(input.focusFiles as string[]).length} files)` : ''}`
    case MCP_TOOLS.CODE_GRAPH.SEARCH_IDENTIFIERS.name:
      return `search: ${(input.query as string) || ''}`

    // ── MCP tools: Semantic Search ──
    case MCP_TOOLS.SEMANTIC_SEARCH.SEMANTIC_SEARCH.name:
      return `semantic: ${(input.query as string) || ''}`

    // ── MCP tools: Git Context ──
    case MCP_TOOLS.GIT_CONTEXT.GIT_LOG.name:
      return `git log${input.path ? ` ${toRelativePath(input.path as string, workspacePath)}` : ''}`
    case MCP_TOOLS.GIT_CONTEXT.GIT_DIFF.name:
      return `git diff${input.path ? ` ${toRelativePath(input.path as string, workspacePath)}` : ''}`
    case MCP_TOOLS.GIT_CONTEXT.GIT_BLAME.name:
      return `git blame ${toRelativePath((input.path as string) || '', workspacePath)}`

    // ── MCP tools: Task Context ──
    case MCP_TOOLS.TASK_CONTEXT.LIST_TASKS.name:
      return 'list tasks'
    case MCP_TOOLS.TASK_CONTEXT.GET_TASK_OUTPUT.name:
      return `task output ${(input.taskId as string)?.slice(0, 7) ?? ''}…`

    // ── MCP tools: Checkpoint Context ──
    case MCP_TOOLS.CHECKPOINT_CONTEXT.LIST_CHECKPOINTS.name:
      return 'list checkpoints'
    case MCP_TOOLS.CHECKPOINT_CONTEXT.GET_CHECKPOINT.name:
      return `checkpoint ${(input.checkpointId as string)?.slice(0, 7) ?? ''}…`

    // ── MCP tools: GitHub Context ──
    case MCP_TOOLS.GITHUB_CONTEXT.GET_PR_STATUS.name:
      return `PR #${(input.prNumber as string) || ''}`
    case MCP_TOOLS.GITHUB_CONTEXT.LIST_PR_COMMENTS.name:
      return `PR #${(input.prNumber as string) || ''} comments`
    case MCP_TOOLS.GITHUB_CONTEXT.LIST_ISSUES.name:
      return 'list issues'

    default:
      // Generic MCP tool fallback — extract server + tool name for any unhandled MCP tools
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__')
        return parts.length >= 3 ? `${parts[1]}/${parts[2]}` : toolName
      }
      return ''
  }
}

/**
 * Shared base class for agent services (Generalist and specialist workers).
 * Extracts common stream-json parsing, buffer management, env building, and error handling.
 */
export abstract class AgentBaseService extends EventEmitter {
  protected process: ChildProcess | null = null
  protected buffer: string = ''
  protected currentStatus: AgentStatus['status'] = 'idle'
  protected tokenUsage: number = 0
  protected startedAt: number = 0
  protected messageStartedAt: number = 0
  protected hasEmittedContent: boolean = false
  protected currentToolName: string | null = null
  protected currentToolId: string | null = null
  protected currentToolInput: string = ''
  protected toolIdToName: Map<string, string> = new Map()
  /** Track tool IDs already processed via streaming (content_block_start/stop) to skip duplicates from full messages */
  protected processedToolIds: Set<string> = new Set()
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
      agentSessionRepository.updateTokenUsage(this.dbSessionId, this.tokenUsage)
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
      agentSessionRepository.complete(this.dbSessionId, status, this.tokenUsage)
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
      case 'assistant': {
        this.currentStatus = 'writing'
        this.emit('statusUpdate', this.getStatus())

        const message = event.message as Record<string, unknown> | undefined
        if (message) {
          const content = message.content as Array<Record<string, unknown>> | undefined
          if (content) {
            for (const block of content) {
              if (block.type === 'text') {
                // Only emit if content wasn't already streamed via content_block_delta/start
                if (!this.hasEmittedContent) {
                  this.emit('chunk', {
                    type: 'text',
                    content: block.text as string
                  } as StreamChunk)
                }
                this.hasEmittedContent = true
              } else if (block.type === 'tool_use') {
                const toolName = block.name as string
                const toolId = block.id as string
                const toolInput = block.input as Record<string, unknown> | undefined
                if (toolId) {
                  this.toolIdToName.set(toolId, toolName)
                }
                // Skip if already processed via content_block_start/stop streaming
                if (toolId && this.processedToolIds.has(toolId)) {
                  break
                }
                this.currentStatus = 'reviewing'
                this.emit('statusUpdate', this.getStatus())
                this.emit('chunk', {
                  type: 'tool_use',
                  toolName,
                  toolId,
                  toolInput: toolInput
                    ? summarizeToolInput(toolName, toolInput, this.cwd)
                    : undefined
                } as StreamChunk)

                // Plan file safety net (full-message path): When Claude CLI writes a plan to
                // .claude/plans/ via its built-in plan mode, extract the content from the tool
                // input and emit it as a ```plan block so the UI renders a PlanCard.
                // The streaming path (content_block_start/stop) handles this via
                // forwardChunkToRenderer instead — processedToolIds prevents duplication.
                if (
                  toolName === 'Write' &&
                  toolInput &&
                  typeof toolInput.content === 'string' &&
                  typeof toolInput.file_path === 'string' &&
                  ((toolInput.file_path as string).includes('.claude/plans/') ||
                    isPlanContent(toolInput.content as string))
                ) {
                  this.emit('chunk', {
                    type: 'text',
                    content: `\n\n\`\`\`\`plan\n${toolInput.content as string}\n\`\`\`\`\n`
                  } as StreamChunk)
                  this.log.info(
                    `Injected plan content from Write to ${toolInput.file_path} (full-message path)`
                  )
                }
              }
            }
          }
        }

        const contentBlock = event.content_block as Record<string, unknown> | undefined
        const delta = event.delta as Record<string, unknown> | undefined
        if (contentBlock?.type === 'text_delta' || delta?.type === 'text_delta') {
          const text = contentBlock?.text ?? delta?.text
          if (text) {
            this.emit('chunk', { type: 'text', content: text } as StreamChunk)
          }
        }
        break
      }

      case 'user': {
        const userMessage = event.message as Record<string, unknown> | undefined
        if (userMessage) {
          const userContent = userMessage.content as Array<Record<string, unknown>> | undefined
          if (userContent) {
            for (const block of userContent) {
              if (block.type === 'tool_result') {
                const toolUseId = block.tool_use_id as string
                // Skip if already handled by content_block_stop streaming
                if (toolUseId && this.processedToolIds.has(toolUseId)) {
                  this.processedToolIds.delete(toolUseId)
                  this.toolIdToName.delete(toolUseId)
                  break
                }
                const toolName = this.toolIdToName.get(toolUseId) ?? 'Unknown'
                if (toolUseId) {
                  this.toolIdToName.delete(toolUseId)
                }
                this.emit('chunk', {
                  type: 'tool_result',
                  toolName,
                  toolId: toolUseId
                } as StreamChunk)
              }
            }
          }
        }
        break
      }

      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && delta.text) {
          this.emit('chunk', {
            type: 'text',
            content: delta.text as string
          } as StreamChunk)
          this.hasEmittedContent = true
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          // Accumulate tool input for display
          this.currentToolInput += delta.partial_json as string
        }
        break
      }

      case 'content_block_start': {
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

            // Actually stop processing — the `return` alone just skips this event,
            // but handleOutput will fire again on the next stdout data chunk.
            this.circuitBroken = true
            return
          }

          this.currentStatus = 'reviewing'
          this.currentToolName = contentBlock.name as string
          this.currentToolId = contentBlock.id as string
          this.currentToolInput = ''
          const toolId = contentBlock.id as string
          if (toolId) {
            this.processedToolIds.add(toolId)
          }
          const toolInput = contentBlock.input as Record<string, unknown> | undefined

          // Pre-fill with serialized input when the full input is available at start time.
          // In this case, no input_json_delta events will follow, so currentToolInput
          // would otherwise remain empty when content_block_stop fires.
          if (toolInput && Object.keys(toolInput).length > 0) {
            this.currentToolInput = JSON.stringify(toolInput)
          }

          this.emit('statusUpdate', this.getStatus())
          this.emit('chunk', {
            type: 'tool_use',
            toolName: contentBlock.name as string,
            toolId: contentBlock.id as string,
            toolInput: toolInput
              ? summarizeToolInput(this.currentToolName, toolInput, this.cwd)
              : undefined
          } as StreamChunk)
        } else if (contentBlock?.type === 'text' && contentBlock.text) {
          this.emit('chunk', {
            type: 'text',
            content: contentBlock.text as string
          } as StreamChunk)
          this.hasEmittedContent = true
        }
        break
      }

      case 'content_block_stop': {
        // If we were tracking a tool call, emit tool_result to mark it complete
        if (this.currentToolName) {
          // Plan file safety net (streaming path): When the LLM writes plan content
          // via a Write tool call, intercept it and emit as a ````plan block so
          // the UI renders a PlanCard instead of showing a file write.
          if (this.currentToolName === 'Write' && this.currentToolInput) {
            try {
              const toolInput = JSON.parse(this.currentToolInput)
              if (
                typeof toolInput.content === 'string' &&
                typeof toolInput.file_path === 'string' &&
                ((toolInput.file_path as string).includes('.claude/plans/') ||
                  isPlanContent(toolInput.content as string))
              ) {
                this.emit('chunk', {
                  type: 'text',
                  content: `\n\n\`\`\`\`plan\n${toolInput.content as string}\n\`\`\`\`\n`
                } as StreamChunk)
                this.log.info(
                  `Injected plan content from Write to ${toolInput.file_path} (streaming path)`
                )
              }
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
        break
      }

      case 'message_start': {
        const usage = (event.message as Record<string, unknown>)?.usage as
          | Record<string, number>
          | undefined
        if (usage?.input_tokens) {
          this.tokenUsage += usage.input_tokens
        }
        break
      }

      case 'message_delta': {
        const usage = event.usage as Record<string, number> | undefined
        if (usage?.output_tokens) {
          this.tokenUsage += usage.output_tokens
        }
        break
      }

      case 'message_stop': {
        // No-op: message_stop fires between turns in multi-turn tool use.
        // The 'result' event handles final status update + completion.
        break
      }

      case 'result': {
        this.onResultEvent(event)
        break
      }

      case 'system': {
        this.onSystemEvent(event)
        break
      }

      case 'error': {
        this.currentStatus = 'failed'
        this.emit('statusUpdate', this.getStatus())
        this.emit('chunk', {
          type: 'error',
          error: (event.error as Record<string, string>)?.message ?? 'Unknown error'
        } as StreamChunk)
        // Emit complete so the UI isn't stuck — if the CLI recovers and sends
        // a result event later, handleOutput will start a new interaction cycle
        this.emit('complete')
        break
      }

      default: {
        this.log.debug(
          `Unhandled stream event type: "${type}"`,
          JSON.stringify(event).substring(0, 200)
        )
        break
      }
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
