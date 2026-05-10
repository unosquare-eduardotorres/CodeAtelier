/**
 * ScriptedClaudeClient — A mock implementation of the Claude SDK execute interface.
 *
 * Simulates SDK streaming behavior for unit/integration tests without network access.
 * Supports scripted tool calls, text chunks, and error scenarios.
 *
 * Usage:
 *   const client = new ScriptedClaudeClient([
 *     { type: 'text', content: 'Hello from Claude' },
 *     { type: 'tool_use', name: 'Read', input: { file_path: '/foo.ts' } },
 *     { type: 'tool_result', content: 'file contents here' },
 *     { type: 'text', content: 'Done reading the file.' }
 *   ])
 */

import { EventEmitter } from 'node:events'

// ── Script Step Types ──

export interface TextStep {
  type: 'text'
  content: string
}

export interface ToolUseStep {
  type: 'tool_use'
  name: string
  input: Record<string, unknown>
  id?: string
}

export interface ToolResultStep {
  type: 'tool_result'
  content: string
  toolUseId?: string
}

export interface ErrorStep {
  type: 'error'
  message: string
}

export interface ThinkingStep {
  type: 'thinking'
  content: string
}

export type ScriptStep = TextStep | ToolUseStep | ToolResultStep | ErrorStep | ThinkingStep

// ── Mock SDK Message Types (mirroring Claude Agent SDK) ──

export interface MockMessage {
  id: string
  role: 'user' | 'assistant'
  content: MockContentBlock[]
  model: string
  stop_reason: string | null
  usage: MockUsage
}

export interface MockContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  content?: string
  thinking?: string
}

export interface MockUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

// ── ScriptedClaudeClient ──

export class ScriptedClaudeClient extends EventEmitter {
  private script: ScriptStep[]
  private stepIndex = 0
  private _executeCalls: Array<{ prompt: string; options?: Record<string, unknown> }> = []
  private _toolCallCount = 0

  constructor(script: ScriptStep[] = []) {
    super()
    this.script = script
  }

  /** All calls to execute(), for assertions */
  get executeCalls() {
    return this._executeCalls
  }

  /** Number of tool_use steps consumed */
  get toolCallCount() {
    return this._toolCallCount
  }

  /**
   * Replace the current script (useful for multi-turn scenarios).
   */
  setScript(script: ScriptStep[]): void {
    this.script = script
    this.stepIndex = 0
  }

  /**
   * Simulate a Claude SDK `execute()` call.
   * Processes all script steps and emits events matching the real SDK pattern.
   *
   * Returns a MockMessage summarizing the full response.
   */
  async execute(
    prompt: string,
    options?: Record<string, unknown>
  ): Promise<MockMessage> {
    this._executeCalls.push({ prompt, options })

    const contentBlocks: MockContentBlock[] = []
    let outputTokens = 0

    while (this.stepIndex < this.script.length) {
      const step = this.script[this.stepIndex]
      this.stepIndex++

      switch (step.type) {
        case 'text':
          contentBlocks.push({ type: 'text', text: step.content })
          outputTokens += Math.ceil(step.content.length / 4) // rough token estimate
          this.emit('text', step.content)
          break

        case 'tool_use': {
          this._toolCallCount++
          const toolId = step.id ?? `tool_${this._toolCallCount}`
          contentBlocks.push({
            type: 'tool_use',
            id: toolId,
            name: step.name,
            input: step.input
          })
          this.emit('tool_use', { id: toolId, name: step.name, input: step.input })
          break
        }

        case 'tool_result':
          contentBlocks.push({ type: 'tool_result', content: step.content })
          this.emit('tool_result', { content: step.content, toolUseId: step.toolUseId })
          break

        case 'thinking':
          contentBlocks.push({ type: 'thinking', thinking: step.content })
          this.emit('thinking', step.content)
          break

        case 'error':
          this.emit('error', new Error(step.message))
          throw new Error(step.message)
      }
    }

    const message: MockMessage = {
      id: `msg_mock_${Date.now()}`,
      role: 'assistant',
      content: contentBlocks,
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: Math.ceil(prompt.length / 4),
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    }

    this.emit('message', message)
    return message
  }

  /**
   * Simulate streaming text chunk-by-chunk.
   * Useful for testing streaming handlers that process incremental text.
   */
  async *streamText(text: string, chunkSize = 20): AsyncGenerator<string> {
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize)
      this.emit('text', chunk)
      yield chunk
    }
  }

  /** Reset state for re-use across tests */
  reset(): void {
    this.stepIndex = 0
    this._executeCalls = []
    this._toolCallCount = 0
    this.removeAllListeners()
  }
}

// ── Helper Factories ──

/**
 * Create a ScriptedClaudeClient that returns a simple text response.
 */
export function createTextOnlyClient(text: string): ScriptedClaudeClient {
  return new ScriptedClaudeClient([{ type: 'text', content: text }])
}

/**
 * Create a ScriptedClaudeClient that simulates a tool call followed by a response.
 */
export function createToolCallClient(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: string,
  finalText: string
): ScriptedClaudeClient {
  return new ScriptedClaudeClient([
    { type: 'tool_use', name: toolName, input: toolInput },
    { type: 'tool_result', content: toolResult },
    { type: 'text', content: finalText }
  ])
}

/**
 * Create a ScriptedClaudeClient that throws an error during execution.
 */
export function createErrorClient(errorMessage: string): ScriptedClaudeClient {
  return new ScriptedClaudeClient([{ type: 'error', message: errorMessage }])
}
