import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { LogFunctions } from 'electron-log'
import type { AgentStatus } from '../../shared/types'
import { buildEnvWithPath } from './env-utils'

export interface StreamChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'status'
  content?: string
  toolName?: string
  toolInput?: string
  error?: string
}

/**
 * Extracts a human-readable summary from raw tool input for display in the UI.
 */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return (input.description as string) || (input.command as string) || ''
    case 'Read':
      return (input.file_path as string) || ''
    case 'Write':
    case 'Edit':
      return (input.file_path as string) || ''
    case 'Grep':
      return `/${input.pattern as string}/` + (input.path ? ` in ${input.path}` : '')
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
    default:
      return ''
  }
}

/**
 * Shared base class for agent services (Generalist, Orchestrator).
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
  protected currentToolInput: string = ''
  protected toolIdToName: Map<string, string> = new Map()

  /** Scoped logger — each subclass provides its own scope */
  protected abstract readonly log: LogFunctions

  abstract getStatus(): AgentStatus

  /**
   * Builds a process environment with PATH augmented for claude CLI discovery.
   * Delegates to shared env-utils for cross-platform PATH construction.
   */
  protected buildEnvWithPath(): NodeJS.ProcessEnv {
    return buildEnvWithPath()
  }

  /**
   * Processes raw stdout data into newline-delimited JSON events.
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
        this.processStreamEvent(event)
      } catch {
        if (trimmed) {
          this.emit('chunk', {
            type: 'text',
            content: trimmed
          } as StreamChunk)
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
                this.emit('chunk', {
                  type: 'text',
                  content: block.text as string
                } as StreamChunk)
                this.hasEmittedContent = true
              } else if (block.type === 'tool_use') {
                const toolName = block.name as string
                const toolId = block.id as string
                const toolInput = block.input as Record<string, unknown> | undefined
                if (toolId) {
                  this.toolIdToName.set(toolId, toolName)
                }
                this.currentStatus = 'reviewing'
                this.emit('statusUpdate', this.getStatus())
                this.emit('chunk', {
                  type: 'tool_use',
                  toolName,
                  toolInput: toolInput ? summarizeToolInput(toolName, toolInput) : undefined
                } as StreamChunk)
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
                const toolName = this.toolIdToName.get(toolUseId) ?? 'Unknown'
                if (toolUseId) {
                  this.toolIdToName.delete(toolUseId)
                }
                this.emit('chunk', {
                  type: 'tool_result',
                  toolName
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
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          // Accumulate tool input for display
          this.currentToolInput += delta.partial_json as string
        }
        break
      }

      case 'content_block_start': {
        const contentBlock = event.content_block as Record<string, unknown> | undefined
        if (contentBlock?.type === 'tool_use') {
          this.currentStatus = 'reviewing'
          this.currentToolName = contentBlock.name as string
          this.currentToolInput = ''
          const toolInput = contentBlock.input as Record<string, unknown> | undefined
          this.emit('statusUpdate', this.getStatus())
          this.emit('chunk', {
            type: 'tool_use',
            toolName: contentBlock.name as string,
            toolInput: toolInput ? summarizeToolInput(this.currentToolName, toolInput) : undefined
          } as StreamChunk)
        } else if (contentBlock?.type === 'text' && contentBlock.text) {
          this.emit('chunk', {
            type: 'text',
            content: contentBlock.text as string
          } as StreamChunk)
        }
        break
      }

      case 'content_block_stop': {
        // If we were tracking a tool call, emit tool_result to mark it complete
        if (this.currentToolName) {
          this.emit('chunk', {
            type: 'tool_result',
            toolName: this.currentToolName,
            content: this.currentToolInput || undefined
          } as StreamChunk)
          this.currentToolName = null
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
        this.currentStatus = 'idle'
        this.emit('statusUpdate', this.getStatus())
        this.emit('complete')
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

    this.toolIdToName.clear()
    this.emit('complete')
    this.process = null
  }

  /**
   * Gracefully stops the process.
   */
  async stop(): Promise<void> {
    if (this.process) {
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
