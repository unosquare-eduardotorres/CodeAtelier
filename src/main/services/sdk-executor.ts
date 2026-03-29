import { query } from '@anthropic-ai/claude-agent-sdk'
import type { StreamChunk } from './agent-base.service'
import { summarizeToolInput } from './agent-base.service'
import log from 'electron-log/main'

const sdkLog = log.scope('SDKExecutor')

export interface SDKExecuteOptions {
  prompt: string
  systemPrompt: string
  model: string
  cwd: string
  permissionMode: 'plan' | 'bypassPermissions' | 'acceptEdits'
  allowedTools?: string[]
  resume?: string
  hooks?: Record<string, unknown>
  maxThinkingTokens?: number
}

export interface SDKExecuteResult {
  sessionId?: string
  result?: string
  tokenUsage: { input: number; output: number }
}

export class SDKExecutor {
  /**
   * Execute a query via the Agent SDK.
   * Returns an async generator of StreamChunks — same interface as CLI-based agents.
   * Callers don't need to know if they're talking to CLI or SDK.
   */
  async *execute(
    options: SDKExecuteOptions
  ): AsyncGenerator<StreamChunk & { _meta?: SDKExecuteResult }> {
    const totalUsage = { input: 0, output: 0 }
    let sessionId: string | undefined
    let resultText: string | undefined

    try {
      const q = query({
        prompt: options.prompt,
        options: {
          model: options.model,
          systemPrompt: options.systemPrompt,
          cwd: options.cwd,
          permissionMode: options.permissionMode,
          allowedTools: options.allowedTools,
          resume: options.resume,
          maxThinkingTokens: options.maxThinkingTokens
        }
      })

      for await (const message of q) {
        const msg = message as Record<string, unknown>

        // Capture session ID from system.init messages
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id as string | undefined
        }

        // Map assistant messages to StreamChunks
        if (msg.type === 'assistant') {
          const assistantMsg = msg.message as Record<string, unknown> | undefined
          if (assistantMsg?.content && Array.isArray(assistantMsg.content)) {
            for (const block of assistantMsg.content as Record<string, unknown>[]) {
              if (block.type === 'text' && block.text) {
                yield { type: 'text', content: block.text as string }
              } else if (block.type === 'tool_use') {
                const toolName = block.name as string
                const toolInput = block.input as Record<string, unknown> | undefined
                yield {
                  type: 'tool_use',
                  toolName,
                  toolInput: toolInput ? summarizeToolInput(toolName, toolInput) : undefined
                }
              }
            }
          }
        }

        // Map content_block_delta for real-time streaming
        if (msg.type === 'content_block_delta') {
          const delta = msg.delta as Record<string, unknown> | undefined
          if (delta?.type === 'text_delta' && delta.text) {
            yield { type: 'text', content: delta.text as string }
          }
        }

        // Map content_block_start for tool activities
        if (msg.type === 'content_block_start') {
          const cb = msg.content_block as Record<string, unknown> | undefined
          if (cb?.type === 'tool_use') {
            const toolName = cb.name as string
            const toolInput = cb.input as Record<string, unknown> | undefined
            yield {
              type: 'tool_use',
              toolName,
              toolInput: toolInput ? summarizeToolInput(toolName, toolInput) : undefined
            }
          }
        }

        // Map user messages for tool results
        if (msg.type === 'user') {
          const userMsg = msg.message as Record<string, unknown> | undefined
          if (userMsg?.content && Array.isArray(userMsg.content)) {
            for (const block of userMsg.content as Record<string, unknown>[]) {
              if (block.type === 'tool_result') {
                yield { type: 'tool_result', toolName: 'tool' }
              }
            }
          }
        }

        // Capture result text
        if (msg.type === 'result') {
          resultText = msg.result as string | undefined
          if (resultText) {
            yield { type: 'text', content: resultText }
          }
        }

        // Accumulate token usage from all event types
        const usage = msg.usage as Record<string, number> | undefined
        if (usage) {
          totalUsage.input += usage.input_tokens ?? 0
          totalUsage.output += usage.output_tokens ?? 0
        }
        // message_start carries usage in msg.message.usage
        if (msg.type === 'message_start') {
          const startMsg = msg.message as Record<string, unknown> | undefined
          const startUsage = startMsg?.usage as Record<string, number> | undefined
          if (startUsage) {
            totalUsage.input += startUsage.input_tokens ?? 0
          }
        }
        // message_delta carries output_tokens
        if (msg.type === 'message_delta') {
          const deltaUsage = msg.usage as Record<string, number> | undefined
          if (deltaUsage) {
            totalUsage.output += deltaUsage.output_tokens ?? 0
          }
        }
      }
    } catch (error) {
      sdkLog.error('SDK execution error:', error)
      yield {
        type: 'error',
        error: `SDK execution failed: ${(error as Error).message}`
      }
    }

    // Yield final metadata chunk (callers can check for _meta)
    yield {
      type: 'status',
      content: 'complete',
      _meta: { sessionId, result: resultText, tokenUsage: totalUsage }
    } as StreamChunk & { _meta: SDKExecuteResult }
  }

  /**
   * Execute a single prompt and collect the full text result (non-streaming).
   * Used for decomposition and other one-shot queries.
   */
  async executeAndCollect(options: SDKExecuteOptions): Promise<{
    result: string
    sessionId?: string
    tokenUsage: { input: number; output: number }
  }> {
    let result = ''
    let sessionId: string | undefined
    const totalUsage = { input: 0, output: 0 }

    for await (const chunk of this.execute(options)) {
      if (chunk.type === 'text' && chunk.content) {
        result += chunk.content
      }
      if ('_meta' in chunk && chunk._meta) {
        const meta = chunk._meta as SDKExecuteResult
        sessionId = meta.sessionId
        totalUsage.input = meta.tokenUsage.input
        totalUsage.output = meta.tokenUsage.output
      }
    }

    return { result, sessionId, tokenUsage: totalUsage }
  }
}

export const sdkExecutor = new SDKExecutor()
